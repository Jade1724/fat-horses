# fat-horses — Plan

> **Update (2026-09-21):** the backend moved from Rust to TypeScript on Lambda's managed Node.js runtime, at the owner's request (easier to manage). Rust mentions below are historical; `SPEC.md` is current.

A restaurant picker driven by a real horse race: each horse gets a country, the winning
horse's country decides the cuisine, and the app picks a nearby restaurant serving it.

This document is the source for `SPEC.md` (what to build) and `TASKS.md` (ordered work
for the implementation loop). Sections 1–7 and 9–10 feed `SPEC.md`; section 8 feeds `TASKS.md`.

## 0. Decisions made so far

- **Race source: TAB NZ.** Reading race cards and results needs no account. The app never logs in or bets, so no TAB credentials are stored. TAB NZ also covers Australian and international races, so there should almost always be a race starting within 15 minutes.
- **No nearby restaurant for the winning country:** still show the country, then fall back to a search for places serving that country's signature dishes or ingredients (e.g. Switzerland → fondue, raclette, Gruyère).
- **LLM on Amazon Bedrock, for matching only:** a small model (e.g. Claude Haiku 4.5) (a) guesses the cuisine of nearby places that have no OSM `cuisine` tag, and (b) runs the fallback by picking which nearby places likely serve the country's dishes/ingredients. It only chooses among real OSM places by ID and never invents one. The race, the country draw and the random pick stay deterministic code with no LLM. This replaces the web-search provider in v1.
- **Access:** only the user, protected by a simple shared API key.
- **Stack:** AWS + Terraform, Rust backend on Lambda, web UI with a map. Prefer open-source tools and data; paying for AWS is fine.
- **Visit tracking:** a database records which countries have been visited and logs every restaurant's status: `null` (never picked) → `PICKED` → `VISITED`. **Database: DynamoDB.** With one user and small data, on-demand DynamoDB costs cents a month and needs no servers or VPC. RDS/Aurora would need the Lambdas inside a VPC, plus a NAT gateway (about USD 30+/month) so they can still call TAB and OSM.

## 1. Goal
Help the user explore the world's cuisines. Enter an address; a real upcoming horse race decides a country (one country per horse, the winning horse's country wins); the app shows every restaurant nearby serving that country's food on a map and picks one of them at random.

## 2. Non-goals (v1)
- Betting, or any use of a TAB account.
- Multiple users, accounts, history across users.
- Ranking restaurants by rating, price or opening hours (the pick is uniformly random).
- Native mobile apps (the web UI must work on a phone browser).
- Web search for restaurants (possible later behind a `WebSearch` trait; the Bedrock fallback covers v1).
- Any LLM involvement in choosing the race, the country or the picked restaurant.

## 3. User flow
1. Open the web app. On first visit, enter the API key; it is kept in `localStorage`.
2. Enter an address. Optional: radius (default **200 m**), minimum country population (default **10 million**).
3. The map centres on the geocoded address and draws the radius circle.
4. The app finds the next gallops race and shows a race card: horse number, horse name and assigned country (flag + name), plus the start time and a countdown.
5. Status updates while waiting: `waiting for start` → `running` → `result`.
6. The winner is shown: horse and country.
7. Pins appear for every matching restaurant within the radius. One is highlighted as **the pick**, with name, cuisine tags, address and a link to directions. Matches guessed by the LLM are labelled **"likely"** and show its one-line reason.
8. If there are no matches, the page says so, lists the country's signature dishes and ingredients, and shows fallback results (§6.6) with the LLM's reason for each (e.g. "Le Chalet: likely serves raclette").
9. "Race again" starts a new pick at the same address.
10. The picked restaurant is saved as `PICKED`. After eating there, press **"We went here"** → `VISITED`, and its country counts as visited. **"Skip"** puts it back to `null`.
11. A **Passport** page lists every country in the pool as visited/not visited, with a progress count. A **History** page lists every status change (which restaurant, when, which country).
12. Map pins are coloured by status: new, picked, visited.

