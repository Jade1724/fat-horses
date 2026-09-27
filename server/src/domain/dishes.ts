// Dish picks (SPEC.md F15): the dishes a race chooses from, and giving them to
// horses. A podium needs three, so a dish pick needs at least three dishes.

import type { RaceCard } from "./assign";
import type { Runner } from "./race";
import { choose, shuffle, type Rng } from "./rng";

export const PODIUM_SIZE = 3;
export const MIN_DISHES = PODIUM_SIZE;
export const MAX_DISHES = 40;
export const MAX_DISH_CHARS = 80;

export class InvalidDishes extends Error {}

/**
 * Tidy dish names: trim, collapse runs of spaces, drop empties and repeats
 * (ignoring case, keeping the first spelling).
 */
export function tidyDishes(names: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = raw.trim().split(/\s+/).filter(Boolean).join(" ");
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** The dishes a person confirmed: tidied, then refused if they can't make a podium or are too long. */
export function validateDishes(names: readonly string[]): string[] {
  const out = tidyDishes(names);
  const long = out.find((n) => n.length > MAX_DISH_CHARS);
  if (long) throw new InvalidDishes(`"${long.slice(0, 30)}…" is longer than ${MAX_DISH_CHARS} characters`);
  if (out.length < MIN_DISHES) throw new InvalidDishes(`need at least ${MIN_DISHES} different dishes`);
  if (out.length > MAX_DISHES) throw new InvalidDishes(`at most ${MAX_DISHES} dishes`);
  return out;
}

/**
 * The dishes a menu reading offers for review: tidied, overlong ones dropped
 * and the list capped, since a person trims it before the race anyway.
 */
export function dishesFromReading(names: readonly string[]): string[] {
  return tidyDishes(names)
    .filter((n) => n.length <= MAX_DISH_CHARS)
    .slice(0, MAX_DISHES);
}

/**
 * Give the non-scratched runners a dish each: distinct dishes while they last
 * (extra dishes sit out), then repeats at random, so every dish runs when
 * there are more horses than dishes.
 */
export function assignDishes(runners: readonly Runner[], dishes: readonly string[], rng: Rng): RaceCard {
  const needed = runners.filter((r) => !r.scratched).length;
  const drawn = draw(needed, dishes, rng);
  let i = 0;
  return {
    entries: runners.map((r) => ({
      number: r.number,
      horse: r.name,
      country_iso: null,
      dish: r.scratched ? null : (drawn[i++] ?? null),
      scratched: r.scratched,
    })),
  };
}

function draw(needed: number, dishes: readonly string[], rng: Rng): string[] {
  let out = shuffle(dishes, rng).slice(0, needed);
  if (out.length < needed) {
    const distinct = [...out];
    while (out.length < needed) {
      const d = choose(distinct, rng);
      if (d === undefined) break;
      out.push(d);
    }
    // Repeats were appended last; shuffle so they aren't always the highest numbers.
    out = shuffle(out, rng);
  }
  return out;
}
