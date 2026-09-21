// The pick workflow (SPEC.md §6). Each step takes a session and returns it
// updated; Step Functions runs them one per Lambda call, the CLI via `runPick`.

import { applyScratchings, assign, EmptyPoolError } from "../domain/assign";
import { placeInput, type Classifier } from "../domain/classify";
import type { Countries } from "../domain/countries";
import { guessUntagged, MAX_PLACES, type GuessConfig } from "../domain/guessing";
import { chooseRestaurant, DEFAULT_CONFIDENCE_THRESHOLD, primaryMatches, type Match } from "../domain/matching";
import { DEFAULT_AMENITIES, type Place, type Places } from "../domain/places";
import { pool } from "../domain/pool";
import { candidates, hasEnoughRunners, snapshot, type RaceProvider } from "../domain/race";
import type { Rng } from "../domain/rng";
import { failed, type PickSession } from "../domain/session";
import type { Restaurant } from "../domain/status";
import { NotFoundError, recordPick, type Store } from "../domain/store";
import { addMs, ms, MINUTE, type Iso } from "../domain/time";
import { resolve, type ResultSnapshot } from "../domain/winner";
import { log } from "../log";

/** Poll interval for results (F5.1). */
export const POLL_INTERVAL_MS = MINUTE;

export interface Config {
  amenities: string[];
  confidence_threshold: number;
  guess: GuessConfig;
}

export const defaultConfig = (): Config => ({
  amenities: [...DEFAULT_AMENITIES],
  confidence_threshold: DEFAULT_CONFIDENCE_THRESHOLD,
  guess: { prompt_version: 1, model_id: "none" },
});

export interface Deps {
  races: RaceProvider;
  places: Places;
  classifier: Classifier;
  store: Store;
  countries: Countries;
  config: Config;
}

/** Step 1: choose the race (F3). */
export async function findRace(deps: Deps, s: PickSession, now: Iso): Promise<PickSession> {
  let schedule;
  try {
    schedule = await deps.races.schedule(now);
  } catch (e) {
    log.warn("race schedule unavailable", { pick_id: s.pick_id, error: String(e) });
    return failed(s, "race_source_unavailable");
  }
  for (const race of candidates(schedule, now)) {
    try {
      const u = await deps.races.update(race);
      if (u.race.status === "open" && hasEnoughRunners(u.race)) return { ...s, race: u.race };
    } catch (e) {
      log.warn("race card unavailable", { pick_id: s.pick_id, race: race.id, error: String(e) });
    }
  }
  return failed(s, "no_upcoming_race");
}

/** Step 2: build the pool and draw countries (F2, F4). Sets `waiting_start`. */
export async function assignCountries(deps: Deps, s: PickSession, rng: Rng): Promise<PickSession> {
  if (!s.race) return failed(s, "internal");
  const visited = new Set((await deps.store.countryVisits()).filter((c) => c.visit_count > 0).map((c) => c.iso2));
  const p = pool(deps.countries.all, s.request.min_population, visited, s.request.include_visited);
  try {
    return { ...s, card: assign(s.race.runners, p, rng), world_complete: p.world_complete, status: "waiting_start" };
  } catch (e) {
    if (e instanceof EmptyPoolError) return failed(s, "internal");
    throw e;
  }
}

/**
 * Step 3: fetch nearby places and guess cuisines for untagged ones (F6.1, F6.3)
 * while the race hasn't started (F6.4). A failed lookup leaves `places_loaded`
 * false; `ensurePlaces` retries it after the race.
 */
export async function prepareNearby(deps: Deps, s: PickSession, now: Iso): Promise<PickSession> {
  let places: Place[];
  try {
    places = await deps.places.nearby(s.location.lat, s.location.lon, s.request.radius_m, deps.config.amenities);
  } catch (e) {
    log.warn("places unavailable; will retry after the race", { pick_id: s.pick_id, error: String(e) });
    return s;
  }
  const out = await guessUntagged(places, deps.classifier, deps.store, deps.config.guess, now);
  return {
    ...s,
    places,
    places_loaded: true,
    guesses: out.guesses,
    llm_unavailable: s.llm_unavailable || out.llm_unavailable,
  };
}

