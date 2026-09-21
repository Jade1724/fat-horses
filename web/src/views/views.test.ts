import { describe, expect, it } from "vitest";
import { historyRow } from "./history";
import { renderPassport } from "./passport";

describe("renderPassport", () => {
  it("shows progress and puts visited countries first", () => {
    const el = renderPassport({
      visited: 1,
      total: 3,
      countries: [
        { iso2: "IT", name: "Italy", flag: "🇮🇹", visited: false, visit_count: 0, last_visited_at: null },
        {
          iso2: "JP",
          name: "Japan",
          flag: "🇯🇵",
          visited: true,
          visit_count: 2,
          last_visited_at: "2026-09-21T10:00:00Z",
        },
        { iso2: "MX", name: "Mexico", flag: "🇲🇽", visited: false, visit_count: 0, last_visited_at: null },
      ],
    });
    expect(el.querySelector(".progress-label")?.textContent).toBe("Visited 1 of 3 countries");
    expect(el.querySelector(".progress-fill")?.getAttribute("style")).toBe("width: 33%");
    const names = [...el.querySelectorAll(".stamp .name")].map((n) => n.textContent);
    expect(names).toEqual(["Japan", "Italy", "Mexico"]);
    expect(el.querySelector(".stamp.visited .when")?.textContent).toContain("2×");
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
