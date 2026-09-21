// The pick session: everything one pick knows, stored as it progresses (§4.2, §5, §6).

import type { RaceCard } from "./assign";
import type { Guess } from "./classify";
import type { Match } from "./matching";
import type { Location, Place } from "./places";
import type { Race } from "./race";
import type { Iso } from "./time";
import type { Placing, Winner } from "./winner";

export type PickStatus =
  | "finding_race"
  | "waiting_start"
  | "running"
  | "resolving"
  | "searching"
  | "done"
  | "failed";

export type PickError = "no_upcoming_race" | "race_source_unavailable" | "places_unavailable" | "internal";

/** The validated request that started a pick (F1.1). */
export interface PickRequest {
  radius_m: number;
  min_population: number;
  include_visited: boolean;
}

export interface PickSession {
  pick_id: string;
  created_at: Iso;
  request: PickRequest;
  location: Location;
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
  /** false until the places lookup has succeeded (it is retried after the race). */
  places_loaded: boolean;
  places: Place[];
  guesses: Guess[];
  matches: Match[];
  /** Place id of the chosen restaurant. */
  pick: string | null;
  llm_unavailable: boolean;
}

export function newSession(pickId: string, createdAt: Iso, request: PickRequest, location: Location): PickSession {
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
    places_loaded: false,
    places: [],
    guesses: [],
    matches: [],
    pick: null,
    llm_unavailable: false,
  };
}

export function failed(s: PickSession, error: PickError): PickSession {
  return { ...s, status: "failed", error };
}