## 4. Architecture

```
Browser (MapLibre GL JS SPA)
   │  HTTPS, x-api-key header
CloudFront ── /        → S3 (static site, private, OAC)
           └─ /api/*   → API Gateway HTTP API → Lambda `api` (Rust)
                                                  │ start execution / read state
                                                  ▼
                              Step Functions (Standard) "pick workflow"
                                 FindRace → AssignCountries → WaitUntilStart
                                 → loop { Wait 60s → CheckResult } (timeout)
                                 → ResolveWinner → FindRestaurants
                                 → [none] FallbackSearch → PickRestaurant
                                 each step = Rust Lambda; state saved in DynamoDB
                                 FindRestaurants / FallbackSearch ──► Amazon Bedrock (Converse API)
DynamoDB table `fat-horses` (single table, on-demand, point-in-time recovery on; see §6.9)
SSM Parameter Store (SecureString): api key
```

**Why Step Functions instead of one long Lambda:** Lambda has a hard 15-minute limit, and races are often late or delayed. A Lambda that sits waiting also bills for every second of idle time. Step Functions `Wait` states cost nothing while waiting, survive delays, and make each step a short, testable Rust function. The Rust code still runs on Lambda, as the user asked.

**Frontend updates:** poll `GET /api/picks/{id}` every 5 s. This is simpler than WebSockets and fine for a single user.

## 5. Open-source / external services

| Need | Choice | Notes |
|---|---|---|
| Map rendering | MapLibre GL JS (BSD) | |
| Map tiles | OpenFreeMap (OSM data, free, no key) | Could self-host a Protomaps PMTiles file on S3 later |
| Geocoding | Nominatim (OSM) | Called from the backend with a proper User-Agent; at most 1 request/s; cache results in DynamoDB |
| Restaurant search | Overpass API (OSM) | **All** `amenity=restaurant` (+ `fast_food`/`cafe`, configurable) inside the radius, tagged or not; untagged ones go to the classifier |
| Race data | TAB NZ public JSON endpoints used by its website | Exact endpoints and terms of use confirmed in the spike (§8 M1) |
| Country population | World Bank / UN WPP open data | Snapshot committed to `data/countries.json` with its source and year |
| Cuisine guessing + fallback matching | Amazon Bedrock, small Claude model (e.g. Claude Haiku 4.5) via the Converse API | Paid per token, billed through AWS; the only non-open-source runtime part. Model access, region/cross-region inference and cost are confirmed in the spike (§8 M1) |

## 6. Domain rules (→ SPEC.md)

6.1 **Country pool:** countries with population ≥ threshold (default 10,000,000; roughly 90 countries). By default, **countries already visited are left out** (a toggle can include them). If every country in the pool has been visited, show "world complete" and use the whole pool again. Data file fields: ISO code, name, flag emoji, population, OSM cuisine tags, signature dishes/ingredients.

6.2 **Country → cuisine mapping:** curated in `data/countries.json`. Example: Japan → `japanese, sushi, ramen, udon, yakitori, izakaya`; Switzerland → `swiss, fondue, raclette`. OSM `cuisine` values are `;`-separated and matched case-insensitively. The dish/ingredient list per country is drafted once at development time (by Claude Code, not Bedrock) and reviewed by hand; it is committed data, not generated at runtime.

6.3 **Race selection:** the next **gallops** race (no harness or greyhound racing) on TAB NZ that starts between **2 and 15 minutes** from now. If none, take the next one after that and show its start time. Runners marked scratched are excluded.

6.4 **Assignment:** with N active runners, sample N **distinct** countries uniformly at random from the pool, one per runner. If N is larger than the pool, repeat countries only then. A horse scratched after assignment takes its country out of the race.

6.5 **Winner:** the horse placed 1st in the official result (the interim result is accepted if no official result appears within 10 minutes). **Dead heat:** pick at random among the tied winners. **Race abandoned or no result 45 minutes after the scheduled start:** pick at random from the assigned countries, and label the pick "race abandoned — random pick".

