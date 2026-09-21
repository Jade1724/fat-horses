// App shell: API key gate, navigation between Pick, Passport and History (F10.1, F10.2).

import "./style.css";
import { Api } from "./api";
import { clear, h } from "./dom";
import { PickMap } from "./map";
import { createMap } from "./mapView";
import { storage } from "./storage";
import { historyPage } from "./views/history";
import { passportPage } from "./views/passport";
import { PickPage } from "./views/pick";

type Route = "pick" | "passport" | "history";

const found = document.querySelector<HTMLDivElement>("#app");
if (!found) throw new Error("missing #app");
const app: HTMLDivElement = found;

function currentRoute(): Route {
  const r = window.location.hash.replace(/^#\/?/, "");
  return r === "passport" || r === "history" ? r : "pick";
}

function keyScreen(message?: string): void {
  clear(app);
  const input = h("input", {
    type: "password",
    name: "key",
    autocomplete: "current-password",
    placeholder: "API key",
    required: true,
    "aria-label": "API key",
  });
  const form = h(
    "form",
    { class: "key-form" },
    h("h1", {}, "🐎 Fat Horses"),
    h("p", {}, "A horse race picks the country. We find the restaurant."),
    message ? h("p", { class: "message error" }, message) : null,
    input,
    h("button", { type: "submit", class: "primary" }, "Continue"),
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const key = input.value.trim();
    if (!key) return;
    storage.setApiKey(key);
    boot();
  });
  app.append(h("main", { class: "key-page" }, form));
  input.focus();
}

function boot(): void {
  const key = storage.apiKey();
  if (!key) {
    keyScreen();
    return;
  }
  const api = new Api(key, () => {
    storage.setApiKey(null);
    keyScreen("That key didn't work. Enter it again.");
  });

  clear(app);
  const nav = h("nav", { class: "tabs" });
  const tabs: Record<Route, HTMLAnchorElement> = {
    pick: h("a", { href: "#/pick" }, "Pick"),
    passport: h("a", { href: "#/passport" }, "Passport"),
    history: h("a", { href: "#/history" }, "History"),
  };
  nav.append(tabs.pick, tabs.passport, tabs.history);
  const header = h("header", { class: "top" }, h("span", { class: "logo" }, "🐎 Fat Horses"), nav);
  const main = h("main", {});
  app.append(header, main);

  const mapEl = h("div", { class: "map", role: "region", "aria-label": "Map" });
  const map = createMap(mapEl, (el) => new PickMap(el));
  const pick = new PickPage(api, map, mapEl);
  const other = h("div", { class: "page" });
  void pick.start();

  const show = () => {
    const route = currentRoute();
    for (const [name, a] of Object.entries(tabs)) {
      if (name === route) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
    clear(main);
    if (route === "pick") {
      main.append(pick.root);
      map.resize();
    } else {
      main.append(other);
      void (route === "passport" ? passportPage(api, other) : historyPage(api, other));
    }
  };
  window.addEventListener("hashchange", show);
  show();
}

boot();
