// Places (F6.1), classifier validation (§3), matching (F6.2–F6.4), pick (F7),
// status (F8), cached guessing (L5–L6).

import { describe, expect, it } from "vitest";
import {
  FakeClassifier,
  MAX_REASON_CHARS,
  ClassifierError,
  placeInput,
  validateDishMatches,
  validateGuesses,
  type Guess,
} from "./classify";
import type { Country } from "./countries";
import { guessUntagged, inputHash, type GuessConfig } from "./guessing";
import { chooseRestaurant, inferredMatches, primaryMatches, taggedMatches, type Match } from "./matching";
import { distanceM, normaliseAddress, osmId, parseCuisine, type Place } from "./places";
import { seeded } from "./rng";
import { applyEvent, InvalidTransition, type Restaurant, type Status } from "./status";
import { isFresh, logKey, pickedAfter, GEOCODE_TTL_MS, type CachedGuess, type Store } from "./store";
import { addMs, DAY } from "./time";

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
    tags: {},
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

const guess = (id: string, tags: [string, number][]): Guess => ({
  place_id: id,
  cuisines: tags.map(([tag, confidence]) => ({ tag, confidence })),
  reason: `reason for ${id}`,
});

describe("places", () => {
  it("parses cuisine values", () => {
    expect(parseCuisine("Japanese; sushi")).toEqual(["japanese", "sushi"]);
    expect(parseCuisine(" ramen ;;UDON; ")).toEqual(["ramen", "udon"]);
    expect(parseCuisine("South African")).toEqual(["south_african"]);
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

describe("classifier output validation (L4)", () => {
  const ids = new Set(["osm:node/1", "osm:node/2"]);
  const tags = new Set(["japanese", "sushi", "italian"]);

  it("keeps valid guesses and drops unknown places", () => {
    const g = validateGuesses(
      JSON.stringify({
        guesses: [
          { place_id: "osm:node/1", cuisines: [{ tag: "japanese", confidence: 0.9 }], reason: "Sakura Sushi" },
          { place_id: "osm:node/99", cuisines: [], reason: "x" },
        ],
      }),
      ids,
      tags,
    );
    expect(g).toEqual([{ place_id: "osm:node/1", cuisines: [{ tag: "japanese", confidence: 0.9 }], reason: "Sakura Sushi" }]);
  });

  it("drops unknown tags and bad confidence, keeps one guess per place", () => {
    const g = validateGuesses(
      JSON.stringify({
        guesses: [
          {
            place_id: "osm:node/1",
            cuisines: [
              { tag: "Japanese", confidence: 0.8 },
              { tag: "martian", confidence: 0.9 },
              { tag: "sushi", confidence: 1.5 },
              { tag: "italian", confidence: -0.1 },
            ],
            reason: "first",
          },
          { place_id: "osm:node/1", cuisines: [], reason: "second" },
        ],
      }),
      ids,
      tags,
    );
    expect(g).toEqual([{ place_id: "osm:node/1", cuisines: [{ tag: "japanese", confidence: 0.8 }], reason: "first" }]);
  });

  it("clamps long reasons", () => {
    const g = validateGuesses(
      JSON.stringify({ guesses: [{ place_id: "osm:node/1", cuisines: [], reason: "x".repeat(300) }] }),
      ids,
      tags,
    );
    expect([...g[0]!.reason]).toHaveLength(MAX_REASON_CHARS);
    expect(g[0]!.reason.endsWith("…")).toBe(true);
  });

  it.each(["", "not json", '{"guesses":"no"}', '{"other":[]}'])("rejects %j", (bad) => {
    expect(() => validateGuesses(bad, ids, tags)).toThrow(ClassifierError);
  });

  it("validates dish matches", () => {
    const m = validateDishMatches(
      JSON.stringify({
        matches: [
          { place_id: "osm:node/2", reason: "Serves raclette" },
          { place_id: "osm:node/2", reason: "dup" },
          { place_id: "osm:node/7", reason: "unknown" },
        ],
      }),
      ids,
    );
    expect(m).toEqual([{ place_id: "osm:node/2", reason: "Serves raclette" }]);
    expect(() => validateDishMatches("[]", ids)).toThrow(ClassifierError);
  });

  it("FakeClassifier returns configured answers", async () => {
    const fake = new FakeClassifier()
      .withGuess(guess("osm:node/1", []))
      .withDishMatch("Switzerland", "osm:node/2", "fondue")
      .withDishMatch("Switzerland", "osm:node/3", "not asked");
    const inputs = [place("osm:node/1", ""), place("osm:node/2", "")].map(placeInput);
    expect(await fake.guessCuisines(inputs)).toHaveLength(1);
    expect(await fake.matchDishes(inputs, { name: "Switzerland", dishes: ["fondue"] })).toHaveLength(1);
    expect(fake.guessedPlaces).toEqual(["osm:node/1", "osm:node/2"]);
    await expect(FakeClassifier.failing().guessCuisines(inputs)).rejects.toThrow(ClassifierError);
  });
});

describe("matching (F6.2–F6.4)", () => {
  it("tier 1 matches any cuisine value", () => {
    const ms = taggedMatches(
      [place("osm:node/1", "Japanese; sushi"), place("osm:way/2", "ramen"), place("osm:node/3", "italian"), place("osm:node/4", "")],
      japan,
    );
    expect(ms.map((m) => m.place_id)).toEqual(["osm:node/1", "osm:way/2"]);
    expect(ms.every((m) => m.match === "tagged" && m.reason === null)).toBe(true);
  });

  it("tier 2 needs the threshold and an untagged place", () => {
    const places = [place("osm:node/1", ""), place("osm:node/2", ""), place("osm:node/3", ""), place("osm:node/4", "italian")];
    const guesses = [
      guess("osm:node/1", [["japanese", 0.7]]),
      guess("osm:node/2", [["japanese", 0.69]]),
      guess("osm:node/3", [["italian", 0.95], ["sushi", 0.8]]),
      guess("osm:node/4", [["japanese", 0.99]]),
    ];
    const ms = inferredMatches(places, guesses, japan, 0.7);
    expect(ms.map((m) => m.place_id)).toEqual(["osm:node/1", "osm:node/3"]);
    expect(ms[0]).toEqual({ place_id: "osm:node/1", match: "inferred", reason: "reason for osm:node/1" });
    expect(inferredMatches([place("osm:node/9", "")], [], japan, 0.7)).toEqual([]);
  });

  it("primary is tagged then inferred", () => {
    const ms = primaryMatches([place("osm:node/1", ""), place("osm:node/2", "sushi")], [guess("osm:node/1", [["ramen", 0.9]])], japan, 0.7);
    expect(ms.map((m) => [m.place_id, m.match])).toEqual([
      ["osm:node/2", "tagged"],
      ["osm:node/1", "inferred"],
    ]);
  });
});

describe("choosing the restaurant (F7)", () => {
  const m = (id: string, match: Match["match"] = "tagged"): Match => ({ place_id: id, match, reason: null });
  const picks = (primary: Match[], fallback: Match[], visited: string[]) =>
    new Set(
      Array.from({ length: 100 }, (_, s) =>
        chooseRestaurant(primary, fallback, (id) => (visited.includes(id) ? 1 : 0), seeded(s))?.place_id,
      ),
    );

  it("chooses among all primary matches", () => {
    expect(picks([m("a"), m("b", "inferred")], [], [])).toEqual(new Set(["a", "b"]));
  });

  it("prefers never-visited, else all", () => {
    expect(picks([m("a"), m("b"), m("c")], [], ["a", "b"])).toEqual(new Set(["c"]));
    expect(picks([m("a"), m("b")], [], ["a", "b"])).toEqual(new Set(["a", "b"]));
  });

  it("uses fallback only without primary matches", () => {
    expect(picks([m("a")], [m("f", "fallback")], ["a"])).toEqual(new Set(["a"]));
    expect(picks([], [m("f", "fallback")], [])).toEqual(new Set(["f"]));
    expect(chooseRestaurant([], [], () => 0, seeded(0))).toBeUndefined();
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
    expect(t.restaurant).toMatchObject({ status: "PICKED", status_before_pick: null, picked_at: NOW, pick_id: "p1" });
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
    expect(t.restaurant).toMatchObject({ status: "VISITED", status_before_pick: null, visit_count: 1, visited_at: NOW });
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
    expect(applyEvent(pickedVisited, { kind: "skip" }, NOW).restaurant).toMatchObject({ status: "VISITED", visit_count: 1 });
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

describe("cached guessing (L5, L6)", () => {
  const config = (v = 1): GuessConfig => ({ prompt_version: v, model_id: "fake" });
  function cache(): Pick<Store, "getGuess" | "putGuess"> {
    const m = new Map<string, CachedGuess>();
    return {
      getGuess: async (id, v) => m.get(`${id}#${v}`) ?? null,
      putGuess: async (g) => void m.set(`${g.guess.place_id}#${g.prompt_version}`, g),
    };
  }

  it("asks only about untagged places", async () => {
    const fake = new FakeClassifier().withGuess(guess("osm:node/1", [["japanese", 0.9]]));
    const out = await guessUntagged([place("osm:node/1", ""), place("osm:node/2", "thai")], fake, cache(), config(), NOW);
    expect(out.guesses.map((g) => g.place_id)).toEqual(["osm:node/1"]);
    expect(fake.guessedPlaces).toEqual(["osm:node/1"]);
    expect(out.llm_unavailable).toBe(false);
  });

  it("reuses cached guesses until the place, prompt or age changes", async () => {
    const places = [place("osm:node/1", "")];
    const fake = new FakeClassifier().withGuess(guess("osm:node/1", [["japanese", 0.9]]));
    const c = cache();
    await guessUntagged(places, fake, c, config(), NOW);
    await guessUntagged(places, fake, c, config(), NOW);
    expect(fake.guessCalls).toBe(1);
    places[0]!.name = "Renamed";
    await guessUntagged(places, fake, c, config(), NOW);
    expect(fake.guessCalls).toBe(2);
    await guessUntagged(places, fake, c, config(2), NOW);
    expect(fake.guessCalls).toBe(3);
    await guessUntagged(places, fake, c, config(2), addMs(NOW, 181 * DAY));
    expect(fake.guessCalls).toBe(4);
  });

  it("caches skipped places as empty guesses", async () => {
    const fake = new FakeClassifier();
    const c = cache();
    const out = await guessUntagged([place("osm:node/1", "")], fake, c, config(), NOW);
    expect(out.guesses[0]!.cuisines).toEqual([]);
    await guessUntagged([place("osm:node/1", "")], fake, c, config(), NOW);
    expect(fake.guessCalls).toBe(1);
  });

  it("batches of 50, at most 200 closest", async () => {
    const places = Array.from({ length: 230 }, (_, i) => place(`osm:node/${i}`, "", i));
    const fake = new FakeClassifier();
    const out = await guessUntagged(places, fake, cache(), config(), NOW);
    expect(fake.guessCalls).toBe(4);
    expect(out.guesses).toHaveLength(200);
    expect(fake.guessedPlaces).toContain("osm:node/199");
    expect(fake.guessedPlaces).not.toContain("osm:node/200");
  });

  it("failure marks llm_unavailable", async () => {
    const out = await guessUntagged([place("osm:node/1", "")], FakeClassifier.failing(), cache(), config(), NOW);
    expect(out).toEqual({ guesses: [], llm_unavailable: true });
  });

  it("hash depends on name and tags", () => {
    const p = placeInput(place("osm:node/1", ""));
    expect(inputHash(p)).toBe(inputHash({ ...p }));
    expect(inputHash(p)).not.toBe(inputHash({ ...p, tags: { website: "x" } }));
    expect(inputHash(p)).toHaveLength(64);
  });
});
