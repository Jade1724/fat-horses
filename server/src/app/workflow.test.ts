// Whole-pick scenarios with fakes, one step at a time too (SPEC.md §6).

import { describe, expect, it } from "vitest";
import { FakeClassifier, type Guess } from "../domain/classify";
import { Countries, type Country } from "../domain/countries";
import { parseCuisine, PlacesUnavailable, type Place, type Places } from "../domain/places";
import type { Race, RaceProvider, RaceStatus, RaceUpdate } from "../domain/race";
import { seeded } from "../domain/rng";
import { newSession, type PickSession, type PickStatus } from "../domain/session";
import { recordVisit } from "../domain/store";
import { addMs, ms, MINUTE, type Iso } from "../domain/time";
import { contractRestaurant } from "../store/contract";
import { MemoryStore } from "../store/state";
import { defaultConfig, runPick, runStep, type Clock, type Deps } from "./workflow";

const T0 = "2026-09-21T10:00:00.000Z";
const at = (m: number) => addMs(T0, m * MINUTE);

class FakeClock implements Clock {
  constructor(public t: Iso = T0) {}
  now() {
    return this.t;
  }
  async sleepUntil(t: Iso) {
    if (ms(t) > ms(this.t)) this.t = t;
  }
}

/** A fixed schedule, then the given updates in order (the last repeats). */
class FakeRaces implements RaceProvider {
  constructor(
    private readonly races: Race[],
    private readonly updates: RaceUpdate[],
  ) {}
  async schedule() {
    return this.races;
  }
  async update() {
    const next = this.updates.length > 1 ? this.updates.shift() : this.updates[0];
    if (!next) throw new Error("no updates");
    return next;
  }
}

/** Returns its places after failing the first `failures` calls. */
class FakePlaces implements Places {
  constructor(
    private readonly places: Place[],
    private failures = 0,
  ) {}
  async nearby() {
    if (this.failures > 0) {
      this.failures--;
      throw new PlacesUnavailable("504");
    }
    return this.places;
  }
}

const country = (iso2: string, name: string, tags: string[], dishes: string[]): Country => ({
  iso2,
  name,
  flag: "🏳",
  population: 50_000_000,
  cuisine_tags: tags,
  dishes,
});

const countries = new Countries({
  source: { population: "test", year: 2025 },
  countries: [
    country("JP", "Japan", ["japanese", "sushi"], ["sushi", "ramen", "miso"]),
    country("IT", "Italy", ["italian", "pizza"], ["pizza", "pasta", "gelato"]),
    country("MX", "Mexico", ["mexican"], ["tacos", "mole", "tamales"]),
  ],
});

const place = (id: string, name: string, cuisine: string): Place => ({
  id,
  name,
  lat: -36.85,
  lon: 174.76,
  address: null,
  amenity: "restaurant",
  cuisine: parseCuisine(cuisine),
  tags: {},
  distance_m: 50,
});

/** One tagged restaurant per country, so any winner has a match. */
const onePerCountry = () => [
  place("osm:node/1", "Sakura", "sushi"),
  place("osm:node/2", "Roma", "pizza"),
  place("osm:node/3", "Taqueria", "mexican"),
];

const race = (status: RaceStatus): Race => ({
  id: "r1",
  meeting_id: "m1",
  venue: "Ellerslie",
  venue_country: "NZ",
  race_number: 3,
  name: "Test Stakes",
  race_type: "gallops",
  status,
  start_time: at(8),
  runners: [1, 2, 3].map((n) => ({ number: n, name: `Horse ${n}`, scratched: false })),
});

const update = (status: RaceStatus, placings: [number, number][] = []): RaceUpdate => ({
  race: race(status),
  placings: placings.map(([position, number]) => ({ position, number })),
});

const openThen = (result: RaceUpdate) => [update("open"), update("closed"), result];

const session = (): PickSession =>
  newSession(
    "p1",
    T0,
    { radius_m: 200, min_population: 10_000_000, include_visited: false },
    { lat: -36.85, lon: 174.76, display_name: "Sky Tower" },
  );

