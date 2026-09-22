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

output "api_keys_parameter" {
  description = "Set the users' keys here (infra/README.md)."
  value       = aws_ssm_parameter.api_keys.name
}

output "state_machine_arn" {
  value = aws_sfn_state_machine.picks.arn
}
