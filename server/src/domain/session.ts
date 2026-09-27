// The pick session: everything one pick knows, stored as it progresses (§4.2, §5, §6).

import type { RaceCard } from "./assign";
import type { Match } from "./matching";
import type { Location, Place } from "./places";
import type { Race } from "./race";
import type { Iso } from "./time";
import type { Placing, PodiumPlace, Winner } from "./winner";

export type PickStatus =
  "finding_race" | "waiting_start" | "running" | "resolving" | "searching" | "done" | "failed" | "cancelled";

/** Nothing more will happen to a pick in one of these statuses. */
export function isFinished(status: PickStatus): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

export type PickError =
  | "no_upcoming_race"
  | "race_source_unavailable"
  | "places_unavailable"
  /** Nothing nearby is tagged with a cuisine any country claims, so no country can enter the race (F2.2). */
  | "no_matching_places"
  | "internal";

/** The validated request that started a restaurant pick (F1.1). */
export interface PickRequest {
  /** Absent in picks saved before dish picks existed. */
  mode?: "restaurant";
  radius_m: number;
  min_population: number;
  include_visited: boolean;
  /** Only races starting within this many minutes (F3.2). Absent in picks saved before it existed. */
  max_wait_min?: number;
}

/** The validated request that started a dish pick (F15). */
export interface DishRequest {
  mode: "dish";
  /** Cleaned by `validateDishes`: 3–40 distinct names. */
  dishes: string[];
  restaurant_name: string | null;
  /** Only races starting within this many minutes (F3.2). */
  max_wait_min?: number;
}

export interface PickSession {
  pick_id: string;
  created_at: Iso;
  request: PickRequest | DishRequest;
  /** Where to look for restaurants; null for dish picks. */
  location: Location | null;
  status: PickStatus;
  error: PickError | null;
  world_complete: boolean;
  /** The chosen race; its runners hold the latest scratchings. */
  race: Race | null;
  card: RaceCard | null;
  /** The latest interim placings and when they were first seen unchanged (F5.2). */
  interim_placings: Placing[];
  interim_since: Iso | null;
  winner: Winner | null;
  /** Dish picks: the top three dishes (F15). Absent in picks saved before dish picks existed. */
  podium?: PodiumPlace[] | null;
  /**
   * false until the places lookup has succeeded. A pick loads places first, to
   * know which countries may run (F2.2); picks saved before that retry after the race.
   */
  places_loaded: boolean;
  places: Place[];
  matches: Match[];
  /** Place id of the chosen restaurant. */
  pick: string | null;
}

export function newSession(
  pickId: string,
  createdAt: Iso,
  request: PickRequest | DishRequest,
  location: Location | null,
): PickSession {
  return {
    pick_id: pickId,
    created_at: createdAt,
    request,
    location,
    status: "finding_race",
    error: null,
    world_complete: false,
    race: null,
    card: null,
    interim_placings: [],
    interim_since: null,
    winner: null,
    podium: null,
    places_loaded: false,
    places: [],
    matches: [],
    pick: null,
  };
}

/** A restaurant pick: it always has a place to search around. */
export type RestaurantPick = PickSession & { request: PickRequest; location: Location };

/** A new dish pick (F15): no location; the race picks from `request.dishes`. */
export function newDishSession(pickId: string, createdAt: Iso, request: DishRequest): PickSession {
  return { ...newSession(pickId, createdAt, request, null), request };
}

export function isDishPick(s: PickSession): s is PickSession & { request: DishRequest } {
  return s.request.mode === "dish";
}

/** The race has given its verdict: a winning country, or a dish podium. */
export function isDecided(s: PickSession): boolean {
  return s.winner !== null || (s.podium ?? null) !== null;
}

export function failed(s: PickSession, error: PickError): PickSession {
  return { ...s, status: "failed", error };
}
