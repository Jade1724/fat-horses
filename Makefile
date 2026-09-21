# `make check` is the single source of truth for "is the code good?".
# It must pass before any change is considered done.

CARGO ?= cargo

.PHONY: check fmt fmt-check lint test fix it web-check web-build

## Run every gate: format, lint, test. Stops at the first failure.
check: fmt-check lint test web-check
	@echo "check: OK"

## Fail if any file is not rustfmt-formatted.
fmt-check:
	$(CARGO) fmt --all -- --check

## Clippy on all targets; any warning is an error.
lint:
	$(CARGO) clippy --all-targets --all-features --locked -- -D warnings

## Unit, integration and doc tests.
test:
	$(CARGO) test --all-features --locked -q

## Format the code in place.
fmt:
	$(CARGO) fmt --all

## Apply formatting and clippy's automatic fixes, then re-check.
fix:
	$(CARGO) fmt --all
	$(CARGO) clippy --all-targets --all-features --fix --allow-dirty --allow-staged -- -D warnings
	$(MAKE) check

DYNAMODB_LOCAL_IMAGE ?= amazon/dynamodb-local:latest

## Integration tests against DynamoDB Local in Docker. Not part of `check`.
it:
	@docker rm -f fat-horses-ddb >/dev/null 2>&1 || true
	docker run -d --rm --name fat-horses-ddb -p 8000:8000 $(DYNAMODB_LOCAL_IMAGE) -jar DynamoDBLocal.jar -inMemory
	@for i in $$(seq 1 30); do curl -s -o /dev/null localhost:8000 && break; sleep 1; done
	FAT_HORSES_DYNAMODB_ENDPOINT=http://localhost:8000 $(CARGO) run --locked -q -p fat-horses-store --example dynamo_contract; \
	  status=$$?; docker stop fat-horses-ddb >/dev/null; exit $$status

## Install web dependencies when the lock file changes.
web/node_modules/.package-lock.json: web/package-lock.json
	cd web && npm ci --no-audit --no-fund

## Web UI: typecheck, lint, unit tests.
web-check: web/node_modules/.package-lock.json
	cd web && npm run -s typecheck && npm run -s lint && npm test -s

## Production build of the web UI into web/dist.
web-build: web/node_modules/.package-lock.json
	cd web && npm run -s build