/** Before matching: retry the places lookup if needed; fail if it still fails. */
export async function ensurePlaces(deps: Deps, s: PickSession, now: Iso): Promise<PickSession> {
  if (s.places_loaded) return s;
  const next = await prepareNearby(deps, s, now);
  return next.places_loaded ? next : failed(next, "places_unavailable");
}

/** Step 4: poll the race once (F5). Sets `resolving` when a winner is decided. */
export async function checkResult(deps: Deps, s: PickSession, now: Iso, rng: Rng): Promise<PickSession> {
  if (!s.race || !s.card) return failed(s, "internal");
  let next: PickSession = { ...s };
  let snap: ResultSnapshot | null = null;
  try {
    const u = await deps.races.update(s.race);
    next.card = applyScratchings(s.card, u.race.runners);
    next.race = u.race;
    snap = snapshot(u);
  } catch (e) {
    log.warn("result check failed; will retry", { pick_id: s.pick_id, error: String(e) });
  }
  if (snap) {
    if (snap.status === "interim") {
      if (JSON.stringify(snap.placings) !== JSON.stringify(s.interim_placings) || s.interim_since === null) {
        next = { ...next, interim_placings: snap.placings, interim_since: now };
      }
    } else {
      next = { ...next, interim_placings: [], interim_since: null };
    }
  }
  const start = s.race.start_time;
  if (ms(now) >= ms(start) && next.status === "waiting_start") next.status = "running";
  const winner = resolve(next.card ?? s.card, snap, start, now, next.interim_since, rng);
  return winner ? { ...next, winner, status: "resolving" } : next;
}

/** Step 5: tiers 1–2 (F6.2–F6.4). Sets `searching`. */
export function matchRestaurants(deps: Deps, s: PickSession): PickSession {
  const country = s.winner ? deps.countries.get(s.winner.country_iso) : undefined;
  if (!country) return failed(s, "internal");
  return {
    ...s,
    status: "searching",
    matches: primaryMatches(s.places, s.guesses, country, deps.config.confidence_threshold),
  };
}

/** Step 6: tier 3, only without primary matches (F6.5, F6.8). */
export async function fallbackMatch(deps: Deps, s: PickSession): Promise<PickSession> {
  if (s.matches.length > 0 || s.places.length === 0) return s;
  const country = s.winner ? deps.countries.get(s.winner.country_iso) : undefined;
  if (!country) return failed(s, "internal");
  try {
    const found = await deps.classifier.matchDishes(s.places.slice(0, MAX_PLACES).map(placeInput), {
      name: country.name,
      dishes: country.dishes,
    });
    return { ...s, matches: found.map((m) => ({ place_id: m.place_id, match: "fallback", reason: m.reason })) };
  } catch (e) {
    log.warn("dish matching failed", { pick_id: s.pick_id, error: String(e) });
    return { ...s, llm_unavailable: true };
  }
}

/** The stored restaurant for a matched place. */
export function restaurantFrom(p: Place, countryIso: string, m: Match): Restaurant {
  return {
    id: p.id,
    name: p.name,
    lat: p.lat,
    lon: p.lon,
    address: p.address,
    cuisine: p.cuisine,
    country_iso: countryIso,
    status: null,
    status_before_pick: null,
    picked_at: null,
    visited_at: null,
    visit_count: 0,
    pick_id: null,
    match: m.match,
    reason: m.reason,
  };
}

