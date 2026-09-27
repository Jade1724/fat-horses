// Per-browser conveniences in localStorage. Every access is guarded: storage can
// be unavailable (private mode, blocked site data) and the app must still work.

const LAST_PICK = "fat-horses.last-pick";
const LAST_DISH_PICK = "fat-horses.last-dish-pick";
const MODE = "fat-horses.mode";
const LAST_ADDRESS = "fat-horses.last-address";

function get(name: string): string | null {
  try {
    return window.localStorage.getItem(name);
  } catch {
    return null;
  }
}

function set(name: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(name);
    else window.localStorage.setItem(name, value);
  } catch {
    // Not persisted; fine for a convenience.
  }
}

export const storage = {
  lastPick: () => get(LAST_PICK),
  setLastPick: (v: string | null) => set(LAST_PICK, v),
  lastDishPick: () => get(LAST_DISH_PICK),
  setLastDishPick: (v: string | null) => set(LAST_DISH_PICK, v),
  /** The Pick tab's mode: restaurant (the default) or dishes (F15). */
  mode: (): "restaurant" | "dish" => (get(MODE) === "dish" ? "dish" : "restaurant"),
  setMode: (v: "restaurant" | "dish") => set(MODE, v),
  lastAddress: () => get(LAST_ADDRESS),
  setLastAddress: (v: string | null) => set(LAST_ADDRESS, v),
};
