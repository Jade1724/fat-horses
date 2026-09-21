// MapLibre GL map with OpenFreeMap tiles: search area, restaurant pins.

import * as maplibregl from "maplibre-gl";
import type { Feature } from "geojson";
import "maplibre-gl/dist/maplibre-gl.css";
import { circleRing, pinKind } from "./format";
import type { PickRestaurant } from "./api";

const STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const AREA = "search-area";

export class PickMap {
  private readonly map: maplibregl.Map;
  private markers: maplibregl.Marker[] = [];
  private centre: maplibregl.Marker | null = null;
  private ready: Promise<void>;

  constructor(container: HTMLElement) {
    this.map = new maplibregl.Map({
      container,
      style: STYLE_URL,
      center: [174.7633, -36.8485],
      zoom: 11,
      attributionControl: { compact: true },
    });
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    this.ready = new Promise((resolve) => this.map.once("load", () => resolve()));
  }

  /** Centre on the search location and draw the radius circle (F10.3). */
  async showArea(lat: number, lon: number, radiusM: number): Promise<void> {
    await this.ready;
    const data: Feature = {
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates: [circleRing(lat, lon, radiusM)] },
    };
    const source = this.map.getSource(AREA) as maplibregl.GeoJSONSource | undefined;
    if (source) {
      source.setData(data);
    } else {
      this.map.addSource(AREA, { type: "geojson", data });
      this.map.addLayer({
        id: `${AREA}-fill`,
        type: "fill",
        source: AREA,
        paint: { "fill-color": "#1f5f4a", "fill-opacity": 0.08 },
      });
      this.map.addLayer({
        id: `${AREA}-line`,
        type: "line",
        source: AREA,
        paint: { "line-color": "#1f5f4a", "line-width": 2, "line-dasharray": [2, 2] },
      });
    }
    this.centre?.remove();
    const dot = document.createElement("div");
    dot.className = "centre-dot";
    dot.title = "Search centre";
    this.centre = new maplibregl.Marker({ element: dot }).setLngLat([lon, lat]).addTo(this.map);
    const ring = circleRing(lat, lon, radiusM, 16);
    const bounds = ring.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(ring[0], ring[0]));
    this.map.fitBounds(bounds, { padding: 32, maxZoom: 17, duration: 600 });
  }

  /** A pin per restaurant, coloured by status; the chosen one on top (F10.5). */
  showRestaurants(
    restaurants: PickRestaurant[],
    chosenId: string | null,
    onClick: (r: PickRestaurant) => void,
  ): void {
    for (const m of this.markers) m.remove();
    this.markers = [];
    const ordered = [...restaurants].sort((a, b) => Number(a.id === chosenId) - Number(b.id === chosenId));
    for (const r of ordered) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = `pin pin-${pinKind(r.status, r.id === chosenId)}`;
      el.setAttribute("aria-label", r.name);
      el.title = r.name;
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick(r);
      });
      this.markers.push(
        new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat([r.lon, r.lat]).addTo(this.map),
      );
    }
  }

  flyTo(lat: number, lon: number): void {
    this.map.flyTo({ center: [lon, lat], zoom: Math.max(this.map.getZoom(), 16) });
  }

  resize(): void {
    this.map.resize();
  }
}
