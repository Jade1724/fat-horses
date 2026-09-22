# Deploying fat-horses to AWS

Everything runs in one AWS account and region (`ap-southeast-2` by default):
CloudFront → S3 (site) and API Gateway → `api` Lambda; Step Functions → `workflow`
Lambda; DynamoDB; SSM (API keys); a monthly budget alarm. See SPEC.md §6.

Tools: AWS CLI v2, Terraform ≥ 1.10, Node 22. Commands use the AWS profile
`fat-horses` (override with `AWS_PROFILE=...`).

## First time

1. Credentials: `aws configure --profile fat-horses` (region `ap-southeast-2`).
2. State bucket and settings (once):

   ```
   BUDGET_EMAIL=you@example.com make infra-bootstrap
   ```

   Creates a private, versioned S3 bucket for Terraform's state and writes
   `infra/backend.hcl` and `infra/terraform.tfvars` (both git-ignored).
3. Look before you leap: `make infra-plan`.
4. Deploy: `make deploy`. It builds the Lambdas and the site, applies Terraform,
   uploads the site and runs a smoke test. It prints the app's URL.
5. Confirm the email AWS sends to the budget address (SNS subscription), so
   alarms reach you.
6. API keys, one per user (F14):

   ```
   scripts/set-api-keys.sh haruka friend
   ```

   Keys go to SSM and to `~/.config/fat-horses/api-keys.json` (only you can
   read it); they are never printed. Give each person their own key. They
   apply within 5 minutes. Running it again replaces **all** keys, so list
   every user each time.

## Later

- Code changes: `make deploy`.
- Terraform settings: `infra/variables.tf` (e.g. `budget_usd`, `geocode_countries`, `tab_from`),
  set in `infra/terraform.tfvars`.
- Remove everything: `terraform -chdir=infra destroy` (the table has deletion
  protection; turn it off in `data.tf` first if you really mean it).
