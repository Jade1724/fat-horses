import { describe, expect, it } from "vitest";
import { bundledCountries } from "../domain/countries";
import { newSession, type PickSession } from "../domain/session";
import { recordPick, recordVisit } from "../domain/store";
import { contractRestaurant } from "../store/contract";
import { MemoryStore } from "../store/state";
import * as render from "./render";

const countries = bundledCountries();

function session(): PickSession {
  const s = newSession(
    "p1",
    "2026-09-21T10:00:00.000Z",
    { radius_m: 200, min_population: 10_000_000, include_visited: false },
    { lat: -36.85, lon: 174.76, display_name: "Sky Tower" },
  );
  s.race = {
    id: "r",
    meeting_id: "m",
    venue: "Ellerslie",
    venue_country: "NZ",
    race_number: 3,
    name: "Test Stakes",
    race_type: "gallops",
    status: "open",
    start_time: "2026-09-21T10:08:00.000Z",
    runners: [],
  };
  s.card = {
    entries: [
      { number: 1, horse: "Fast One", country_iso: "JP", scratched: false },
      { number: 2, horse: "Slow One", country_iso: null, scratched: true },
    ],
  };
  return s;
}

describe("CLI output", () => {
  it("race card", () => {
    const text = render.raceCard(session(), countries);
    expect(text).toContain("Ellerslie R3");
    expect(text).toContain("10:08 UTC");
    expect(text).toContain("🇯🇵 Japan");
    expect(text).toContain("(scratched)");
  });

  it("summary with a pick", () => {
    const s = session();
    s.status = "done";
    s.winner = { number: 1, country_iso: "JP", reason: "result", tied: [] };
    s.places = [
      {
        id: "osm:node/1",
        name: "Sakura",
        lat: -36.8,
        lon: 174.7,
        address: "1 Queen St",
        amenity: "restaurant",
        cuisine: ["sushi"],
        tags: {},
        distance_m: 120,
      },
    ];
    s.matches = [{ place_id: "osm:node/1", match: "tagged", reason: null }];
    s.pick = "osm:node/1";
    const text = render.summary(s, countries);
    expect(text).toContain("Horse 1 wins: 🇯🇵 Japan");
    expect(text).toContain("👉 Sakura — 120 m, 1 Queen St");
    expect(text).toContain("destination=-36.8,174.7");
    expect(text).toContain("fat-horses visit 'osm:node/1'");
  });

  it("summary without matches, and failures", () => {
    const s = session();
    s.status = "done";
    s.winner = { number: 1, country_iso: "JP", reason: "abandoned", tied: [] };
    const text = render.summary(s, countries);
    expect(text).toContain("race abandoned");
    expect(text).toContain("No match nearby.");
    expect(text).toContain("sushi");
    expect(
      render.summary({ ...session(), status: "failed", error: "no_upcoming_race" }, countries),
    ).toContain("no_upcoming_race");
  });

  it("passport and history from a store", async () => {
    const store = new MemoryStore();
    const r = { ...contractRestaurant("osm:node/1", "JP"), name: "Sakura" };
    await recordPick(store, r, "p1", "2026-09-21T10:00:00.000Z");
    const visited = await recordVisit(store, "osm:node/1", null, "2026-09-21T10:30:00.000Z");
    expect(render.restaurant(visited, countries)).toBe("Sakura (🇯🇵 Japan): VISITED, 1 visit(s)\n");
    const text = render.passport(countries, await store.countryVisits(), 10_000_000);
    expect(text.split("\n")[0]).toBe("Passport: visited 1 of 95 countries");
    expect(text.split("\n")[1]).toBe("  ✅ 🇯🇵 Japan — 1 visit(s), last 2026-09-21");
    expect(text).toContain("  ·  🇮🇹 Italy");
    const page = await store.history(null, 1);
    const h = render.history(page, countries);
    expect(h.startsWith("2026-09-21 10:30  Sakura")).toBe(true);
    expect(h).toContain("More: fat-horses history --cursor");
    expect(render.history(await store.history(page.next_cursor, 10), countries)).toContain("picked");
    expect(render.history({ entries: [], next_cursor: null }, countries)).toBe("No history yet.\n");
  });

  it("printer shows the card once and each status", () => {
    const out: string[] = [];
    const p = new render.Printer(countries, (x) => out.push(x));
    const s = { ...session(), status: "waiting_start" as const };
    p.update(s);
    p.update(s);
    p.update({ ...s, status: "running" });
    expect(out.filter((x) => x.includes("Ellerslie"))).toHaveLength(1);
    expect(out.filter((x) => x.startsWith("⏳"))).toEqual([
      "⏳ Waiting for the start…\n",
      "⏳ Race under way, waiting for the result…\n",
    ]);
  });
});
