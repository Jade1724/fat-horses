// Adapters against recorded fixtures (no network). See docs/spikes/.

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { distinctLocations } from "../domain/places";
import type { Race } from "../domain/race";
import { hasEnoughRunners } from "../domain/race";
import {
  buildQuery,
  Nominatim,
  nominatimFromEnv,
  Overpass,
  parseCountries,
  parseOverpass,
  parseSearch,
} from "./osm";
import { parseEvent, parseMeetings, raceDays, RaceSourceUnavailable, TabNz } from "./tabNz";

const fixture = (path: string) =>
  readFileSync(new URL(`../../test/fixtures/${path}`, import.meta.url), "utf8");
const tab = (name: string) => fixture(`tab_nz/${name}`);

function scottsville(): Race {
  const r = parseMeetings(tab("meeting_open.json")).find(
    (x) => x.id === "f0eb3cef-e900-48bd-be5c-fe7b0330239f",
  );
  expect(r).toBeDefined();
  return r!;
}

function found(body: string) {
  const e = parseEvent(body, scottsville());
  if (!e.found) throw new Error("expected an event");
  return e.update;
}

describe("TAB NZ", () => {
  it("race days cover both NZ offsets and three hours", () => {
    expect(raceDays("2026-09-21T09:57:00.000Z")).toEqual(["2026-09-21", "2026-09-22"]);
    expect(raceDays("2026-09-21T02:00:00.000Z")).toEqual(["2026-09-21"]);
  });

  it("links each race to its page on tab.co.nz", () => {
    const race = scottsville();
    expect(race.url).toBe("https://www.tab.co.nz/racing/race/f0eb3cef-e900-48bd-be5c-fe7b0330239f");
    // A race card update keeps the link.
    expect(found(tab("event_open_scratched.json")).race.url).toBe(race.url);
  });

  it("maps meeting types and statuses", () => {
    const races = parseMeetings(tab("meetings_list.json"));
    const laurel = races.filter((r) => r.venue === "Laurel Park");
    expect(laurel).toHaveLength(10);
    expect(laurel.every((r) => r.race_type === "gallops")).toBe(true);
    expect(laurel[0]!.venue_country).toBe("USA");
    expect(races.filter((r) => r.venue === "Orkla").every((r) => r.race_type === "harness")).toBe(true);
    expect(races.filter((r) => r.venue === "Shepparton").every((r) => r.race_type === "greyhound")).toBe(
      true,
    );
    expect(races.some((r) => r.status === "open")).toBe(true);
    expect(races.some((r) => r.status === "final")).toBe(true);
    expect(races.every((r) => r.runners.length === 0)).toBe(true);
  });

  it("reads an open race card with scratchings", () => {
    const u = found(tab("event_open_scratched.json"));
    expect(u.race.status).toBe("open");
    expect(u.race.runners).toHaveLength(18);
    expect(u.race.runners.filter((r) => r.scratched).map((r) => r.number)).toEqual([2, 18]);
    expect(hasEnoughRunners(u.race)).toBe(true);
    expect(u.placings).toEqual([]);
    expect(u.race.start_time).toBe(scottsville().start_time);
  });

  it("reads closed, interim and final", () => {
    expect(found(tab("event_closed.json"))).toMatchObject({ race: { status: "closed" }, placings: [] });
    expect(found(tab("event_interim.json"))).toMatchObject({
      race: { status: "interim" },
      placings: [{ position: 1, number: 5 }],
    });
    const fin = found(tab("event_final.json"));
    expect(fin.race.status).toBe("final");
    expect(fin.placings[0]!.number).toBe(5);
    expect(fin.placings.length).toBeGreaterThanOrEqual(4);
  });

  it("dead heat has two winners", () => {
    expect(
      found(tab("event_dead_heat_synthetic.json")).placings.filter((p) => p.position === 1),
    ).toHaveLength(2);
  });

  it("abandoned: event not found, meeting says abandoned", () => {
    expect(parseEvent(tab("event_not_found.json"), scottsville())).toEqual({ found: false });
    const gore = parseMeetings(tab("meeting_abandoned.json"));
    expect(gore.length).toBeGreaterThan(0);
    expect(gore.every((r) => r.status === "abandoned")).toBe(true);
    expect(gore[0]!.venue).toBe("Gore");
  });

  it("other errors are errors", () => {
    const body = '{"header":{"error":"There was an unexpected error","error_code":"FR1000"}}';
    expect(() => parseMeetings(body)).toThrow(RaceSourceUnavailable);
    expect(() => parseEvent(body, scottsville())).toThrow(RaceSourceUnavailable);
    expect(() => parseEvent("<html>", scottsville())).toThrow(RaceSourceUnavailable);
  });

  it("falls back to the meeting when an event is gone, and sends identity headers", async () => {
    const race = { ...parseMeetings(tab("meeting_abandoned.json"))[0]! };
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      void init;
      return String(url).includes("/events/")
        ? new Response(tab("event_not_found.json"))
        : new Response(tab("meeting_abandoned.json"));
    });
    const client = new TabNz({ from: "me@example.com" }, "https://tab.test", fetchFn as typeof fetch);
    const u = await client.update(race);
    expect(u.race.status).toBe("abandoned");
    const init = fetchFn.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).from).toBe("me@example.com");
  });
});

