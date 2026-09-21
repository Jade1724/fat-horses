// OpenStreetMap services: Nominatim geocoding (F1.2, N4) and Overpass places (F6.1).

import { z } from "zod";
import {
  distanceM,
  GeocoderUnavailable,
  osmId,
  parseCuisine,
  PlacesUnavailable,
  type Geocoder,
  type Location,
  type Place,
  type Places,
} from "../domain/places";
import { log } from "../log";
import { fetchText, sleep, type Fetch } from "./http";

// ---- Nominatim ----

export const NOMINATIM_URL = "https://nominatim.openstreetmap.org";
/** Nominatim's usage policy: at most one request per second (N4). */
export const NOMINATIM_INTERVAL_MS = 1000;

const searchResults = z.array(z.object({ lat: z.string(), lon: z.string(), display_name: z.string() }));

/** Parse a `format=jsonv2` search; the first result wins (F1.2). */
export function parseSearch(body: string): Location | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new GeocoderUnavailable("bad Nominatim response: not JSON");
  }
  const r = searchResults.safeParse(value);
  if (!r.success) throw new GeocoderUnavailable(`bad Nominatim response: ${r.error.message}`);
  const first = r.data[0];
  if (!first) return null;
  const lat = Number(first.lat);
  const lon = Number(first.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new GeocoderUnavailable("bad coordinates");
  return { lat, lon, display_name: first.display_name };
}

export class Nominatim implements Geocoder {
  private last = 0;

  constructor(
    private readonly baseUrl = NOMINATIM_URL,
    private readonly fetchFn: Fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {}

  /** Wait until a second has passed since the previous request. */
  async throttle(): Promise<void> {
    const gap = this.now() - this.last;
    if (this.last > 0 && gap < NOMINATIM_INTERVAL_MS) await this.wait(NOMINATIM_INTERVAL_MS - gap);
    this.last = this.now();
  }

  async geocode(address: string): Promise<Location | null> {
    await this.throttle();
    const q = new URLSearchParams({ q: address, format: "jsonv2", limit: "1" });
    let body: string;
    try {
      body = await fetchText(`${this.baseUrl}/search?${q}`, { fetchFn: this.fetchFn, timeoutMs: 10_000 });
    } catch (e) {
      throw new GeocoderUnavailable(String(e));
    }
    return parseSearch(body);
  }
}

// ---- Overpass ----

/**
 * Public instances, tried in order. The main one is often briefly overloaded
 * (HTTP 504 on about half of first attempts in testing), so each is tried
 * OVERPASS_ATTEMPTS times.
 */
export const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
export const OVERPASS_ATTEMPTS = 3;
export const OVERPASS_RETRY_MS = 3000;

/** OSM tags passed on to the classifier (SPEC.md L3). Public data only. */
const KEPT_TAGS = [
  "brand",
  "description",
  "menu",
  "website",
  "contact:website",
  "website:menu",
  "name:en",
  "diet:vegetarian",
  "diet:vegan",
  "diet:halal",
];

export function buildQuery(lat: number, lon: number, radiusM: number, amenities: readonly string[]): string {
  return (
    "[out:json][timeout:25];" +
    `nwr["amenity"~"^(${amenities.join("|")})$"](around:${radiusM},${lat},${lon});` +
    "out center tags;"
  );
}

const overpassResponse = z.object({
  elements: z.array(
    z.object({
      type: z.string(),
      id: z.number(),
      lat: z.number().optional(),
      lon: z.number().optional(),
      center: z.object({ lat: z.number(), lon: z.number() }).optional(),
      tags: z.record(z.string(), z.string()).default({}),
    }),
  ),
  remark: z.string().optional(),
});

function address(tags: Record<string, string>): string | null {
  const n = tags["addr:housenumber"];
  const s = tags["addr:street"];
  const street = s ? (n ? `${n} ${s}` : s) : null;
  const parts = [street, tags["addr:suburb"], tags["addr:city"]].filter((x): x is string => !!x);
  return parts.length > 0 ? parts.join(", ") : null;
}

/** Places within `radiusM` of the origin, nearest first; elements without coordinates dropped. */
export function parseOverpass(body: string, lat: number, lon: number, radiusM: number): Place[] {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new PlacesUnavailable(`bad Overpass response: ${body.slice(0, 200)}`);
  }
  const r = overpassResponse.safeParse(value);
  if (!r.success) throw new PlacesUnavailable(`bad Overpass response: ${r.error.message}`);
  if (r.data.remark?.includes("error")) throw new PlacesUnavailable(`Overpass: ${r.data.remark}`);
  const places: Place[] = [];
  for (const e of r.data.elements) {
    const pLat = e.lat ?? e.center?.lat;
    const pLon = e.lon ?? e.center?.lon;
    if (pLat === undefined || pLon === undefined) continue;
    const amenity = e.tags.amenity ?? "";
    const d = distanceM(lat, lon, pLat, pLon);
    if (d > radiusM) continue;
    places.push({
      id: osmId(e.type, e.id),
      name: e.tags.name ?? `Unnamed ${amenity.replaceAll("_", " ")}`,
      lat: pLat,
      lon: pLon,
      address: address(e.tags),
      amenity,
      cuisine: e.tags.cuisine ? parseCuisine(e.tags.cuisine) : [],
      tags: Object.fromEntries(KEPT_TAGS.flatMap((k) => (e.tags[k] ? [[k, e.tags[k]]] : []))),
      distance_m: d,
    });
  }
  return places.sort((a, b) => a.distance_m - b.distance_m);
}

export class Overpass implements Places {
  constructor(
    private readonly endpoints: readonly string[] = OVERPASS_ENDPOINTS,
    private readonly fetchFn: Fetch = fetch,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {}

  async nearby(lat: number, lon: number, radiusM: number, amenities: readonly string[]): Promise<Place[]> {
    const query = buildQuery(lat, lon, radiusM, amenities);
    const errors: string[] = [];
    for (const endpoint of this.endpoints) {
      for (let attempt = 1; attempt <= OVERPASS_ATTEMPTS; attempt++) {
        try {
          const body = await fetchText(endpoint, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ data: query }).toString(),
            fetchFn: this.fetchFn,
            timeoutMs: 40_000,
          });
          return parseOverpass(body, lat, lon, radiusM);
        } catch (e) {
          log.warn("Overpass request failed", { endpoint, attempt, error: String(e) });
          errors.push(`${endpoint} (attempt ${attempt}): ${String(e)}`);
          if (attempt < OVERPASS_ATTEMPTS) await this.wait(OVERPASS_RETRY_MS);
        }
      }
    }
    throw new PlacesUnavailable(errors.join("; "));
  }
}
