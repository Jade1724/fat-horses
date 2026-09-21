// Injected randomness (SPEC.md N1): production uses crypto, tests use a seed.

import { randomInt } from "node:crypto";

/** Returns a float in [0, 1). */
export type Rng = () => number;

/** Deterministic generator for tests (mulberry32). */
export function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cryptographically random, for real picks. */
// randomInt's range must be below 2^48; dividing by 2^48 keeps the result < 1.
export const systemRng: Rng = () => randomInt(0, 2 ** 48 - 1) / 2 ** 48;

/** Uniform integer in [0, n). */
export function randomIndex(n: number, rng: Rng): number {
  return Math.min(n - 1, Math.floor(rng() * n));
}

/** A shuffled copy (Fisher–Yates). */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1, rng);
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

/** One element chosen uniformly, or undefined for an empty list. */
export function choose<T>(items: readonly T[], rng: Rng): T | undefined {
  return items.length === 0 ? undefined : items[randomIndex(items.length, rng)];
}
