// The LLM classifier interface and its output validation (SPEC.md §3).

import { z } from "zod";
import type { Place } from "./places";

/** Longest reason kept from the model (L4). */
export const MAX_REASON_CHARS = 120;

export interface CuisineGuess {
  tag: string;
  confidence: number;
}

/** The classifier's cuisine guess for one untagged place (L2). */
export interface Guess {
  place_id: string;
  cuisines: CuisineGuess[];
  reason: string;
}

/** A place the classifier thinks serves the country's dishes (F6.5). */
export interface DishMatch {
  place_id: string;
  reason: string;
}

/** What the classifier may see about a place: public OSM data only (L3). */
export interface PlaceInput {
  place_id: string;
  name: string;
  amenity: string;
  cuisine: string[];
  tags: Record<string, string>;
}

export function placeInput(p: Place): PlaceInput {
  return { place_id: p.id, name: p.name, amenity: p.amenity, cuisine: p.cuisine, tags: p.tags };
}

export interface CountryDishes {
  name: string;
  dishes: string[];
}

export class ClassifierError extends Error {}

export interface Classifier {
  /** Guess cuisines for places without a `cuisine` tag (F6.3). */
  guessCuisines(places: readonly PlaceInput[]): Promise<Guess[]>;
  /** Places likely to serve the country's dishes (F6.5). */
  matchDishes(places: readonly PlaceInput[], country: CountryDishes): Promise<DishMatch[]>;
}

function clampReason(reason: string): string {
  const r = reason.trim();
  const chars = [...r];
  return chars.length <= MAX_REASON_CHARS ? r : `${chars.slice(0, MAX_REASON_CHARS - 1).join("").trimEnd()}…`;
}

const rawGuesses = z.object({
  guesses: z.array(
    z.object({
      place_id: z.string(),
      cuisines: z.array(z.object({ tag: z.string(), confidence: z.number() })).default([]),
      reason: z.string().default(""),
    }),
  ),
});

const rawMatches = z.object({
  matches: z.array(z.object({ place_id: z.string(), reason: z.string().default("") })),
});

function parse<T>(schema: z.ZodType<T>, json: string): T {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (e) {
    throw new ClassifierError(`classifier output is not JSON: ${String(e)}`);
  }
  const r = schema.safeParse(value);
  if (!r.success) throw new ClassifierError(`classifier output invalid: ${r.error.message}`);
  return r.data;
}

/**
 * Validate `guessCuisines` output (L4): drop unknown places, tags outside
 * `knownTags` and confidences outside [0, 1]; one guess per place; clamp reasons.
 */
export function validateGuesses(
  json: string,
  inputIds: ReadonlySet<string>,
  knownTags: ReadonlySet<string>,
): Guess[] {
  const seen = new Set<string>();
  return parse(rawGuesses, json)
    .guesses.filter((g) => inputIds.has(g.place_id) && !seen.has(g.place_id) && seen.add(g.place_id))
    .map((g) => ({
      place_id: g.place_id,
      cuisines: g.cuisines
        .map((c) => ({ tag: c.tag.trim().toLowerCase(), confidence: c.confidence }))
        .filter((c) => knownTags.has(c.tag) && c.confidence >= 0 && c.confidence <= 1),
      reason: clampReason(g.reason),
    }));
}

/** Validate `matchDishes` output (L4): only known places, once each. */
export function validateDishMatches(json: string, inputIds: ReadonlySet<string>): DishMatch[] {
  const seen = new Set<string>();
  return parse(rawMatches, json)
    .matches.filter((m) => inputIds.has(m.place_id) && !seen.has(m.place_id) && seen.add(m.place_id))
    .map((m) => ({ place_id: m.place_id, reason: clampReason(m.reason) }));
}

/** Deterministic classifier for tests and offline runs (L2). */
export class FakeClassifier implements Classifier {
  private readonly guesses = new Map<string, Guess>();
  private readonly dishMatches = new Map<string, DishMatch[]>();
  guessCalls = 0;
  dishCalls = 0;
  readonly guessedPlaces: string[] = [];

  constructor(private readonly fail = false) {}

  static failing(): FakeClassifier {
    return new FakeClassifier(true);
  }

  withGuess(g: Guess): this {
    this.guesses.set(g.place_id, g);
    return this;
  }

  withDishMatch(country: string, placeId: string, reason: string): this {
    const list = this.dishMatches.get(country) ?? [];
    list.push({ place_id: placeId, reason });
    this.dishMatches.set(country, list);
    return this;
  }

  async guessCuisines(places: readonly PlaceInput[]): Promise<Guess[]> {
    this.guessCalls++;
    if (this.fail) throw new ClassifierError("fake failure");
    this.guessedPlaces.push(...places.map((p) => p.place_id));
    return places.flatMap((p) => {
      const g = this.guesses.get(p.place_id);
      return g ? [g] : [];
    });
  }

  async matchDishes(places: readonly PlaceInput[], country: CountryDishes): Promise<DishMatch[]> {
    this.dishCalls++;
    if (this.fail) throw new ClassifierError("fake failure");
    const ids = new Set(places.map((p) => p.place_id));
    return (this.dishMatches.get(country.name) ?? []).filter((m) => ids.has(m.place_id));
  }
}
