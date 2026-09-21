// Restaurant status and visit tracking (SPEC.md F8).

import type { MatchKind } from "./matching";
import type { Iso } from "./time";

/** null is the spec's `null` (never picked, or skipped). */
export type Status = "PICKED" | "VISITED" | null;

/** A restaurant as stored once picked or visited (§4.2). */
export interface Restaurant {
  id: string;
  name: string;
  lat: number;
  lon: number;
  address: string | null;
  cuisine: string[];
  /** The country a visit credits (F8.4). */
  country_iso: string;
  status: Status;
  /** Status to restore on skip or supersede. */
  status_before_pick: Status;
  picked_at: Iso | null;
  visited_at: Iso | null;
  visit_count: number;
  pick_id: string | null;
  match: MatchKind | null;
  reason: string | null;
}

export type Event = { kind: "pick"; pick_id: string } | { kind: "visit" } | { kind: "skip" } | { kind: "supersede" };

export type LogReason = "picked" | "visited" | "skipped" | "superseded";

/** One history entry (F8.6). */
export interface LogEntry {
  at: Iso;
  restaurant_id: string;
  restaurant_name: string;
  country_iso: string;
  from: Status;
  to: Status;
  reason: LogReason;
  pick_id: string | null;
}

/** Everything one transition changes, written atomically (F8.7). */
export interface Transition {
  restaurant: Restaurant;
  /** The stored status before; stores make the write conditional on it. */
  expected_status: Status;
  /** The country's visit count goes up by one. */
  country_visited: boolean;
  log: LogEntry;
}

export class InvalidTransition extends Error {
  constructor(
    readonly event: string,
    readonly from: Status,
  ) {
    super(`cannot ${event} a restaurant whose status is ${from ?? "null"}`);
  }
}

/**
 * Apply `event` to `current` (F8.2). The caller handles F8.3: before picking a
 * restaurant, supersede any other PICKED one in the same write.
 */
export function applyEvent(current: Restaurant, event: Event, now: Iso): Transition {
  const from = current.status;
  const next: Restaurant = { ...current };
  let reason: LogReason;
  let pickId = current.pick_id;
  let countryVisited = false;
  switch (event.kind) {
    case "pick":
      // Picked again while PICKED keeps the original status_before_pick.
      if (from !== "PICKED") next.status_before_pick = from;
      next.status = "PICKED";
      next.picked_at = now;
      next.pick_id = event.pick_id;
      pickId = event.pick_id;
      reason = "picked";
      break;
    case "visit":
      next.status = "VISITED";
      next.status_before_pick = null;
      next.visited_at = now;
      next.visit_count = current.visit_count + 1;
      countryVisited = true;
      reason = "visited";
      break;
    case "skip":
    case "supersede":
      if (from !== "PICKED") throw new InvalidTransition(event.kind, from);
      next.status = current.status_before_pick;
      next.status_before_pick = null;
      reason = event.kind === "skip" ? "skipped" : "superseded";
      break;
  }
  return {
    restaurant: next,
    expected_status: from,
    country_visited: countryVisited,
    log: {
      at: now,
      restaurant_id: current.id,
      restaurant_name: current.name,
      country_iso: current.country_iso,
      from,
      to: next.status,
      reason,
      pick_id: pickId,
    },
  };
}
