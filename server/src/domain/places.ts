// Places near the pick location (SPEC.md F6.1) and geocoding (F1.2–F1.3).

/** Default OSM `amenity` values that count as restaurants (F6.1). */
export const DEFAULT_AMENITIES = ["restaurant", "fast_food"];

/** A restaurant-like OSM node or way inside the radius. */
export interface Place {
  /** `osm:<type>/<id>`, e.g. `osm:node/123`. */
  id: string;
  name: string;
  lat: number;
  lon: number;
  address: string | null;
  amenity: string;
  /** Parsed OSM `cuisine` values; empty when untagged. */
  cuisine: string[];
  /** Public OSM tags passed to the classifier (website, menu, description, ...). */
  tags: Record<string, string>;
  distance_m: number;
}

export class PlacesUnavailable extends Error {}

export interface Places {
  /** Restaurant-like places around a point, nearest first. */
  nearby(lat: number, lon: number, radiusM: number, amenities: readonly string[]): Promise<Place[]>;
}

export interface Location {
  lat: number;
  lon: number;
  display_name: string;
}

export class GeocoderUnavailable extends Error {}

/** Most matches offered for an address (F1.2). */
export const MAX_ADDRESS_MATCHES = 5;
/** Matches closer than this are the same place (one building, several OSM objects). */
export const SAME_PLACE_M = 100;

export interface Geocoder {
  /** Which part of the world it searches (e.g. "nz"); part of the cache key. */
  readonly scope: string;
  /** Up to MAX_ADDRESS_MATCHES matches, best first; empty for none (F1.2). */
  search(address: string): Promise<Location[]>;
}

/** Drop matches within SAME_PLACE_M of a better one, keeping order. */
export function distinctLocations(locations: readonly Location[]): Location[] {
  const out: Location[] = [];
  for (const l of locations) {
    if (!out.some((o) => distanceM(o.lat, o.lon, l.lat, l.lon) < SAME_PLACE_M)) out.push(l);
  }
  return out;
}

export function osmId(kind: string, id: number): string {
  return `osm:${kind}/${id}`;
}

export function isTagged(p: Place): boolean {
  return p.cuisine.length > 0;
}

/**
 * Parse an OSM `cuisine` value: `;`-separated, trimmed, lowercased, empty parts
 * dropped, duplicates removed. Spaces become `_` so "South African" matches
 * `south_african`.
 */
export function parseCuisine(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(";")) {
    const v = part.trim().toLowerCase().split(/\s+/).filter(Boolean).join("_");
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** Cache key for an address (F1.3): lowercase, whitespace collapsed. */
export function normaliseAddress(address: string): string {
  return address.split(/\s+/).filter(Boolean).join(" ").toLowerCase();
}

/** Great-circle distance in metres (haversine). */
export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_008.8;
  const rad = Math.PI / 180;
  const dp = (lat2 - lat1) * rad;
  const dl = (lon2 - lon1) * rad;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
