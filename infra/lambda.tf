# The two Lambda handlers (SPEC.md §6): TypeScript bundles on the managed Node.js 22 runtime.

locals {
  lambdas = {
    api = {
      description = "fat-horses HTTP API"
      timeout     = 15
      memory      = 512
      environment = {
        TABLE_NAME           = aws_dynamodb_table.main.name
        PASSWORD_HASH_PARAM  = aws_ssm_parameter.password_hash.name
        SESSION_SECRET_PARAM = aws_ssm_parameter.session_secret.name
        STATE_MACHINE_ARN    = local.state_machine_arn
        GEOCODE_COUNTRIES    = var.geocode_countries
      }
    }
    workflow = {
      description = "fat-horses pick workflow step"
      # Overpass can take two endpoints x three attempts of up to 40 s each.
      timeout = 300
      memory  = 512
      environment = {
        TABLE_NAME = aws_dynamodb_table.main.name
        TAB_FROM   = var.tab_from
      }
    }
  }
  # Known before the state machine exists, so the api Lambda can refer to it.
  state_machine_arn = "arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:stateMachine:${var.name}"
}

data "archive_file" "lambda" {
  for_each    = local.lambdas
  type        = "zip"
  source_dir  = "${var.lambda_dist}/${each.key}"
  output_path = "${path.module}/.build/${each.key}.zip"
}

resource "aws_cloudwatch_log_group" "lambda" {
  for_each          = local.lambdas
  name              = "/aws/lambda/${var.name}-${each.key}"
  retention_in_days = 14
}

resource "aws_lambda_function" "fn" {
  for_each         = local.lambdas
  function_name    = "${var.name}-${each.key}"
  description      = each.value.description
  role             = aws_iam_role.lambda[each.key].arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.lambda[each.key].output_path
  source_code_hash = data.archive_file.lambda[each.key].output_base64sha256
  timeout          = each.value.timeout
  memory_size      = each.value.memory

  environment {
    variables = merge(each.value.environment, { NODE_OPTIONS = "--enable-source-maps" })
  }

  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.lambda[each.key].name
  }
}

# ---- IAM: one role per function, least privilege (SPEC.md §6) ----

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  for_each           = local.lambdas
  name               = "${var.name}-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "lambda" {
  for_each = local.lambdas

  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.lambda[each.key].arn}:*"]
  }

  statement {
    sid = "Table"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query",
      "dynamodb:ConditionCheckItem",
    ]
    resources = [aws_dynamodb_table.main.arn]
  }

  dynamic "statement" {
    for_each = each.key == "api" ? [1] : []
    content {
      sid       = "AuthSecrets"
      actions   = ["ssm:GetParameter"]
      resources = [aws_ssm_parameter.password_hash.arn, aws_ssm_parameter.session_secret.arn]
    }
  }

  dynamic "statement" {
    for_each = each.key == "api" ? [1] : []
    content {
      sid       = "DecryptAuthSecrets"
      actions   = ["kms:Decrypt"]
      resources = [data.aws_kms_alias.ssm.target_key_arn]
    }
  }

  dynamic "statement" {
    for_each = each.key == "api" ? [1] : []
    content {
      sid       = "StartPicks"
      actions   = ["states:StartExecution"]
      resources = [local.state_machine_arn]
    }
  }

  dynamic "statement" {
    for_each = each.key == "api" ? [1] : []
    content {
      sid       = "StopPicks"
      actions   = ["states:StopExecution"]
      resources = ["arn:aws:states:${var.region}:${data.aws_caller_identity.current.account_id}:execution:${var.name}:*"]
    }
  }
}

resource "aws_iam_role_policy" "lambda" {
  for_each = local.lambdas
  name     = "${var.name}-${each.key}"
  role     = aws_iam_role.lambda[each.key].id
  policy   = data.aws_iam_policy_document.lambda[each.key].json
}
