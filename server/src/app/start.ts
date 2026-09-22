// Starting a pick: validate the request and geocode it (SPEC.md F1).

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { distinctLocations, normaliseAddress, type Geocoder, type Location } from "../domain/places";
import { DEFAULT_MIN_POPULATION } from "../domain/pool";
import { DEFAULT_MAX_WAIT_MIN, MAX_WAIT_MIN_RANGE } from "../domain/race";
import { newSession, type PickSession } from "../domain/session";
import { GEOCODE_TTL_MS, isFresh, type Store } from "../domain/store";
import type { Iso } from "../domain/time";
import { log } from "../log";

export const DEFAULT_RADIUS_M = 200;
export const RADIUS_MIN = 50;
export const RADIUS_MAX = 2000;

/** The body of `POST /picks` (§5). */
export const startInput = z.object({
  address: z.string().optional(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  radius_m: z.number().int().optional(),
  min_population: z.number().int().nonnegative().optional(),
  include_visited: z.boolean().optional(),
  max_wait_min: z.number().int().optional(),
  /** With lat+lon: the address to show, e.g. a match chosen from `GET /geocode` (F1.2). */
  label: z.string().max(300).optional(),
});
export type StartInput = z.infer<typeof startInput>;

export class InvalidRequest extends Error {}
export class AddressNotFound extends Error {
  constructor() {
    super("address not found");
  }
}

/** More than one place matches; the caller must choose (F1.2). */
export class AmbiguousAddress extends Error {
  constructor(readonly matches: Location[]) {
    super(`${matches.length} places match that address`);
  }
}

/** Validate F1.1 and resolve the location (F1.2–F1.3); returns a new session. */
export async function startPick(
  geocoder: Geocoder,
  cache: Pick<Store, "getGeocode" | "putGeocode">,
  input: StartInput,
  pickId: string,
  now: Iso,
): Promise<PickSession> {
  const radius = input.radius_m ?? DEFAULT_RADIUS_M;
  if (radius < RADIUS_MIN || radius > RADIUS_MAX) {
    throw new InvalidRequest(`radius_m must be ${RADIUS_MIN}–${RADIUS_MAX}`);
  }
  const maxWait = input.max_wait_min ?? DEFAULT_MAX_WAIT_MIN;
  const [minWait, maxWaitLimit] = MAX_WAIT_MIN_RANGE;
  if (maxWait < minWait || maxWait > maxWaitLimit) {
    throw new InvalidRequest(`max_wait_min must be ${minWait}–${maxWaitLimit}`);
  }
  const address = input.address?.trim() || undefined;
  let location: Location;
  if (address !== undefined && input.lat === undefined && input.lon === undefined) {
    const matches = await lookupAddress(geocoder, cache, address, now);
    const [only, ...others] = matches;
    if (!only) throw new AddressNotFound();
    if (others.length > 0) throw new AmbiguousAddress(matches);
    location = only;
  } else if (address === undefined && input.lat !== undefined && input.lon !== undefined) {
    if (Math.abs(input.lat) > 90 || Math.abs(input.lon) > 180)
      throw new InvalidRequest("lat/lon out of range");
    location = {
      lat: input.lat,
      lon: input.lon,
      display_name: input.label?.trim() || `${input.lat.toFixed(5)}, ${input.lon.toFixed(5)}`,
    };
  } else {
    throw new InvalidRequest("give exactly one of address or lat+lon");
  }
  return newSession(
    pickId,
    now,
    {
      radius_m: radius,
      min_population: input.min_population ?? DEFAULT_MIN_POPULATION,
      include_visited: input.include_visited ?? false,
      max_wait_min: maxWait,
    },
    location,
  );
}

/**
 * Distinct places matching `address` (F1.2), best first, cached per address and
 * geocoder scope (F1.3). Matches within SAME_PLACE_M of a better one are merged.
 */
export async function lookupAddress(
  geocoder: Geocoder,
  cache: Pick<Store, "getGeocode" | "putGeocode">,
  address: string,
  now: Iso,
): Promise<Location[]> {
  const key = `${geocoder.scope}|${normaliseAddress(address)}`;
  const cached = await cache.getGeocode(key).catch(() => null);
  if (cached && Array.isArray(cached.results) && isFresh(cached.created_at, GEOCODE_TTL_MS, now)) {
    return cached.results;
  }
  const results = distinctLocations(await geocoder.search(address));
  await cache
    .putGeocode(key, { results, created_at: now })
    .catch((e) => log.warn("geocode cache write failed", { error: String(e) }));
  return results;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A new, time-ordered pick id (ULID). */
export function newPickId(nowMs = Date.now()): string {
  let time = "";
  let t = nowMs;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rand = [...randomBytes(16)].map((b) => CROCKFORD[b % 32]).join("");
  return time + rand;
}
