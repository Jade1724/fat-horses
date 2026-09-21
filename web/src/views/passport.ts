// Passport: every pool country, visited or not (SPEC.md F9.1).

import type { Api, Passport } from "../api";
import { clear, h } from "../dom";
import { dateText } from "../format";

export function renderPassport(data: Passport): HTMLElement {
  const pct = data.total ? Math.round((data.visited / data.total) * 100) : 0;
  const sorted = [...data.countries].sort(
    (a, b) => Number(b.visited) - Number(a.visited) || a.name.localeCompare(b.name),
  );
  return h(
    "section",
    { class: "passport" },
    h("h1", {}, "Passport"),
    h("p", { class: "progress-label" }, `Visited ${data.visited} of ${data.total} countries`),
    h(
      "div",
      {
        class: "progress",
        role: "progressbar",
        "aria-valuemin": "0",
        "aria-valuemax": String(data.total),
        "aria-valuenow": String(data.visited),
      },
      h("div", { class: "progress-fill", style: `width: ${pct}%` }),
    ),
    h(
      "ul",
      { class: "stamps" },
      ...sorted.map((c) =>
        h(
          "li",
          { class: c.visited ? "stamp visited" : "stamp" },
          h("span", { class: "flag" }, c.flag),
          h("span", { class: "name" }, c.name),
          c.visited
            ? h(
                "span",
                { class: "when" },
                `${c.visit_count}× · ${c.last_visited_at ? dateText(c.last_visited_at) : ""}`,
              )
            : null,
        ),
      ),
    ),
  );
}

export async function passportPage(api: Api, root: HTMLElement): Promise<void> {
  clear(root);
  root.append(h("p", { class: "message" }, "Loading…"));
  try {
    const data = await api.countries();
    clear(root);
    root.append(renderPassport(data));
  } catch {
    clear(root);
    root.append(h("p", { class: "message error" }, "Couldn't load your passport."));
  }
}
