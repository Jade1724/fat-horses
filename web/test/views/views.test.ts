import { describe, expect, it, vi } from "vitest";
import { historyRow } from "../../src/views/history";
import { renderPassport } from "../../src/views/passport";
import { chosenDishes, renderPodium } from "../../src/views/dishes";
import { raceCard, watchLink } from "../../src/views/race";

describe("renderPassport", () => {
  it("shows progress and puts visited countries first", () => {
    const el = renderPassport({
      visited: 1,
      total: 3,
      countries: [
        {
          iso2: "IT",
          name: "Italy",
          flag: "🇮🇹",
          visited: false,
          marked: false,
          visit_count: 0,
          last_visited_at: null,
        },
        {
          iso2: "JP",
          name: "Japan",
          flag: "🇯🇵",
          visited: true,
          marked: false,
          visit_count: 2,
          last_visited_at: "2026-09-21T10:00:00Z",
        },
        {
          iso2: "MX",
          name: "Mexico",
          flag: "🇲🇽",
          visited: false,
          marked: false,
          visit_count: 0,
          last_visited_at: null,
        },
      ],
    });
    expect(el.querySelector(".progress-label")?.textContent).toBe("Visited 1 of 3 countries");
    expect(el.querySelector(".progress-fill")?.getAttribute("style")).toBe("width: 33%");
    const names = [...el.querySelectorAll(".stamp .name")].map((n) => n.textContent);
    expect(names).toEqual(["Japan", "Italy", "Mexico"]);
    expect(el.querySelector(".stamp.visited .when")?.textContent).toContain("2×");
  });

  it("offers to mark unvisited countries and unmark marked ones (F8.8)", () => {
    const onMark = vi.fn();
    const row = { visit_count: 0, last_visited_at: null };
    const el = renderPassport(
      {
        visited: 2,
        total: 3,
        countries: [
          { iso2: "IT", name: "Italy", flag: "🇮🇹", visited: false, marked: false, ...row },
          { iso2: "JP", name: "Japan", flag: "🇯🇵", visited: true, marked: true, ...row },
          {
            iso2: "MX",
            name: "Mexico",
            flag: "🇲🇽",
            visited: true,
            marked: true,
            visit_count: 1,
            last_visited_at: "2026-09-21T10:00:00Z",
          },
        ],
      },
      onMark,
    );
    const stamp = (name: string) =>
      [...el.querySelectorAll(".stamp")].find((s) => s.querySelector(".name")?.textContent === name)!;
    const button = (name: string) => stamp(name).querySelector("button")!;
    expect(button("Italy").textContent).toBe("Mark visited");
    expect(stamp("Japan").querySelector(".when")?.textContent).toBe("Visited before");
    expect(button("Japan").textContent).toBe("Unmark");
    expect(stamp("Mexico").querySelector(".when")?.textContent).toContain("1×");
    expect(button("Mexico").textContent).toBe("Unmark");
    button("Italy").click();
    button("Japan").click();
    expect(onMark.mock.calls).toEqual([
      ["IT", true, button("Italy")],
      ["JP", false, button("Japan")],
    ]);
  });

  it("shows no buttons without a handler", () => {
    const el = renderPassport({
      visited: 0,
      total: 1,
      countries: [
        {
          iso2: "IT",
          name: "Italy",
          flag: "🇮🇹",
          visited: false,
          marked: false,
          visit_count: 0,
          last_visited_at: null,
        },
      ],
    });
    expect(el.querySelector("button")).toBeNull();
  });
});

describe("historyRow", () => {
  it("describes the change", () => {
    const li = historyRow(
      {
        at: "2026-09-21T10:00:00Z",
        restaurant_id: "osm:node/1",
        restaurant_name: "Sakura",
        country_iso: "JP",
        from: "PICKED",
        to: null,
        reason: "superseded",
        pick_id: "p1",
      },
      (iso) => (iso === "JP" ? "🇯🇵" : iso),
    );
    expect(li.querySelector(".what")?.textContent).toBe("Replaced by a newer pick");
    expect(li.querySelector(".name")?.textContent).toBe("🇯🇵 Sakura");
  });

  it("never interprets names as HTML", () => {
    const li = historyRow(
      {
        at: "2026-09-21T10:00:00Z",
        restaurant_id: "x",
        restaurant_name: "<img src=x onerror=alert(1)>",
        country_iso: "JP",
        from: null,
        to: "VISITED",
        reason: "visited",
        pick_id: null,
      },
      () => "",
    );
    expect(li.querySelector("img")).toBeNull();
    expect(li.textContent).toContain("<img");
  });
});

describe("watchLink", () => {
  const race = {
    venue: "Vaal",
    race_number: 2,
    name: "Maiden Plate",
    start_time: "2026-09-22T10:50:00Z",
    runners: [],
    url: "https://www.tab.co.nz/racing/race/a9f3d00d",
  };

  it("opens the race on TAB in a new tab", () => {
    const a = watchLink(race)!;
    expect(a.href).toBe("https://www.tab.co.nz/racing/race/a9f3d00d");
    expect(a.target).toBe("_blank");
    expect(a.rel).toBe("noopener noreferrer");
    expect(a.textContent).toBe("📺 Watch Vaal R2 on TAB");
  });

  it("is absent for picks saved before links existed", () => {
    expect(watchLink({ ...race, url: null })).toBeNull();
  });
});

describe("race card", () => {
  const race = {
    venue: "Ellerslie",
    race_number: 3,
    name: "Test Stakes",
    start_time: "2026-09-21T10:00:00Z",
    url: null,
    runners: [
      { number: 1, horse: "Alpha", country: null, dish: "Pad Thai", scratched: false },
      { number: 2, horse: "Bravo", country: null, dish: "Satay", scratched: true },
    ],
  };

  it("labels each horse by what it runs for, and marks the highlighted ones", () => {
    const { el, stop } = raceCard(race, { label: (r) => r.dish ?? "—", highlight: [1], live: false });
    stop();
    const rows = [...el.querySelectorAll(".card li")];
    expect(rows.map((r) => r.querySelector(".country")?.textContent)).toEqual(["Pad Thai", "Satay"]);
    expect(rows[0]?.classList.contains("winner")).toBe(true);
    expect(rows[1]?.classList.contains("scratched")).toBe(true);
  });
});

describe("dish review (F15)", () => {
  it("races only ticked, non-empty dishes, once each", () => {
    expect(
      chosenDishes([
        { name: " Pad Thai ", checked: true },
        { name: "pad thai", checked: true },
        { name: "Coke", checked: false },
        { name: "  ", checked: true },
        { name: "Satay", checked: true },
      ]),
    ).toEqual(["Pad Thai", "Satay"]);
  });
});

describe("renderPodium (F15)", () => {
  it("shows three dishes with medals, horses and any note", () => {
    const el = renderPodium([
      { place: 1, number: 4, horse: "Delta", dish: "Pad Thai", reason: "result" },
      { place: 2, number: 2, horse: "Bravo", dish: "Satay", reason: "dead_heat" },
      { place: 3, number: 1, horse: "Alpha", dish: "Larb", reason: "drawn" },
    ]);
    const rows = [...el.querySelectorAll("li")];
    expect(rows.map((r) => r.querySelector(".dish")?.textContent)).toEqual(["Pad Thai", "Satay", "Larb"]);
    expect(rows[0]?.textContent).toContain("🥇");
    expect(rows[0]?.textContent).toContain("#4 Delta");
    expect(rows[1]?.querySelector(".note")?.textContent).toBe("dead heat, order drawn");
    expect(rows[0]?.querySelector(".note")).toBeNull();
  });
});
