variable "region" {
  description = "AWS region for everything (SPEC.md §6)."
  type        = string
  default     = "ap-southeast-2"
}

variable "name" {
  description = "Prefix for resource names."
  type        = string
  default     = "fat-horses"
}

variable "budget_email" {
  description = "Where the monthly budget alarm is sent."
  type        = string
}

variable "budget_usd" {
  description = "Monthly budget in USD; alerts at 80% actual and 100% forecast."
  type        = number
  default     = 10
}

variable "geocode_countries" {
  description = "Countries addresses are searched in (F1.2), comma-separated ISO codes; empty for worldwide."
  type        = string
  default     = "nz"
}

variable "tab_from" {
  description = "Optional From header for the TAB NZ API (an email). Empty to send none."
  type        = string
  default     = ""
}

variable "lambda_dist" {
  description = "Directory with the bundled Lambda handlers (make build-lambdas)."
  type        = string
  default     = "../server/dist/lambda"
}
