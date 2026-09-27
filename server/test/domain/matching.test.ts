// Places (F6.1), matching by cuisine tag (F6.2), who may run (F2.2), pick (F7),
// status (F8).

import { describe, expect, it } from "vitest";
import type { Country } from "../../src/domain/countries";
import {
  chooseRestaurant,
  countriesWithTaggedPlaces,
  taggedMatches,
  type Match,
} from "../../src/domain/matching";
import { distanceM, normaliseAddress, osmId, parseCuisine, type Place } from "../../src/domain/places";
import { seeded } from "../../src/domain/rng";
import { applyEvent, InvalidTransition, type Restaurant, type Status } from "../../src/domain/status";
import { isFresh, logKey, pickedAfter, GEOCODE_TTL_MS } from "../../src/domain/store";
import { addMs, DAY } from "../../src/domain/time";

const NOW = "2026-09-21T10:00:00.000Z";

export function place(id: string, cuisine: string, distance = 100): Place {
  return {
    id,
    name: `Place ${id}`,
    lat: -36.85,
    lon: 174.76,
    address: null,
    amenity: "restaurant",
    cuisine: parseCuisine(cuisine),
    distance_m: distance,
  };
}

const japan: Country = {
  iso2: "JP",
  name: "Japan",
  flag: "🇯🇵",
  population: 123e6,
  cuisine_tags: ["japanese", "sushi", "ramen"],
  dishes: ["sushi", "ramen", "tempura"],
};

describe("places", () => {
  it("parses cuisine values", () => {
    expect(parseCuisine("Japanese; sushi")).toEqual(["japanese", "sushi"]);
    expect(parseCuisine(" ramen ;;UDON; ")).toEqual(["ramen", "udon"]);
    expect(parseCuisine("South African")).toEqual(["south_african"]);
    expect(parseCuisine("Tex-Mex;italian-pizza")).toEqual(["tex_mex", "italian_pizza"]);
    expect(parseCuisine("thai;Thai; thai")).toEqual(["thai"]);
    expect(parseCuisine(" ; ")).toEqual([]);
  });

  it("ids, addresses and distances", () => {
    expect(osmId("way", 9)).toBe("osm:way/9");
    expect(normaliseAddress("  1 Queen   Street,\tAuckland ")).toBe("1 queen street, auckland");
    expect(distanceM(-36.8, 174.7, -36.8, 174.7)).toBe(0);
    expect(Math.abs(distanceM(0, 0, 1, 0) - 111_195)).toBeLessThan(50);
  });
});

describe("matching by cuisine tag (F6.2)", () => {
  it("matches any cuisine value", () => {
    const ms = taggedMatches(
      [
        place("osm:node/1", "Japanese; sushi"),
        place("osm:way/2", "ramen"),
        place("osm:node/3", "italian"),
        place("osm:node/4", ""),
      ],
      japan,
    );
    expect(ms.map((m) => m.place_id)).toEqual(["osm:node/1", "osm:way/2"]);
    expect(ms.every((m) => m.match === "tagged" && m.reason === null)).toBe(true);
  });
});

describe("countries that can enter the race (F2.2)", () => {
  const italy: Country = { ...japan, iso2: "IT", name: "Italy", cuisine_tags: ["italian", "pizza"] };
  const algeria: Country = { ...japan, iso2: "DZ", name: "Algeria", cuisine_tags: ["algerian", "maghreb"] };

  it("keeps only countries with a tagged restaurant nearby", () => {
    const nearby = [place("osm:node/1", "ramen"), place("osm:node/2", "pizza;burger")];
    expect(countriesWithTaggedPlaces([japan, italy, algeria], nearby).map((c) => c.iso2)).toEqual([
      "JP",
      "IT",
    ]);
  });

  it("ignores untagged places", () => {
    expect(countriesWithTaggedPlaces([japan, italy], [place("osm:node/1", "")])).toEqual([]);
  });

  it("is empty when nothing nearby has a cuisine any country claims", () => {
    expect(countriesWithTaggedPlaces([japan, italy, algeria], [place("osm:node/1", "burger")])).toEqual([]);
  });
});

describe("choosing the restaurant (F7)", () => {
  const m = (id: string): Match => ({ place_id: id, match: "tagged", reason: null });
  const picks = (matches: Match[], visited: string[]) =>
    new Set(
      Array.from(
        { length: 100 },
        (_, s) => chooseRestaurant(matches, (id) => (visited.includes(id) ? 1 : 0), seeded(s))?.place_id,
      ),
    );

  it("chooses among all matches", () => {
    expect(picks([m("a"), m("b")], [])).toEqual(new Set(["a", "b"]));
  });

  it("prefers never-visited, else all", () => {
    expect(picks([m("a"), m("b"), m("c")], ["a", "b"])).toEqual(new Set(["c"]));
    expect(picks([m("a"), m("b")], ["a", "b"])).toEqual(new Set(["a", "b"]));
  });

  it("is undefined without matches", () => {
    expect(chooseRestaurant([], () => 0, seeded(0))).toBeUndefined();
  });
});

