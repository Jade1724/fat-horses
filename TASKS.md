# fat-horses — Tasks

The ordered work list for building `SPEC.md`. Requirement IDs (e.g. `F4.2`) point into `SPEC.md`.

## How to use this list

- Take the **first unchecked task** whose `Needs` are all checked and which is not tagged `[human]`.
- Do only that task: one logical change, with tests. It is done when its **Done when** holds **and** `make check` passes.
- Then tick its box (`- [x]`) in the same change.
- `[human]` = needs the owner (credentials, accounts, a decision, or review). Don't start it; skip to the next task that doesn't depend on it.
- If a task turns out too big, split it here into smaller tasks first. If the spec seems wrong, stop and say so; don't change the spec silently.

---

## M0 Workspace

- [x] **T0.1 Convert to a Cargo workspace.** Root `Cargo.toml` becomes a workspace. Move `src/main.rs` to `crates/cli` (binary `fat-horses`). Add an empty `crates/domain` library with one placeholder test. Update the layout note in `CLAUDE.md`.
  Done when: `cargo run -p fat-horses-cli` prints something; `make check` passes and runs the domain test.

## M1 Spikes (findings go to `docs/spikes/`)

- [ ] **T1.1 TAB NZ data spike.** Find the JSON endpoints TAB NZ's website uses for: upcoming meetings/races (with race type), a race card with runners and scratchings, and results (interim/official, dead heat, abandoned if visible). Record 3–6 real responses as fixtures in `crates/race/tests/fixtures/`. Write `docs/spikes/tab-nz.md`: endpoints, fields used, how each F3/F5 case appears, rate-limit notes, and the terms-of-use text you found.
  Done when: the doc and fixtures exist.
- [ ] **T1.2 [human] Review TAB NZ terms.** The owner reads `docs/spikes/tab-nz.md` and confirms automated read-only use is acceptable, or picks another source.
  Needs: T1.1.
- [ ] **T1.3 [human] Bedrock access.** The owner enables model access for a small Claude model in the chosen region (or a cross-region inference profile), creates local AWS credentials for development, and writes the model ID/profile ARN and region into `docs/spikes/bedrock.md`.
- [ ] **T1.4 [human] Sample addresses.** The owner adds 3–5 addresses they would really use to `docs/spikes/overpass.md`.
- [ ] **T1.5 Overpass coverage spike.** For each T1.4 address, query places within 200 m and 500 m; record counts of total places, places with a `cuisine` tag and the most common tags. Save the raw responses as fixtures in `crates/places/tests/fixtures/`.
  Needs: T1.4. Done when: the table is in `docs/spikes/overpass.md` and the fixtures are saved.

## M2 Domain rules (`crates/domain`, pure, seeded RNG + fixed clock)

- [x] **T2.1 Countries data model and loader.** Types for §4.1, a loader from JSON, and the §4.1 validation as a function with tests (a valid sample passes; each rule has a failing sample).
- [x] **T2.2 Populate `data/countries.json`.** Every country with population ≥ 10 M from World Bank `SP.POP.TOTL` (latest full year), with flag, `cuisine_tags` (OSM values where they exist) and 3–12 `dishes`. A test loads the real file and validates it.
  Needs: T2.1.
- [ ] **T2.3 [human] Review `countries.json`.** The owner checks the cuisine tags and dishes.
  Needs: T2.2.
