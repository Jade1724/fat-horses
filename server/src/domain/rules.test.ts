// Pool (F2), race selection (F3), assignment (F4) and winner (F5).

import { describe, expect, it } from "vitest";
import { applyScratchings, assign, cardEntry, EmptyPoolError, type RaceCard } from "./assign";
import type { Country } from "./countries";
import { DEFAULT_MIN_POPULATION, pool } from "./pool";
import { candidates, hasEnoughRunners, selectRace, type Race, type RaceStatus, type Runner } from "./race";
import { seeded, shuffle } from "./rng";
import { addMs, MINUTE } from "./time";
import { resolve, type ResultSnapshot, type Winner } from "./winner";

const NOW = "2026-09-21T10:00:00.000Z";
const at = (minutes: number) => addMs(NOW, minutes * MINUTE);

function c(iso2: string, population = 20_000_000): Country {
  return { iso2, name: iso2, flag: "🏳", population, cuisine_tags: ["x"], dishes: ["a", "b", "c"] };
}

const isos = (cs: Country[]) => cs.map((x) => x.iso2);

function runner(number: number, scratched = false): Runner {
  return { number, name: `Horse ${number}`, scratched };
}

function race(id: string, minutes: number, over: Partial<Race> = {}): Race {
  return {
    id,
    meeting_id: "m1",
    venue: "Ellerslie",
    venue_country: "NZ",
    race_number: 1,
    name: "Race 1",
    race_type: "gallops",
    status: "open",
    start_time: at(minutes),
    runners: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => runner(n)),
    ...over,
  };
}

describe("pool (F2)", () => {
  const all = [c("JP", 120e6), c("IT", 58e6), c("PT", 10e6), c("NZ", 5e6)];

  it("threshold is inclusive", () => {
    const p = pool(all, DEFAULT_MIN_POPULATION, new Set(), false);
    expect(isos(p.countries)).toEqual(["JP", "IT", "PT"]);
    expect(p.world_complete).toBe(false);
    expect(isos(pool(all, 1e6, new Set(), false).countries)).toEqual(["JP", "IT", "PT", "NZ"]);
  });

  it("leaves out visited countries unless asked", () => {
    const p = pool(all, DEFAULT_MIN_POPULATION, new Set(["IT"]), false);
    expect(isos(p.countries)).toEqual(["JP", "PT"]);
    expect(isos(p.full)).toEqual(["JP", "IT", "PT"]);
    expect(isos(pool(all, DEFAULT_MIN_POPULATION, new Set(["IT"]), true).countries)).toEqual(["JP", "IT", "PT"]);
  });

  it("world complete uses the whole pool", () => {
    const p = pool(all, DEFAULT_MIN_POPULATION, new Set(["JP", "IT", "PT"]), false);
    expect(isos(p.countries)).toEqual(["JP", "IT", "PT"]);
    expect(p.world_complete).toBe(true);
  });

  it("nothing above the threshold is empty, not complete", () => {
    const p = pool(all, Number.MAX_SAFE_INTEGER, new Set(), false);
    expect(p.countries).toEqual([]);
    expect(p.world_complete).toBe(false);
  });
});

