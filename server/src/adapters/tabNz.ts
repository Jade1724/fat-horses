// TAB NZ Affiliates API client (docs/spikes/tab-nz.md).

import { z } from "zod";
import type { Race, RaceProvider, RaceStatus, RaceType, RaceUpdate } from "../domain/race";
import { MAX_LEAD_MS } from "../domain/race";
import { HOUR, ms, type Iso } from "../domain/time";
import { fetchText, type Fetch } from "./http";

export const TAB_BASE_URL = "https://api.tab.co.nz/affiliates/v1";

/** Optional identifying headers the API docs ask for. */
export interface TabIdentity {
  from?: string;
  partner?: string;
  partnerId?: string;
}

/** Read TAB_FROM, TAB_PARTNER and TAB_PARTNER_ID. */
export function identityFromEnv(env: NodeJS.ProcessEnv = process.env): TabIdentity {
  const v = (k: string) => env[k]?.trim() || undefined;
  return { from: v("TAB_FROM"), partner: v("TAB_PARTNER"), partnerId: v("TAB_PARTNER_ID") };
}

export class RaceSourceUnavailable extends Error {}

const TYPES: Record<string, RaceType> = { T: "gallops", H: "harness", G: "greyhound" };
const STATUSES: Record<string, RaceStatus> = {
  Open: "open",
  Closed: "closed",
  Interim: "interim",
  Final: "final",
  Abandoned: "abandoned",
};

const header = z.object({ error: z.string().optional(), error_code: z.string().optional() });

const meetingsResponse = z.object({
  header,
  data: z
    .object({
      meetings: z
        .array(
          z.object({
            meeting: z.string(),
            name: z.string(),
            category: z.string(),
            country: z.string().default(""),
            races: z
              .array(
                z.object({
                  id: z.string(),
                  race_number: z.number(),
                  name: z.string().default(""),
                  start_time: z.string(),
                  status: z.string(),
                }),
              )
              .default([]),
          }),
        )
        .default([]),
    })
    .optional(),
});

const eventResponse = z.object({
  header,
  data: z
    .object({
      race: z.object({ status: z.string(), advertised_start: z.number() }),
      runners: z
        .array(
          z.object({ runner_number: z.number(), name: z.string(), is_scratched: z.boolean().default(false) }),
        )
        .default([]),
      results: z.array(z.object({ position: z.number(), runner_number: z.number() })).nullish(),
    })
    .optional(),
});

function parseJson<T>(schema: z.ZodType<T>, body: string, what: string): T {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new RaceSourceUnavailable(`bad TAB NZ ${what}: not JSON`);
  }
  const r = schema.safeParse(value);
  if (!r.success) throw new RaceSourceUnavailable(`bad TAB NZ ${what}: ${r.error.message}`);
  return r.data;
}

/** NZ race days covering [now, now + 3 h]; both NZ offsets, so no zone database. */
export function raceDays(now: Iso): string[] {
  const days = new Set<string>();
  for (const t of [ms(now), ms(now) + MAX_LEAD_MS]) {
    for (const offset of [12, 13]) days.add(new Date(t + offset * HOUR).toISOString().slice(0, 10));
  }
  return [...days].sort();
}

/** Parse `/racing/meetings` or `/racing/meetings/{id}` into races without runners. */
export function parseMeetings(body: string): Race[] {
  const r = parseJson(meetingsResponse, body, "meetings");
  if (r.header.error) throw new RaceSourceUnavailable(`TAB NZ: ${r.header.error}`);
  const out: Race[] = [];
  for (const m of r.data?.meetings ?? []) {
    const race_type = TYPES[m.category];
    if (!race_type) continue;
    for (const race of m.races) {
      const status = STATUSES[race.status];
      if (!status) continue;
      out.push({
        id: race.id,
        meeting_id: m.meeting,
        venue: m.name,
        venue_country: m.country,
        race_number: race.race_number,
        name: race.name,
        race_type,
        status,
        start_time: new Date(race.start_time).toISOString(),
        runners: [],
      });
    }
  }
  return out;
}

/** `FR0002 race can not be found` is returned for abandoned races. */
export type EventResult = { found: true; update: RaceUpdate } | { found: false };

/** Parse `/racing/events/{id}`, applied to the scheduled `race`. */
export function parseEvent(body: string, race: Race): EventResult {
  const r = parseJson(eventResponse, body, "event");
  if (r.header.error_code === "FR0002") return { found: false };
  if (r.header.error) throw new RaceSourceUnavailable(`TAB NZ: ${r.header.error}`);
  if (!r.data) throw new RaceSourceUnavailable("bad TAB NZ event: no data and no error");
  const status = STATUSES[r.data.race.status];
  if (!status) throw new RaceSourceUnavailable(`bad TAB NZ event status: ${r.data.race.status}`);
  return {
    found: true,
    update: {
      race: {
        ...race,
        status,
        start_time: new Date(r.data.race.advertised_start * 1000).toISOString(),
        runners: r.data.runners
          .map((x) => ({ number: x.runner_number, name: x.name, scratched: x.is_scratched }))
          .sort((a, b) => a.number - b.number),
      },
      placings: (r.data.results ?? []).map((x) => ({ position: x.position, number: x.runner_number })),
    },
  };
}

export class TabNz implements RaceProvider {
  constructor(
    private readonly identity: TabIdentity = {},
    private readonly baseUrl = TAB_BASE_URL,
    private readonly fetchFn: Fetch = fetch,
  ) {}

  private async get(path: string): Promise<string> {
    const headers: Record<string, string> = {};
    if (this.identity.from) headers.from = this.identity.from;
    if (this.identity.partner) headers["x-partner"] = this.identity.partner;
    if (this.identity.partnerId) headers["x-partner-id"] = this.identity.partnerId;
    try {
      return await fetchText(this.baseUrl + path, { headers, fetchFn: this.fetchFn });
    } catch (e) {
      throw new RaceSourceUnavailable(String(e));
    }
  }

  async schedule(now: Iso): Promise<Race[]> {
    const byId = new Map<string, Race>();
    for (const day of raceDays(now)) {
      const body = await this.get(`/racing/meetings?date_from=${day}&date_to=${day}`);
      for (const r of parseMeetings(body)) byId.set(r.id, r);
    }
    return [...byId.values()];
  }

  async update(race: Race): Promise<RaceUpdate> {
    const event = parseEvent(await this.get(`/racing/events/${race.id}`), race);
    if (event.found) return event.update;
    // Abandoned races disappear from the event endpoint; the meeting still lists them.
    const listed = parseMeetings(await this.get(`/racing/meetings/${race.meeting_id}`)).find(
      (r) => r.id === race.id,
    );
    if (!listed) throw new RaceSourceUnavailable(`race ${race.id} not found`);
    return { race: { ...race, status: listed.status }, placings: [] };
  }
}
