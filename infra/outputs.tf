output "url" {
  description = "The app."
  value       = "https://${aws_cloudfront_distribution.site.domain_name}"
}

output "site_bucket" {
  value = aws_s3_bucket.site.bucket
}

output "distribution_id" {
  value = aws_cloudfront_distribution.site.id
}

output "password_hash_parameter" {
  description = "The shared password's hash; set it with scripts/set-password.sh."
  value       = aws_ssm_parameter.password_hash.name
}

output "session_secret_parameter" {
  description = "Signs session cookies; rotating it ends every session."
  value       = aws_ssm_parameter.session_secret.name
}

output "state_machine_arn" {
  value = aws_sfn_state_machine.picks.arn
}
