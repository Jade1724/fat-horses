# Spike: TAB NZ race data (T1.1)

Date: 2026-09-21. Result: **usable**, pending the owner's review of the terms (T1.2).

## Source

TAB NZ's **Affiliates API**, `https://api.tab.co.nz/affiliates/v1/` (documentation page at the same URL).
Public JSON over HTTPS, no login, no TAB account needed. It covers NZ, Australian and international
thoroughbred, harness and greyhound racing, so there are usually several gallops races an hour.

## Terms of use (read by the owner in T1.2)

From the API documentation page:

> These endpoints are for personal use only and are not to be republished without written permission
> from Entain Australia and New Zealand.

- Terms of service linked from the docs: https://entaingroup.com.au/terms-of-use/
- The docs ask callers to identify themselves with headers: `From: <your email>`, `X-Partner: <company>`,
  `X-Partner-ID: <id issued by Entain>`. Calls without them work today. The client sends them when the
  env vars `TAB_FROM`, `TAB_PARTNER` and `TAB_PARTNER_ID` are set, and always sends a descriptive
  `User-Agent`. **Owner decision:** whether to set `TAB_FROM` to your email.
- No documented rate limit. We poll one race once a minute plus a handful of schedule calls per pick.
- "Beta" endpoints may change; the schema is "open" (unknown fields may appear, so parse leniently).

fat-horses is a private, single-user app that shows a race card to its owner: that looks like
personal use. It must not become a public site showing TAB data without permission.

## Endpoints used

| Purpose | Call | Notes |
|---|---|---|
| Schedule | `GET /racing/meetings?date_from=<YYYY-MM-DD>&date_to=<same>` | Dates are **NZ race days** (`tote_raceday_date`). Fetch today and tomorrow (NZ) to cover 3 hours ahead. ~150 KB. |
| One meeting | `GET /racing/meetings/{meeting_id}` | Race statuses for the meeting, including `Abandoned`. |
| Race card / result | `GET /racing/events/{race_id}` | Runners with scratchings; `results` once `Interim`/`Final`. ~60 KB. |

`/racing/list?date_from=now` exists but has no race type, and filtering it by `meet_types` returned
HTTP 500, so we use `meetings`.

## Race page on tab.co.nz

`https://www.tab.co.nz/racing/race/<race id>` (the Affiliates API's UUID) opens the race's page with its card,
odds and the Trackside stream (checked in Chromium, 2026-09-22). `/racing/meeting/<id>/race/<id>` redirects to
the racing home page, with either the UUIDs or the older numeric ids.

## Fields we read

Meeting: `meeting` (id), `name`, `category` (`T` thoroughbred = gallops, `H` harness, `G` greyhounds),
`country`, `races[]`.

Race in a meeting: `id`, `race_number`, `name`, `start_time` (UTC, RFC 3339), `status`.

Event (`data.race`): `event_id`, `status`, `advertised_start` (epoch s), `type`, `meeting_name`,
`race_number`, `description`. `data.runners[]`: `runner_number`, `name`, `is_scratched`, `scratch_time`.
`data.results[]` (absent before a result): `position`, `runner_number`, `name`.

## Statuses seen (maps to `RaceStatus`)

| TAB `status` | Meaning | `RaceStatus` |
|---|---|---|
| `Open` | betting open, not started | `Open` |
| `Closed` | started / betting closed, no result | `Closed` |
| `Interim` | provisional placings | `Interim` |
| `Final` | official result | `Final` |
| `Abandoned` | race off (in meeting lists only) | `Abandoned` |

Recorded timeline for Scottsville R1 (SAF, gallops, "Gallop Tv Mdn Plate"), scheduled 10:07 UTC, polled every minute:

| UTC | status | results |
|---|---|---|
| 09:57–10:08 | Open | – |
| 10:09 | Closed | – |
| 10:11 | Interim | 1st only (#5) |
| 10:13 | Interim | 1st–4th (#5, #17, #14, #9) |
| 10:19 | Final | unchanged |

So a result appears ~4 min after the start and turns official ~12 min after it. F5.2's 10-minute interim
grace is rarely needed but harmless.

## How each spec case appears

- **Scratchings (F3.3, F4.4):** `runners[].is_scratched = true` with `scratch_time`. The recorded open race
  had 2 of 18 runners scratched (`event_open_scratched.json`).
- **Abandoned (F5.4):** the meeting shows the race as `Abandoned`, but `GET /racing/events/{id}` returns
  HTTP 200 with `header.error = "race can not be found"`, `error_code = "FR0002"` and no `data`
  (`event_not_found.json`, `meeting_abandoned.json`). So: when the event is not found, read the
  meeting; `Abandoned` there → abandoned. 30 of ~1,700 races over 19–20 Sep were abandoned.
- **Dead heat (F5.3):** none found in 250 finished gallops races checked. Assumed shape: two `results`
  entries with `position: 1`. `event_dead_heat_synthetic.json` is the real final with the 2nd placing
  edited to 1, and is labelled synthetic in its header.
- **Non-gallops (F3.1):** `category` `H`/`G` on the meeting.

## Fixtures (`server/test/fixtures/tab_nz/`)

Real responses, with bulky betting sections we never read (`big_bets`, `live_bets`, `money_tracker`,
`tote_pools`, `derivatives`) removed. `meetings_list.json` is trimmed to 3 meetings per category plus
Scottsville.

| File | Content |
|---|---|
| `meetings_list.json` | schedule for 2026-09-21 |
| `meeting_open.json` | Scottsville before the race |
| `meeting_abandoned.json` | Gore, 2026-09-20, every race `Abandoned` |
| `event_open_scratched.json` | race card, `Open`, 2 scratchings |
| `event_closed.json` | `Closed`, no results |
| `event_interim.json` | `Interim`, 1st only |
| `event_final.json` | `Final` |
| `event_not_found.json` | abandoned race's event lookup |
| `event_dead_heat_synthetic.json` | synthetic dead heat |
