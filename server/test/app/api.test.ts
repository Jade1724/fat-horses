// Starting picks (F1) and the HTTP API (§5).

import { describe, expect, it } from "vitest";
import { bundledCountries } from "../../src/domain/countries";
import { GeocoderUnavailable, type Geocoder, type Location } from "../../src/domain/places";
import { recordPick } from "../../src/domain/store";
import { contractRestaurant } from "../store/contract";
import { MemoryStore } from "../../src/store/state";
import { Api, type ApiRequest, type WorkflowStarter } from "../../src/app/api";
import { FakeMenuReader, MenuReadingNotSetUp, MenuUnreadable, type MenuReader } from "../../src/domain/menu";
import { newDishSession } from "../../src/domain/session";
import {
  AddressNotFound,
  AmbiguousAddress,
  InvalidRequest,
  lookupAddress,
  newPickId,
  startPick,
  type StartInput,
} from "../../src/app/start";
import { sessionCookie, TEST_PASSWORD, testAuth } from "../auth";

const NOW = "2026-09-21T10:00:00.000Z";

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

function api(starter = new FakeStarter(), menus: MenuReader = new FakeMenuReader()) {
  const store = new MemoryStore();
  return {
    api: new Api({
      geocoder: new FakeGeocoder(),
      store,
      starter,
      countries: bundledCountries(),
      auth: testAuth(),
      menus,
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
  cookies: sessionCookie(NOW),
  body: body === undefined ? undefined : JSON.stringify(body),
});
const get = (path: string, query: Record<string, string> = {}) => req("GET", path, undefined, query);
const post = (path: string, body: unknown = {}) => req("POST", path, body);

function errorOf(r: { status: number; body: unknown }) {
  return [r.status, (r.body as { error: string }).error];
}

describe("API (§5)", () => {
  it("requires a session", async () => {
    const { api: a } = api();
    for (const cookies of [undefined, "", "fh_session=nonsense", sessionCookie(NOW, "another secret")]) {
      expect(errorOf(await a.handle({ ...get("/history"), cookies }, NOW))).toEqual([401, "unauthorized"]);
    }
    expect((await a.handle(get("/history"), NOW)).status).toBe(200);
  });

  it("stops accepting a session once it expires", async () => {
    const { api: a } = api();
    const later = new Date(Date.parse(NOW) + 13 * 60 * 60 * 1000).toISOString();
    const r = await a.handle(get("/history"), later);
    expect(errorOf(r)).toEqual([401, "unauthorized"]);
    expect((r.body as { message: string }).message).toBe("session expired");
  });

  describe("POST /login", () => {
    it("trades the password for an HttpOnly session cookie", async () => {
      const { api: a } = api();
      const r = await a.handle({ ...post("/login", { password: TEST_PASSWORD }), cookies: undefined }, NOW);
      expect(r.status).toBe(200);
      expect(r.setCookie).toContain("HttpOnly");
      expect(r.setCookie).toContain("SameSite=Strict");
      // The reply itself carries no token, so no script can read one.
      expect(JSON.stringify(r.body)).not.toContain(".");

      const token = (r.setCookie ?? "").split(";")[0];
      expect((await a.handle({ ...get("/history"), cookies: token }, NOW)).status).toBe(200);
    });

    it("refuses a wrong password and sets no cookie", async () => {
      const { api: a } = api();
      const r = await a.handle({ ...post("/login", { password: "guess" }), cookies: undefined }, NOW);
      expect(errorOf(r)).toEqual([401, "unauthorized"]);
      expect(r.setCookie).toBeUndefined();
    });

    it("needs a password in the body", async () => {
      const { api: a } = api();
      expect(errorOf(await a.handle(post("/login", {}), NOW))).toEqual([422, "invalid_request"]);
      expect(errorOf(await a.handle(post("/login", { password: "" }), NOW))).toEqual([
        422,
        "invalid_request",
      ]);
    });

    it("is 503 until a password has been set", async () => {
      const a = new Api({
        geocoder: new FakeGeocoder(),
        store: new MemoryStore(),
        starter: new FakeStarter(),
        countries: bundledCountries(),
        auth: { passwordHash: "unset", sessionSecret: "s", secureCookie: true },
        menus: new FakeMenuReader(),
      });
      expect(errorOf(await a.handle(post("/login", { password: "x" }), NOW))).toEqual([503, "internal"]);
    });
  });

  it("logging out expires the cookie", async () => {
    const { api: a } = api();
    const r = await a.handle(post("/logout"), NOW);
    expect(r.status).toBe(200);
    expect(r.setCookie).toContain("Max-Age=0");
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
    const store = new MemoryStore();
    expect((await a.pickView({ ...session, race, card }, store)).race?.url).toBe(
      "https://www.tab.co.nz/racing/race/r1",
    );
    // Picks saved before links existed have none.
    const { url: _unused, ...old } = race;
    void _unused;
    expect((await a.pickView({ ...session, race: old, card }, store)).race?.url).toBeNull();
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

  describe("dish picks (F15)", () => {
    const dishes = ["Pad Thai", "pad thai", " Green  curry ", "Satay", "Tom yum"];

    it("starts a dish pick from a reviewed list, with no address", async () => {
      const { api: a, store, starter } = api();
      const r = await a.handle(post("/picks", { mode: "dish", dishes, restaurant_name: "Siam House" }), NOW);
      expect(r.status).toBe(202);
      const id = (r.body as { pick_id: string }).pick_id;
      expect(starter.started).toEqual([id]);
      expect((await store.getPick(id))?.request).toEqual({
        mode: "dish",
        dishes: ["Pad Thai", "Green curry", "Satay", "Tom yum"],
        restaurant_name: "Siam House",
        max_wait_min: 10,
      });
      expect((await a.handle(get(`/picks/${id}`), NOW)).body).toMatchObject({
        mode: "dish",
        restaurant_name: "Siam House",
        menu: ["Pad Thai", "Green curry", "Satay", "Tom yum"],
        location: null,
        podium: null,
      });
    });

    it("refuses fewer than three dishes or a bad wait", async () => {
      const { api: a } = api();
      for (const body of [
        { mode: "dish", dishes: ["Soup", "soup", "Bread"] },
        { mode: "dish", dishes: ["a", "b", "c"], max_wait_min: 5000 },
        { mode: "dish" },
      ]) {
        expect(errorOf(await a.handle(post("/picks", body), NOW))).toEqual([422, "invalid_request"]);
      }
    });

    it("shows each horse's dish and the podium with horse names", async () => {
      const { api: a } = api();
      const session = newDishSession("d1", NOW, {
        mode: "dish",
        dishes: ["A", "B", "C"],
        restaurant_name: null,
      });
      const card = {
        entries: [1, 2, 3].map((n) => ({
          number: n,
          horse: `Horse ${n}`,
          country_iso: null,
          dish: "ABC"[n - 1] ?? null,
          scratched: false,
        })),
      };
      const race = {
        id: "r1",
        meeting_id: "m1",
        venue: "Ellerslie",
        venue_country: "NZ",
        race_number: 1,
        name: "Test",
        race_type: "gallops" as const,
        status: "final" as const,
        start_time: NOW,
        runners: [],
      };
      const podium = [
        { place: 1, number: 2, dish: "B", reason: "result" as const },
        { place: 2, number: 3, dish: "C", reason: "result" as const },
        { place: 3, number: 1, dish: "A", reason: "drawn" as const },
      ];
      const view = await a.pickView({ ...session, race, card, podium, status: "done" }, new MemoryStore());
      expect(view.race?.runners.map((r) => r.dish)).toEqual(["A", "B", "C"]);
      expect(view.podium).toEqual([
        { place: 1, number: 2, horse: "Horse 2", dish: "B", reason: "result" },
        { place: 2, number: 3, horse: "Horse 3", dish: "C", reason: "result" },
        { place: 3, number: 1, horse: "Horse 1", dish: "A", reason: "drawn" },
      ]);
    });
  });

  describe("POST /menus/read (F15)", () => {
    // Only the first bytes matter to the check: each format's signature.
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString("base64");
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");

    it("returns the dishes the reader found, tidied", async () => {
      const menus = new FakeMenuReader({
        restaurant_name: "Siam House",
        dishes: ["Pad Thai", "pad thai", "Satay", "x".repeat(81), "Green curry"],
      });
      const r = await api(undefined, menus).api.handle(
        post("/menus/read", { image: JPEG, media_type: "image/jpeg" }),
        NOW,
      );
      expect(r).toMatchObject({
        status: 200,
        body: { restaurant_name: "Siam House", dishes: ["Pad Thai", "Satay", "Green curry"] },
      });
      expect(menus.reads).toBe(1);
    });

    it("refuses what isn't an image of the stated type, without calling the reader", async () => {
      const menus = new FakeMenuReader();
      const { api: a } = api(undefined, menus);
      for (const body of [
        { image: PNG, media_type: "image/jpeg" },
        { image: JPEG, media_type: "image/gif" },
        { image: "not base64!", media_type: "image/jpeg" },
        { image: "", media_type: "image/jpeg" },
      ]) {
        expect(errorOf(await a.handle(post("/menus/read", body), NOW))).toEqual([422, "invalid_request"]);
      }
      expect(menus.reads).toBe(0);
    });

    it("refuses a photo over 4 MB", async () => {
      const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(4 * 1024 * 1024)]);
      const r = await api().api.handle(
        post("/menus/read", { image: big.toString("base64"), media_type: "image/jpeg" }),
        NOW,
      );
      expect(errorOf(r)).toEqual([422, "invalid_request"]);
    });

    it("says so when too few dishes can be read", async () => {
      const menus = new FakeMenuReader({ restaurant_name: null, dishes: ["Coffee", "Tea"] });
      const r = await api(undefined, menus).api.handle(
        post("/menus/read", { image: JPEG, media_type: "image/jpeg" }),
        NOW,
      );
      expect(errorOf(r)).toEqual([422, "too_few_dishes"]);
    });

    it("says menu reading isn't set up, rather than blaming the photo", async () => {
      const menus = new FakeMenuReader(new MenuReadingNotSetUp("MENU_MODEL_ID is empty"));
      const r = await api(undefined, menus).api.handle(
        post("/menus/read", { image: JPEG, media_type: "image/jpeg" }),
        NOW,
      );
      expect(errorOf(r)).toEqual([503, "menu_reading_not_set_up"]);
      expect((r.body as { message: string }).message).toBe("Reading menus isn't set up yet.");
    });

    it("is 503 when the reader fails", async () => {
      const menus = new FakeMenuReader(new MenuUnreadable("model down"));
      const r = await api(undefined, menus).api.handle(
        post("/menus/read", { image: JPEG, media_type: "image/jpeg" }),
        NOW,
      );
      expect(errorOf(r)).toEqual([503, "menu_unreadable"]);
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

  it("marks and unmarks a country by hand (F8.8)", async () => {
    const { api: a } = api();
    const passport = async () =>
      (await a.handle(get("/countries"), NOW)).body as {
        visited: number;
        countries: { iso2: string; visited: boolean; marked: boolean }[];
      };
    const marked = await a.handle(post("/countries/IT/mark"), NOW);
    expect(marked.status).toBe(200);
    expect(marked.body).toEqual({
      iso2: "IT",
      name: "Italy",
      flag: "🇮🇹",
      visited: true,
      marked: true,
      visit_count: 0,
      last_visited_at: null,
    });
    let p = await passport();
    expect(p.visited).toBe(1);
    expect(p.countries.find((x) => x.iso2 === "IT")).toMatchObject({ visited: true, marked: true });
    expect(((await a.handle(get("/history"), NOW)).body as { entries: unknown[] }).entries).toEqual([]);

    const unmarked = await a.handle(post("/countries/it/unmark"), NOW);
    expect(unmarked.body).toMatchObject({ iso2: "IT", visited: false, marked: false });
    p = await passport();
    expect(p.visited).toBe(0);

    expect(errorOf(await a.handle(post("/countries/XX/mark"), NOW))).toEqual([404, "not_found"]);
    const anon = { ...post("/countries/IT/mark"), cookies: undefined };
    expect(errorOf(await a.handle(anon, NOW))).toEqual([401, "unauthorized"]);
  });
});