describe("Nominatim", () => {
  it("parses every result, best first", () => {
    const [loc] = parseSearch(fixture("nominatim/sky_tower.json"));
    expect(loc?.lat).toBeCloseTo(-36.8484632, 6);
    expect(loc?.lon).toBeCloseTo(174.762183, 6);
    expect(loc?.display_name.startsWith("Sky Tower")).toBe(true);
    expect(parseSearch(fixture("nominatim/albert_street_nz.json"))).toHaveLength(5);
    expect(parseSearch(fixture("nominatim/not_found.json"))).toEqual([]);
    expect(() => parseSearch("<html>")).toThrow();
    expect(() => parseSearch('[{"lat":"x","lon":"1","display_name":"a"}]')).toThrow();
  });

  it("the country filter is what keeps London out (recorded responses)", () => {
    const world = parseSearch(fixture("nominatim/albert_street_world.json"));
    const nz = parseSearch(fixture("nominatim/albert_street_nz.json"));
    expect(world[0]?.display_name).toContain("London");
    expect(nz.every((l) => l.display_name.endsWith("New Zealand / Aotearoa"))).toBe(true);
    expect(nz.some((l) => l.display_name.includes("City Centre, Auckland"))).toBe(true);
  });

  it("merges several OSM objects for one place, keeps different places", () => {
    expect(distinctLocations(parseSearch(fixture("nominatim/sky_tower_nz.json")))).toHaveLength(1);
    expect(distinctLocations(parseSearch(fixture("nominatim/albert_street_nz.json")))).toHaveLength(5);
  });

  it("limits the search to the configured countries", () => {
    const nz = new URL(new Nominatim({ countries: ["nz"] }).searchUrl("50 Albert Street"));
    expect(nz.searchParams.get("countrycodes")).toBe("nz");
    expect(nz.searchParams.get("limit")).toBe("5");
    expect(nz.searchParams.get("q")).toBe("50 Albert Street");
    expect(new URL(new Nominatim().searchUrl("x")).searchParams.has("countrycodes")).toBe(false);
    expect(new Nominatim({ countries: ["nz", "au"] }).scope).toBe("nz,au");
    expect(new Nominatim().scope).toBe("world");
  });

  it("reads GEOCODE_COUNTRIES, defaulting to New Zealand", () => {
    expect(parseCountries(" NZ, au ,x, usa")).toEqual(["nz", "au"]);
    expect(parseCountries("")).toEqual([]);
    expect(nominatimFromEnv({}).scope).toBe("nz");
    expect(nominatimFromEnv({ GEOCODE_COUNTRIES: "" }).scope).toBe("world");
    expect(nominatimFromEnv({ GEOCODE_COUNTRIES: "au" }).scope).toBe("au");
  });

  it("waits a second between requests", async () => {
    let now = 1_000;
    const waits: number[] = [];
    const n = new Nominatim({
      now: () => now,
      wait: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    });
    await n.throttle();
    now += 300;
    await n.throttle();
    expect(waits).toEqual([700]);
  });
});

