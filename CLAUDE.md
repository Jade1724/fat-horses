# fat-horses

Rust binary crate (`cargo`, edition from `Cargo.toml`).

## Commands

- `make check` — format check, clippy (`-D warnings`), tests. **The definition of done.**
- `make fmt` — format in place.
- `make fix` — `cargo fmt` + `clippy --fix`, then `make check`.
- `make test` / `make lint` / `make fmt-check` — individual gates.

## Definition of done

A change is done only when `make check` passes. A Stop hook
(`.claude/hooks/stop-gate.sh`) runs it when you try to finish and sends the
failures back to you. Don't treat that as noise — fix the cause.

## Rules

- Fix the code, not the gate. Never weaken `make check`, add `#[allow(...)]`
  or `#[ignore]`, or delete/loosen a test just to get green. If a lint or test
  is genuinely wrong, stop and say why.
- Add or update tests with every behavior change. Write the failing test first
  when fixing a bug.
- Work in small steps: one logical change, `make check`, then the next.
- Dependencies are locked (`--locked`). Adding a crate is a deliberate change:
  `cargo add <crate>`, then mention it in your summary.
- Keep `main.rs` thin; put logic in modules that can be unit-tested.
- If you're stuck after a few honest attempts, stop and report what you tried
  and what's failing instead of thrashing.
