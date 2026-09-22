// Starting picks (F1) and the HTTP API (§5).

import { describe, expect, it } from "vitest";
import { bundledCountries } from "../domain/countries";
import { GeocoderUnavailable, type Geocoder, type Location } from "../domain/places";
import { recordPick } from "../domain/store";
import { contractRestaurant } from "../store/contract";
import { MemoryStore } from "../store/state";
import { Api, constantTimeEqual, type ApiRequest, type WorkflowStarter } from "./api";
import {
  AddressNotFound,
  AmbiguousAddress,
  InvalidRequest,
  lookupAddress,
  newPickId,
  startPick,
  type StartInput,
} from "./start";

const NOW = "2026-09-21T10:00:00.000Z";
const KEY = "s3cret-key";

const SKY_TOWER: Location = { lat: -36.8485, lon: 174.7622, display_name: "Sky Tower, Auckland" };
const ALBERT_STREETS: Location[] = [
  { lat: -36.94037, lon: 174.85203, display_name: "50, Albert Street, Ōtāhuhu, Auckland" },
  { lat: -36.84642, lon: 174.7646, display_name: "50, Albert Street, City Centre, Auckland" },
];

class FakeGeocoder implements Geocoder {
  readonly scope = "nz";
  calls = 0;
  async search(address: string): Promise<Location[]> {
    this.calls++;
    if (address === "down") throw new GeocoderUnavailable("503");
    if (address.includes("nowhere")) return [];
    if (address.includes("Albert")) return ALBERT_STREETS;
    // Three OSM objects for one building, as Nominatim returns for "Sky Tower".
    return [SKY_TOWER, { ...SKY_TOWER, lat: -36.84809 }, { ...SKY_TOWER, lon: 174.76213 }];
  }
}

class FakeStarter implements WorkflowStarter {
  started: string[] = [];
  cancelled: string[] = [];
  constructor(private readonly fail = false) {}
  async start(id: string) {
    if (this.fail) throw new Error("step functions down");
    this.started.push(id);
  }
  async cancel(id: string) {
    this.cancelled.push(id);
  }
}

describe("startPick (F1)", () => {
  const address = (a: string): StartInput => ({ address: a });

  it("uses defaults and geocodes", async () => {
    const s = await startPick(new FakeGeocoder(), new MemoryStore(), address("Sky Tower"), "p1", NOW);
    expect(s.request).toEqual({
      radius_m: 500,
      min_population: 10_000_000,
      include_visited: false,
      max_wait_min: 10,
    });
    expect(s.location.display_name).toBe("Sky Tower, Auckland");
    expect(s.pick_id).toBe("p1");
  });

  it("caches geocodes by normalised address", async () => {
    const g = new FakeGeocoder();
    const cache = new MemoryStore();
    for (const a of ["Sky Tower", "  sky   TOWER "]) await startPick(g, cache, address(a), "p", NOW);
    expect(g.calls).toBe(1);
  });

  it("coordinates skip geocoding", async () => {
    const g = new FakeGeocoder();
    const s = await startPick(g, new MemoryStore(), { lat: -36.8, lon: 174.7, radius_m: 500 }, "p", NOW);
    expect(s.location.lat).toBe(-36.8);
    expect(s.request.radius_m).toBe(500);
    expect(g.calls).toBe(0);
  });

  it.each<StartInput>([
    {},
    { address: "x", lat: 1, lon: 1 },
    { lat: 1 },
    { lat: 91, lon: 0 },
    { address: "Sky Tower", radius_m: 49 },
    { address: "Sky Tower", radius_m: 2001 },
  ])("rejects %j", async (input) => {
    await expect(startPick(new FakeGeocoder(), new MemoryStore(), input, "p", NOW)).rejects.toThrow(
      InvalidRequest,
    );
  });

  it("unknown address and outage", async () => {
    await expect(
      startPick(new FakeGeocoder(), new MemoryStore(), address("nowhere st"), "p", NOW),
    ).rejects.toThrow(AddressNotFound);
    await expect(startPick(new FakeGeocoder(), new MemoryStore(), address("down"), "p", NOW)).rejects.toThrow(
      GeocoderUnavailable,
    );
  });

  it("one place, even when the geocoder returns it several times", async () => {
    const s = await startPick(new FakeGeocoder(), new MemoryStore(), address("Sky Tower"), "p", NOW);
    expect(s.location).toEqual(SKY_TOWER);
  });

  it("several places: the caller must choose", async () => {
    const err = await startPick(
      new FakeGeocoder(),
      new MemoryStore(),
      address("50 Albert Street"),
      "p",
      NOW,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmbiguousAddress);
    expect((err as AmbiguousAddress).matches).toEqual(ALBERT_STREETS);
  });

  it("a chosen match starts with its address as the label", async () => {
    const [chosen] = ALBERT_STREETS;
    const s = await startPick(
      new FakeGeocoder(),
      new MemoryStore(),
      { lat: chosen!.lat, lon: chosen!.lon, label: chosen!.display_name },
      "p",
      NOW,
    );
    expect(s.location).toEqual(chosen);
  });

  it("the cache is per geocoder scope", async () => {
    const cache = new MemoryStore();
    const nz = new FakeGeocoder();
    await lookupAddress(nz, cache, "Sky Tower", NOW);
    await lookupAddress(nz, cache, "Sky Tower", NOW);
    expect(nz.calls).toBe(1);
    const world = Object.assign(new FakeGeocoder(), { scope: "world" });
    await lookupAddress(world, cache, "Sky Tower", NOW);
    expect(world.calls).toBe(1);
  });

  it("pick ids are time-ordered ULIDs", () => {
    const a = newPickId(1_000);
    const b = newPickId(2_000);
    expect(a).toHaveLength(26);
    expect(a < b).toBe(true);
    expect(newPickId()).not.toBe(newPickId());
  });
});

