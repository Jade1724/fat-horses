// Starting a pick: validate the request and geocode it (SPEC.md F1).

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { normaliseAddress, type Geocoder, type Location } from "../domain/places";
import { DEFAULT_MIN_POPULATION } from "../domain/pool";
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
});
export type StartInput = z.infer<typeof startInput>;

export class InvalidRequest extends Error {}
export class AddressNotFound extends Error {
  constructor() {
    super("address not found");
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
  const address = input.address?.trim() || undefined;
  let location: Location;
  if (address !== undefined && input.lat === undefined && input.lon === undefined) {
    location = await geocode(geocoder, cache, address, now);
  } else if (address === undefined && input.lat !== undefined && input.lon !== undefined) {
    if (Math.abs(input.lat) > 90 || Math.abs(input.lon) > 180)
      throw new InvalidRequest("lat/lon out of range");
    location = {
      lat: input.lat,
      lon: input.lon,
      display_name: `${input.lat.toFixed(5)}, ${input.lon.toFixed(5)}`,
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
    },
    location,
  );
}

async function geocode(
  geocoder: Geocoder,
  cache: Pick<Store, "getGeocode" | "putGeocode">,
  address: string,
  now: Iso,
): Promise<Location> {
  const key = normaliseAddress(address);
  const cached = await cache.getGeocode(key).catch(() => null);
  if (cached && isFresh(cached.created_at, GEOCODE_TTL_MS, now)) return cached.location;
  const location = await geocoder.geocode(address);
  if (!location) throw new AddressNotFound();
  await cache
    .putGeocode(key, { location, created_at: now })
    .catch((e) => log.warn("geocode cache write failed", { error: String(e) }));
  return location;
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
