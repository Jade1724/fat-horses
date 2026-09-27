// Dish picks (F15): cleaning a menu, giving dishes to horses, and the podium.

import { describe, expect, it } from "vitest";
import type { RaceCard } from "../../src/domain/assign";
import { assignDishes, InvalidDishes, validateDishes } from "../../src/domain/dishes";
import { hasEnoughRunners, type Race, type Runner } from "../../src/domain/race";
import { seeded } from "../../src/domain/rng";
import { addMs, MINUTE } from "../../src/domain/time";
import { resolvePodium, type Placing, type PodiumPlace, type ResultSnapshot } from "../../src/domain/winner";

const NOW = "2026-09-21T10:00:00.000Z";
const at = (minutes: number) => addMs(NOW, minutes * MINUTE);

const runner = (number: number, scratched = false): Runner => ({
  number,
  name: `Horse ${number}`,
  scratched,
});
const runners = (n: number) => Array.from({ length: n }, (_, i) => runner(i + 1));
const snap = (status: ResultSnapshot["status"], placings: [number, number][] = []): ResultSnapshot => ({
  status,
  placings: placings.map(([position, number]): Placing => ({ position, number })),
});

/** A card with the given dishes, runner n carrying dishes[n - 1]. */
function card(dishes: string[], scratched: number[] = []): RaceCard {
  return {
    entries: dishes.map((dish, i) => ({
      number: i + 1,
      horse: `Horse ${i + 1}`,
      country_iso: null,
      dish,
      scratched: scratched.includes(i + 1),
    })),
  };
}

const dishesOf = (p: PodiumPlace[] | null) => p?.map((x) => x.dish);

describe("validateDishes", () => {
  it("trims, collapses spaces and drops duplicates regardless of case", () => {
    expect(validateDishes(["  Pad  Thai ", "pad thai", "Green curry", "", "Satay"])).toEqual([
      "Pad Thai",
      "Green curry",
      "Satay",
    ]);
  });

  it("needs at least three dishes for a podium", () => {
    expect(() => validateDishes(["Soup", "soup", "Bread"])).toThrow(InvalidDishes);
  });

  it("refuses more than 40 dishes and names over 80 characters", () => {
    expect(() => validateDishes(Array.from({ length: 41 }, (_, i) => `Dish ${i}`))).toThrow(InvalidDishes);
    expect(() => validateDishes(["a", "b", "x".repeat(81)])).toThrow(InvalidDishes);
    expect(validateDishes(["a", "b", "x".repeat(80)])).toHaveLength(3);
  });
});

describe("assignDishes (F15)", () => {
  it("gives each horse a different dish when there are enough", () => {
    const c = assignDishes(runners(4), ["A", "B", "C", "D", "E", "F"], seeded(1));
    const drawn = c.entries.map((e) => e.dish);
    expect(new Set(drawn).size).toBe(4);
    expect(c.entries.every((e) => e.country_iso === null)).toBe(true);
  });

  it("runs every dish when there are more horses, repeating some", () => {
    const c = assignDishes(runners(7), ["A", "B", "C"], seeded(2));
    const drawn = c.entries.map((e) => e.dish);
    expect(new Set(drawn)).toEqual(new Set(["A", "B", "C"]));
    expect(drawn).toHaveLength(7);
  });

  it("gives scratched horses no dish", () => {
    const c = assignDishes([runner(1), runner(2, true), runner(3), runner(4)], ["A", "B", "C"], seeded(3));
    expect(c.entries.find((e) => e.number === 2)).toMatchObject({ dish: null, scratched: true });
    expect(new Set(c.entries.filter((e) => !e.scratched).map((e) => e.dish))).toEqual(
      new Set(["A", "B", "C"]),
    );
  });
});

describe("race selection for dishes", () => {
  it("can ask for more runners than a country pick needs", () => {
    const race = { runners: [runner(1), runner(2), runner(3, true)] } as Race;
    expect(hasEnoughRunners(race)).toBe(true);
    expect(hasEnoughRunners(race, 3)).toBe(false);
  });
});

