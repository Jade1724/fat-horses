// App shell: the login gate, navigation between Pick, Passport and History (F10.1, F10.2).

import "./style.css";
import { Api, ApiError } from "./api";
import { clear, h } from "./dom";
import { PickMap } from "./map";
import { createMap } from "./mapView";
import { storage } from "./storage";
import { historyPage } from "./views/history";
import { passportPage } from "./views/passport";
import { DishPage } from "./views/dishes";
import { PickPage } from "./views/pick";

type Route = "pick" | "passport" | "history";

const found = document.querySelector<HTMLDivElement>("#app");
if (!found) throw new Error("missing #app");
const app: HTMLDivElement = found;

function currentRoute(): Route {
  const r = window.location.hash.replace(/^#\/?/, "");
  return r === "passport" || r === "history" ? r : "pick";
}

function loginScreen(message?: string): void {
  clear(app);
  const input = h("input", {
    type: "password",
    name: "password",
    autocomplete: "current-password",
    placeholder: "Password",
    required: true,
    "aria-label": "Password",
  });
  const button = h("button", { type: "submit", class: "primary" }, "Log in");
  const form = h(
    "form",
    { class: "key-form" },
    h("h1", {}, "🐎 Fat Horses"),
    h("p", {}, "A horse race picks the country. We find the restaurant."),
    message ? h("p", { class: "message error" }, message) : null,
    input,
    button,
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const password = input.value;
    if (!password) return;
    button.disabled = true;
    // The cookie the server sets is HttpOnly, so nothing is kept here.
    void new Api(() => {})
      .login(password)
      .then(() => boot())
      .catch(() => {
        button.disabled = false;
        input.value = "";
        loginScreen("That password didn't work. Try again.");
      });
  });
  app.append(h("main", { class: "key-page" }, form));
  input.focus();
}

function boot(): void {
  const api = new Api(() => loginScreen("Your session expired. Log in again."));

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
  // The Pick tab picks a restaurant, or dishes from a menu (F15).
  let mode = storage.mode();
  const dishes = new DishPage(api);
  const setMode = (m: "restaurant" | "dish") => {
    mode = m;
    storage.setMode(m);
    show();
  };
  const pick = new PickPage(api, map, mapEl, (restaurantName) => {
    dishes.forRestaurant(restaurantName);
    setMode("dish");
  });
  const other = h("div", { class: "page" });
  void pick.start();
  void dishes.start();

  const modeSwitch = () => {
    const button = (m: "restaurant" | "dish", label: string) => {
      const b = h("button", { type: "button", class: "mode", "aria-pressed": String(mode === m) }, label);
      b.addEventListener("click", () => setMode(m));
      return b;
    };
    return h(
      "div",
      { class: "mode-switch", role: "group", "aria-label": "What to pick" },
      button("restaurant", "🗺 Restaurant"),
      button("dish", "🍽 Dishes"),
    );
  };

  const show = () => {
    const route = currentRoute();
    for (const [name, a] of Object.entries(tabs)) {
      if (name === route) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
    clear(main);
    if (route === "pick") {
      main.append(modeSwitch(), mode === "dish" ? dishes.root : pick.root);
      if (mode === "restaurant") map.resize();
    } else {
      main.append(other);
      void (route === "passport" ? passportPage(api, other) : historyPage(api, other));
    }
  };
  window.addEventListener("hashchange", show);
  show();
}

/**
 * The session lives in a cookie we can't read, so ask the API instead: one cheap
 * call says whether we're logged in. Anything other than a 401 is the app's own
 * problem to show, not a reason to ask for the password again.
 */
void new Api(() => {})
  .picked()
  .then(() => boot())
  .catch((e: unknown) => {
    if (e instanceof ApiError && e.status === 401) loginScreen();
    else boot();
  });
