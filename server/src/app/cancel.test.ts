// Maximum wait for a race (F3.2) and cancelling a pick (F12).

import { describe, expect, it } from "vitest";
import { FakeClassifier } from "../domain/classify";
import { bundledCountries } from "../domain/countries";
import type { Geocoder } from "../domain/places";
import { parseCuisine, type Place, type Places } from "../domain/places";
import { candidates, type Race, type RaceProvider, type RaceUpdate } from "../domain/race";
import { seeded } from "../domain/rng";
import { newSession, type PickSession } from "../domain/session";
import { cancelPick } from "../domain/store";
import { addMs, ms, MINUTE, type Iso } from "../domain/time";
import { executionArn } from "../lambda/env";
import { MemoryStore } from "../store/state";
import { Api, type ApiRequest, type WorkflowStarter } from "./api";
import { defaultConfig, runPick, runStep, systemClock, type Clock, type Deps } from "./workflow";

const T0 = "2026-09-21T10:00:00.000Z";
const at = (m: number) => addMs(T0, m * MINUTE);

class FakeClock implements Clock {
  t: Iso = T0;
  now() {
    return this.t;
  }
  async sleepUntil(t: Iso) {
    if (ms(t) > ms(this.t)) this.t = t;
  }
}

const race = (startMin: number, status: Race["status"] = "open"): Race => ({
  id: `r${startMin}`,
  meeting_id: "m",
  venue: "Ellerslie",
  venue_country: "NZ",
  race_number: 1,
  name: "Test",
  race_type: "gallops",
  status,
  start_time: at(startMin),
  runners: [1, 2, 3].map((n) => ({ number: n, name: `H${n}`, scratched: false })),
});

/** Each race is open when first looked up (race selection), then has a result. */
class Races implements RaceProvider {
  private readonly seen = new Set<string>();
  constructor(private readonly schedule_: Race[]) {}
  async schedule() {
    return this.schedule_;
  }
  async update(r: Race): Promise<RaceUpdate> {
    if (!this.seen.has(r.id)) {
      this.seen.add(r.id);
      return { race: r, placings: [] };
    }
    return { race: { ...r, status: "final" }, placings: [{ position: 1, number: 1 }] };
  }
}

const places: Places = {
  async nearby(): Promise<Place[]> {
    return ["sushi", "pizza", "mexican", "indian", "chinese"].map((c, i) => ({
      id: `osm:node/${i}`,
      name: c,
      lat: -36.85,
      lon: 174.76,
      address: null,
      amenity: "restaurant",
      cuisine: parseCuisine(c),
      tags: {},
      distance_m: 10,
    }));
  },
};

function deps(schedule: Race[]): Deps {
  return {
    races: new Races(schedule),
    places,
    classifier: new FakeClassifier(),
    store: new MemoryStore(),
    countries: bundledCountries(),
    config: defaultConfig(),
  };
}

const session = (maxWait?: number): PickSession =>
  newSession(
    "p1",
    T0,
    { radius_m: 200, min_population: 10_000_000, include_visited: false, max_wait_min: maxWait },
    { lat: -36.85, lon: 174.76, display_name: "Sky Tower" },
  );

describe("maximum wait (F3.2)", () => {
  it("only races inside the window are candidates", () => {
    const rs = [race(1), race(5), race(10), race(11)];
    expect(candidates(rs, T0, 10 * MINUTE).map((r) => r.id)).toEqual(["r5", "r10"]);
  });

  it("fails at once when no race starts within the default 10 minutes", async () => {
    const d = deps([race(25)]);
    const s = await runPick(d, session(), new FakeClock(), seeded(1));
    expect(s).toMatchObject({ status: "failed", error: "no_upcoming_race", race: null });
  });

  it("a longer maximum wait finds the later race", async () => {
    const s = await runPick(deps([race(25)]), session(30), new FakeClock(), seeded(1));
    expect(s.status).toBe("done");
    expect(s.race?.id).toBe("r25");
  });

  it("picks saved before max_wait_min existed use the default", async () => {
    const old = session();
    delete old.request.max_wait_min;
    const s = await runPick(deps([race(25)]), old, new FakeClock(), seeded(1));
    expect(s.error).toBe("no_upcoming_race");
  });
});

