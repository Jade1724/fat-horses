# CLI end-to-end run (T4.2)

## Run 1 — 2026-09-21, by Claude

`fat-horses --store <tmp> pick "Sky Tower, Auckland" --radius 500 --fake-llm`

- Geocoded via Nominatim: "Sky Tower, … Auckland 1010".
- Race: Scottsville R2 (SAF gallops), 10:45 UTC, 18 runners, 3 scratched → 15 countries drawn.
- Overpass returned 504 before the race; the lookup was retried after the result and succeeded
  (this run's binary predates the per-endpoint retries).
- Result: horse 6 won → 🇩🇿 Algeria. No place within 500 m is tagged Algerian (the 500 m sample has
  212 places, none `algerian`/`north_african`/`maghreb`), so the pick ended "No match nearby" with the
  dish list. With `--fake-llm` there are no inferred or fallback matches.
- Exit code 0; session saved in the store.

## Run 2 — 2026-09-21, by Claude, TypeScript CLI

`npm run cli -- --store <tmp> pick "Sky Tower, Auckland" --radius 500 --fake-llm`

- Race: Scottsville R4 (SAF gallops), 11:55 UTC, 10 runners, 2 scratched → 8 countries.
- Places loaded before the race on the first try (after raising Node's per-address connect timeout).
- Result: horse 7 won → 🇳🇵 Nepal. No place within 500 m is tagged Nepalese/Himalayan/momo, so
  "No match nearby" with the dish list is correct. Exit code 0.
- Two bugs found on the way, both fixed: `systemRng` range, and Node's 250 ms happy-eyeballs timeout.

## Still to do

- Owner runs one pick at a real address and confirms (T4.2 done-when).
- Rerun with Bedrock once T3.9 is done, to see tiers 2–3 in action.
