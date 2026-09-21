// Assigning countries to horses (SPEC.md F4).

import type { Country } from "./countries";
import type { Pool } from "./pool";
import type { Runner } from "./race";
import { choose, shuffle, type Rng } from "./rng";

export interface CardEntry {
  number: number;
  horse: string;
  /** null only for runners already scratched at assignment time. */
  country_iso: string | null;
  scratched: boolean;
}

/** The saved assignment of countries to runners (F4.3). Never re-drawn. */
export interface RaceCard {
  entries: CardEntry[];
}

export function cardEntry(card: RaceCard, number: number): CardEntry | undefined {
  return card.entries.find((e) => e.number === number);
}

/** Mark runners scratched after assignment (F4.4); their countries stay on the card. */
export function applyScratchings(card: RaceCard, runners: readonly Runner[]): RaceCard {
  const scratched = new Set(runners.filter((r) => r.scratched).map((r) => r.number));
  return {
    entries: card.entries.map((e) => (scratched.has(e.number) ? { ...e, scratched: true } : e)),
  };
}

export class EmptyPoolError extends Error {
  constructor() {
    super("the country pool is empty");
  }
}

/**
 * Draw countries for the non-scratched runners (F4.1–F4.2): distinct countries
 * from `pool.countries` first, then distinct unused ones from `pool.full`, and
 * only then repeats.
 */
export function assign(runners: readonly Runner[], p: Pool, rng: Rng): RaceCard {
  const needed = runners.filter((r) => !r.scratched).length;
  const drawn = draw(needed, p, rng);
  let i = 0;
  return {
    entries: runners.map((r) => ({
      number: r.number,
      horse: r.name,
      country_iso: r.scratched ? null : (drawn[i++]?.iso2 ?? null),
      scratched: r.scratched,
    })),
  };
}

function draw(needed: number, p: Pool, rng: Rng): Country[] {
  if (needed === 0) return [];
  if (p.countries.length === 0 && p.full.length === 0) throw new EmptyPoolError();
  let out = shuffle(p.countries, rng).slice(0, needed);
  if (out.length < needed) {
    const used = new Set(out.map((c) => c.iso2));
    const topUp = shuffle(
      p.full.filter((c) => !used.has(c.iso2)),
      rng,
    ).slice(0, needed - out.length);
    out = out.concat(topUp);
  }
  if (out.length < needed) {
    const distinct = [...out];
    while (out.length < needed) {
      const c = choose(distinct, rng);
      if (!c) break;
      out.push(c);
    }
    // Repeats were appended last; shuffle so they aren't always the highest numbers.
    out = shuffle(out, rng);
  }
  return out;
}
