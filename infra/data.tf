# DynamoDB single table (SPEC.md §4.2).
resource "aws_dynamodb_table" "main" {
  name         = var.name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  deletion_protection_enabled = true
}

# API keys, one per user (F14.2): {"<user>": "<key>", …}. Terraform creates the
# parameter with a placeholder and never reads or overwrites the real value,
# which is set by hand (see infra/README.md), so keys never enter the state.
resource "aws_ssm_parameter" "api_keys" {
  name        = "/${var.name}/api-keys"
  description = "fat-horses API keys: JSON object of user to key"
  type        = "SecureString"
  # Not valid key JSON on purpose: until the real keys are set, the API refuses
  # every request instead of accepting a key that is written in this repo.
  value = "unset"

  lifecycle {
    ignore_changes = [value]
  }
}

data "aws_kms_alias" "ssm" {
  name = "alias/aws/ssm"
}
