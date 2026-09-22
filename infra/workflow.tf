# The pick workflow (SPEC.md §6): start → prepare_nearby → wait for the start →
# check_result every 60 s until decided → finish. A task that keeps failing
# goes to `fail`, which marks the pick failed. Cancelling a pick stops the
# execution (F12). Every task keeps the input {pick_id, user} and puts the
# step's output under $.out.

locals {
  workflow_fn = aws_lambda_function.fn["workflow"].arn

  retry = [
    {
      ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException", "Lambda.TooManyRequestsException", "States.TaskFailed"]
      IntervalSeconds = 5
      MaxAttempts     = 2
      BackoffRate     = 3
    }
  ]

  catch = [{ ErrorEquals = ["States.ALL"], ResultPath = "$.error", Next = "Fail" }]

  task = { for step in ["start", "prepare_nearby", "check_result", "finish", "fail"] : step => {
    Type     = "Task"
    Resource = "arn:aws:states:::lambda:invoke"
    Parameters = {
      FunctionName = local.workflow_fn
      Payload = {
        step        = step
        "pick_id.$" = "$.pick_id"
        "user.$"    = "$.user"
      }
    }
    ResultSelector = { "result.$" = "$.Payload" }
    ResultPath     = "$.out"
    Retry          = local.retry
  } }

  stopped = { Variable = "$.out.result.failed", BooleanEquals = true, Next = "Done" }

  definition = {
    Comment        = "fat-horses pick workflow"
    StartAt        = "Start"
    TimeoutSeconds = 5 * 3600 # up to 3 h to the start + 45 min for a result, with margin
    States = {
      Start         = merge(local.task["start"], { Next = "StartDone", Catch = local.catch })
      StartDone     = { Type = "Choice", Choices = [local.stopped], Default = "PrepareNearby" }
      PrepareNearby = merge(local.task["prepare_nearby"], { Next = "PrepareDone", Catch = local.catch })
      PrepareDone   = { Type = "Choice", Choices = [local.stopped], Default = "WaitForStart" }
      WaitForStart  = { Type = "Wait", TimestampPath = "$.out.result.start_time", Next = "CheckResult" }
      CheckResult   = merge(local.task["check_result"], { Next = "Decided", Catch = local.catch })
      Decided = {
        Type = "Choice"
        Choices = [
          local.stopped,
          { Variable = "$.out.result.decided", BooleanEquals = true, Next = "Finish" },
        ]
        Default = "Poll"
      }
      Poll   = { Type = "Wait", Seconds = 60, Next = "CheckResult" }
      Finish = merge(local.task["finish"], { Next = "Done", Catch = local.catch })
      Fail   = merge(local.task["fail"], { Next = "Done", Retry = local.retry })
      Done   = { Type = "Succeed" }
    }
  }
}

resource "aws_cloudwatch_log_group" "workflow" {
  name              = "/aws/vendedlogs/states/${var.name}"
  retention_in_days = 14
}

resource "aws_sfn_state_machine" "picks" {
  name       = var.name
  type       = "STANDARD"
  role_arn   = aws_iam_role.workflow.arn
  definition = jsonencode(local.definition)

  logging_configuration {
    level                  = "ERROR"
    include_execution_data = false
    log_destination        = "${aws_cloudwatch_log_group.workflow.arn}:*"
  }
}

data "aws_iam_policy_document" "states_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "workflow" {
  name               = "${var.name}-workflow-sfn"
  assume_role_policy = data.aws_iam_policy_document.states_assume.json
}

data "aws_iam_policy_document" "workflow" {
  statement {
    sid       = "InvokeSteps"
    actions   = ["lambda:InvokeFunction"]
    resources = [local.workflow_fn, "${local.workflow_fn}:*"]
  }

  # Step Functions logging needs these on "*" (AWS documented requirement).
  statement {
    sid = "Logs"
    actions = [
      "logs:CreateLogDelivery",
      "logs:GetLogDelivery",
      "logs:UpdateLogDelivery",
      "logs:DeleteLogDelivery",
      "logs:ListLogDeliveries",
      "logs:PutResourcePolicy",
      "logs:DescribeResourcePolicies",
      "logs:DescribeLogGroups",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "workflow" {
  name   = "${var.name}-workflow-sfn"
  role   = aws_iam_role.workflow.id
  policy = data.aws_iam_policy_document.workflow.json
}

# An execution that fails or times out (the Fail state already marked the pick)
# is worth knowing about (TASKS T8.2).
resource "aws_cloudwatch_metric_alarm" "workflow_failures" {
  alarm_name          = "${var.name}-workflow-failures"
  namespace           = "AWS/States"
  metric_name         = "ExecutionsFailed"
  dimensions          = { StateMachineArn = aws_sfn_state_machine.picks.arn }
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
