// Plain-text output for the CLI.

import type { Countries } from "../domain/countries";
import type { PickSession, PickStatus } from "../domain/session";
import type { Restaurant } from "../domain/status";
import type { CountryVisits, HistoryPage } from "../domain/store";

function label(countries: Countries, iso2: string): string {
  const c = countries.get(iso2);
  return c ? `${c.flag} ${c.name}` : iso2;
}

/** The race card (F4.3). */
export function raceCard(s: PickSession, countries: Countries): string {
  if (!s.race || !s.card) return "";
  const hhmm = s.race.start_time.slice(11, 16);
  const lines = [`🏇 ${s.race.venue} R${s.race.race_number} — ${s.race.name} (${s.race.venue_country}), starts ${hhmm} UTC`];
  for (const e of s.card.entries) {
    const who = e.country_iso ? label(countries, e.country_iso) : "—";
    lines.push(`  ${String(e.number).padStart(2)}  ${e.horse.padEnd(24)} ${who}${e.scratched ? "  (scratched)" : ""}`);
  }
  if (s.world_complete) lines.push("🌍 World complete! Every country is back in the draw.");
  return lines.join("\n") + "\n";
}

/** The result: winner, matches and the pick. */
export function summary(s: PickSession, countries: Countries): string {
  const out: string[] = [];
  if (s.winner) {
    const w = s.winner;
    const how =
      w.reason === "dead_heat"
        ? ` (dead heat between ${w.tied.map((n) => `#${n}`).join(" and ")}, drawn at random)`
        : w.reason === "abandoned"
          ? " (race abandoned — random pick)"
          : w.reason === "timeout"
            ? " (no result in time — random pick)"
            : "";
    out.push(`🏆 Horse ${w.number} wins: ${label(countries, w.country_iso)}${how}`);
  }
  if (s.status === "failed") {
    out.push(`❌ Pick failed: ${s.error ?? "unknown error"}`);
    return out.join("\n") + "\n";
  }
  if (!s.winner) return out.join("\n");
  if (s.llm_unavailable) out.push("⚠️  Cuisine guessing unavailable, showing tagged places only");
  if (s.matches.length === 0) {
    out.push("No match nearby.");
    const c = countries.get(s.winner.country_iso);
    if (c) out.push(`Try looking for: ${c.dishes.join(", ")}`);
    return out.join("\n") + "\n";
  }
  out.push(`${s.matches.length} match(es) nearby:`);
  for (const m of s.matches) {
    const p = s.places.find((x) => x.id === m.place_id);
    if (!p) continue;
    const star = s.pick === p.id ? "👉" : "  ";
    const kind = m.match === "tagged" ? "" : `  [likely: ${m.reason ?? "no reason given"}]`;
    out.push(`${star} ${p.name} — ${Math.round(p.distance_m)} m${p.address ? `, ${p.address}` : ""}${kind}`);
  }
  const picked = s.places.find((p) => p.id === s.pick);
  if (picked) {
    out.push(`Directions: https://www.google.com/maps/dir/?api=1&destination=${picked.lat},${picked.lon}`);
    out.push(`After eating there: fat-horses visit '${picked.id}'   (or: fat-horses skip '${picked.id}')`);
  }
  return out.join("\n") + "\n";
}

const STATUS_TEXT: Partial<Record<PickStatus, string>> = {
  finding_race: "Finding the next race…",
  waiting_start: "Waiting for the start…",
  running: "Race under way, waiting for the result…",
  resolving: "Result in!",
  searching: "Looking for restaurants…",
};

/** Prints progress as the session changes. */
export class Printer {
  private last: PickStatus | null = null;
  private cardShown = false;

  constructor(
    private readonly countries: Countries,
    private readonly write: (s: string) => void = (s) => process.stdout.write(s),
  ) {}

  update(s: PickSession): void {
    if (!this.cardShown && s.card) {
      this.write(raceCard(s, this.countries));
      this.cardShown = true;
    }
    if (s.status !== this.last) {
      const msg = STATUS_TEXT[s.status];
      if (msg) this.write(`⏳ ${msg}\n`);
      this.last = s.status;
    }
  }
}

export function restaurant(r: Restaurant, countries: Countries): string {
  const status = r.status === null ? "not picked" : r.status;
  return `${r.name} (${label(countries, r.country_iso)}): ${status}, ${r.visit_count} visit(s)\n`;
}

/** The Passport (F9.1): visited first. */
export function passport(countries: Countries, visits: CountryVisits[], minPopulation: number): string {
  const byIso = new Map(visits.filter((v) => v.visit_count > 0).map((v) => [v.iso2, v]));
  const rows = countries.all
    .filter((c) => c.population >= minPopulation)
    .map((c) => {
      const v = byIso.get(c.iso2);
      const line = v
        ? `  ✅ ${c.flag} ${c.name} — ${v.visit_count} visit(s), last ${v.last_visited_at?.slice(0, 10) ?? ""}`
        : `  ·  ${c.flag} ${c.name}`;
      return { visited: !!v, line };
    });
  const visited = rows.filter((r) => r.visited).length;
  const sorted = [...rows.filter((r) => r.visited), ...rows.filter((r) => !r.visited)];
  return [`Passport: visited ${visited} of ${rows.length} countries`, ...sorted.map((r) => r.line)].join("\n") + "\n";
}

const REASON = { picked: "picked", visited: "visited", skipped: "skipped", superseded: "replaced by a newer pick" };

/** One page of history (F9.2). */
export function history(page: HistoryPage, countries: Countries): string {
  if (page.entries.length === 0) return "No history yet.\n";
  const lines = page.entries.map(
    (e) =>
      `${e.at.slice(0, 16).replace("T", " ")}  ${e.restaurant_name.padEnd(24)} ${label(countries, e.country_iso).padEnd(26)} ${REASON[e.reason]}`,
  );
  if (page.next_cursor) lines.push(`More: fat-horses history --cursor '${page.next_cursor}'`);
  return lines.join("\n") + "\n";
}