6.6 **Restaurant search:** fetch all places within the radius from Overpass, then match in three tiers. Each result carries `match: tagged | inferred | fallback` and, for the last two, a one-line `reason`.
1. **Tagged:** the OSM `cuisine` tag matches the country's cuisine tags (§6.2). No LLM.
2. **Inferred:** places **without** a `cuisine` tag get a guessed cuisine from the classifier (§6.11), based on name and other OSM tags (e.g. "Sakura Sushi" → `japanese`, confidence 0.9). Guesses at or above a confidence threshold (default 0.7) count as matches, shown as "likely". Guesses are cached per place (§6.9), so each place is classified once.
3. **Fallback** (only when tiers 1–2 find nothing; the country is still shown): the classifier gets every nearby place plus the country's dishes and ingredients and returns the places likely to serve them, each with a reason (e.g. "Cheese Bar: likely has Gruyère").
4. If still nothing, show "no match nearby" with the dish list and the "Race again" button.

Show **all** matches from the tier that produced results as pins. If Bedrock fails or times out, continue with tier 1 only and note "cuisine guessing unavailable" on the page; a pick never fails because of the LLM.
- Open question for SPEC: should the fallback also widen the radius (e.g. to 1 km)?

6.7 **The pick:** uniform random choice among the found restaurants (tiers 1 and 2 together; fallback results only if there are none). The LLM never takes part in the pick. Restaurants never visited are preferred; visited ones are picked only if nothing else matches. The random number generator is injected so that tests can seed it.

6.8 **Restaurant status** (state machine in `crates/domain`, fully unit-tested):

| From | Event | To |
|---|---|---|
| `null` | the app picks it | `PICKED` |
| `PICKED` | user presses "We went here" | `VISITED` |
| `PICKED` | user presses "Skip", or a newer pick finishes while it is still `PICKED` | `null` |
| `null` | user marks it visited from the map (went without a race) | `VISITED` |
| `VISITED` | picked again later | stays `VISITED`; the new visit is logged |

At most one restaurant is `PICKED` at a time. Every transition writes a log entry. A country becomes **visited** when any of its restaurants reaches `VISITED`. Fallback results (§6.6) count toward the winning country.

6.9 **Data model: DynamoDB single table `fat-horses`** (partition key `pk`, sort key `sk`):

| Item | pk | sk | Attributes |
|---|---|---|---|
| Restaurant | `RESTAURANT#<source>:<id>` (e.g. `osm:node/123`) | `META` | name, lat, lon, address, cuisine tags, country ISO code, status (absent = `null`), picked_at, visited_at, visit_count |
| Country | `COUNTRY#<iso>` | `META` | visit_count, first_visited_at, last_visited_at |
| Log entry | `LOG` | `<ISO timestamp>#<restaurant id>` | from, to, country, restaurant name, pick_id |
| Pick session | `PICK#<pick_id>` | `META` | workflow status, race card, winner, results, the pick; TTL 30 days |
| Cuisine guess | `PLACE#<source>:<id>` | `GUESS#<prompt_version>` | cuisines [{tag, confidence}], reason, model_id, input_hash (name + tags; guess again when it changes), created_at; TTL 180 days |

- A status change updates the restaurant, the country and the log **in one `TransactWriteItems`** call, so they can't disagree. A condition on the current status rejects stale or double updates.
- The History page = query `pk = LOG`, newest first. The Passport page = query all `COUNTRY#` items and join them with `data/countries.json` in the API.
- Only restaurants that were ever picked or visited are stored. Search results stay in the pick session, not as separate rows.
- The storage trait (`VisitStore`) lives in `crates/domain`; the DynamoDB implementation lives in `crates/store`. An in-memory implementation is used in tests and the CLI; DynamoDB Local (docker) is used for an optional integration test.

6.10 **API**

