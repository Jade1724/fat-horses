// Passport: every pool country, visited or not (SPEC.md F9.1), and marking
// countries visited by hand (F8.8).

import type { Api, Passport, PassportCountry } from "../api";
import { clear, h } from "../dom";
import { dateText } from "../format";

/** Called when a stamp's button is pressed: `mark` true to mark, false to unmark. */
export type OnMark = (iso2: string, mark: boolean, button: HTMLButtonElement) => void;

function when(c: PassportCountry): string | null {
  if (c.visit_count > 0) return `${c.visit_count}× · ${c.last_visited_at ? dateText(c.last_visited_at) : ""}`;
  return c.marked ? "Visited before" : null;
}

function markButton(c: PassportCountry, onMark: OnMark): HTMLButtonElement | null {
  if (c.visited && !c.marked) return null;
  const b = h("button", { type: "button", class: "small mark" }, c.marked ? "Unmark" : "Mark visited");
  b.addEventListener("click", () => onMark(c.iso2, !c.marked, b));
  return b;
}

export function renderPassport(data: Passport, onMark?: OnMark): HTMLElement {
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
      ...sorted.map((c) => {
        const w = when(c);
        return h(
          "li",
          { class: c.visited ? "stamp visited" : "stamp" },
          h("span", { class: "flag" }, c.flag),
          h("span", { class: "name" }, c.name),
          w ? h("span", { class: "when" }, w) : null,
          onMark ? markButton(c, onMark) : null,
        );
      }),
    ),
  );
}

export async function passportPage(api: Api, root: HTMLElement): Promise<void> {
  clear(root);
  root.append(h("p", { class: "message" }, "Loading…"));
  const show = async () => {
    const data = await api.countries();
    clear(root);
    root.append(renderPassport(data, onMark));
  };
  const onMark: OnMark = (iso2, mark, button) => {
    button.disabled = true;
    void (async () => {
      try {
        await (mark ? api.markCountry(iso2) : api.unmarkCountry(iso2));
        await show();
      } catch {
        button.disabled = false;
        button.textContent = "Try again";
      }
    })();
  };
  try {
    await show();
  } catch {
    clear(root);
    root.append(h("p", { class: "message error" }, "Couldn't load your passport."));
  }
}