/** Step 7: choose the restaurant and mark it PICKED (F7, F8). Sets `done`. */
export async function pickRestaurant(deps: Deps, s: PickSession, now: Iso, rng: Rng): Promise<PickSession> {
  if (!s.winner) return failed(s, "internal");
  const counts = new Map<string, number>();
  for (const m of s.matches) counts.set(m.place_id, (await deps.store.getRestaurant(m.place_id))?.visit_count ?? 0);
  const primary = s.matches.filter((m) => m.match !== "fallback");
  const fallback = s.matches.filter((m) => m.match === "fallback");
  const chosen = chooseRestaurant(primary, fallback, (id) => counts.get(id) ?? 0, rng);
  const place = chosen && s.places.find((p) => p.id === chosen.place_id);
  if (chosen && place) {
    await recordPick(deps.store, restaurantFrom(place, s.winner.country_iso, chosen), s.pick_id, now);
    return { ...s, pick: chosen.place_id, status: "done" };
  }
  return { ...s, status: "done" };
}

/** Time source for `runPick`; tests use one that jumps instead of sleeping. */
export interface Clock {
  now(): Iso;
  sleepUntil(t: Iso): Promise<void>;
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
  sleepUntil: (t) => new Promise((r) => setTimeout(r, Math.max(0, ms(t) - Date.now()))),
};

/** Run a whole pick in-process (CLI, local server, tests), saving after every step. */
export async function runPick(
  deps: Deps,
  session: PickSession,
  clock: Clock,
  rng: Rng,
  onUpdate: (s: PickSession) => void = () => {},
): Promise<PickSession> {
  let s = session;
  const save = async () => {
    await deps.store.putPick(s);
    onUpdate(s);
    return s.status === "failed";
  };
  if (await save()) return s;
  s = await findRace(deps, s, clock.now());
  if (await save()) return s;
  s = await assignCountries(deps, s, rng);
  if (await save()) return s;
  s = await prepareNearby(deps, s, clock.now());
  if (await save()) return s;
  if (s.race) await clock.sleepUntil(s.race.start_time);
  for (;;) {
    s = await checkResult(deps, s, clock.now(), rng);
    if (await save()) return s;
    if (s.winner) break;
    await clock.sleepUntil(addMs(clock.now(), POLL_INTERVAL_MS));
  }
  s = await ensurePlaces(deps, s, clock.now());
  if (await save()) return s;
  s = await fallbackMatch(deps, matchRestaurants(deps, s));
  if (await save()) return s;
  s = await pickRestaurant(deps, s, clock.now(), rng);
  await save();
  return s;
}

/** One Step Functions task (§6): start → prepare_nearby → wait → check_result (loop) → finish. */
export type Step = "start" | "prepare_nearby" | "check_result" | "finish";

export interface StepOutput {
  pick_id: string;
  status: PickSession["status"];
  /** The scheduled start, for the Wait state. */
  start_time: Iso | null;
  /** A winner is decided; go to `finish`. */
  decided: boolean;
  /** The pick has failed; stop. */
  failed: boolean;
}

function output(s: PickSession): StepOutput {
  return {
    pick_id: s.pick_id,
    status: s.status,
    start_time: s.race?.start_time ?? null,
    decided: s.winner !== null,
    failed: s.status === "failed",
  };
}

/** Load the session, run one step, save it. Safe to retry: finished work is skipped. */
export async function runStep(deps: Deps, step: Step, pickId: string, now: Iso, rng: Rng): Promise<StepOutput> {
  let s = await deps.store.getPick(pickId);
  if (!s) throw new NotFoundError(`pick ${pickId} not found`);
  if (s.status === "failed" || s.status === "done") return output(s);
  if (step === "start" && !s.card) {
    s = await findRace(deps, s, now);
    if (s.status !== "failed") s = await assignCountries(deps, s, rng);
  } else if (step === "prepare_nearby" && !s.places_loaded) {
    s = await prepareNearby(deps, s, now);
  } else if (step === "check_result" && !s.winner) {
    s = await checkResult(deps, s, now, rng);
  } else if (step === "finish") {
    s = await ensurePlaces(deps, s, now);
    if (s.status !== "failed") s = await pickRestaurant(deps, await fallbackMatch(deps, matchRestaurants(deps, s)), now, rng);
  }
  await deps.store.putPick(s);
  return output(s);
}
