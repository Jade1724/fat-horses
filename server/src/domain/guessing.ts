// Cuisine guesses for untagged places, with caching (SPEC.md F6.3, L5, L6).

import { createHash } from "node:crypto";
import { log } from "../log";
import { placeInput, type Classifier, type Guess, type PlaceInput } from "./classify";
import { isTagged, type Place } from "./places";
import { GUESS_TTL_MS, isFresh, type Store } from "./store";
import type { Iso } from "./time";

/** Places per classifier call (L5). */
export const BATCH_SIZE = 50;
/** Most places classified per pick, closest first (L5). */
export const MAX_PLACES = 200;

/** Which prompt and model produced a guess; part of the cache key (L6, L7). */
export interface GuessConfig {
  prompt_version: number;
  model_id: string;
}

export interface GuessOutcome {
  guesses: Guess[];
  /** Some batch failed; its places have no guess (F6.8). */
  llm_unavailable: boolean;
}

/** SHA-256 of name, amenity and sorted tags (L6): a changed place is guessed again. */
export function inputHash(p: PlaceInput): string {
  const h = createHash("sha256");
  h.update(p.name).update("\0").update(p.amenity);
  for (const [k, v] of Object.entries(p.tags).sort(([a], [b]) => a.localeCompare(b))) {
    h.update("\0").update(k).update("\x01").update(v);
  }
  return h.digest("hex");
}

type GuessCache = Pick<Store, "getGuess" | "putGuess">;

/**
 * Guesses for every untagged place (up to MAX_PLACES, closest first): fresh
 * cached guesses with a matching hash are reused, the rest go to the classifier
 * in batches and are cached. A place the classifier skipped is cached with no
 * cuisines. Failures never abort: they set `llm_unavailable`.
 */
export async function guessUntagged(
  places: readonly Place[],
  classifier: Classifier,
  cache: GuessCache,
  config: GuessConfig,
  now: Iso,
): Promise<GuessOutcome> {
  const untagged = places
    .filter((p) => !isTagged(p))
    .sort((a, b) => a.distance_m - b.distance_m)
    .slice(0, MAX_PLACES);
  const out: GuessOutcome = { guesses: [], llm_unavailable: false };
  const toAsk: { input: PlaceInput; hash: string }[] = [];
  for (const p of untagged) {
    const input = placeInput(p);
    const hash = inputHash(input);
    const cached = await cache.getGuess(p.id, config.prompt_version).catch(() => null);
    if (cached && cached.input_hash === hash && isFresh(cached.created_at, GUESS_TTL_MS, now)) {
      out.guesses.push(cached.guess);
    } else {
      toAsk.push({ input, hash });
    }
  }
  for (let i = 0; i < toAsk.length; i += BATCH_SIZE) {
    const batch = toAsk.slice(i, i + BATCH_SIZE);
    let answered: Guess[];
    try {
      answered = await classifier.guessCuisines(batch.map((b) => b.input));
    } catch (e) {
      log.warn("cuisine guessing failed", { error: String(e) });
      out.llm_unavailable = true;
      continue;
    }
    for (const { input, hash } of batch) {
      const guess = answered.find((g) => g.place_id === input.place_id) ?? {
        place_id: input.place_id,
        cuisines: [],
        reason: "",
      };
      await cache
        .putGuess({
          guess,
          prompt_version: config.prompt_version,
          input_hash: hash,
          model_id: config.model_id,
          created_at: now,
        })
        .catch(() => undefined);
      out.guesses.push(guess);
    }
  }
  return out;
}
