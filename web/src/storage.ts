// Per-browser conveniences in localStorage. Every access is guarded: storage can
// be unavailable (private mode, blocked site data) and the app must still work.

const KEY = "fat-horses.api-key";
const LAST_PICK = "fat-horses.last-pick";
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
  apiKey: () => get(KEY),
  setApiKey: (v: string | null) => set(KEY, v),
  lastPick: () => get(LAST_PICK),
  setLastPick: (v: string | null) => set(LAST_PICK, v),
  lastAddress: () => get(LAST_ADDRESS),
  setLastAddress: (v: string | null) => set(LAST_ADDRESS, v),
};
