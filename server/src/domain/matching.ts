// Matching places to countries by their OSM cuisine tag (SPEC.md F6) and choosing one (F7).

import type { Country } from "./countries";
import type { Place } from "./places";
import { choose, type Rng } from "./rng";

/** How a place matched. Only by its own cuisine tag since the AI tiers were dropped. */
export type MatchKind = "tagged";

export interface Match {
  place_id: string;
  match: MatchKind;
  /** Why it matched, beyond the tag. No tier gives one now; kept so stored restaurants keep their shape. */
  reason: string | null;
}

/** A place matches when its own cuisine tag is one of the country's (F6.2). */
export function taggedMatches(places: readonly Place[], country: Country): Match[] {
  const tags = new Set(country.cuisine_tags);
  return places
    .filter((p) => p.cuisine.some((t) => tags.has(t)))
    .map((p) => ({ place_id: p.id, match: "tagged", reason: null }));
}

/**
 * The countries allowed into the race (F2.2): those with at least one tagged
 * restaurant nearby, so whichever horse wins, there is somewhere to eat.
 */
export function countriesWithTaggedPlaces(
  countries: readonly Country[],
  places: readonly Place[],
): Country[] {
  return countries.filter((c) => taggedMatches(places, c).length > 0);
}

/** Choose uniformly among the matches, only never-visited ones if any (F7). */
export function chooseRestaurant(
  candidates: readonly Match[],
  visitCount: (placeId: string) => number,
  rng: Rng,
): Match | undefined {
  const fresh = candidates.filter((m) => visitCount(m.place_id) === 0);
  return choose(fresh.length > 0 ? fresh : candidates, rng);
}