describe("resolvePodium (F15)", () => {
  const menu = card(["Pad Thai", "Green curry", "Satay", "Tom yum", "Larb"]);

  it("is the first three past the post, in order", () => {
    const p = resolvePodium(
      menu,
      snap("final", [
        [1, 3],
        [2, 1],
        [3, 5],
        [4, 2],
      ]),
      NOW,
      at(3),
      null,
      seeded(1),
    );
    expect(p).toEqual([
      { place: 1, number: 3, dish: "Satay", reason: "result" },
      { place: 2, number: 1, dish: "Pad Thai", reason: "result" },
      { place: 3, number: 5, dish: "Larb", reason: "result" },
    ]);
  });

  it("skips a horse whose dish is already on the podium", () => {
    const repeats = card(["Soup", "Soup", "Bread", "Salad"]);
    const p = resolvePodium(
      repeats,
      snap("final", [
        [1, 1],
        [2, 2],
        [3, 3],
        [4, 4],
      ]),
      NOW,
      at(3),
      null,
      seeded(1),
    );
    expect(dishesOf(p)).toEqual(["Soup", "Bread", "Salad"]);
    expect(p?.map((x) => x.number)).toEqual([1, 3, 4]);
  });

  it("draws the rest when the result names fewer than three distinct dishes", () => {
    const p = resolvePodium(menu, snap("final", [[1, 2]]), NOW, at(3), null, seeded(4));
    expect(p?.[0]).toEqual({ place: 1, number: 2, dish: "Green curry", reason: "result" });
    expect(p?.slice(1).every((x) => x.reason === "drawn")).toBe(true);
    expect(new Set(dishesOf(p)).size).toBe(3);
  });

  it("marks a dead heat and draws the order between the tied horses", () => {
    const orders = new Set<string>();
    for (let s = 0; s < 40; s++) {
      const p = resolvePodium(
        menu,
        snap("final", [
          [1, 1],
          [1, 2],
          [3, 3],
        ]),
        NOW,
        at(3),
        null,
        seeded(s),
      );
      expect(p?.slice(0, 2).every((x) => x.reason === "dead_heat")).toBe(true);
      expect(p?.[2]).toMatchObject({ number: 3, reason: "result" });
      orders.add(String(p?.slice(0, 2).map((x) => x.number)));
    }
    expect(orders).toEqual(new Set(["1,2", "2,1"]));
  });

  it("never puts a scratched horse on the podium", () => {
    const p = resolvePodium(
      card(["A", "B", "C", "D"], [1]),
      snap("final", [
        [1, 1],
        [2, 2],
        [3, 3],
        [4, 4],
      ]),
      NOW,
      at(3),
      null,
      seeded(1),
    );
    expect(dishesOf(p)).toEqual(["B", "C", "D"]);
  });

  it("waits for an interim result to hold for 10 minutes, like the winner", () => {
    const s = snap("interim", [
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    expect(resolvePodium(menu, s, NOW, at(9), at(1), seeded(1))).toBeNull();
    expect(dishesOf(resolvePodium(menu, s, NOW, at(11), at(1), seeded(1)))).toEqual([
      "Pad Thai",
      "Green curry",
      "Satay",
    ]);
  });

  it("draws all three for an abandoned race or after the timeout", () => {
    const abandoned = resolvePodium(menu, snap("abandoned"), NOW, at(1), null, seeded(5));
    expect(abandoned?.map((x) => x.reason)).toEqual(["abandoned", "abandoned", "abandoned"]);
    expect(new Set(dishesOf(abandoned)).size).toBe(3);
    expect(resolvePodium(menu, snap("closed"), NOW, at(44), null, seeded(5))).toBeNull();
    expect(resolvePodium(menu, snap("closed"), NOW, at(45), null, seeded(5))?.[0]?.reason).toBe("timeout");
  });
});