function deps(over: Partial<Deps> & { updates?: RaceUpdate[]; schedule?: Race[] } = {}): Deps {
  return {
    races: new FakeRaces(over.schedule ?? [race("open")], over.updates ?? []),
    places: over.places ?? new FakePlaces(onePerCountry()),
    classifier: over.classifier ?? new FakeClassifier(),
    store: over.store ?? new MemoryStore(),
    countries,
    config: defaultConfig(),
  };
}

async function run(d: Deps) {
  const statuses: PickStatus[] = [];
  const s = await runPick(d, session(), new FakeClock(), seeded(7), (x) => statuses.push(x.status));
  return { s, statuses };
}

const guess = (id: string, tag: string): Guess => ({
  place_id: id,
  cuisines: [{ tag, confidence: 0.9 }],
  reason: `${tag} name`,
});

describe("runPick", () => {
  it("normal pick", async () => {
    const d = deps({
      updates: openThen(
        update("final", [
          [1, 2],
          [2, 1],
          [3, 3],
        ]),
      ),
    });
    const { s, statuses } = await run(d);
    expect(s.status).toBe("done");
    expect(s.winner).toMatchObject({ number: 2, reason: "result" });
    expect(s.card?.entries.find((e) => e.number === 2)?.country_iso).toBe(s.winner?.country_iso);
    expect(s.matches).toHaveLength(1);
    expect(s.matches[0]?.match).toBe("tagged");
    const picked = await d.store.currentlyPicked();
    expect(picked?.id).toBe(s.pick);
    expect(picked?.status).toBe("PICKED");
    expect(picked?.country_iso).toBe(s.winner?.country_iso);
    expect(await d.store.getPick("p1")).toEqual(s);
    expect(statuses[0]).toBe("finding_race");
    expect(statuses).toContain("waiting_start");
    expect(statuses).toContain("running");
    expect(statuses.at(-1)).toBe("done");
  });

  it("dead heat", async () => {
    const { s } = await run(
      deps({
        updates: openThen(
          update("final", [
            [1, 1],
            [1, 3],
            [3, 2],
          ]),
        ),
      }),
    );
    expect(s.winner?.reason).toBe("dead_heat");
    expect(s.winner?.tied).toEqual([1, 3]);
    expect([1, 3]).toContain(s.winner?.number);
    expect(s.pick).not.toBeNull();
  });

  it("abandoned race draws an assigned country", async () => {
    const { s } = await run(deps({ updates: openThen(update("abandoned")) }));
    expect(s.winner?.reason).toBe("abandoned");
    expect(s.status).toBe("done");
    expect(s.pick).not.toBeNull();
  });

  it("no result times out", async () => {
    const { s } = await run(deps({ updates: [update("open"), update("closed")] }));
    expect(s.winner?.reason).toBe("timeout");
  });

  it("no match is done without a pick", async () => {
    const d = deps({
      updates: openThen(update("final", [[1, 1]])),
      places: new FakePlaces([place("osm:node/9", "Burger Barn", "burger")]),
    });
    const { s } = await run(d);
    expect(s.status).toBe("done");
    expect(s.matches).toEqual([]);
    expect(s.pick).toBeNull();
    expect(await d.store.currentlyPicked()).toBeNull();
    expect(s.llm_unavailable).toBe(false);
  });

  it("LLM failure still finishes", async () => {
    const { s } = await run(
      deps({
        updates: openThen(update("final", [[1, 1]])),
        places: new FakePlaces([place("osm:node/9", "Mystery Kitchen", "")]),
        classifier: FakeClassifier.failing(),
      }),
    );
    expect(s.status).toBe("done");
    expect(s.llm_unavailable).toBe(true);
    expect(s.pick).toBeNull();
  });

  it("inferred matches count as primary", async () => {
    const fake = new FakeClassifier()
      .withGuess(guess("osm:node/1", "japanese"))
      .withGuess(guess("osm:node/2", "italian"))
      .withGuess(guess("osm:node/3", "mexican"));
    const { s } = await run(
      deps({
        updates: openThen(update("final", [[1, 1]])),
        places: new FakePlaces([
          place("osm:node/1", "Sakura", ""),
          place("osm:node/2", "Roma", ""),
          place("osm:node/3", "Taq", ""),
        ]),
        classifier: fake,
      }),
    );
    expect(s.guesses).toHaveLength(3);
    expect(s.matches).toHaveLength(1);
    expect(s.matches[0]?.match).toBe("inferred");
    expect(s.pick).not.toBeNull();
  });

  it("fallback when there is no primary match", async () => {
    let fake = new FakeClassifier();
    for (const n of ["Japan", "Italy", "Mexico"])
      fake = fake.withDishMatch(n, "osm:node/9", "has the dishes");
    const { s } = await run(
      deps({
        updates: openThen(update("final", [[1, 1]])),
        places: new FakePlaces([place("osm:node/9", "Corner Bistro", "")]),
        classifier: fake,
      }),
    );
    expect(s.matches).toEqual([{ place_id: "osm:node/9", match: "fallback", reason: "has the dishes" }]);
    expect(s.pick).toBe("osm:node/9");
  });

  it("a places outage before the race is retried", async () => {
    const { s } = await run(
      deps({ updates: openThen(update("final", [[1, 1]])), places: new FakePlaces(onePerCountry(), 1) }),
    );
    expect(s.status).toBe("done");
    expect(s.places_loaded).toBe(true);
    expect(s.pick).not.toBeNull();
  });

  it("a places outage after the race fails, with the winner shown", async () => {
    const { s } = await run(
      deps({ updates: openThen(update("final", [[1, 1]])), places: new FakePlaces(onePerCountry(), 2) }),
    );
    expect(s.status).toBe("failed");
    expect(s.error).toBe("places_unavailable");
    expect(s.winner).not.toBeNull();
  });

  it("no race fails", async () => {
    const d = deps({ schedule: [] });
    const { s } = await run(d);
    expect(s).toMatchObject({ status: "failed", error: "no_upcoming_race" });
    expect((await d.store.getPick("p1"))?.status).toBe("failed");
  });

  it("world complete when every country is visited", async () => {
    const store = new MemoryStore();
    for (const [id, iso] of [
      ["osm:node/1", "JP"],
      ["osm:node/2", "IT"],
      ["osm:node/3", "MX"],
    ] as const) {
      await recordVisit(store, id, contractRestaurant(id, iso), T0);
    }
    const { s } = await run(deps({ store, updates: openThen(update("final", [[1, 1]])) }));
    expect(s.world_complete).toBe(true);
    expect(new Set(s.card?.entries.map((e) => e.country_iso)).size).toBe(3);
  });

  it("visited countries are drawn last", async () => {
    const store = new MemoryStore();
    for (const [id, iso] of [
      ["osm:node/1", "JP"],
      ["osm:node/2", "IT"],
    ] as const) {
      await recordVisit(store, id, contractRestaurant(id, iso), T0);
    }
    const { s } = await run(deps({ store, updates: openThen(update("final", [[1, 1]])) }));
    expect(s.world_complete).toBe(false);
    expect(s.card?.entries.some((e) => e.country_iso === "MX")).toBe(true);
  });
});