describe("cancelling (F12)", () => {
  it("a cancelled pick stops at the next save and picks nothing", async () => {
    const d = deps([race(8)]);
    const statuses: string[] = [];
    const s = await runPick(d, session(), new FakeClock(), seeded(1), (x) => {
      statuses.push(x.status);
      if (x.status === "waiting_start") void cancelPick(d.store, "p1");
    });
    expect(s.status).toBe("cancelled");
    expect(statuses.at(-1)).toBe("cancelled");
    expect((await d.store.getPick("p1"))?.status).toBe("cancelled");
    expect(await d.store.currentlyPicked()).toBeNull();
  });

  it("aborting the signal stops a waiting run without more steps", async () => {
    const d = deps([race(8)]);
    const abort = new AbortController();
    const s = await runPick(
      d,
      session(),
      new FakeClock(),
      seeded(1),
      (x) => {
        if (x.status === "waiting_start") abort.abort();
      },
      abort.signal,
    );
    expect(s.status).toBe("cancelled");
    expect(s.winner).toBeNull();
    expect(await d.store.currentlyPicked()).toBeNull();
  });

  it("runStep leaves a cancelled pick alone", async () => {
    const d = deps([race(8)]);
    await d.store.putPick(session());
    await cancelPick(d.store, "p1");
    const out = await runStep(d, "start", "p1", T0, seeded(1));
    expect(out).toMatchObject({ status: "cancelled", cancelled: true, failed: true });
    expect((await d.store.getPick("p1"))?.race).toBeNull();
  });

  it("the system clock wakes early when aborted", async () => {
    const abort = new AbortController();
    const started = Date.now();
    const sleeping = systemClock.sleepUntil(addMs(new Date().toISOString(), 60 * MINUTE), abort.signal);
    abort.abort();
    await sleeping;
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("execution ARNs follow the state machine ARN", () => {
    expect(executionArn("arn:aws:states:ap-southeast-2:123:stateMachine:fat-horses", "01J")).toBe(
      "arn:aws:states:ap-southeast-2:123:execution:fat-horses:01J",
    );
  });
});

describe("cancel API (F12)", () => {
  class Starter implements WorkflowStarter {
    cancelled: string[] = [];
    async start() {}
    async cancel(id: string) {
      this.cancelled.push(id);
    }
  }
  const geocoder: Geocoder = { geocode: async () => ({ lat: -36.8, lon: 174.7, display_name: "x" }) };
  const post = (path: string, body: unknown = {}): ApiRequest => ({
    method: "POST",
    path,
    query: {},
    apiKey: "k",
    body: JSON.stringify(body),
  });

  function setup() {
    const store = new MemoryStore();
    const starter = new Starter();
    const api = new Api({ geocoder, store, starter, countries: bundledCountries(), apiKey: "k" });
    return { store, starter, api };
  }

  it("cancels a running pick and stops its workflow", async () => {
    const { api, starter } = setup();
    const r = await api.handle(post("/picks", { address: "Sky Tower" }), T0);
    const id = (r.body as { pick_id: string }).pick_id;
    const c = await api.handle(post(`/picks/${id}/cancel`), T0);
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ pick_id: id, status: "cancelled", max_wait_min: 10 });
    expect(starter.cancelled).toEqual([id]);
  });

  it("leaves finished picks alone and 404s unknown ones", async () => {
    const { api, store, starter } = setup();
    await store.putPick({ ...session(), status: "done" });
    const c = await api.handle(post("/picks/p1/cancel"), T0);
    expect(c.body).toMatchObject({ status: "done" });
    expect(starter.cancelled).toEqual([]);
    expect((await api.handle(post("/picks/nope/cancel"), T0)).status).toBe(404);
  });

  it("validates max_wait_min", async () => {
    const { api } = setup();
    for (const max_wait_min of [4, 181]) {
      const r = await api.handle(post("/picks", { address: "x", max_wait_min }), T0);
      expect(r).toMatchObject({ status: 422, body: { error: "invalid_request" } });
    }
    const ok = await api.handle(post("/picks", { address: "x", max_wait_min: 30 }), T0);
    expect(ok.status).toBe(202);
  });
});
