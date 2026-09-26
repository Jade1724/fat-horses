# Deploying fat-horses to AWS

Everything runs in one AWS account and region (`ap-southeast-2` by default):
CloudFront → S3 (site) and API Gateway → `api` Lambda; Step Functions → `workflow`
Lambda; DynamoDB; SSM (API keys); a monthly budget alarm. See SPEC.md §6.

Tools: AWS CLI v2, Terraform ≥ 1.10, Node 22. The `make` targets pin the AWS
profile to `fat-horses`, so a shell that exports `AWS_PROFILE` for another
account can't redirect them; to use a different one, pass it on the command
line: `make AWS_PROFILE=... deploy`. Scripts run directly (`scripts/*.sh`) fall
back to the ambient `AWS_PROFILE`, so prefix those with
`AWS_PROFILE=fat-horses` if your shell points elsewhere.

## First time

1. Credentials: `aws configure sso --profile fat-horses` — region
   `ap-southeast-2`, output `json`. Reuse an existing `sso-session` name if you
   have one; one `aws sso login --sso-session <name>` then covers every account
   it grants. Check with `aws sts get-caller-identity --profile fat-horses`, and
   make sure no stale `[fat-horses]` block is left in `~/.aws/credentials` —
   static keys there win over SSO in `~/.aws/config`.
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
6. The shared password (F11):

   ```
   scripts/set-password.sh
   ```

   It prompts for the password twice, stores only its scrypt hash in SSM, and
   writes nothing to your machine. Share the password with whoever should get
   in, by a private channel — never in this repo. It applies within 5 minutes.

   Everyone who logs in shares one view of picks, passport and history (F14):
   that is the point, not an oversight.

## Rotating the password

```
scripts/set-password.sh                     # change the password
scripts/set-password.sh --revoke-sessions   # …and log everyone out now
```

Changing the password alone leaves current sessions alive, because a session
cookie is signed with a separate secret — usually what you want. Add
`--revoke-sessions` when a session itself might be in the wrong hands (a lost
laptop, a browser left open): it also replaces the signing secret, so every live
cookie stops verifying.

Either way the `api` Lambda picks the change up within 5 minutes; `make deploy`
applies it at once. A forgotten password cannot be recovered, only replaced —
SSM holds a hash, not the password.

## Later

- Code changes: `make deploy`.
- Terraform settings: `infra/variables.tf` (e.g. `budget_usd`, `geocode_countries`, `tab_from`),
  set in `infra/terraform.tfvars`.
- Remove everything: `terraform -chdir=infra destroy` (the table has deletion
  protection; turn it off in `data.tf` first if you really mean it).
