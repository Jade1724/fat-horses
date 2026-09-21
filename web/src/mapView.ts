// What the Pick page needs from a map, and a stand-in for when the map can't
// start (e.g. no WebGL2), so the rest of the page still works.

import type { PickRestaurant } from "./api";
import { h } from "./dom";

export interface MapView {
  showArea(lat: number, lon: number, radiusM: number): Promise<void>;
  showRestaurants(
    restaurants: PickRestaurant[],
    chosenId: string | null,
    onClick: (r: PickRestaurant) => void,
  ): void;
  flyTo(lat: number, lon: number): void;
  resize(): void;
}

/** Does nothing; the restaurant list on the page still shows every match. */
export class NoMap implements MapView {
  async showArea(): Promise<void> {}
  showRestaurants(): void {}
  flyTo(): void {}
  resize(): void {}
}

/**
 * Build the map with `factory`; if it throws, show why in `el` and return a
 * NoMap instead of letting the error stop the whole page.
 */
export function createMap(el: HTMLElement, factory: (el: HTMLElement) => MapView): MapView {
  try {
    return factory(el);
  } catch (e) {
    console.error("map unavailable", e);
    const webgl = e instanceof Error && /WebGL/i.test(e.message);
    el.classList.add("map-unavailable");
    el.append(
      h(
        "div",
        { class: "map-message" },
        h("strong", {}, "The map can't be shown."),
        h(
          "p",
          {},
          webgl
            ? "This browser has WebGL2 turned off or unsupported. Everything else still works; restaurants are listed on the left."
            : "Everything else still works; restaurants are listed on the left.",
        ),
      ),
    );
    return new NoMap();
  }
}
