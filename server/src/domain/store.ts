// Storage interfaces (SPEC.md §4.2) and the visit operations built on them (F8).

import type { Guess } from "./classify";
import type { Location } from "./places";
import type { PickSession } from "./session";
import { applyEvent, type Event, type LogEntry, type Restaurant, type Transition } from "./status";
import { DAY, ms, type Iso } from "./time";

export const GEOCODE_TTL_MS = 30 * DAY;
export const GUESS_TTL_MS = 180 * DAY;
export const PICK_TTL_MS = 30 * DAY;
export const HISTORY_PAGE = 50;

/** A condition failed: the data changed since it was read (F8.7). */
export class ConflictError extends Error {
  constructor() {
    super("conflict: the data changed since it was read");
  }
}

export class NotFoundError extends Error {
  constructor(what = "not found") {
    super(what);
  }
}

/** Transitions written together, all or nothing (F8.7). */
export interface Change {
  transitions: Transition[];
  /** The id the store must currently hold as the one PICKED restaurant (F8.3). */
  expected_picked: string | null;
}

export interface CountryVisits {
  iso2: string;
  visit_count: number;
  first_visited_at: Iso | null;
  last_visited_at: Iso | null;
}

export interface HistoryPage {
  /** Newest first. */
  entries: LogEntry[];
  next_cursor: string | null;
}

export interface CachedGuess {
  guess: Guess;
  prompt_version: number;
  /** SHA-256 of the place's name and sorted tags (L6). */
  input_hash: string;
  model_id: string;
  created_at: Iso;
}

export interface CachedLocation {
  location: Location;
  created_at: Iso;
}

/** Everything the app stores. */
export interface Store {
  getRestaurant(id: string): Promise<Restaurant | null>;
  currentlyPicked(): Promise<Restaurant | null>;
  /**
   * Write every transition atomically, or nothing. Throws ConflictError if any
   * restaurant's stored status differs from its `expected_status` or the PICKED
   * pointer differs from `expected_picked`. Keeps the PICKED pointer, updates
   * country visit counts and appends the log entries.
   */
  apply(change: Change): Promise<void>;
  countryVisits(): Promise<CountryVisits[]>;
  /** Newest first; `cursor` is a previous page's `next_cursor`. */
  history(cursor: string | null, limit: number): Promise<HistoryPage>;

  getPick(pickId: string): Promise<PickSession | null>;
  putPick(session: PickSession): Promise<void>;

  getGuess(placeId: string, promptVersion: number): Promise<CachedGuess | null>;
  putGuess(guess: CachedGuess): Promise<void>;

  /** `key` is `normaliseAddress` of the address. */
  getGeocode(key: string): Promise<CachedLocation | null>;
  putGeocode(key: string, value: CachedLocation): Promise<void>;
}

export class StoreUnavailable extends Error {}

export function isFresh(createdAt: Iso, ttlMs: number, now: Iso): boolean {
  return ms(now) - ms(createdAt) < ttlMs;
}

/** The PICKED pointer after `change`, for store implementations. */
export function pickedAfter(change: Change): string | null {
  const nowPicked = change.transitions.find((t) => t.restaurant.status === "PICKED");
  if (nowPicked) return nowPicked.restaurant.id;
  const old = change.expected_picked;
  if (old !== null && change.transitions.some((t) => t.restaurant.id === old)) return null;
  return old;
}

/** History sort key: `<ISO µs timestamp>#<restaurant id>#<reason>` (§4.2). */
export function logKey(entry: LogEntry): string {
  // JS dates have millisecond precision; pad to microseconds to keep the §4.2 format.
  const at = new Date(entry.at).toISOString().replace("Z", "000Z");
  return `${at}#${entry.restaurant_id}#${entry.reason}`;
}

/**
 * Record that a pick chose `candidate` (F7.4, F8.2): supersede any other PICKED
 * restaurant and mark this one PICKED, atomically. A stored record's status and
 * visit count win over the candidate's.
 */
export async function recordPick(
  store: Store,
  candidate: Restaurant,
  pickId: string,
  now: Iso,
): Promise<Restaurant> {
  const currentPicked = await store.currentlyPicked();
  const stored = await store.getRestaurant(candidate.id);
  const base: Restaurant = stored
    ? {
        ...candidate,
        status: stored.status,
        status_before_pick: stored.status_before_pick,
        picked_at: stored.picked_at,
        visited_at: stored.visited_at,
        visit_count: stored.visit_count,
        pick_id: stored.pick_id,
      }
    : candidate;
  const transitions: Transition[] = [];
  if (currentPicked && currentPicked.id !== base.id) {
    transitions.push(applyEvent(currentPicked, { kind: "supersede" }, now));
  }
  const pick = applyEvent(base, { kind: "pick", pick_id: pickId }, now);
  transitions.push(pick);
  await store.apply({ transitions, expected_picked: currentPicked?.id ?? null });
  return pick.restaurant;
}

/** "We went here" (F8.2). `details` is required if the restaurant isn't stored. */
export async function recordVisit(
  store: Store,
  id: string,
  details: Restaurant | null,
  now: Iso,
): Promise<Restaurant> {
  const current = (await store.getRestaurant(id)) ?? details;
  if (!current) throw new NotFoundError(`restaurant ${id} not found`);
  return changeOne(store, current, { kind: "visit" }, now);
}

/** "Skip" (F8.2). */
export async function recordSkip(store: Store, id: string, now: Iso): Promise<Restaurant> {
  const current = await store.getRestaurant(id);
  if (!current) throw new NotFoundError(`restaurant ${id} not found`);
  return changeOne(store, current, { kind: "skip" }, now);
}

async function changeOne(store: Store, current: Restaurant, event: Event, now: Iso): Promise<Restaurant> {
  const expectedPicked = (await store.currentlyPicked())?.id ?? null;
  const t = applyEvent(current, event, now);
  await store.apply({ transitions: [t], expected_picked: expectedPicked });
  return t.restaurant;
}
