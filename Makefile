# `make check` is the single source of truth for "is the code good?".
# It must pass before any change is considered done.

.PHONY: check server-check web-check infra-fmt-check fmt build-lambdas web-build it infra-bootstrap infra-init infra-plan deploy

## Run every gate for both packages: format, types, lint, tests.
check: server-check web-check infra-fmt-check
	@echo "check: OK"

## Install dependencies when a lock file changes.
server/node_modules/.package-lock.json: server/package-lock.json
	cd server && npm ci --no-audit --no-fund

web/node_modules/.package-lock.json: web/package-lock.json
	cd web && npm ci --no-audit --no-fund

## Backend (TypeScript on Node.js 22): prettier, tsc, eslint, vitest.
server-check: server/node_modules/.package-lock.json
	cd server && npm run -s check

## Web UI: prettier, tsc, eslint, vitest.
web-check: web/node_modules/.package-lock.json
	cd web && npm run -s fmt-check && npm run -s typecheck && npm run -s lint && npm test -s

## Terraform formatting (offline; `make infra-plan` validates with AWS).
infra-fmt-check:
	$(TERRAFORM) -chdir=infra fmt -check -recursive

## Format everything in place.
fmt: server/node_modules/.package-lock.json web/node_modules/.package-lock.json
	cd server && npm run -s fmt
	cd web && npm run -s fmt
	$(TERRAFORM) -chdir=infra fmt -recursive

## Bundle the Lambda handlers into server/dist/lambda/<name>/index.mjs.
build-lambdas: server/node_modules/.package-lock.json
	cd server && npm run -s build:lambdas

## Production build of the web UI into web/dist.
web-build: web/node_modules/.package-lock.json
	cd web && npm run -s build

TERRAFORM ?= terraform
export AWS_PROFILE ?= fat-horses

## One-off: Terraform state bucket, infra/backend.hcl and infra/terraform.tfvars (BUDGET_EMAIL=...).
infra-bootstrap:
	scripts/infra-bootstrap.sh

infra-init:
	$(TERRAFORM) -chdir=infra init -input=false -backend-config=backend.hcl

## Build and show what `make deploy` would change.
infra-plan: build-lambdas infra-init
	$(TERRAFORM) -chdir=infra validate
	$(TERRAFORM) -chdir=infra plan -input=false

## Build, apply, upload the site, then smoke-test.
deploy: build-lambdas web-build infra-init
	$(TERRAFORM) -chdir=infra validate
	$(TERRAFORM) -chdir=infra apply -input=false
	aws s3 sync web/dist "s3://$$($(TERRAFORM) -chdir=infra output -raw site_bucket)" --delete
	aws cloudfront create-invalidation --distribution-id "$$($(TERRAFORM) -chdir=infra output -raw distribution_id)" --paths "/*" >/dev/null
	scripts/smoke-test.sh "$$($(TERRAFORM) -chdir=infra output -raw url)"

DYNAMODB_LOCAL_IMAGE ?= amazon/dynamodb-local:latest

## Store contract against DynamoDB Local in Docker. Not part of `check`.
it: server/node_modules/.package-lock.json
	@docker rm -f fat-horses-ddb >/dev/null 2>&1 || true
	docker run -d --rm --name fat-horses-ddb -p 8000:8000 $(DYNAMODB_LOCAL_IMAGE) -jar DynamoDBLocal.jar -inMemory
	@for i in $$(seq 1 30); do curl -s -o /dev/null localhost:8000 && break; sleep 1; done
	cd server && FAT_HORSES_DYNAMODB_ENDPOINT=http://localhost:8000 npm run -s it; \
	  status=$$?; docker stop fat-horses-ddb >/dev/null; exit $$status
