// The Pick view: form, map, race progress and results (SPEC.md F10.3–F10.8).

import { ApiError } from "../api";
import type { Api, PickRestaurant, PickView, Race, StoredRestaurant, Winner } from "../api";
import { clear, h } from "../dom";
import {
  countdown,
  directionsUrl,
  distanceText,
  errorText,
  isFinished,
  osmUrl,
  statusText,
  winReasonText,
} from "../format";
import type { PickMap } from "../map";
import { storage } from "../storage";

const POLL_MS = 5000;

export class PickPage {
  readonly root: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly banner: HTMLElement;
  private readonly form: HTMLFormElement;
  private pick: PickView | null = null;
  private selected: string | null = null;
  private pollTimer: number | undefined;
  private tickTimer: number | undefined;
  private readonly api: Api;
  private readonly map: PickMap;

  constructor(api: Api, map: PickMap, mapEl: HTMLElement) {
    this.api = api;
    this.map = map;
    this.banner = h("div", { class: "banner", hidden: true });
    this.form = this.buildForm();
    this.panel = h("div", { class: "panel-body", "aria-live": "polite" });
    this.root = h(
      "section",
      { class: "pick-page" },
      h("div", { class: "side" }, this.banner, this.form, this.panel),
      mapEl,
    );
  }

  /** Show the stored PICKED restaurant (F10.8) and resume the last pick. */
  async start(): Promise<void> {
    void this.refreshBanner();
    const last = storage.lastPick();
    if (last) await this.load(last);
  }

  stop(): void {
    window.clearTimeout(this.pollTimer);
    window.clearInterval(this.tickTimer);
  }

