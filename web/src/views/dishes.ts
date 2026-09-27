// Dish picks (SPEC.md F15): photograph a menu, review the dishes found, race
// for them, and show the top three. The photo is shrunk here and never kept.

import { ApiError, type Api, type MenuImage, type PickView, type PodiumPlace } from "../api";
import { clear, h } from "../dom";
import { errorText, fitWithin, isFinished, podiumNote, statusText } from "../format";
import { storage } from "../storage";
import { raceCard, watchLink } from "./race";

const POLL_MS = 5000;
/** Claude reads images up to about this long edge without shrinking them itself. */
const MAX_EDGE = 1568;
const MIN_DISHES = 3;
const MEDALS = ["🥇", "🥈", "🥉"];
const WAITS = [
  ["10", "10 minutes"],
  ["30", "30 minutes"],
  ["60", "1 hour"],
  ["180", "3 hours"],
] as const;

export interface DishRow {
  name: string;
  checked: boolean;
}

/** The dishes to race: ticked, non-empty, each once (ignoring case), as the server keeps them. */
export function chosenDishes(rows: readonly DishRow[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const name = r.name.trim().split(/\s+/).filter(Boolean).join(" ");
    if (!r.checked || !name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

/** The top three: medal, dish, horse, and a note when the result didn't decide the place. */
export function renderPodium(podium: readonly PodiumPlace[]): HTMLElement {
  return h(
    "ol",
    { class: "podium" },
    ...podium.map((p) => {
      const note = podiumNote(p.reason);
      return h(
        "li",
        {},
        h("span", { class: "medal", "aria-hidden": "true" }, MEDALS[p.place - 1] ?? String(p.place)),
        h("span", { class: "dish" }, p.dish),
        h("span", { class: "horse" }, `#${p.number}${p.horse ? ` ${p.horse}` : ""}`),
        note ? h("span", { class: "note" }, note) : null,
      );
    }),
  );
}

/** Shrink a photo to MAX_EDGE and re-encode it as JPEG, so uploads stay small (~300 KB). */
export async function shrinkPhoto(file: Blob): Promise<MenuImage> {
  const bitmap = await createImageBitmap(file);
  const { width, height } = fitWithin(bitmap.width, bitmap.height, MAX_EDGE);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("could not encode"))), "image/jpeg", 0.85),
  );
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { media_type: "image/jpeg", data: btoa(binary) };
}

export class DishPage {
  readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly api: Api;
  private restaurantName = "";
  private rows: DishRow[] = [];
  private maxWait = 10;
  private pollTimer: number | undefined;
  private stopRaceCard: () => void = () => {};

  constructor(api: Api) {
    this.api = api;
    this.body = h("div", { class: "panel-body", "aria-live": "polite" });
    this.root = h("section", { class: "dish-page" }, this.body);
  }

  /** Resume the last dish pick, or start with the photo step. */
  async start(): Promise<void> {
    const last = storage.lastDishPick();
    if (last) await this.load(last);
    else this.showPhotoStep();
  }

  stop(): void {
    window.clearTimeout(this.pollTimer);
    this.stopRaceCard();
  }

  /** A fresh dish pick at a restaurant picked by a race (F15). */
  forRestaurant(name: string): void {
    this.stop();
    storage.setLastDishPick(null);
    this.restaurantName = name;
    this.rows = [];
    this.showPhotoStep();
  }

