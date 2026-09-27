// A local server restart must not strand picks (SPEC.md F13), and concurrent
// writes to the local stores must not lose updates.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundledCountries } from "../../src/domain/countries";
import { parseCuisine, type Place, type Places } from "../../src/domain/places";
import type { Race, RaceProvider, RaceUpdate } from "../../src/domain/race";
import { seeded } from "../../src/domain/rng";
import { newSession, type PickSession } from "../../src/domain/session";
import { recordVisit } from "../../src/domain/store";
import { addMs, ms, MINUTE, type Iso } from "../../src/domain/time";
import { contractRestaurant } from "../store/contract";
import { FileStore } from "../../src/store/file";
import { MemoryStore } from "../../src/store/state";
import { defaultConfig, runPick, type Clock, type Deps } from "../../src/app/workflow";

const T0 = "2026-09-22T10:35:00.000Z";
const at = (m: number) => addMs(T0, m * MINUTE);

class FakeClock implements Clock {
  constructor(public t: Iso = T0) {}
  now() {
    return this.t;
  }
  async sleepUntil(t: Iso, signal?: AbortSignal) {
    if (signal?.aborted) return;
    if (ms(t) > ms(this.t)) this.t = t;
  }
}

const race: Race = {
  id: "mombetsu-10",
  meeting_id: "m",
  venue: "Mombetsu",
  venue_country: "JPN",
  race_number: 10,
  name: "Test",
  race_type: "gallops",
  status: "open",
  start_time: at(5),
  runners: [1, 2, 3].map((n) => ({ number: n, name: `H${n}`, scratched: false })),
};

/** Open when the race is chosen, final (runner 1 wins) after that. */
class Races implements RaceProvider {
  calls = 0;
  async schedule() {
    return [race];
  }
  async update(): Promise<RaceUpdate> {
    return this.calls++ === 0
      ? { race, placings: [] }
      : { race: { ...race, status: "final" }, placings: [{ position: 1, number: 1 }] };
  }
}

const places: Places = {
  async nearby(): Promise<Place[]> {
    return bundledCountries()
      .all.slice(0, 95)
      .map((c, i) => ({
        id: `osm:node/${i}`,
        name: c.name,
        lat: -36.85,
        lon: 174.76,
        address: null,
        amenity: "restaurant",
        cuisine: parseCuisine(c.cuisine_tags[0] ?? ""),
        distance_m: 10,
      }));
  },
};

function deps(store: Deps["store"], races = new Races()): Deps {
  return {
    races,
    places,
    store,
    countries: bundledCountries(),
    config: defaultConfig(),
  };
}

const session = (): PickSession =>
  newSession(
    "p1",
    T0,
    { radius_m: 500, min_population: 10_000_000, include_visited: false, max_wait_min: 10 },
    { lat: -36.85, lon: 174.76, display_name: "Sky Tower" },
  );

describe("resuming a pick after a restart (F13)", () => {
  it("a pick stopped while waiting for the start finishes when resumed", async () => {
    const store = new FileStore(join(mkdtempSync(join(tmpdir(), "fat-horses-")), "store.json"));
    // First server: stops (Ctrl+C) while waiting for the start, as the stranded picks did.
    const stop = new AbortController();
    await runPick(
      deps(store),
      session(),
      new FakeClock(),
      seeded(1),
      (s) => {
        if (s.status === "waiting_start" && s.places_loaded) stop.abort();
      },
      stop.signal,
    );
    const stranded = await store.getPick("p1");
    expect(stranded?.status).toBe("waiting_start");
    expect(stranded?.places_loaded).toBe(true);

    // Second server: a new store instance over the same file, and a clock after the race.
    const restarted = new FileStore(store.path);
    expect((await restarted.unfinishedPicks()).map((p) => p.pick_id)).toEqual(["p1"]);
    const races = new Races();
    races.calls = 1; // the race is over: TAB reports the result straight away
    const done = await runPick(deps(restarted, races), stranded!, new FakeClock(at(20)), seeded(1));
    expect(done.status).toBe("done");
    expect(done.winner?.number).toBe(1);
    expect(done.pick).not.toBeNull();
    // The race and countries drawn before the restart were kept, not re-drawn.
    expect(done.card).toEqual(stranded!.card);
    expect(await restarted.unfinishedPicks()).toEqual([]);
  });

  it("unfinished means not done, failed or cancelled", async () => {
    const store = new MemoryStore();
    const s = session();
    await store.putPick({ ...s, pick_id: "a", status: "waiting_start" });
    await store.putPick({ ...s, pick_id: "b", status: "done" });
    await store.putPick({ ...s, pick_id: "c", status: "failed" });
    await store.putPick({ ...s, pick_id: "d", status: "cancelled" });
    await store.putPick({ ...s, pick_id: "e", status: "running" });
    expect((await store.unfinishedPicks()).map((p) => p.pick_id).sort()).toEqual(["a", "e"]);
  });
});

describe("local stores under concurrent writes", () => {
  it.each([
    ["memory", () => new MemoryStore()],
    ["file", () => new FileStore(join(mkdtempSync(join(tmpdir(), "fat-horses-")), "store.json"))],
  ])("%s store keeps every write", async (_name, make) => {
    const store = make();
    const s = session();
    await Promise.all([
      store.putPick({ ...s, pick_id: "a" }),
      store.putPick({ ...s, pick_id: "b" }),
      recordVisit(store, "osm:node/1", contractRestaurant("osm:node/1", "JP"), T0),
      store.putGeocode("k", { results: [], created_at: T0 }),
    ]);
    expect(await store.getPick("a")).not.toBeNull();
    expect(await store.getPick("b")).not.toBeNull();
    expect((await store.getRestaurant("osm:node/1"))?.status).toBe("VISITED");
    expect(await store.getGeocode("k")).not.toBeNull();
  });
});