function api(starter = new FakeStarter()) {
  const store = new MemoryStore();
  return {
    api: new Api({
      geocoder: new FakeGeocoder(),
      store,
      starter,
      countries: bundledCountries(),
      apiKey: KEY,
    }),
    store,
    starter,
  };
}

const req = (
  method: string,
  path: string,
  body?: unknown,
  query: Record<string, string> = {},
): ApiRequest => ({
  method,
  path,
  query,
  apiKey: KEY,
  body: body === undefined ? undefined : JSON.stringify(body),
});
const get = (path: string, query: Record<string, string> = {}) => req("GET", path, undefined, query);
const post = (path: string, body: unknown = {}) => req("POST", path, body);

function errorOf(r: { status: number; body: unknown }) {
  return [r.status, (r.body as { error: string }).error];
}

describe("API (§5)", () => {
  it("requires the key", async () => {
    const { api: a } = api();
    expect(errorOf(await a.handle({ ...get("/history"), apiKey: undefined }, NOW))).toEqual([
      401,
      "unauthorized",
    ]);
    expect(errorOf(await a.handle({ ...get("/history"), apiKey: "wrong" }, NOW))).toEqual([
      401,
      "unauthorized",
    ]);
    expect((await a.handle(get("/history"), NOW)).status).toBe(200);
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });

  it("unknown routes are 404", async () => {
    const { api: a } = api();
    for (const r of [
      get("/nope"),
      get("/picks/"),
      post("/restaurants/osm:node/1/eat"),
      req("DELETE", "/picks"),
    ]) {
      expect(errorOf(await a.handle(r, NOW))).toEqual([404, "not_found"]);
    }
  });

  it("the pick view links the race to TAB when known", async () => {
    const { api: a } = api();
    const session = await startPick(
      new FakeGeocoder(),
      new MemoryStore(),
      { address: "Sky Tower" },
      "p1",
      NOW,
    );
    const race = {
      id: "r1",
      meeting_id: "m1",
      venue: "Vaal",
      venue_country: "SAF",
      race_number: 2,
      name: "Maiden Plate",
      race_type: "gallops" as const,
      status: "open" as const,
      start_time: NOW,
      runners: [],
      url: "https://www.tab.co.nz/racing/race/r1",
    };
    const card = { entries: [] };
    expect((await a.pickView({ ...session, race, card })).race?.url).toBe(
      "https://www.tab.co.nz/racing/race/r1",
    );
    // Picks saved before links existed have none.
    const { url: _unused, ...old } = race;
    void _unused;
    expect((await a.pickView({ ...session, race: old, card })).race?.url).toBeNull();
  });

  it("starts, stores and shows a pick", async () => {
    const { api: a, store, starter } = api();
    const r = await a.handle(post("/picks", { address: "Sky Tower" }), NOW);
    expect(r.status).toBe(202);
    const id = (r.body as { pick_id: string }).pick_id;
    expect(starter.started).toEqual([id]);
    expect((await store.getPick(id))?.status).toBe("finding_race");
    const view = await a.handle(get(`/picks/${id}`), NOW);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({
      status: "finding_race",
      location: { radius_m: 500, display_name: "Sky Tower, Auckland" },
      restaurants: [],
      race: null,
    });
  });

  it("start errors", async () => {
    const { api: a, starter } = api();
    expect(errorOf(await a.handle(post("/picks", { address: "x", radius_m: 5 }), NOW))).toEqual([
      422,
      "invalid_request",
    ]);
    expect(errorOf(await a.handle(post("/picks", {}), NOW))).toEqual([422, "invalid_request"]);
    expect(errorOf(await a.handle({ ...post("/picks"), body: "{not json" }, NOW))).toEqual([
      422,
      "invalid_request",
    ]);
    expect(errorOf(await a.handle(post("/picks", { address: "nowhere" }), NOW))).toEqual([
      422,
      "address_not_found",
    ]);
    expect(starter.started).toEqual([]);
    const failing = api(new FakeStarter(true)).api;
    expect(errorOf(await failing.handle(post("/picks", { lat: -36.8, lon: 174.7 }), NOW))).toEqual([
      503,
      "internal",
    ]);
    expect(errorOf(await a.handle(get("/picks/nope"), NOW))).toEqual([404, "not_found"]);
  });

  it("lists address matches (F1.2)", async () => {
    const { api: a } = api();
    const r = await a.handle(get("/geocode", { q: "50 Albert Street" }), NOW);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ matches: ALBERT_STREETS });
    const one = await a.handle(get("/geocode", { q: "Sky Tower" }), NOW);
    expect(one.body).toEqual({ matches: [SKY_TOWER] });
    const none = await a.handle(get("/geocode", { q: "nowhere" }), NOW);
    expect(none.body).toEqual({ matches: [] });
    expect(errorOf(await a.handle(get("/geocode"), NOW))).toEqual([422, "invalid_request"]);
    expect(errorOf(await a.handle(get("/geocode", { q: "down" }), NOW))).toEqual([503, "internal"]);
  });

  it("an ambiguous address is 409 with the matches", async () => {
    const { api: a, starter } = api();
    const r = await a.handle(post("/picks", { address: "50 Albert Street" }), NOW);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "ambiguous_address", matches: ALBERT_STREETS });
    expect(starter.started).toEqual([]);
    const chosen = ALBERT_STREETS[1]!;
    const ok = await a.handle(
      post("/picks", { lat: chosen.lat, lon: chosen.lon, label: chosen.display_name }),
      NOW,
    );
    expect(ok.status).toBe(202);
  });

  it("picked, visit and skip", async () => {
    const { api: a, store } = api();
    expect((await a.handle(get("/restaurants/picked"), NOW)).body).toBeNull();
    await recordPick(store, contractRestaurant("osm:node/1", "JP"), "p1", NOW);
    expect((await a.handle(get("/restaurants/picked"), NOW)).body).toMatchObject({
      id: "osm:node/1",
      status: "PICKED",
    });
    const v = await a.handle(post("/restaurants/osm%3Anode%2F1/visit"), NOW);
    expect(v.body).toMatchObject({ status: "VISITED", visit_count: 1 });
    expect(errorOf(await a.handle(post("/restaurants/osm:node/1/skip"), NOW))).toEqual([
      409,
      "invalid_transition",
    ]);
  });

  it("skip a picked restaurant", async () => {
    const { api: a, store } = api();
    await recordPick(store, contractRestaurant("osm:way/7", "IT"), "p1", NOW);
    expect((await a.handle(post("/restaurants/osm:way/7/skip"), NOW)).body).toMatchObject({ status: null });
    expect(errorOf(await a.handle(post("/restaurants/osm:way/8/skip"), NOW))).toEqual([404, "not_found"]);
  });

  it("a map visit needs details", async () => {
    const { api: a } = api();
    expect(errorOf(await a.handle(post("/restaurants/osm:node/5/visit"), NOW))).toEqual([
      422,
      "invalid_request",
    ]);
    const details = (iso: string) => ({
      restaurant: { name: "Taqueria", lat: -36.8, lon: 174.7, cuisine: ["mexican"], country_iso: iso },
    });
    expect(errorOf(await a.handle(post("/restaurants/osm:node/5/visit", details("XX")), NOW))).toEqual([
      422,
      "invalid_request",
    ]);
    const ok = await a.handle(post("/restaurants/osm:node/5/visit", details("MX")), NOW);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ country_iso: "MX", status: "VISITED" });
  });

  it("countries and history", async () => {
    const { api: a, store } = api();
    await recordPick(store, contractRestaurant("osm:node/1", "JP"), "p1", NOW);
    await a.handle(post("/restaurants/osm:node/1/visit"), NOW);
    const c = (await a.handle(get("/countries"), NOW)).body as {
      total: number;
      visited: number;
      countries: { iso2: string; visited: boolean; visit_count: number }[];
    };
    expect(c.total).toBe(95);
    expect(c.visited).toBe(1);
    expect(c.countries.find((x) => x.iso2 === "JP")).toMatchObject({ visited: true, visit_count: 1 });
    const small = (await a.handle(get("/countries", { min_population: "100000000" }), NOW)).body as {
      total: number;
    };
    expect(small.total).toBeLessThan(20);
    expect(errorOf(await a.handle(get("/countries", { min_population: "lots" }), NOW))).toEqual([
      422,
      "invalid_request",
    ]);
    const h = (await a.handle(get("/history"), NOW)).body as { entries: { reason: string }[] };
    expect(h.entries.map((e) => e.reason)).toEqual(["visited", "picked"]);
  });
});
