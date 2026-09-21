# `make check` is the single source of truth for "is the code good?".
# It must pass before any change is considered done.

CARGO ?= cargo

.PHONY: check fmt fmt-check lint test fix

## Run every gate: format, lint, test. Stops at the first failure.
check: fmt-check lint test
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
