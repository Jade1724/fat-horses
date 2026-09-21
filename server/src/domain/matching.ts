// Matching places to the winning country (SPEC.md F6.2–F6.4) and choosing one (F7).

import type { Guess } from "./classify";
import type { Country } from "./countries";
import { isTagged, type Place } from "./places";
import { choose, type Rng } from "./rng";

/** Default confidence needed for an inferred match (F6.3). */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

export type MatchKind = "tagged" | "inferred" | "fallback";

export interface Match {
  place_id: string;
  match: MatchKind;
  /** The LLM's reason, for inferred and fallback matches. */
  reason: string | null;
}

/** Tier 1 (F6.2): the place's own cuisine tag matches the country. */
export function taggedMatches(places: readonly Place[], country: Country): Match[] {
  const tags = new Set(country.cuisine_tags);
  return places
    .filter((p) => p.cuisine.some((t) => tags.has(t)))
    .map((p) => ({ place_id: p.id, match: "tagged", reason: null }));
}

/** Tier 2 (F6.3): untagged places whose guess matches with enough confidence. */
export function inferredMatches(
  places: readonly Place[],
  guesses: readonly Guess[],
  country: Country,
  threshold: number,
): Match[] {
  const tags = new Set(country.cuisine_tags);
  const out: Match[] = [];
  for (const p of places) {
    if (isTagged(p)) continue;
    const g = guesses.find((x) => x.place_id === p.id);
    if (g?.cuisines.some((c) => c.confidence >= threshold && tags.has(c.tag))) {
      out.push({ place_id: p.id, match: "inferred", reason: g.reason });
    }
  }
  return out;
}

/** Tiers 1 and 2 together: the primary matches (F6.4). */
export function primaryMatches(
  places: readonly Place[],
  guesses: readonly Guess[],
  country: Country,
  threshold: number,
): Match[] {
  return [...taggedMatches(places, country), ...inferredMatches(places, guesses, country, threshold)];
}

/**
 * Choose uniformly (F7.1–F7.3): primary matches, or fallback ones when there
 * are none; among them only never-visited ones if any. The LLM plays no part.
 */
export function chooseRestaurant(
  primary: readonly Match[],
  fallback: readonly Match[],
  visitCount: (placeId: string) => number,
  rng: Rng,
): Match | undefined {
  const candidates = primary.length > 0 ? primary : fallback;
  const fresh = candidates.filter((m) => visitCount(m.place_id) === 0);
  return choose(fresh.length > 0 ? fresh : candidates, rng);
}
