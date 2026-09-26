// Pure display helpers (unit-tested).

import type { PickError, PickStatus, RestaurantStatus, WinReason } from "./api";

/** Directions to a point (SPEC.md F10.5). */
export function directionsUrl(lat: number, lon: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
}

/** "4:05" until `start`, or null once it has passed. */
export function countdown(start: Date, now: Date): string | null {
  const ms = start.getTime() - now.getTime();
  if (ms <= 0) return null;
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function statusText(status: PickStatus): string {
  switch (status) {
    case "finding_race":
      return "Finding restaurants and the next race…";
    case "waiting_start":
      return "Waiting for the start";
    case "running":
      return "They're racing! Waiting for the result…";
    case "resolving":
      return "Result in!";
    case "searching":
      return "Looking for restaurants…";
    case "done":
      return "Done";
    case "failed":
      return "Something went wrong";
    case "cancelled":
      return "Cancelled";
  }
}

/** A duration in minutes as words: 10 → "10 minutes", 180 → "3 hours". */
export function minutesText(min: number): string {
  if (min % 60 === 0) return min === 60 ? "hour" : `${min / 60} hours`;
  return `${min} minutes`;
}

export function errorText(error: PickError | null, maxWaitMin = 10, radiusM = 500): string {
  switch (error) {
    case "no_upcoming_race":
      return `No gallops race starts in the next ${minutesText(maxWaitMin)}. Try again later, or allow a longer wait in Options.`;
    case "race_source_unavailable":
      return "TAB NZ isn't answering right now. Try again in a few minutes.";
    case "places_unavailable":
      return "The restaurant search (OpenStreetMap) is down. Try again in a few minutes.";
    case "no_matching_places":
      return `No restaurant within ${distanceText(radiusM)} has a cuisine we can match to a country, so there's nobody to race. Try a bigger radius in Options.`;
    case "internal":
    case null:
      return "Something went wrong on our side. Try again.";
  }
}

export function winReasonText(reason: WinReason, tied: number[] = []): string | null {
  switch (reason) {
    case "result":
      return null;
    case "dead_heat":
      return `Dead heat between ${tied.map((n) => `#${n}`).join(" and ")}, drawn at random`;
    case "abandoned":
      return "Race abandoned: country drawn at random";
    case "timeout":
      return "No result in time: country drawn at random";
  }
}

export type PinKind = "new" | "picked" | "visited" | "chosen";

/** Pin colour class for a restaurant (F10.5). The chosen one stands out. */
export function pinKind(status: RestaurantStatus, chosen: boolean): PinKind {
  if (chosen) return "chosen";
  if (status === "VISITED") return "visited";
  if (status === "PICKED") return "picked";
  return "new";
}

/** A shorter address for choice lists: without the country at the end. */
export function shortAddress(displayName: string): string {
  const parts = displayName.split(",").map((p) => p.trim());
  if (parts.length > 2) parts.pop();
  return parts.join(", ");
}

export function distanceText(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

export function isFinished(status: PickStatus): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

/** A closed ring approximating a circle, for the radius overlay (GeoJSON order: lon, lat). */
export function circleRing(lat: number, lon: number, radiusM: number, steps = 64): [number, number][] {
  const earth = 6_371_008.8;
  const dLat = (radiusM / earth) * (180 / Math.PI);
  const dLon = dLat / Math.cos((lat * Math.PI) / 180);
  const ring: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return ring;
}

/** "osm:node/123" → "https://www.openstreetmap.org/node/123". */
export function osmUrl(id: string): string | null {
  const m = /^osm:(node|way|relation)\/(\d+)$/.exec(id);
  return m ? `https://www.openstreetmap.org/${m[1]}/${m[2]}` : null;
}

export function dateText(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
