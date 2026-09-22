terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.66"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.8"
    }
  }

  # Partial configuration: bucket, key and region come from backend.hcl
  # (`terraform init -backend-config=backend.hcl`), written by `make infra-bootstrap`.
  backend "s3" {
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "fat-horses"
      ManagedBy = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}