  private buildForm(): HTMLFormElement {
    const address = h("input", {
      name: "address",
      type: "text",
      placeholder: "Address, e.g. 1 Queen Street, Auckland",
      autocomplete: "street-address",
      required: true,
      "aria-label": "Address",
    });
    address.value = storage.lastAddress() ?? "";
    const radius = h("input", {
      name: "radius",
      type: "number",
      min: "50",
      max: "2000",
      step: "50",
      value: "200",
    });
    const minPop = h("select", { name: "min_population" });
    for (const [value, label] of [
      ["10000000", "10 million+"],
      ["1000000", "1 million+"],
      ["50000000", "50 million+"],
      ["0", "Every country"],
    ] as const) {
      minPop.append(h("option", { value }, label));
    }
    const includeVisited = h("input", { name: "include_visited", type: "checkbox" });
    const submit = h("button", { type: "submit", class: "primary" }, "Race for a restaurant");
    const form = h(
      "form",
      { class: "pick-form" },
      address,
      h(
        "details",
        {},
        h("summary", {}, "Options"),
        h("label", {}, "Radius (m)", radius),
        h("label", {}, "Countries with", minPop),
        h("label", { class: "check" }, includeVisited, "Include countries I've visited"),
      ),
      submit,
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.submit(
        address.value.trim(),
        Number(radius.value),
        Number(minPop.value),
        includeVisited.checked,
        submit,
      );
    });
    return form;
  }

  private async submit(
    address: string,
    radius: number,
    minPopulation: number,
    includeVisited: boolean,
    button: HTMLButtonElement,
  ): Promise<void> {
    if (!address) return;
    button.disabled = true;
    this.showMessage("Starting…");
    try {
      const { pick_id } = await this.api.startPick({
        address,
        radius_m: radius,
        min_population: minPopulation,
        include_visited: includeVisited,
      });
      storage.setLastAddress(address);
      storage.setLastPick(pick_id);
      this.selected = null;
      await this.load(pick_id);
    } catch (e) {
      this.showMessage(
        e instanceof ApiError && e.code === "address_not_found"
          ? "Couldn't find that address. Try adding the suburb or city."
          : e instanceof ApiError && e.code === "invalid_request"
            ? e.message
            : "Couldn't start a pick. Try again.",
        true,
      );
    } finally {
      button.disabled = false;
    }
  }

  private async load(pickId: string): Promise<void> {
    window.clearTimeout(this.pollTimer);
    try {
      const view = await this.api.getPick(pickId);
      const firstLoad = this.pick?.pick_id !== view.pick_id;
      this.pick = view;
      if (firstLoad) {
        void this.map.showArea(view.location.lat, view.location.lon, view.location.radius_m);
      }
      this.render();
      if (!isFinished(view.status)) {
        this.pollTimer = window.setTimeout(() => void this.load(pickId), POLL_MS);
      } else {
        void this.refreshBanner();
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        storage.setLastPick(null);
        return;
      }
      this.pollTimer = window.setTimeout(() => void this.load(pickId), POLL_MS * 2);
    }
  }

  private showMessage(text: string, error = false): void {
    clear(this.panel);
    this.panel.append(h("p", { class: error ? "message error" : "message" }, text));
  }

  private render(): void {
    const p = this.pick;
    if (!p) return;
    clear(this.panel);
    window.clearInterval(this.tickTimer);

    this.panel.append(h("p", { class: "where" }, "📍 ", p.location.display_name));
    if (p.world_complete) {
      this.panel.append(
        h("p", { class: "note good" }, "🌍 World complete! Every country is back in the draw."),
      );
    }
    if (!isFinished(p.status)) {
      this.panel.append(h("p", { class: "status" }, h("span", { class: "spinner" }), statusText(p.status)));
    }
    if (p.status === "failed") {
      this.panel.append(h("p", { class: "message error" }, errorText(p.error)));
    }
    if (p.winner) this.panel.append(this.renderWinner(p.winner));
    if (p.status === "done") this.panel.append(this.renderResults(p));
    if (p.race) this.panel.append(this.renderRace(p.race, p.winner));

    this.map.showRestaurants(p.restaurants, p.pick, (r) => {
      this.selected = r.id;
      this.render();
    });
  }

  private renderRace(race: Race, winner: Winner | null): HTMLElement {
    const start = new Date(race.start_time);
    const clock = h("span", { class: "countdown" });
    const tick = () => {
      const c = countdown(start, new Date());
      clock.textContent = c
        ? `starts in ${c}`
        : `started ${start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    };
    tick();
    if (!winner) this.tickTimer = window.setInterval(tick, 1000);
    const rows = race.runners.map((r) =>
      h(
        "li",
        {
          class: [
            r.scratched ? "scratched" : "",
            winner?.number === r.number ? "winner" : "",
          ].join(" "),
        },
        h("span", { class: "num" }, String(r.number)),
        h("span", { class: "horse" }, r.horse),
        h(
          "span",
          { class: "country" },
          r.country ? `${r.country.flag} ${r.country.name}` : "—",
        ),
      ),
    );
    return h(
      "details",
      { class: "race", open: !winner },
      h(
        "summary",
        {},
        h("strong", {}, `🏇 ${race.venue} R${race.race_number}`),
        " ",
        clock,
      ),
      h("p", { class: "race-name" }, race.name),
      h("ol", { class: "card" }, ...rows),
    );
  }

  private renderWinner(w: Winner): HTMLElement {
    const why = winReasonText(w.reason, w.tied ?? []);
    return h(
      "div",
      { class: "winner-box" },
      h("div", { class: "flag" }, w.country?.flag ?? "🏁"),
      h(
        "div",
        {},
        h("p", { class: "label" }, `#${w.number} ${w.horse ?? ""} wins`),
        h("p", { class: "country-name" }, w.country?.name ?? "Unknown country"),
        why ? h("p", { class: "note" }, why) : null,
      ),
    );
  }

  private renderResults(p: PickView): HTMLElement {
    const box = h("div", { class: "results" });
    if (p.llm_unavailable) {
      box.append(
        h("p", { class: "note" }, "Cuisine guessing unavailable, showing tagged places only."),
      );
    }
    if (p.restaurants.length === 0) {
      box.append(h("p", { class: "message" }, "No match nearby."));
      if (p.dishes) box.append(h("p", { class: "note" }, "Look out for: ", p.dishes.join(", ")));
      box.append(this.raceAgainButton());
      return box;
    }
    const chosen = p.restaurants.find((r) => r.id === p.pick) ?? null;
    const focus = p.restaurants.find((r) => r.id === this.selected) ?? chosen;
    if (focus) box.append(this.restaurantCard(focus, focus.id === p.pick, p));
    box.append(
      h(
        "p",
        { class: "count" },
        `${p.restaurants.length} place${p.restaurants.length === 1 ? "" : "s"} nearby:`,
      ),
      h(
        "ul",
        { class: "matches" },
        ...p.restaurants.map((r) => {
          const b = h(
            "button",
            { type: "button", class: r.id === focus?.id ? "match active" : "match" },
            h("span", { class: `dot dot-${r.id === p.pick ? "chosen" : (r.status ?? "new").toLowerCase()}` }),
            h("span", { class: "name" }, r.name),
            h("span", { class: "dist" }, distanceText(r.distance_m)),
          );
          b.addEventListener("click", () => {
            this.selected = r.id;
            this.map.flyTo(r.lat, r.lon);
            this.render();
          });
          return h("li", {}, b);
        }),
      ),
      this.raceAgainButton(),
    );
    return box;
  }

  private restaurantCard(r: PickRestaurant, isPick: boolean, p: PickView): HTMLElement {
    const actions = h("div", { class: "actions" });
    const visit = h("button", { type: "button", class: "primary" }, "We went here");
    visit.addEventListener("click", () => void this.visit(r, p, visit));
    actions.append(visit);
    if (isPick && r.status === "PICKED") {
      const skip = h("button", { type: "button" }, "Skip");
      skip.addEventListener("click", () => void this.skip(r, skip));
      actions.append(skip);
    }
    const osm = osmUrl(r.id);
    return h(
      "article",
      { class: isPick ? "restaurant pick" : "restaurant" },
      isPick ? h("p", { class: "label" }, "👉 The pick") : null,
      h("h2", {}, r.name),
      h(
        "p",
        { class: "meta" },
        [r.cuisine.join(", "), r.address, distanceText(r.distance_m)].filter(Boolean).join(" · "),
      ),
      r.match !== "tagged"
        ? h("p", { class: "likely" }, h("span", { class: "badge" }, "likely"), " ", r.reason ?? "")
        : null,
      r.status === "VISITED"
        ? h("p", { class: "note good" }, `✅ Visited ${r.visit_count}×`)
        : null,
      h(
        "p",
        { class: "links" },
        h("a", { href: directionsUrl(r.lat, r.lon), target: "_blank", rel: "noopener" }, "Directions"),
        osm ? " · " : null,
        osm ? h("a", { href: osm, target: "_blank", rel: "noopener" }, "OpenStreetMap") : null,
      ),
      actions,
    );
  }

  private raceAgainButton(): HTMLElement {
    const b = h("button", { type: "button", class: "secondary" }, "Race again");
    b.addEventListener("click", () => this.form.requestSubmit());
    return b;
  }

  private async visit(r: PickRestaurant, p: PickView, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      const stored = r.status !== null;
      await this.api.visit(
        r.id,
        stored || !p.winner?.country
          ? undefined
          : {
              name: r.name,
              lat: r.lat,
              lon: r.lon,
              address: r.address,
              cuisine: r.cuisine,
              country_iso: p.winner.country.iso2,
            },
      );
      await this.load(p.pick_id);
    } catch {
      button.disabled = false;
      this.showMessage("Couldn't save that. Try again.", true);
    }
  }

  private async skip(r: PickRestaurant, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      await this.api.skip(r.id);
      if (this.pick) await this.load(this.pick.pick_id);
    } catch {
      button.disabled = false;
    }
  }

  /** The currently PICKED restaurant from an earlier pick (F10.8). */
  private async refreshBanner(): Promise<void> {
    let r: StoredRestaurant | null;
    try {
      r = await this.api.picked();
    } catch {
      return;
    }
    clear(this.banner);
    const current = this.pick?.pick;
    if (!r || r.id === current) {
      this.banner.hidden = true;
      return;
    }
    const picked = r;
    const visit = h("button", { type: "button", class: "primary small" }, "We went here");
    visit.addEventListener("click", async () => {
      visit.disabled = true;
      await this.api.visit(picked.id).catch(() => undefined);
      void this.refreshBanner();
    });
    const skip = h("button", { type: "button", class: "small" }, "Skip");
    skip.addEventListener("click", async () => {
      skip.disabled = true;
      await this.api.skip(picked.id).catch(() => undefined);
      void this.refreshBanner();
    });
    this.banner.append(
      h("p", {}, "Still to try: ", h("strong", {}, picked.name)),
      h("div", { class: "actions" }, visit, skip),
    );
    this.banner.hidden = false;
  }
}
