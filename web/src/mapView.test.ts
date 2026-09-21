import { describe, expect, it, vi } from "vitest";
import { createMap, NoMap, type MapView } from "./mapView";

describe("createMap", () => {
  it("returns the real map when it starts", () => {
    const real = new NoMap();
    const el = document.createElement("div");
    expect(createMap(el, () => real)).toBe(real);
    expect(el.classList.contains("map-unavailable")).toBe(false);
  });

  it("falls back and explains when the map throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const el = document.createElement("div");
    const map: MapView = createMap(el, () => {
      throw new Error("WebGL2 is required to display this map.");
    });
    expect(map).toBeInstanceOf(NoMap);
    expect(el.classList.contains("map-unavailable")).toBe(true);
    expect(el.textContent).toContain("WebGL2");
  });

  it("the stand-in accepts every call", async () => {
    const m = new NoMap();
    await m.showArea();
    m.showRestaurants();
    m.flyTo();
    m.resize();
  });
});
