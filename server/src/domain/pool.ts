// The country pool for a pick (SPEC.md F2).

import type { Country } from "./countries";

export const DEFAULT_MIN_POPULATION = 10_000_000;

export interface Pool {
  /** Countries eligible to be assigned to horses. */
  countries: Country[];
  /** Countries passing the population threshold, visited or not (F2.2). */
  full: Country[];
  /** Every country in `full` has been visited, so all of it is used (F2.4). */
  world_complete: boolean;
}

/** Build the pool (F2.2–F2.4). `visited` holds ISO codes with `visit_count > 0`. */
export function pool(
  countries: readonly Country[],
  minPopulation: number,
  visited: ReadonlySet<string>,
  includeVisited: boolean,
): Pool {
  const full = countries.filter((c) => c.population >= minPopulation);
  if (includeVisited) return { countries: full, full, world_complete: false };
  const unvisited = full.filter((c) => !visited.has(c.iso2));
  if (unvisited.length === 0 && full.length > 0) return { countries: full, full, world_complete: true };
  return { countries: unvisited, full, world_complete: false };
}
