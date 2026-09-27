// Deciding the winning country (SPEC.md F5), or the top three dishes (F15), from a race result.

import { cardEntry, type CardEntry, type RaceCard } from "./assign";
import type { RaceStatus } from "./race";
import { choose, shuffle, type Rng } from "./rng";
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
  const settled = settle(snap, now, interimSince);
  if (settled === "abandoned") return randomPick(card, "abandoned", rng);
  if (settled) {
    const w = fromPlacings(card, settled, rng);
    if (w) return w;
  }
  if (timedOut(scheduledStart, now)) return randomPick(card, "timeout", rng);
  return null;
}

/**
 * Placings that can be trusted (F5.2): a final result, or an interim one that
 * has held for INTERIM_GRACE_MS. "abandoned" when the race won't be run.
 */
function settle(
  snap: ResultSnapshot | null,
  now: Iso,
  interimSince: Iso | null,
): Placing[] | "abandoned" | null {
  switch (snap?.status) {
    case "final":
      return snap.placings;
    case "interim":
      return interimSince !== null && ms(now) - ms(interimSince) >= INTERIM_GRACE_MS ? snap.placings : null;
    case "abandoned":
      return "abandoned";
    default:
      return null;
  }
}

function timedOut(scheduledStart: Iso, now: Iso): boolean {
  return ms(now) - ms(scheduledStart) >= RESULT_TIMEOUT_MS;
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

export type PodiumReason = "result" | "dead_heat" | "drawn" | "abandoned" | "timeout";

/** One place on a dish pick's podium (F15). */
export interface PodiumPlace {
  place: number;
  number: number;
  dish: string;
  /** "dead_heat": tied with the next or previous place, order drawn; "drawn": not placed, filled at random. */
  reason: PodiumReason;
}

/**
 * The top three distinct dishes, or null to poll again (F15). Settles exactly
 * when the winner would (F5.2–F5.4). A horse whose dish is already on the
 * podium is passed over; places the result doesn't fill are drawn at random
 * from the other runners' dishes.
 */
export function resolvePodium(
  card: RaceCard,
  snap: ResultSnapshot | null,
  scheduledStart: Iso,
  now: Iso,
  interimSince: Iso | null,
  rng: Rng,
): PodiumPlace[] | null {
  const settled = settle(snap, now, interimSince);
  if (settled === "abandoned") return fill([], dishRunners(card), "abandoned", rng);
  if (settled) {
    const p = podiumFromPlacings(card, settled, rng);
    if (p) return p;
  }
  if (timedOut(scheduledStart, now)) return fill([], dishRunners(card), "timeout", rng);
  return null;
}

const PODIUM = 3;

function dishRunners(card: RaceCard): (CardEntry & { dish: string })[] {
  return card.entries.filter((e): e is CardEntry & { dish: string } => !e.scratched && !!e.dish);
}

function podiumFromPlacings(card: RaceCard, placings: readonly Placing[], rng: Rng): PodiumPlace[] | null {
  const runners = dishRunners(card);
  const byNumber = new Map(runners.map((e) => [e.number, e]));
  const valid = placings.filter((p) => byNumber.has(p.number));
  if (valid.length === 0) return null;

  const podium: PodiumPlace[] = [];
  const positions = [...new Set(valid.map((p) => p.position))].sort((a, b) => a - b);
  for (const position of positions) {
    const tied = [...new Set(valid.filter((p) => p.position === position).map((p) => p.number))];
    const reason: PodiumReason = tied.length > 1 ? "dead_heat" : "result";
    for (const number of shuffle(
      tied.sort((a, b) => a - b),
      rng,
    )) {
      const e = byNumber.get(number);
      if (e && podium.length < PODIUM && !podium.some((x) => x.dish === e.dish)) {
        podium.push({ place: podium.length + 1, number, dish: e.dish, reason });
      }
    }
  }
  return fill(podium, runners, "drawn", rng);
}

/** Top the podium up to three distinct dishes, drawn at random from `runners`. */
function fill(
  podium: PodiumPlace[],
  runners: readonly (CardEntry & { dish: string })[],
  reason: PodiumReason,
  rng: Rng,
): PodiumPlace[] {
  const out = [...podium];
  for (const e of shuffle(runners, rng)) {
    if (out.length >= PODIUM) break;
    if (!out.some((x) => x.dish === e.dish))
      out.push({ place: out.length + 1, number: e.number, dish: e.dish, reason });
  }
  return out;
}
