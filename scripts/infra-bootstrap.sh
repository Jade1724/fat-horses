#!/usr/bin/env bash
# One-off: create the S3 bucket for Terraform's state and write infra/backend.hcl.
# Safe to run again. Uses AWS_PROFILE (default fat-horses) and REGION (default ap-southeast-2).
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-fat-horses}"
REGION="${REGION:-ap-southeast-2}"
cd "$(dirname "$0")/.."

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="fat-horses-tfstate-${ACCOUNT}"

if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "State bucket $BUCKET already exists."
else
  aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
    --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  echo "Created state bucket $BUCKET."
fi
aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

cat > infra/backend.hcl <<HCL
bucket = "${BUCKET}"
key    = "fat-horses.tfstate"
region = "${REGION}"
HCL
echo "Wrote infra/backend.hcl."

if [ ! -f infra/terraform.tfvars ]; then
  if [ -z "${BUDGET_EMAIL:-}" ]; then
    echo "Set BUDGET_EMAIL=you@example.com and run again to write infra/terraform.tfvars." >&2
    exit 1
  fi
  printf 'budget_email = "%s"\n' "$BUDGET_EMAIL" > infra/terraform.tfvars
  echo "Wrote infra/terraform.tfvars."
fi