| Method | Path | Body / response |
|---|---|---|
| `POST` | `/api/picks` | `{address \| {lat,lon}, radius_m?=200, min_population?=10000000}` → `{pick_id}` |
| `GET` | `/api/picks/{id}` | `{status, location, race{venue, number, start_time, runners[{no, name, country, scratched}]}, winner?, restaurants[{…, status, match, reason?}], pick?, fallback?, llm_unavailable?}` |
| `POST` | `/api/restaurants/{id}/visit` | → `VISITED` (from `PICKED` or `null`; the body carries restaurant details when it was `null`) |
| `POST` | `/api/restaurants/{id}/skip` | `PICKED` → `null` |
| `GET` | `/api/countries` | pool with `visited`, `visit_count`, `last_visited_at` |
| `GET` | `/api/history?cursor=` | log entries, newest first, paginated |

`POST /api/picks` also takes `include_visited?=false`.

Statuses: `finding_race`, `waiting_start`, `running`, `resolving`, `searching`, `done`, `failed`.

Every request needs the `x-api-key` header, compared against SSM in constant time. API Gateway throttling is set low (e.g. 5 requests/s).

6.11 **LLM usage rules (Bedrock)**
- **Interface:** a `Classifier` trait in `crates/domain` with two operations: `guess_cuisines(places) → [{place_id, cuisines[{tag, confidence}], reason}]` and `match_dishes(places, country_dishes) → [{place_id, reason}]`. Implementations: `BedrockClassifier` (real) and `FakeClassifier` (deterministic, for tests and offline CLI runs). `make check` never calls Bedrock.
- **Input:** only public OSM data (name, tags, website/menu URLs if tagged) and the country's dish list. Never the user's address, history or API key.
- **Output:** JSON checked against a schema. Every `place_id` must come from the input and every cuisine tag from the known tag list; anything else is dropped. Invalid JSON gets one retry, then the tier is treated as "unavailable".
- **Batching and limits:** one call per batch of up to ~50 places; a hard cap on places per pick (e.g. 200) and on tokens per call; a Lambda timeout for each call.
- **Prompts** are versioned files in the repo (`crates/classify/prompts/*.md`). The version is part of the cache key, so changing a prompt refreshes guesses.
- **Model** is configured by an environment variable (model ID or inference profile ARN), so switching models needs no code change.
- **Evaluation:** a small labelled set of real nearby places (from the M1 spike) with an `eval` CLI command that reports accuracy for a model/prompt. Run by hand, not in `make check`.

## 7. Code layout

```
Cargo.toml                 workspace
crates/domain/             pure logic: pool filter, assignment, winner, cuisine match, pick (no I/O)
crates/race/               RaceProvider trait + TabNz impl (reqwest), JSON fixtures in tests
crates/places/             Geocoder (Nominatim), Places (Overpass) traits + impls
crates/classify/           BedrockClassifier + FakeClassifier, prompts/, eval fixtures
crates/store/              VisitStore + pick-session store on DynamoDB (aws-sdk-dynamodb)
crates/lambdas/            one binary per handler (lambda_runtime); thin wiring only
crates/cli/                `fat-horses pick "<address>"`: runs the whole flow locally, polling in-process
data/countries.json
web/                       Vite + TypeScript + MapLibre
infra/                     Terraform (S3 backend with native lock file; modules: site, api, workflow, data)
docs/PLAN.md
```

The current `src/main.rs` becomes `crates/cli`. The CLI makes every step runnable and testable without AWS, which suits the verification loop.

Suggested crates (added with `cargo add`, as `CLAUDE.md` requires): `tokio`, `reqwest` (rustls), `serde`/`serde_json`, `rand`, `chrono`, `thiserror`, `lambda_runtime`, `lambda_http`, `aws-sdk-dynamodb`, `aws-sdk-sfn`, `aws-sdk-ssm`, `aws-sdk-bedrockruntime`, `tracing`. Build with `cargo-lambda` for arm64 (`provided.al2023`).

## 8. Milestones (→ TASKS.md)