describe("Overpass", () => {
  const ORIGIN = [-36.8484632, 174.762183] as const;
  const parse = (radius: number) =>
    parseOverpass(fixture("overpass/hand_written.json"), ORIGIN[0], ORIGIN[1], radius);

  it("builds the query", () => {
    expect(buildQuery(-36.8, 174.7, 200, ["restaurant", "fast_food"])).toBe(
      '[out:json][timeout:25];nwr["amenity"~"^(restaurant|fast_food)$"](around:200,-36.8,174.7);out center tags;',
    );
  });

  it("parses nodes, ways and relations nearest first", () => {
    const places = parse(200);
    expect(places.map((p) => p.id)).toEqual([
      "osm:relation/3005",
      "osm:node/1004",
      "osm:node/1001",
      "osm:node/1003",
      "osm:way/2002",
    ]);
    expect(places.some((p) => p.name === "Too Far" || p.name === "No Geometry")).toBe(false);
    expect(parse(5000).some((p) => p.name === "Too Far")).toBe(true);
  });

  it("maps fields", () => {
    const places = parse(200);
    const sakura = places.find((p) => p.id === "osm:node/1001")!;
    expect(sakura).toMatchObject({
      name: "Sakura Sushi",
      amenity: "restaurant",
      cuisine: ["japanese", "sushi"],
      address: "12 Victoria Street West, Auckland",
      tags: { website: "https://example.com/sakura" },
    });
    expect(sakura.tags).not.toHaveProperty("opening_hours");
    expect(places.find((p) => p.id === "osm:way/2002")).toMatchObject({
      lat: -36.849,
      lon: 174.7615,
      amenity: "fast_food",
    });
    expect(places.find((p) => p.id === "osm:node/1003")).toMatchObject({
      cuisine: [],
      tags: { description: "Fondue and raclette" },
    });
    expect(places.find((p) => p.id === "osm:node/1004")).toMatchObject({
      name: "Unnamed restaurant",
      address: null,
    });
  });

  it("parses a real response", () => {
    const body = fixture("overpass/sky_tower_500m.json");
    const places = parseOverpass(body, ORIGIN[0], ORIGIN[1], 500);
    expect(places.length).toBeGreaterThan(150);
    expect(places.filter((p) => p.cuisine.length > 0).length).toBeGreaterThan(100);
    expect(places.every((p) => p.distance_m <= 500)).toBe(true);
    expect(places.some((p) => p.id.startsWith("osm:way/"))).toBe(true);
    const near = parseOverpass(body, ORIGIN[0], ORIGIN[1], 200);
    expect(near.length).toBeGreaterThan(0);
    expect(near.length).toBeLessThan(places.length);
  });

  it("errors on HTML pages and error remarks", () => {
    expect(() => parseOverpass(fixture("overpass/runtime_error.html"), 0, 0, 200)).toThrow(/bad Overpass/);
    expect(() =>
      parseOverpass('{"elements":[],"remark":"runtime error: Query timed out"}', 0, 0, 200),
    ).toThrow();
    expect(parseOverpass('{"elements":[],"remark":"note: fine"}', 0, 0, 200)).toEqual([]);
  });

  it("retries each endpoint, then moves on", async () => {
    let calls = 0;
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      void url;
      calls++;
      return calls < 4
        ? new Response("busy", { status: 504 })
        : new Response(fixture("overpass/hand_written.json"));
    });
    const o = new Overpass(["https://a.test", "https://b.test"], fetchFn as typeof fetch, async () => {});
    const places = await o.nearby(ORIGIN[0], ORIGIN[1], 200, ["restaurant"]);
    expect(places).toHaveLength(5);
    expect(fetchFn.mock.calls.map((c) => String(c[0]))).toEqual([
      "https://a.test",
      "https://a.test",
      "https://a.test",
      "https://b.test",
    ]);
  });
});