describe("runStep (Step Functions)", () => {
  it("runs one step at a time and is safe to retry", async () => {
    const d = deps({ updates: [update("open"), update("closed"), update("final", [[1, 3]])] });
    await d.store.putPick(session());
    const rng = seeded(3);
    const out = await runStep(d, "start", "p1", T0, rng);
    expect(out).toMatchObject({ status: "waiting_start", start_time: at(8), decided: false, failed: false });
    expect(await runStep(d, "start", "p1", T0, rng)).toEqual(out);
    await runStep(d, "prepare_nearby", "p1", T0, rng);
    const first = await runStep(d, "check_result", "p1", at(8), rng);
    expect(first).toMatchObject({ decided: false, status: "running" });
    expect((await runStep(d, "check_result", "p1", at(9), rng)).decided).toBe(true);
    expect((await runStep(d, "finish", "p1", at(10), rng)).status).toBe("done");
    const s = await d.store.getPick("p1");
    expect(s?.winner?.number).toBe(3);
    expect(s?.pick).not.toBeNull();
    await expect(runStep(d, "start", "missing", T0, rng)).rejects.toThrow(/not found/);
  });

  it("a failed start reports failed", async () => {
    const d = deps({ schedule: [] });
    await d.store.putPick(session());
    expect(await runStep(d, "start", "p1", T0, seeded(1))).toMatchObject({ failed: true, status: "failed" });
  });
});
