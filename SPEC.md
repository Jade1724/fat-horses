# fat-horses — Specification

A single-user web app that picks a restaurant for you. A real upcoming horse race on TAB NZ
decides a country (each horse carries one country; the winner's country wins). The app then
shows every nearby restaurant serving that country's food on a map and picks one at random.
It tracks which restaurants and countries you have visited.

Background and reasoning: `docs/PLAN.md`. Where this file and the plan disagree, **this file wins**.
Requirement IDs (`F2.3`, `L4`, …) are referenced from `TASKS.md` and should be referenced from tests.

---

## 1. Glossary

| Term | Meaning |
|---|---|
| **Pick** | One run of the whole flow for one address: race → winner country → restaurants → the chosen restaurant. Identified by `pick_id` (ULID). |
| **Pool** | The countries eligible to be assigned to horses in a pick. |
| **Place** | Any OSM restaurant-like node/way returned by Overpass inside the radius. |
| **Match** | A place judged to serve the winning country's food, with `match` = `tagged`, `inferred` or `fallback`. |
| **The pick / picked restaurant** | The one match chosen at random. |
| **Guess** | The LLM's cuisine guess for an untagged place (cached). |

---

## 2. Functional requirements

### F1. Starting a pick
- **F1.1** Input: `address` (free text) **or** `{lat, lon}`; `radius_m` (default **500**, allowed 50–2000); `min_population` (default **10 000 000**); `include_visited` (default **false**); `max_wait_min` (default **10**, allowed 5–180).
- **F1.2** Addresses are geocoded with Nominatim, **limited to the countries in `GEOCODE_COUNTRIES`** (default `nz`; empty = worldwide), up to 5 matches. Matches within 100 m of a better one are the same place and are merged. The web UI calls `GET /geocode` first: one match starts the pick at its coordinates (with the address as `label`); several are shown for the user to choose; none → "Couldn't find that address". `POST /picks` with a free-text address: no match → HTTP 422 `address_not_found`; several → HTTP 409 `ambiguous_address` with the matches; nothing is stored in either case. The CLI lists the matches and asks for a more specific address.
- **F1.3** Geocode matches are cached (key = geocoder scope, e.g. `nz`, plus the normalised address, lowercase + collapsed whitespace; 30 days).
- **F1.4** Starting a pick stores a pick session with status `finding_race` and starts the workflow (§6). Returns `pick_id` immediately.

### F2. Country pool
- **F2.1** Countries come from `data/countries.json` (schema §4.1).
- **F2.2** Pool = countries with `population >= min_population`.
- **F2.3** Unless `include_visited`, countries with `visit_count > 0` are removed from the pool.
- **F2.4** If F2.3 leaves the pool empty, use the F2.2 pool and set `world_complete = true` on the pick session (the UI shows "World complete!").

### F3. Race selection
- **F3.1** Only **gallops** (thoroughbred) races. Harness and greyhound races are ignored.
- **F3.2** Choose the race with the earliest scheduled start in `[now + 2 min, now + max_wait_min]`. If there is none, the pick fails at once with `no_upcoming_race` and the UI says so ("No gallops race starts in the next 10 minutes"), so nobody waits hours for a late-night race by accident.
- **F3.3** Only races that are still open (not started, not abandoned) and have at least **2** non-scratched runners are eligible.

### F4. Assigning countries to horses
- **F4.1** N = number of non-scratched runners at assignment time.
- **F4.2** Countries are drawn **without replacement**, uniformly at random, from the pool. If the pool has fewer than N countries: use all of them, then top up with distinct countries from the F2.2 pool that aren't already used (visited ones), then, only if still short, repeat countries at random.
- **F4.3** The race card (runner number, horse name, country) is saved on the pick session and never re-drawn.
- **F4.4** A runner scratched after assignment is shown as scratched; its country can't win.

### F5. Result and winner
- **F5.1** Polling starts at the scheduled start time, every **60 s**.
- **F5.2** Winner = the runner placed 1st in the **official** result. If only an interim result exists, accept it once it has been unchanged for **10 min**.
- **F5.3** Dead heat for 1st: choose one of the tied runners uniformly at random. The session records `dead_heat = true` and all tied runners.
- **F5.4** Race abandoned, or no result **45 min** after the scheduled start: choose uniformly at random among the non-scratched assigned countries; `winner.reason = "abandoned"` or `"timeout"`.
- **F5.5** The winning country is shown whether or not any restaurant matches.

### F6. Restaurant matching
- **F6.1 Places:** Overpass query for nodes/ways (ways via `out center`) inside the radius with `amenity` in `{restaurant, fast_food}` (**`cafe` excluded by default**; configurable list). Place ID = `osm:<type>/<id>`, e.g. `osm:node/123`.
- **F6.2 Tier 1, tagged:** a place matches when any value of its `cuisine` tag (split on `;`, trimmed, lowercased) is in the winning country's `cuisine_tags`.
- **F6.3 Tier 2, inferred:** for places **without** a `cuisine` tag, use the cached or new Guess (§3). A place matches when a guessed tag with `confidence >= 0.7` is in the country's `cuisine_tags`. Its `reason` is the Guess reason.
- **F6.4** Tiers 1 and 2 together form the **primary** matches. Guesses are made while waiting for the race (§6), before the winner is known, so the wait is used productively.
- **F6.5 Tier 3, fallback:** only if there are no primary matches. The LLM receives every place (tagged or not) and the country's `dishes`, and returns places likely to serve them, each with a reason (§3). These are `match = fallback`.
- **F6.6** If all tiers are empty, the pick ends `done` with no restaurant; the UI shows "No match nearby", the country's dishes and "Race again".
- **F6.7** The radius is **not** widened automatically in v1.
- **F6.8** If Bedrock fails (error, throttling, timeout or invalid output after a retry), skip tier 2 and/or 3, set `llm_unavailable = true`, and carry on. A pick never fails because of the LLM.

### F7. Choosing the restaurant
- **F7.1** Candidates = primary matches, or fallback matches if there are no primary ones.
- **F7.2** If any candidate has `visit_count == 0`, choose among only those; otherwise among all candidates.
- **F7.3** Choose uniformly at random with the injected RNG. The LLM never influences this choice.
- **F7.4** The chosen restaurant becomes `PICKED` (F8). All matches, with their current status, are saved on the pick session.

### F8. Restaurant status and visit tracking
- **F8.1** Status per restaurant: `null` (never picked, or skipped), `PICKED`, `VISITED`. A restaurant is stored only once it is picked or visited.
- **F8.2** Transitions (anything else is rejected with HTTP 409 `invalid_transition`):

| From | Event | To | Side effects |
|---|---|---|---|
| `null` or `VISITED` | pick chooses it | `PICKED` | remember `status_before_pick`; any **other** `PICKED` restaurant is reverted first (reason `superseded`) |
| `PICKED` | "We went here" | `VISITED` | `visit_count += 1`, `visited_at = now`; country `visit_count += 1` |
| `PICKED` | "Skip" or superseded | `status_before_pick` | none |
| `null` or `VISITED` | "We went here" from the map without a pick | `VISITED` | as the `PICKED → VISITED` row |

- **F8.3** At most one restaurant is `PICKED` at any time.
- **F8.4** The country credited by a visit is the restaurant's `country_iso`: the winning country of the pick that found it, or, for a map visit, the country given in the request.
- **F8.5** A country is **visited** when its `visit_count > 0`.
- **F8.6** Every transition writes one log entry `{at, restaurant_id, restaurant_name, country_iso, from, to, reason, pick_id?}`. `reason` ∈ `picked`, `visited`, `skipped`, `superseded`.
- **F8.7** A transition's restaurant update, country update and log entry are written atomically; a transition based on a stale status fails (409) instead of overwriting.

### F9. Passport and history
- **F9.1** Passport: every country in the current F2.2 pool with flag, name, `visited`, `visit_count`, `last_visited_at`, and a total "visited X of Y".
- **F9.2** History: log entries newest first, 50 per page, with a cursor.

### F10. Web UI
- **F10.1** One-page app with three views: **Pick** (default), **Passport**, **History**. Must be usable at 360 px width.
- **F10.2** First visit: ask for the API key and keep it in `localStorage`. A 401 response clears it and asks again.
- **F10.3** Pick view: address field; advanced options (radius, min population, include visited). An ambiguous address shows "Which …?" with the matches, without the country, as buttons (F1.2). A map (MapLibre + OpenFreeMap tiles) centred on the location with the radius circle.
- **F10.4** While the pick runs: poll `GET /api/picks/{id}` every **5 s**; show the status and the race card (number, horse, flag + country, scratched state) with a countdown to the start, and a **Cancel** button (F12). Above the card, "📺 Watch <venue> R<n> on TAB" opens the race's page on tab.co.nz (`https://www.tab.co.nz/racing/race/<race id>`, with TAB's Trackside stream) in a new tab; shown whenever the race is known. The countdown stops once the pick has finished or been cancelled.
- **F10.5** When done: the winner (horse + country, with a note for dead heat, abandoned or timeout); a pin for every match. Pin colours by status: new, `PICKED`, `VISITED`. The pick is highlighted with a card showing name, cuisine, address, match type (`likely` badge + reason for inferred/fallback) and a directions link (`https://www.google.com/maps/dir/?api=1&destination=<lat>,<lon>`).
- **F10.5a** Options include "Race must start within": 10 minutes (default), 30 minutes, 1 hour, 3 hours (F3.2).
- **F10.6** Buttons: "We went here", "Skip", "Race again". Clicking a non-picked pin offers "We went here" (F8.2 last row).
- **F10.7** If `llm_unavailable`, show a small notice "Cuisine guessing unavailable, showing tagged places only".
- **F10.8** The current `PICKED` restaurant (if any) is shown on load, so you can mark it visited later.