- [x] **T2.4 Pool (F2.2–F2.4).** `pool(countries, min_population, visited, include_visited) -> Pool { countries, world_complete }`. Tests: threshold, visited excluded, include_visited, world complete.
- [x] **T2.5 Race types and selection (F3).** Domain types `Race`, `Runner`, `RaceType`, `RaceStatus`; `select_race(races, now) -> Option<Race>`. Tests: the 2–15 min window, fallback to the next race, the 3 h limit, non-gallops ignored, fewer than 2 runners ignored, closed or abandoned races ignored.
- [x] **T2.6 Assignment (F4).** `assign(runners, pool, full_pool, rng) -> RaceCard`. Tests: distinct when possible, the top-up order of F4.2, repeats only when forced, scratched runners get no country, same seed → same card.
- [x] **T2.7 Winner (F5).** `resolve(card, result_snapshot, now, first_interim_seen_at, rng) -> Decision { Pending | Winner{..} }`. Tests: official result, interim after 10 min, interim before 10 min is pending, dead heat, abandoned, 45-min timeout, scratched runner can't win.
- [x] **T2.8 Tier 1 matching (F6.2).** Cuisine tag parsing (`;`, trim, lowercase) and matching. Tests include `"Japanese; sushi"` and ways/nodes alike.
- [x] **T2.9 Tier 2 matching (F6.3, F6.4).** Given places and guesses, return inferred matches (threshold 0.7; tagged places never inferred). Tests at the threshold boundary.
- [x] **T2.10 Choosing the restaurant (F7).** Tests: prefers unvisited, falls back to all, uses fallback matches only when there are no primary ones, empty → none, same seed → same choice.
- [x] **T2.11 Status state machine (F8.2, F8.3, F8.6).** Pure transition function returning the new restaurant state, the country delta and the log entry, or `InvalidTransition`. Tests for every row of F8.2, rejected transitions, and restoring `status_before_pick` on skip/superseded.

## M3 Adapters and stores

- [ ] **T3.1 `RaceProvider` + TAB NZ client.** Trait in domain; `crates/race` client (reqwest, rustls) mapping TAB JSON to domain types. Tests parse the T1.1 fixtures (no network).
  Needs: T1.1, T2.5.
- [ ] **T3.2 Nominatim geocoder (F1.2, N4).** Client + response parsing tests from recorded fixtures; User-Agent set; 1 request/s limit.
- [ ] **T3.3 Overpass places client (F6.1).** Query builder (radius, amenity list, `out center`) with a snapshot test of the query text; parsing tests from fixtures (T1.5 fixtures if available, otherwise hand-written ones).
- [ ] **T3.4 Store traits + in-memory stores + contract tests (§4.2).** `VisitStore` (applies T2.11 transitions atomically, conditional on current status), `PickStore`, `GuessCache`, `GeocodeCache`. A reusable contract test suite; the in-memory store passes it, including stale-status → conflict.
  Needs: T2.11.
- [ ] **T3.5 JSON-file stores.** For the CLI, stored under `~/.local/share/fat-horses/`. Pass the T3.4 contract suite.
  Needs: T3.4.
- [ ] **T3.6 DynamoDB stores.** `crates/store` implementation with `TransactWriteItems` and the `STATE/PICKED` item. Add `make it`, which starts DynamoDB Local (docker) and runs the contract suite against it; not part of `make check`.
  Needs: T3.4.

## M3c Classifier (LLM)

- [ ] **T3.7 `Classifier` trait, `FakeClassifier` and output validation (L2, L4).** Validation as a pure function with tests: unknown place IDs, unknown tags, confidence out of range, long reasons, bad JSON.
- [ ] **T3.8 Guess caching (L6).** Wraps any `Classifier`: uses the `GuessCache`, recomputes when `input_hash` or prompt version changes, batches of 50, cap 200 closest places (L5). Tests with `FakeClassifier` that count calls.
  Needs: T3.4, T3.7.
- [ ] **T3.9 `BedrockClassifier` (L3, L5, L7, L8).** Converse API with tool-use JSON output, prompts in `crates/classify/prompts/`, timeout and one retry. Unit tests build the request from fixtures and parse recorded responses (no network). `make live` runs one real call.
  Needs: T1.3, T3.7.
- [ ] **T3.10 Eval set and `fat-horses eval` (L9).** At least 40 labelled places from T1.5 fixtures; prints precision/recall per tier.
  Needs: T1.5, T3.9.

## M4 App layer and CLI

- [ ] **T4.1 Workflow steps (§6) in `crates/app`.** `find_race`, `assign_countries`, `prepare_nearby`, `check_result`, `match_restaurants`, `fallback_match`, `pick_restaurant`, each `(session, deps) -> session`, generic over the traits. Tests run a full pick with fakes: normal, dead heat, abandoned, no match, LLM failure (F6.8), no race (F3.2).
  Needs: T2.4–T2.11, T3.4, T3.7.
