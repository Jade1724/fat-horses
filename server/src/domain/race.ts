// Races and race selection (SPEC.md F3).

import { HOUR, MINUTE, ms, type Iso } from "./time";
import type { Placing, ResultSnapshot } from "./winner";

/** A race must start at least this long after now (F3.2). */
export const MIN_LEAD_MS = 2 * MINUTE;
/** Races starting later than this after now are not considered (F3.2). */
export const MAX_LEAD_MS = 3 * HOUR;
/** Default and allowed maximum wait for a race to start, in minutes (F1.1, F3.2). */
export const DEFAULT_MAX_WAIT_MIN = 10;
export const MAX_WAIT_MIN_RANGE = [5, 180] as const;
/** A race needs at least this many non-scratched runners (F3.3). */
export const MIN_RUNNERS = 2;

export type RaceType = "gallops" | "harness" | "greyhound";
export type RaceStatus = "open" | "closed" | "interim" | "final" | "abandoned";

export interface Runner {
  number: number;
  name: string;
  scratched: boolean;
}

/** A race as listed by the source. `runners` is empty until details are fetched. */
export interface Race {
  id: string;
  meeting_id: string;
  venue: string;
  /** Country of the venue as the source gives it (e.g. "AUS", "NZ"). */
  venue_country: string;
  race_number: number;
  name: string;
  race_type: RaceType;
  status: RaceStatus;
  start_time: Iso;
  runners: Runner[];
  /** The race's page on the source's website, where it can be watched (F10.4). */
  url?: string;
}

/** A fresh look at one race: status, runners (with scratchings), placings. */
export interface RaceUpdate {
  race: Race;
  /** Empty until there is an interim or final result. */
  placings: Placing[];
}

export function snapshot(u: RaceUpdate): ResultSnapshot {
  return { status: u.race.status, placings: u.placings };
}

export interface RaceProvider {
  /** Races scheduled from now to at least now + MAX_LEAD, without runners. */
  schedule(now: Iso): Promise<Race[]>;
  /** The current state of `race`, with runners. */
  update(race: Race): Promise<RaceUpdate>;
}

export function activeRunners(race: Race): Runner[] {
  return race.runners.filter((r) => !r.scratched);
}

/** Enough non-scratched runners to race for a country (F3.3). */
export function hasEnoughRunners(race: Race): boolean {
  return activeRunners(race).length >= MIN_RUNNERS;
}

/**
 * Races that may be chosen, in the order to try them (F3.2): open gallops
 * races starting in [now + 2 min, now + maxLead], earliest first. The caller
 * fetches runners for each in turn and takes the first with enough runners.
 */
export function candidates(races: readonly Race[], now: Iso, maxLeadMs = MAX_LEAD_MS): Race[] {
  const t = ms(now);
  return races
    .filter((r) => r.race_type === "gallops" && r.status === "open")
    .filter((r) => ms(r.start_time) >= t + MIN_LEAD_MS && ms(r.start_time) <= t + maxLeadMs)
    .sort((a, b) => ms(a.start_time) - ms(b.start_time) || a.id.localeCompare(b.id));
}

/** The race to use when runners are already known (F3). */
export function selectRace(races: readonly Race[], now: Iso, maxLeadMs = MAX_LEAD_MS): Race | undefined {
  return candidates(races, now, maxLeadMs).find(hasEnoughRunners);
}
