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

# The shared password, as a scrypt hash (F11.1). Terraform creates the parameter
# with a placeholder and never reads or overwrites the real value, which
# scripts/set-password.sh sets, so no secret enters the state file.
resource "aws_ssm_parameter" "password_hash" {
  name        = "/${var.name}/password-hash"
  description = "fat-horses shared password, as scrypt$N$r$p$salt$hash"
  type        = "SecureString"
  # Not a valid hash on purpose: until a password is set, the API refuses every
  # login rather than accepting one written in this repo.
  value = "unset"

  lifecycle {
    ignore_changes = [value]
  }
}

# The HMAC key that signs session cookies. Rotating it ends every live session;
# scripts/set-password.sh --revoke-sessions does that.
resource "aws_ssm_parameter" "session_secret" {
  name        = "/${var.name}/session-secret"
  description = "fat-horses session signing secret"
  type        = "SecureString"
  value       = "unset"

  lifecycle {
    ignore_changes = [value]
  }
}

data "aws_kms_alias" "ssm" {
  name = "alias/aws/ssm"
}