- **M0 Harness:** initial commit; convert to a workspace; extend `make check` with `terraform fmt -check` + `terraform validate` and web lint/typecheck/test once those folders exist.
- **M1 Spikes (timeboxed; each writes findings into `docs/`):**
  - TAB NZ: endpoints for meetings, race card and results; how scratchings, dead heats and abandonments appear; terms of use. Save sample JSON as fixtures.
  - Overpass: cuisine-tag coverage around the user's usual areas; save real place lists as fixtures and as the start of the classifier eval set.
  - Bedrock: enable model access; confirm the model is available in the chosen region (or through a cross-region inference profile); run a few real place lists through a draft prompt; note quality, latency and cost per pick.
- **M2 Domain:** `data/countries.json` + `crates/domain` covering §6.1–6.7, with seeded-RNG unit tests (distinct assignment, scratchings, dead heat, abandoned race, empty results).
- **M3 Adapters:** TabNz, Nominatim and Overpass clients, tested against recorded fixtures (no network in `make check`).
- **M3b Visit tracking:** the §6.8 state machine and pool exclusion in `crates/domain`; `crates/store` DynamoDB implementation with transactional status changes; in-memory store for tests.
- **M3c Classifier:** `Classifier` trait + `FakeClassifier`; `crates/classify` Bedrock implementation with output validation, batching and guess caching (§6.11, §6.9); tiers 1–2 of §6.6; `eval` CLI command.
- **M4 Local end-to-end:** `crates/cli` runs a real pick against live services; `fat-horses visit <id>`, `skip <id>`, `passport`, `history` subcommands use a local store (JSON file or DynamoDB Local).
- **M5 Web UI:** map, address form, race card, status polling, pins coloured by status + highlighted pick, "We went here"/"Skip" buttons, Passport and History pages; runs locally against `cargo lambda watch`.
- **M6 Infra:** Terraform for S3/CloudFront, API Gateway, Lambdas, Step Functions, the DynamoDB table (on-demand, point-in-time recovery, TTL on `ttl`), SSM, IAM (least privilege, including `bedrock:InvokeModel` on the one configured model/profile only), budget alarm covering Bedrock; `make deploy`.
- **M7 Fallback:** the LLM dish/ingredient matching tier (§6.6 tier 3) and its UI (reasons, "likely" labels).
- **M8 Polish:** geocode cache, error states, mobile layout, logs/alarms.

## 9. Risks
- **TAB NZ endpoints are undocumented** and may change or forbid automated use → keep everything behind `RaceProvider`, record fixtures, and keep a fallback (§6.5).
- **Sparse OSM cuisine tags** → LLM cuisine guessing for untagged places, the LLM fallback, and a curated tag list per country.
- **Wrong LLM guesses** → shown as "likely" with a reason, never mixed silently with tagged matches; confidence threshold; eval set to compare prompts/models.
- **Bedrock outage, throttling or model retirement** → tier 1 always works without it; the model ID is configuration.
- **Nominatim/Overpass usage policies** → low volume, caching, a User-Agent that identifies the app; could move to a paid/self-hosted instance later.
- **Cost** → all serverless on-demand; expected to be a few dollars a month. Bedrock cost is kept down by caching guesses and capping places/tokens per pick; the spike measures cost per pick. An AWS Budgets alarm is set in M6.

## 10. Open questions for SPEC.md
- AWS region: `ap-southeast-2` (Sydney) or the NZ region.
- Should `fast_food` and `cafe` count as restaurants?
- Should the fallback also widen the radius?
- Should results link to Google Maps or OSM for directions?
- Should an unvisited `PICKED` restaurant go back to `null` automatically after some time (e.g. 7 days), or stay until the next pick?
- Should a visit store a note or rating? (It is easy to add to the log entry later.)
- Confidence threshold for "likely" matches (default 0.7), to tune with the eval set.
- Add a short LLM "what to order" line for the picked restaurant? (Cheap, optional, post-v1.)