describe("race selection (F3)", () => {
  it("picks the earliest in the 2–15 minute window", () => {
    expect(selectRace([race("late", 14), race("soon", 5), race("too_soon", 1)], NOW)?.id).toBe("soon");
    expect(selectRace([race("r", 2)], NOW)?.id).toBe("r");
  });

  it("falls back to the next race, up to three hours", () => {
    expect(selectRace([race("later", 90), race("next", 40), race("gone", -5)], NOW)?.id).toBe("next");
    expect(selectRace([race("tomorrow", 181)], NOW)).toBeUndefined();
    expect(selectRace([race("edge", 180)], NOW)?.id).toBe("edge");
  });

  it("only open gallops races", () => {
    const races = [
      race("harness", 5, { race_type: "harness" }),
      race("dogs", 6, { race_type: "greyhound" }),
      ...(["closed", "interim", "final", "abandoned"] as RaceStatus[]).map((s, i) =>
        race(s, 7 + i, { status: s }),
      ),
      race("ok", 20),
    ];
    expect(candidates(races, NOW).map((r) => r.id)).toEqual(["ok"]);
  });

  it("needs two active runners", () => {
    const thin = race("thin", 5, { runners: [runner(1), runner(2, true), runner(3, true)] });
    expect(selectRace([thin, race("full", 8)], NOW)?.id).toBe("full");
    expect(hasEnoughRunners(race("two", 5, { runners: [runner(1), runner(2), runner(3, true)] }))).toBe(true);
  });

  it("orders candidates by start time", () => {
    expect(candidates([race("c", 30), race("a", 3), race("b", 10)], NOW).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(selectRace([], NOW)).toBeUndefined();
  });
});

describe("assignment (F4)", () => {
  const runners = (n: number) => Array.from({ length: n }, (_, i) => runner(i + 1));
  const assigned = (card: RaceCard) => card.entries.map((e) => e.country_iso).filter((x) => x !== null);

  it("is distinct when the pool is big enough", () => {
    const p = pool(["JP", "IT", "MX", "IN", "TH", "FR", "ET", "PE"].map((i) => c(i)), 0, new Set(), false);
    for (let seed = 0; seed < 50; seed++) {
      const got = assigned(assign(runners(8), p, seeded(seed)));
      expect(new Set(got).size).toBe(8);
    }
  });

  it("uses unvisited countries when there are enough", () => {
    const p = pool(["JP", "IT", "MX", "IN", "TH"].map((i) => c(i)), 0, new Set(["JP", "IT"]), false);
    for (let seed = 0; seed < 50; seed++) {
      expect(assigned(assign(runners(3), p, seeded(seed))).sort()).toEqual(["IN", "MX", "TH"]);
    }
  });

  it("tops up with visited countries before repeating", () => {
    const p = pool(["JP", "IT", "MX", "IN"].map((i) => c(i)), 0, new Set(["JP", "IT"]), false);
    for (let seed = 0; seed < 50; seed++) {
      expect(assigned(assign(runners(4), p, seeded(seed))).sort()).toEqual(["IN", "IT", "JP", "MX"]);
    }
  });

  it("repeats only when forced", () => {
    const p = pool([c("JP"), c("IT")], 0, new Set(), false);
    const got = assigned(assign(runners(5), p, seeded(1)));
    expect(got).toHaveLength(5);
    expect(new Set(got).size).toBe(2);
  });

  it("gives scratched runners no country", () => {
    const p = pool(["JP", "IT", "MX"].map((i) => c(i)), 0, new Set(), false);
    const card = assign([runner(1), runner(2, true), runner(3)], p, seeded(7));
    expect(cardEntry(card, 2)).toMatchObject({ country_iso: null, scratched: true });
    expect(cardEntry(card, 1)?.country_iso).not.toBeNull();
    expect(cardEntry(card, 3)?.country_iso).not.toBeNull();
  });

  it("same seed, same card; different seeds vary", () => {
    const p = pool(["JP", "IT", "MX", "IN", "TH", "FR"].map((i) => c(i)), 0, new Set(), false);
    expect(assign(runners(6), p, seeded(42))).toEqual(assign(runners(6), p, seeded(42)));
    const cards = new Set(Array.from({ length: 20 }, (_, s) => assigned(assign(runners(6), p, seeded(s))).join()));
    expect(cards.size).toBeGreaterThan(1);
  });

  it("an empty pool is an error", () => {
    expect(() => assign(runners(3), pool([], 0, new Set(), false), seeded(0))).toThrow(EmptyPoolError);
  });

  it("records late scratchings", () => {
    const p = pool(["JP", "IT", "MX"].map((i) => c(i)), 0, new Set(), false);
    const card = applyScratchings(assign(runners(3), p, seeded(3)), [runner(2, true), runner(3)]);
    expect(cardEntry(card, 2)?.scratched).toBe(true);
    expect(cardEntry(card, 2)?.country_iso).not.toBeNull();
    expect(cardEntry(card, 3)?.scratched).toBe(false);
  });

  it("shuffle keeps every item", () => {
    expect(shuffle([1, 2, 3, 4], seeded(5)).sort()).toEqual([1, 2, 3, 4]);
  });
});

describe("winner (F5)", () => {
  const card: RaceCard = {
    entries: [
      { number: 1, horse: "A", country_iso: "JP", scratched: false },
      { number: 2, horse: "B", country_iso: "IT", scratched: false },
      { number: 3, horse: "C", country_iso: "MX", scratched: true },
      { number: 4, horse: "D", country_iso: "IN", scratched: false },
    ],
  };
  const snap = (status: RaceStatus, placings: [number, number][]): ResultSnapshot => ({
    status,
    placings: placings.map(([position, number]) => ({ position, number })),
  });
  const win = (w: Winner | null): Winner => {
    expect(w).not.toBeNull();
    return w!;
  };

  it("official result", () => {
    const w = win(resolve(card, snap("final", [[1, 2], [2, 1], [3, 4]]), NOW, at(3), null, seeded(9)));
    expect(w).toEqual({ number: 2, country_iso: "IT", reason: "result", tied: [] });
  });

  it("interim waits ten unchanged minutes", () => {
    const s = snap("interim", [[1, 4]]);
    expect(resolve(card, s, NOW, at(9), at(1), seeded(9))).toBeNull();
    expect(resolve(card, s, NOW, at(9), null, seeded(9))).toBeNull();
    expect(win(resolve(card, s, NOW, at(11), at(1), seeded(9))).country_iso).toBe("IN");
  });

  it("dead heat picks one of the tied at random", () => {
    const s = snap("final", [[1, 1], [1, 4], [3, 2]]);
    const seen = new Set<number>();
    for (let seed = 0; seed < 40; seed++) {
      const w = win(resolve(card, s, NOW, at(3), null, seeded(seed)));
      expect(w.reason).toBe("dead_heat");
      expect(w.tied).toEqual([1, 4]);
      seen.add(w.number);
    }
    expect([...seen].sort()).toEqual([1, 4]);
  });

  it("abandoned draws an active country", () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 60; seed++) {
      const w = win(resolve(card, snap("abandoned", []), NOW, at(1), null, seeded(seed)));
      expect(w.reason).toBe("abandoned");
      expect(w.number).not.toBe(3);
      seen.add(w.country_iso);
    }
    expect([...seen].sort()).toEqual(["IN", "IT", "JP"]);
  });

  it("times out 45 minutes after the start", () => {
    expect(resolve(card, snap("closed", []), NOW, at(44), null, seeded(9))).toBeNull();
    expect(win(resolve(card, snap("closed", []), NOW, at(45), null, seeded(9))).reason).toBe("timeout");
    expect(win(resolve(card, null, NOW, at(50), null, seeded(9))).reason).toBe("timeout");
    expect(win(resolve(card, snap("final", [[1, 1]]), NOW, at(60), null, seeded(9))).reason).toBe("result");
  });

  it("scratched or unknown runners cannot win", () => {
    expect(win(resolve(card, snap("final", [[1, 3], [2, 2], [3, 1]]), NOW, at(3), null, seeded(9))).number).toBe(2);
    expect(win(resolve(card, snap("final", [[1, 99], [2, 4]]), NOW, at(3), null, seeded(9))).number).toBe(4);
    expect(resolve(card, snap("open", []), NOW, at(-1), null, seeded(9))).toBeNull();
  });
});
