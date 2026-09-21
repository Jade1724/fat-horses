// History: every status change, newest first (SPEC.md F9.2).

import type { Api, HistoryEntry } from "../api";
import { clear, h } from "../dom";
import { dateText } from "../format";

const REASON: Record<HistoryEntry["reason"], string> = {
  picked: "Picked",
  visited: "Visited",
  skipped: "Skipped",
  superseded: "Replaced by a newer pick",
};

export function historyRow(e: HistoryEntry, flag: (iso2: string) => string): HTMLElement {
  return h(
    "li",
    { class: `event event-${e.reason}` },
    h("span", { class: "when" }, dateText(e.at)),
    h("span", { class: "what" }, REASON[e.reason]),
    h("span", { class: "name" }, `${flag(e.country_iso)} ${e.restaurant_name}`),
  );
}

export async function historyPage(api: Api, root: HTMLElement): Promise<void> {
  clear(root);
  const list = h("ol", { class: "history" });
  const more = h("button", { type: "button", class: "secondary", hidden: true }, "Load more");
  root.append(h("section", {}, h("h1", {}, "History"), list, more));

  let flags = new Map<string, string>();
  try {
    const countries = await api.countries(0);
    flags = new Map(countries.countries.map((c) => [c.iso2, c.flag]));
  } catch {
    // Flags are decoration.
  }
  const flag = (iso2: string) => flags.get(iso2) ?? iso2;

  let cursor: string | null = null;
  const load = async () => {
    more.disabled = true;
    try {
      const page = await api.history(cursor);
      if (!cursor && page.entries.length === 0) {
        list.replaceWith(h("p", { class: "message" }, "Nothing yet. Run a race!"));
      }
      for (const e of page.entries) list.append(historyRow(e, flag));
      cursor = page.next_cursor;
      more.hidden = !cursor;
    } catch {
      list.append(h("li", { class: "message error" }, "Couldn't load history."));
    } finally {
      more.disabled = false;
    }
  };
  more.addEventListener("click", () => void load());
  await load();
}
