# fat-horses

TypeScript on Node.js 22 (AWS Lambda managed runtime). Product spec: `SPEC.md`;
work list: `TASKS.md` (take the first open non-`[human]` task, tick it in the
same change).

- `server/` — backend: `src/domain` (pure rules and interfaces, no I/O),
  `src/adapters` (TAB NZ, Nominatim, Overpass), `src/store`, `src/app`
  (workflow steps, API handlers), `src/lambda` (handlers), `src/cli`.
- `web/` — the web UI (Vite, MapLibre).
- `data/countries.json` — bundled into the server.

## Commands

- `make check` — prettier check, `tsc`, eslint, vitest for `server/` and `web/`. **The definition of done.**
- `make fmt` — format both packages in place.
- `make build-lambdas` — bundle the Lambda handlers (esbuild) into `server/dist/lambda/`.
- `make web-build` — build the UI into `web/dist/`.
- `make it` — store contract against DynamoDB Local (needs Docker). Not part of `check`.
- `cd server && npm run cli -- <command>` — the `fat-horses` CLI (pick, visit, skip, passport, history, serve, hash-password).

## Definition of done

A change is done only when `make check` passes. A Stop hook
(`.claude/hooks/stop-gate.sh`) runs it when you try to finish and sends the
failures back to you. Don't treat that as noise — fix the cause.

## Rules

- Fix the code, not the gate. Never weaken `make check`, add
  `eslint-disable`/`@ts-ignore`/`@ts-expect-error`, skip tests (`.skip`,
  `.todo`) or delete/loosen a test just to get green. If a lint or test is
  genuinely wrong, stop and say why.
- Add or update tests with every behavior change. Write the failing test first
  when fixing a bug.
- Work in small steps: one logical change, `make check`, then the next.
- Dependencies are locked (`package-lock.json`, installed with `npm ci`).
  Adding a package is a deliberate change: `npm install <pkg>` in the right
  package, then mention it in your summary.
- Keep entry points (`src/lambda/*`, `src/cli/main.ts`) thin; put logic in
  modules that can be unit-tested.
- `make check` needs no network or AWS credentials: test external services
  against recorded fixtures in `server/test/fixtures/`.
- If you're stuck after a few honest attempts, stop and report what you tried
  and what's failing instead of thrashing.
