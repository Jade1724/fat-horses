// The race card and TAB link, shared by restaurant picks (F10.4) and dish picks (F15).

import type { Race, Runner } from "../api";
import { h } from "../dom";
import { countdown } from "../format";

/** "Watch the race on TAB", opening the race's page in a new tab (F10.4); null without a link. */
export function watchLink(race: Race): HTMLAnchorElement | null {
  if (!race.url) return null;
  return h(
    "a",
    { class: "watch", href: race.url, target: "_blank", rel: "noopener noreferrer" },
    `📺 Watch ${race.venue} R${race.race_number} on TAB`,
  );
}

export interface RaceCardOptions {
  /** What each horse runs for: a flag and country, or a dish. */
  label: (r: Runner) => string;
  /** Runners to mark: the winner, or the podium. */
  highlight: readonly number[];
  /** Whether the pick still waits on the race, so the countdown should tick. */
  live: boolean;
}

/** The race card; call `stop` when it is replaced, to end its countdown. */
export function raceCard(race: Race, opts: RaceCardOptions): { el: HTMLElement; stop: () => void } {
  const start = new Date(race.start_time);
  const hhmm = start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const clock = h("span", { class: "countdown" });
  const tick = () => {
    const c = countdown(start, new Date());
    clock.textContent = !opts.live ? `at ${hhmm}` : c ? `starts in ${c}` : `started ${hhmm}`;
  };
  tick();
  const timer = opts.live ? window.setInterval(tick, 1000) : undefined;
  const rows = race.runners.map((r) =>
    h(
      "li",
      {
        class: [r.scratched ? "scratched" : "", opts.highlight.includes(r.number) ? "winner" : ""].join(" "),
      },
      h("span", { class: "num" }, String(r.number)),
      h("span", { class: "horse" }, r.horse),
      h("span", { class: "country" }, opts.label(r)),
    ),
  );
  const el = h(
    "details",
    { class: "race", open: opts.live },
    h("summary", {}, h("strong", {}, `🏇 ${race.venue} R${race.race_number}`), " ", clock),
    h("p", { class: "race-name" }, race.name),
    h("ol", { class: "card" }, ...rows),
  );
  return { el, stop: () => window.clearInterval(timer) };
}