### F11. Access
- **F11.1** Every `/api/*` request needs header `x-api-key`, compared in constant time with every user's key (F14) from SSM, read once when the Lambda starts (a changed key takes effect as containers recycle, or at once after redeploying). Missing or wrong → 401.
- **F11.2** API Gateway throttling: 5 requests/s rate, burst 10.

### F12. Cancelling a pick
- **F12.1** `POST /picks/{id}/cancel` marks a pick that hasn't finished as `cancelled` and stops its workflow (Step Functions `StopExecution` in AWS; the in-process run locally). A pick that is already `done`, `failed` or `cancelled` is left as it is.
- **F12.2** `cancelled` is final: stores refuse to overwrite a cancelled pick with any other status (DynamoDB: a conditional put on a top-level `cancelled` attribute), so a step that was already running can't undo it.
- **F12.3** No restaurant becomes `PICKED` by a cancelled pick: the pick is checked again just before recording the chosen restaurant. Cancelling writes nothing to history.

### F13. Local runs survive restarts
- **F13.1** With `fat-horses serve`, a pick runs inside the server process. When the server starts, it resumes every unfinished pick (not `done`, `failed` or `cancelled`) from its stored state: steps already done (race and countries, places) are kept, not re-drawn, and a race that finished meanwhile is resolved from its result.
- **F13.2** The in-memory and JSON-file stores apply writes one at a time, with their conditions checked inside the write, so concurrent writes (two picks, a pick and a visit) never lose an update. (On AWS, Step Functions keeps picks running and DynamoDB's conditional writes cover F13.2.)

### F14. Users
- **F14.1** Each API key belongs to one user (name: `[a-z0-9_-]{1,32}`). A user's picks, restaurant statuses, passport and history are theirs alone: another user's pick is 404 to them, and one user's pick never replaces another's `PICKED` restaurant. The geocode and cuisine-guess caches hold only public map data and are shared.
- **F14.2** Keys on AWS: SSM SecureString `/fat-horses/api-keys` holding `{"<user>": "<key>", …}`. Locally: `FAT_HORSES_API_KEYS="haruka:key1,friend:key2"`, or the single `FAT_HORSES_API_KEY` for the user `me`. Adding a user = adding a key.
- **F14.3** Local data saved before users existed belongs to `me`. The CLI's `--user` (default `me`) chooses whose data `pick`, `visit`, `skip`, `passport` and `history` use.

---

## 3. LLM rules (Bedrock)

- **L1 Scope:** the LLM does exactly two things: `guess_cuisines` (F6.3) and `match_dishes` (F6.5). It never chooses the race, a country, the winner or the picked restaurant.
- **L2 Interface:** interface `Classifier` in `server/src/domain/classify.ts`:
  - `guess_cuisines(places: &[PlaceInput]) -> Result<Vec<Guess>>`, where `Guess = {place_id, cuisines: [{tag, confidence}], reason}`
  - `match_dishes(places: &[PlaceInput], country: &CountryDishes) -> Result<Vec<DishMatch>>`, where `DishMatch = {place_id, reason}`
  - Implementations: `BedrockClassifier` (`server/src/adapters/bedrock.ts`) and `FakeClassifier` (deterministic, configured from a map; for tests and offline runs).
- **L3 Input:** only public OSM data (name, tags, `website`/`menu` URLs if present) and the country's name and dishes. Never the user's address, coordinates, history or API key.
- **L4 Output validation:** the model returns JSON (via tool use / JSON-schema output in the Converse API). Drop any entry whose `place_id` wasn't in the input, any `tag` not in the known tag set (union of all `cuisine_tags`), and any confidence outside [0, 1]. Clamp `reason` to 120 characters. Invalid JSON → one retry → otherwise error (F6.8).
- **L5 Limits:** at most **50 places per call** and **200 places per pick** (closest first); max output tokens per call set in config; per-call timeout **20 s**.
- **L6 Caching:** a Guess is cached per `(place_id, prompt_version)` together with `input_hash` = SHA-256 of the name and sorted tags. A cached Guess is reused only if the hash matches. TTL 180 days. `match_dishes` results are not cached.
- **L7 Prompts:** versioned files `server/prompts/guess_cuisines.v<N>.md` and `match_dishes.v<N>.md`; the version number is part of the cache key.
- **L8 Model:** configured by env var `BEDROCK_MODEL_ID` (a model ID or inference profile ARN); default a small Claude model (e.g. Claude Haiku 4.5), final choice from spike T1.3. Region is configured separately (`BEDROCK_REGION`).
- **L9 Evaluation:** `fat-horses eval` runs a labelled set (`server/eval/*.json`) through the configured classifier and prints precision/recall per tier. It is run by hand, never by `make check`.

---

## 4. Data

### 4.1 `data/countries.json`
```json
{
  "source": { "population": "World Bank WDI SP.POP.TOTL", "year": 2024 },
  "countries": [
    {
      "iso2": "JP",
      "name": "Japan",
      "flag": "🇯🇵",
      "population": 124000000,
      "cuisine_tags": ["japanese", "sushi", "ramen", "udon", "yakitori", "izakaya"],
      "dishes": ["sushi", "ramen", "tempura", "okonomiyaki", "miso", "wasabi"]
    }
  ]
}
```
Validation (a unit test): `iso2` unique and 2 uppercase letters; `population > 0`; `cuisine_tags` non-empty, lowercase, `[a-z_]+`, and each follows OSM `cuisine=*` values where one exists; `dishes` has 3–12 entries. It covers **every** country with population ≥ 10 M in the source year; smaller countries may be added.

### 4.2 DynamoDB single table `fat-horses`
Keys `pk` (S), `sk` (S); attribute `ttl` (N, epoch seconds) for TTL. On-demand billing, point-in-time recovery on.

User-owned items are prefixed `U#<user>#` (F14); the Guess and Geocode cache items are shared.

| Item | pk | sk | Attributes |
|---|---|---|---|
| Restaurant | `U#<user>#RESTAURANT#<place_id>` | `META` | name, lat, lon, address, cuisine (list), country_iso, status (`PICKED`/`VISITED`; absent = `null`), status_before_pick, picked_at, visited_at, visit_count, match, reason |
| Currently picked | `U#<user>#STATE` | `PICKED` | restaurant_id. Written in the same transaction as every change to or from `PICKED` (enforces F8.3) |
| Country | `U#<user>#COUNTRY` | `<iso2>` | visit_count, first_visited_at, last_visited_at (one partition, so the Passport is a single Query) |
| Log entry | `U#<user>#LOG` | `<RFC3339 µs timestamp>#<restaurant_id>#<reason>` (JS has millisecond precision; the microseconds are zero-padded) | the fields of F8.6 |
| Pick session | `U#<user>#PICK#<pick_id>` | `META` | request, location, status, pool size, world_complete, race card, winner, places, matches, pick, llm_unavailable, error; `ttl` = +30 days |
| Guess | `PLACE#<place_id>` | `GUESS#v<prompt_version>` | cuisines, reason, model_id, input_hash, created_at; `ttl` = +180 days |
| Geocode cache | `GEOCODE#<normalised address>` | `META` | lat, lon, display_name; `ttl` = +30 days |

Records are stored as JSON in a `data` attribute; attributes used in conditions or updates (`status`, `restaurant_id`, country counters, `ttl`) are top level.

A status change = one `TransactWriteItems` with a condition on the restaurant's current status (and on `STATE/PICKED`), a country update if visited, and a log put.

The `Store` interface lives in `server/src/domain/store.ts`. It has an in-memory implementation (tests), a JSON-file implementation (CLI) and a DynamoDB implementation (`server/src/store/`). **One shared contract test suite** runs against every implementation.

---

## 5. HTTP API

All paths are under `/api`; JSON in and out; errors are `{"error": "<code>", "message": "..."}`.

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/picks` | `{address?, lat?, lon?, label?, radius_m?, min_population?, include_visited?, max_wait_min?}` (exactly one of address or lat+lon; `label` names the place for lat+lon) | 202 `{pick_id}`; 422 `address_not_found` / `invalid_request`; 409 `ambiguous_address` with `matches` |
| POST | `/picks/{id}/cancel` | – | 200 pick view (F12); 404 |
| GET | `/geocode` | `?q=<address>` | 200 `{matches: [{lat, lon, display_name}]}` (0–5, best first); 422 without `q` |
| GET | `/picks/{id}` | – | 200 pick view (below); 404 |
| GET | `/restaurants/picked` | – | 200 restaurant or `null` |
| POST | `/restaurants/{id}/visit` | `{restaurant?: {name, lat, lon, address, cuisine, country_iso}}` (required when the restaurant isn't stored yet) | 200 restaurant; 409 `invalid_transition` |
| POST | `/restaurants/{id}/skip` | – | 200 restaurant; 409 |
| GET | `/countries` | `?min_population=` | 200 `{visited, total, countries: [{iso2, name, flag, visited, visit_count, last_visited_at}]}` |
| GET | `/history` | `?cursor=` | 200 `{entries: [...], next_cursor?}` |

Pick view:
```
{ pick_id, status, error?, created_at, location: {lat, lon, display_name, radius_m},
  world_complete, race?: {venue, race_number, name, start_time, url,
     runners: [{number, horse, country: {iso2, name, flag}, scratched}]},
  winner?: {number, horse, country, reason: "result"|"dead_heat"|"abandoned"|"timeout", tied?: [...]},
  restaurants: [{id, name, lat, lon, address, cuisine, match, reason?, status, visit_count}],
  pick?: <restaurant id>, dishes?: [...], llm_unavailable }
```
`status` ∈ `finding_race`, `waiting_start`, `running`, `resolving`, `searching`, `done`, `failed`, `cancelled`. The view also carries `max_wait_min`. `error` (when `failed`) ∈ `no_upcoming_race`, `race_source_unavailable`, `places_unavailable`, `internal`.

---

## 6. Workflow and architecture

Pick workflow (AWS Step Functions Standard; each task invokes the `workflow` Lambda with `{step, pick_id}`; the same steps are plain async functions in `server/src/app/workflow.ts`, which the CLI calls in-process):

1. `FindRace` (F3) → `AssignCountries` (F2, F4) → status `waiting_start`
2. `PrepareNearby`: Overpass places (F6.1) + guesses for untagged places (F6.3), stored on the session
3. `Wait` until the scheduled start → status `running`
4. Loop: `CheckResult` (F5) → `Wait 60 s` until a winner is decided or the 45-min timeout → status `resolving`
5. `Match`: tiers 1–2 (F6.2–F6.4) → if empty, `FallbackMatch` (F6.5) → status `searching`
6. `PickRestaurant` (F7, F8) → status `done`

Each step's output has `failed` (true for failed or cancelled picks) and `cancelled`; the state machine stops when `failed` is true. Any unhandled step error → status `failed` with the error code. Step retries: 2 with backoff for network errors.

Infrastructure (Terraform in `infra/`, S3 state backend with native lock file):
- CloudFront: `/` → private S3 site bucket (OAC); `/api/*` → API Gateway HTTP API → `api` Lambda.
- `api` Lambda environment includes `GEOCODE_COUNTRIES` (default `nz`, F1.2).
- Lambdas: TypeScript on the managed **Node.js 22** runtime (`nodejs22.x`), arm64, one esbuild bundle per handler (`make build-lambdas`); the AWS SDK v3 comes from the runtime. Chosen over Rust on the OS-only runtime because a managed runtime is easier to operate.
- Step Functions state machine, DynamoDB table (§4.2), SSM SecureString `/fat-horses/api-keys` (F14.2). The Step Functions input is `{pick_id, user}`, passed to each `workflow` step.
- IAM: least privilege per Lambda; `bedrock:InvokeModel` only on the configured model/profile; the `api` Lambda may `states:StartExecution` and `states:StopExecution` on the pick state machine only.
- AWS Budgets alarm (default USD 10/month) emailing the owner.
- Region: **`ap-southeast-2`** (default; subject to Bedrock model availability, confirmed in T1.3).

---

## 7. Code layout

```
server/                 TypeScript, Node.js 22
  src/domain/           types, rules F2–F8, interfaces (RaceProvider, Geocoder, Places, Classifier, Store, Clock). No I/O
  src/adapters/         TAB NZ, Nominatim, Overpass (and Bedrock, T3.9)
  src/store/            memory, JSON-file and DynamoDB stores + shared contract suite
  src/app/              workflow steps, start, API handlers
  src/lambda/           `api` and `workflow` handlers; wiring only
  src/cli/              `fat-horses`: pick, visit, skip, passport, history, serve (eval later)
  test/fixtures/        recorded TAB NZ, Nominatim and Overpass responses
  scripts/              Lambda bundling, DynamoDB Local contract run
data/countries.json     bundled into the server
web/                    Vite + TypeScript + MapLibre GL JS
infra/                  Terraform
```

---

## 8. Non-functional requirements

- **N1 Testability:** randomness (`rand::Rng`) and time (`Clock`) are injected everywhere; every rule in F2–F8 has unit tests with a seeded RNG and a fixed clock.
- **N2 Offline gate:** `make check` needs no network and no AWS credentials. External clients are tested against recorded fixtures in `server/test/fixtures/`.
- **N3 Integration tests** (DynamoDB Local, live TAB/Overpass/Bedrock) run only through separate make targets (`make it`, `make live`), never through `make check`.
- **N4 Etiquette:** Nominatim and Overpass calls send `User-Agent: fat-horses/<version> (<contact>)`. At most 1 Nominatim request per second.
- **N5 Cost:** expected < USD 5/month at personal use; nothing billed while idle except storage.
- **N6 Latency:** `POST /picks` < 3 s; `GET /picks/{id}` < 500 ms warm.
- **N7 Logs:** structured JSON logs (`server/src/log.ts`) with `pick_id` where there is one; no API key or address in logs above debug level.

---

## 9. Out of scope (v1)

Betting or TAB login; user accounts beyond API keys (sign-up, passwords); sharing data between users; ratings, notes or reviews; ranking by rating, price or opening hours; web search; automatic radius widening; native apps; an LLM "what to order" line.

## 10. Defaults chosen for PLAN's open questions (confirm or change)

| Question | Default in this spec |
|---|---|
| AWS region | `ap-southeast-2` (§6) |
| Where addresses are searched | New Zealand (`GEOCODE_COUNTRIES=nz`), with a choice when several places match (F1.2) |
| How long to wait for a race | 10 minutes by default, up to 3 hours by choice (F3.2) |
| `fast_food` / `cafe` count as restaurants? | `fast_food` yes, `cafe` no; configurable (F6.1) |
| Fallback widens the radius? | No (F6.7) |
| Directions link | Google Maps URL, no API key (F10.5) |
| `PICKED` expires automatically? | No; it stays until visited, skipped or superseded (F8.2) |
| Note or rating on a visit? | No (§9) |
| "Likely" confidence threshold | 0.7 (F6.3) |