  private showPhotoStep(message?: string): void {
    this.stop();
    clear(this.body);
    const input = h("input", { type: "file", accept: "image/*", capture: "environment", class: "file" });
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file) void this.readPhoto(file);
    });
    if (this.restaurantName) this.body.append(h("p", { class: "where" }, "🍽 ", this.restaurantName));
    this.body.append(
      h(
        "p",
        {},
        "Snap the menu. We'll read the dishes, you tick the ones you'd share, and a horse race picks your top three.",
      ),
      h("label", { class: "button primary photo" }, "📷 Photo of the menu", input),
    );
    if (message) this.body.append(h("p", { class: "message error" }, message));
  }

  private async readPhoto(file: File): Promise<void> {
    clear(this.body);
    this.body.append(h("p", { class: "status" }, h("span", { class: "spinner" }), "Reading the menu…"));
    let image: MenuImage;
    try {
      image = await shrinkPhoto(file);
    } catch {
      this.showPhotoStep("Couldn't open that photo. Try another.");
      return;
    }
    try {
      const reading = await this.api.readMenu(image);
      this.rows = reading.dishes.map((name) => ({ name, checked: true }));
      if (!this.restaurantName && reading.restaurant_name) this.restaurantName = reading.restaurant_name;
      this.showReview();
    } catch (e) {
      this.showPhotoStep(e instanceof ApiError ? e.message : "Couldn't read that menu. Try again.");
    }
  }

  /** Tick the dishes to race, fix any misread names, add missing ones. */
  private showReview(): void {
    clear(this.body);
    const list = h("ul", { class: "dish-list" });
    const count = h("p", { class: "count" });
    const start = h("button", { type: "button", class: "primary" }, "Race for our top 3");
    const refresh = () => {
      const n = chosenDishes(this.rows).length;
      count.textContent = `${n} ${n === 1 ? "dish" : "dishes"} in the race`;
      start.disabled = n < MIN_DISHES;
      start.title = n < MIN_DISHES ? `Pick at least ${MIN_DISHES}` : "";
    };
    const addRow = (row: DishRow, focus = false) => {
      const box = h("input", { type: "checkbox", "aria-label": "Race this dish" });
      box.checked = row.checked;
      const name = h("input", { type: "text", value: row.name, "aria-label": "Dish name", maxlength: "80" });
      box.addEventListener("change", () => {
        row.checked = box.checked;
        refresh();
      });
      name.addEventListener("input", () => {
        row.name = name.value;
        refresh();
      });
      list.append(h("li", {}, box, name));
      if (focus) name.focus();
    };
    for (const row of this.rows) addRow(row);

    const add = h("button", { type: "button", class: "small" }, "+ Add a dish");
    add.addEventListener("click", () => {
      const row = { name: "", checked: true };
      this.rows.push(row);
      addRow(row, true);
      refresh();
    });
    const restaurant = h("input", {
      type: "text",
      value: this.restaurantName,
      placeholder: "Restaurant (optional)",
    });
    restaurant.addEventListener("input", () => (this.restaurantName = restaurant.value));
    const wait = h("select", {});
    for (const [value, label] of WAITS) wait.append(h("option", { value }, label));
    wait.value = String(this.maxWait);
    wait.addEventListener("change", () => (this.maxWait = Number(wait.value)));
    const retake = h("button", { type: "button", class: "small" }, "Take another photo");
    retake.addEventListener("click", () => this.showPhotoStep());
    start.addEventListener("click", () => void this.startRace(chosenDishes(this.rows), start));

    this.body.append(
      h("h2", {}, "Which dishes are in?"),
      h("p", {}, "Untick drinks, sides, anything you won't share. Fix a name if the photo was misread."),
      list,
      add,
      h(
        "details",
        {},
        h("summary", {}, "Options"),
        h("label", {}, "Restaurant", restaurant),
        h("label", {}, "Race must start within", wait),
      ),
      count,
      h("div", { class: "actions" }, start, retake),
    );
    refresh();
  }

  private async startRace(dishes: string[], button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      const { pick_id } = await this.api.startDishPick({
        dishes,
        restaurant_name: this.restaurantName.trim() || null,
        max_wait_min: this.maxWait,
      });
      storage.setLastDishPick(pick_id);
      await this.load(pick_id);
    } catch (e) {
      button.disabled = false;
      this.body.append(
        h("p", { class: "message error" }, e instanceof ApiError ? e.message : "Couldn't start the race."),
      );
    }
  }

  private async load(pickId: string): Promise<void> {
    window.clearTimeout(this.pollTimer);
    try {
      const view = await this.api.getPick(pickId);
      this.render(view);
      if (!isFinished(view.status)) this.pollTimer = window.setTimeout(() => void this.load(pickId), POLL_MS);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        storage.setLastDishPick(null);
        this.showPhotoStep();
        return;
      }
      this.pollTimer = window.setTimeout(() => void this.load(pickId), POLL_MS * 2);
    }
  }

  private render(p: PickView): void {
    this.stopRaceCard();
    clear(this.body);
    if (p.restaurant_name) this.body.append(h("p", { class: "where" }, "🍽 ", p.restaurant_name));
    if (!isFinished(p.status)) {
      const cancel = h("button", { type: "button", class: "small" }, "Cancel");
      cancel.addEventListener("click", () => void this.cancel(p.pick_id, cancel));
      this.body.append(
        h(
          "div",
          { class: "status-row" },
          h("p", { class: "status" }, h("span", { class: "spinner" }), statusText(p.status)),
          cancel,
        ),
      );
    }
    if (p.status === "failed")
      this.body.append(h("p", { class: "message error" }, errorText(p.error, p.max_wait_min)));
    if (p.status === "cancelled") this.body.append(h("p", { class: "message" }, "Race cancelled."));
    if (p.podium) this.body.append(h("h2", {}, "Your top three"), renderPodium(p.podium));
    if (isFinished(p.status)) this.body.append(this.afterButtons(p));
    if (p.race) {
      const watch = watchLink(p.race);
      if (watch) this.body.append(watch);
      const card = raceCard(p.race, {
        label: (r) => r.dish ?? "—",
        highlight: p.podium?.map((x) => x.number) ?? [],
        live: !p.podium && !isFinished(p.status),
      });
      this.stopRaceCard = card.stop;
      this.body.append(card.el);
    }
  }

  private afterButtons(p: PickView): HTMLElement {
    const again = h("button", { type: "button", class: "primary" }, "Race again (same menu)");
    again.addEventListener("click", () => {
      this.restaurantName = p.restaurant_name ?? "";
      this.maxWait = p.max_wait_min;
      void this.startRace(p.menu ?? [], again);
    });
    const fresh = h("button", { type: "button", class: "secondary" }, "New menu");
    fresh.addEventListener("click", () => this.forRestaurant(""));
    return h("div", { class: "actions" }, again, fresh);
  }

  private async cancel(pickId: string, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    window.clearTimeout(this.pollTimer);
    try {
      this.render(await this.api.cancelPick(pickId));
    } catch {
      button.disabled = false;
      await this.load(pickId);
    }
  }
}
