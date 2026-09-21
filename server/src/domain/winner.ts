// Deciding the winning country from a race result (SPEC.md F5).

import { cardEntry, type CardEntry, type RaceCard } from "./assign";
import type { RaceStatus } from "./race";
import { choose, type Rng } from "./rng";
import { MINUTE, ms, type Iso } from "./time";

/** An interim result is accepted once unchanged for this long (F5.2). */
export const INTERIM_GRACE_MS = 10 * MINUTE;
/** Give up waiting this long after the scheduled start (F5.4). */
export const RESULT_TIMEOUT_MS = 45 * MINUTE;

export interface Placing {
  position: number;
  number: number;
}

export interface ResultSnapshot {
  status: RaceStatus;
  placings: Placing[];
}

export type WinReason = "result" | "dead_heat" | "abandoned" | "timeout";

export interface Winner {
  /** The winning runner; for abandoned/timeout, the runner whose country was drawn. */
  number: number;
  country_iso: string;
  reason: WinReason;
  /** All runners tied for first (dead heat only). */
  tied: number[];
}

/**
 * Decide the winner, or null to poll again (F5.2–F5.4). `interimSince` is when
 * the current interim placings were first seen; the caller resets it whenever
 * they change.
 */
export function resolve(
  card: RaceCard,
  snap: ResultSnapshot | null,
  scheduledStart: Iso,
  now: Iso,
  interimSince: Iso | null,
  rng: Rng,
): Winner | null {
  if (snap) {
    switch (snap.status) {
      case "final": {
        const w = fromPlacings(card, snap.placings, rng);
        if (w) return w;
        break;
      }
      case "interim": {
        const settled = interimSince !== null && ms(now) - ms(interimSince) >= INTERIM_GRACE_MS;
        const w = settled ? fromPlacings(card, snap.placings, rng) : null;
        if (w) return w;
        break;
      }
      case "abandoned":
        return randomPick(card, "abandoned", rng);
      case "open":
      case "closed":
        break;
    }
  }
  if (ms(now) - ms(scheduledStart) >= RESULT_TIMEOUT_MS) return randomPick(card, "timeout", rng);
  return null;
}

function eligible(card: RaceCard): CardEntry[] {
  return card.entries.filter((e) => !e.scratched && e.country_iso !== null);
}

/** The best-placed eligible runners; ties at that position are a dead heat. */
function fromPlacings(card: RaceCard, placings: readonly Placing[], rng: Rng): Winner | null {
  const ok = new Set(eligible(card).map((e) => e.number));
  const valid = placings.filter((p) => ok.has(p.number));
  if (valid.length === 0) return null;
  const best = Math.min(...valid.map((p) => p.position));
  const tied = [...new Set(valid.filter((p) => p.position === best).map((p) => p.number))].sort(
    (a, b) => a - b,
  );
  const number = choose(tied, rng);
  const country = number === undefined ? null : cardEntry(card, number)?.country_iso;
  if (number === undefined || !country) return null;
  const deadHeat = tied.length > 1;
  return {
    number,
    country_iso: country,
    reason: deadHeat ? "dead_heat" : "result",
    tied: deadHeat ? tied : [],
  };
}

function randomPick(card: RaceCard, reason: WinReason, rng: Rng): Winner | null {
  const e = choose(eligible(card), rng);
  // Every runner scratched: nothing to draw; the workflow's own timeout fails the pick.
  return e?.country_iso ? { number: e.number, country_iso: e.country_iso, reason, tied: [] } : null;
}