export function restaurant(status: Status = null, id = "osm:node/1", country = "JP"): Restaurant {
  return {
    id,
    name: `Restaurant ${id}`,
    lat: -36.85,
    lon: 174.76,
    address: null,
    cuisine: ["japanese"],
    country_iso: country,
    status,
    status_before_pick: null,
    picked_at: null,
    visited_at: null,
    visit_count: status === "VISITED" ? 1 : 0,
    pick_id: null,
    match: "tagged",
    reason: null,
  };
}

describe("status state machine (F8)", () => {
  const pick = { kind: "pick", pick_id: "p1" } as const;

  it("null → PICKED", () => {
    const t = applyEvent(restaurant(), pick, NOW);
    expect(t.restaurant).toMatchObject({
      status: "PICKED",
      status_before_pick: null,
      picked_at: NOW,
      pick_id: "p1",
    });
    expect(t.expected_status).toBeNull();
    expect(t.country_visited).toBe(false);
    expect(t.log).toMatchObject({ reason: "picked", from: null, to: "PICKED", pick_id: "p1" });
  });

  it("VISITED → PICKED remembers VISITED; picked again keeps it", () => {
    const t = applyEvent(restaurant("VISITED"), pick, NOW);
    expect(t.restaurant).toMatchObject({ status: "PICKED", status_before_pick: "VISITED", visit_count: 1 });
    const again = applyEvent(t.restaurant, { kind: "pick", pick_id: "p2" }, NOW);
    expect(again.restaurant).toMatchObject({ status_before_pick: "VISITED", pick_id: "p2" });
  });

  it("PICKED → VISITED", () => {
    const t = applyEvent(applyEvent(restaurant(), pick, NOW).restaurant, { kind: "visit" }, NOW);
    expect(t.restaurant).toMatchObject({
      status: "VISITED",
      status_before_pick: null,
      visit_count: 1,
      visited_at: NOW,
    });
    expect(t.country_visited).toBe(true);
    expect(t.expected_status).toBe("PICKED");
    expect(t.log).toMatchObject({ reason: "visited", pick_id: "p1" });
  });

  it("map visits from null and from VISITED", () => {
    const t = applyEvent(restaurant(), { kind: "visit" }, NOW);
    expect(t.restaurant.visit_count).toBe(1);
    const t2 = applyEvent(t.restaurant, { kind: "visit" }, NOW);
    expect(t2.restaurant.visit_count).toBe(2);
    expect([t2.log.from, t2.log.to]).toEqual(["VISITED", "VISITED"]);
  });

  it("skip and supersede restore the status before the pick", () => {
    const picked = applyEvent(restaurant(), pick, NOW).restaurant;
    expect(applyEvent(picked, { kind: "skip" }, NOW).restaurant.status).toBeNull();
    expect(applyEvent(picked, { kind: "supersede" }, NOW).log.reason).toBe("superseded");
    const pickedVisited = applyEvent(restaurant("VISITED"), pick, NOW).restaurant;
    expect(applyEvent(pickedVisited, { kind: "skip" }, NOW).restaurant).toMatchObject({
      status: "VISITED",
      visit_count: 1,
    });
  });

  it.each([null, "VISITED"] as const)("skip or supersede from %s is invalid", (s) => {
    expect(() => applyEvent(restaurant(s), { kind: "skip" }, NOW)).toThrow(InvalidTransition);
    expect(() => applyEvent(restaurant(s), { kind: "supersede" }, NOW)).toThrow(InvalidTransition);
  });
});

describe("store helpers", () => {
  it("freshness", () => {
    expect(isFresh(NOW, GEOCODE_TTL_MS, addMs(NOW, 29 * DAY))).toBe(true);
    expect(isFresh(NOW, GEOCODE_TTL_MS, addMs(NOW, 30 * DAY))).toBe(false);
  });

  it("PICKED pointer follows the change", () => {
    const pick = applyEvent(restaurant(), { kind: "pick", pick_id: "p" }, NOW);
    expect(pickedAfter({ transitions: [pick], expected_picked: "other" })).toBe("osm:node/1");
    const skip = applyEvent(pick.restaurant, { kind: "skip" }, NOW);
    expect(pickedAfter({ transitions: [skip], expected_picked: "osm:node/1" })).toBeNull();
    const visit = applyEvent(restaurant(null, "osm:node/2"), { kind: "visit" }, NOW);
    expect(pickedAfter({ transitions: [visit], expected_picked: "osm:node/9" })).toBe("osm:node/9");
  });

  it("log key format", () => {
    const t = applyEvent(restaurant(), { kind: "visit" }, NOW);
    expect(logKey(t.log)).toBe("2026-09-21T10:00:00.000000Z#osm:node/1#visited");
  });
});