- [ ] **T4.2 CLI `pick`.** `fat-horses pick "<address>" [--radius] [--min-population] [--include-visited] [--fake-llm]` runs the steps in-process with live clients and the JSON-file store, printing the race card, waiting and polling, then the winner and matches.
  Needs: T3.1, T3.2, T3.3, T3.5, T4.1. Done when: a real pick runs end to end (owner runs it once and confirms in `docs/spikes/cli-e2e.md`).
- [ ] **T4.3 CLI `visit`, `skip`, `passport`, `history`.** Tests for output formatting against the in-memory store.
  Needs: T3.5.
- [ ] **T4.4 HTTP API handlers (§5, F11.1) in `crates/app`.** Request validation, error codes, API-key check (constant time). Tested with in-memory stores and fake request objects.
  Needs: T4.1.
- [ ] **T4.5 `api` Lambda binary.** `lambda_http` wiring for T4.4. Runs locally with `cargo lambda watch`, using the JSON-file store and running the workflow in-process in the background, for UI development.
  Needs: T4.4.

## M5 Web UI (`web/`)

- [ ] **T5.1 Scaffold.** Vite + TypeScript + ESLint + Vitest. Extend `make check` with `web` typecheck, lint and test. `make check` runs `npm ci` first rather than skipping the web checks when `web/node_modules` is missing.
- [ ] **T5.2 API client and key screen (F10.2).** Typed client for §5; 401 clears the key. Unit tests with mocked fetch.
- [ ] **T5.3 Pick form + map (F10.3).** MapLibre with OpenFreeMap tiles, radius circle, advanced options.
- [ ] **T5.4 Race progress (F10.4).** Polling, status text, race card with countdown. Unit tests for the countdown/status mapping.
- [ ] **T5.5 Results (F10.5–F10.8).** Pins coloured by status, the pick card, "likely" badges, buttons wired to the API, current `PICKED` shown on load.
- [ ] **T5.6 Passport and History views (F9, F10.1).**
- [ ] **T5.7 [human] UI check.** The owner runs the UI against T4.5 on desktop and phone width and notes issues as new tasks.

## M6 Infrastructure (`infra/`)

- [ ] **T6.1 [human] AWS account setup.** The owner creates or chooses the AWS account and a deploy role/profile, the S3 state bucket, and the budget alert email; writes the names into `infra/README.md`.
- [ ] **T6.2 Terraform scaffold.** Providers, S3 backend (native lock file), variables, `make check` gains `terraform fmt -check` and `terraform validate` (with `-backend=false`).
  Needs: T6.1.
- [ ] **T6.3 Data resources.** DynamoDB table (§4.2: keys, TTL, PITR, on-demand) and the SSM parameter (value set by hand, not in state).
- [ ] **T6.4 Lambdas.** `make build-lambdas` (cargo lambda, arm64); Terraform Lambda functions, log groups (14-day retention), least-privilege IAM, including Bedrock (§6).
- [ ] **T6.5 Step Functions state machine (§6).** Definition file with Wait states, the result loop, retries, the 45-min timeout and the failure path.
- [ ] **T6.6 API Gateway + CloudFront + S3 site (§6, F11.2).** Throttling, OAC, `/api/*` behaviour, SPA fallback to `index.html`.
- [ ] **T6.7 Budget alarm (§6).**
- [ ] **T6.8 `make deploy` + smoke test.** Build, `terraform apply`, upload `web/dist`, then a scripted smoke test: 401 without key, POST pick → reaches `waiting_start`.
- [ ] **T6.9 [human] First deploy.** The owner runs `make deploy` and one real pick in the browser.
  Needs: T6.8.

## M7 LLM fallback

- [ ] **T7.1 `match_dishes` end to end (F6.5).** Prompt, Bedrock call, validation, wiring into `fallback_match`; tests with fakes and recorded responses; eval cases for tier 3.
  Needs: T3.9, T4.1.
- [ ] **T7.2 Fallback UI.** "No match nearby" state with dishes, fallback pins with reasons.

## M8 Polish

- [ ] **T8.1 Error states in the UI** for every `error` code in §5.
- [ ] **T8.2 Logs (N7) and a CloudWatch alarm** on failed Step Functions executions.
- [ ] **T8.3 Mobile layout pass** at 360 px (F10.1).
