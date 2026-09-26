// In-process stores (memory and JSON file): one root object holding the shared
// data and the caches. Everyone who logs in sees the same view (SPEC.md F14).

import { isFinished, type PickSession } from "../domain/session";
import type { LogEntry, Restaurant } from "../domain/status";
import {
  ConflictError,
  PickCancelled,
  logKey,
  pickedAfter,
  type CachedGuess,
  type CachedLocation,
  type Change,
  type CountryVisits,
  type HistoryPage,
  type Store,
} from "../domain/store";

export interface RootData {
  restaurants: Record<string, Restaurant>;
  picked: string | null;
  countries: Record<string, CountryVisits>;
  /** Keyed by logKey; read in reverse key order for newest first. */
  log: Record<string, LogEntry>;
  picks: Record<string, PickSession>;
  /** Public map data only. Keyed by `<place_id>#v<prompt_version>`. */
  guesses: Record<string, CachedGuess>;
  geocodes: Record<string, CachedLocation>;
}

export const emptyRoot = (): RootData => ({
  restaurants: {},
  picked: null,
  countries: {},
  log: {},
  picks: {},
  guesses: {},
  geocodes: {},
});

/**
 * Read a stored root, whatever shape it was saved in: the current flat one, the
 * per-user one that F14 used, or the flat one from before users existed. There
 * is one shared view now, so a per-user file keeps "me"'s data.
 */
export function upgradeRoot(raw: Record<string, unknown>): RootData {
  const users = raw.users as Record<string, Partial<RootData>> | undefined;
  const mine: Partial<RootData> = users
    ? (users.me ?? Object.values(users)[0] ?? {})
    : (raw as Partial<RootData>);
  const caches = raw as Partial<RootData>;
  return {
    restaurants: mine.restaurants ?? {},
    picked: mine.picked ?? null,
    countries: mine.countries ?? {},
    log: mine.log ?? {},
    picks: mine.picks ?? {},
    guesses: caches.guesses ?? {},
    geocodes: caches.geocodes ?? {},
  };
}

const clone = <T>(v: T): T => structuredClone(v);

/** The shared data plus the caches; `save` persists after each write (no-op in memory). */
export class StateStore implements Store {
  /** Writes run one at a time, so none starts from a copy another is about to replace (F13.2). */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private root: RootData,
    private readonly save: (data: RootData) => Promise<void> = async () => {},
  ) {}

  /** Apply `f` to a copy, save it, then keep it; on error nothing changes. */
  private write(f: (d: RootData) => void): Promise<void> {
    const run = this.queue.then(async () => {
      const next = clone(this.root);
      f(next);
      await this.save(next);
      this.root = next;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private read<T>(f: (d: RootData) => T): T {
    return clone(f(this.root));
  }

  async getRestaurant(id: string) {
    return this.read((d) => d.restaurants[id] ?? null);
  }

  async currentlyPicked() {
    return this.read((d) => (d.picked ? (d.restaurants[d.picked] ?? null) : null));
  }

  async apply(change: Change) {
    // Conditions are checked inside the write, against the latest state.
    await this.write((d) => {
      if (d.picked !== change.expected_picked) throw new ConflictError();
      for (const t of change.transitions) {
        if ((d.restaurants[t.restaurant.id]?.status ?? null) !== t.expected_status) throw new ConflictError();
      }
      d.picked = pickedAfter(change);
      for (const t of change.transitions) {
        if (t.country_visited) {
          const iso = t.log.country_iso;
          const c = (d.countries[iso] ??= {
            iso2: iso,
            visit_count: 0,
            first_visited_at: null,
            last_visited_at: null,
          });
          c.visit_count += 1;
          c.first_visited_at ??= t.log.at;
          c.last_visited_at = t.log.at;
        }
        d.log[logKey(t.log)] = t.log;
        d.restaurants[t.restaurant.id] = t.restaurant;
      }
    });
  }

  async countryVisits() {
    return this.read((d) => Object.values(d.countries).sort((a, b) => a.iso2.localeCompare(b.iso2)));
  }

  async history(cursor: string | null, limit: number): Promise<HistoryPage> {
    return this.read((d) => {
      const keys = Object.keys(d.log)
        .sort()
        .reverse()
        .filter((k) => cursor === null || k < cursor);
      const page = keys.slice(0, limit);
      return {
        entries: page.map((k) => d.log[k] as LogEntry),
        next_cursor: keys.length > limit ? (page.at(-1) ?? null) : null,
      };
    });
  }

  async getPick(pickId: string) {
    return this.read((d) => d.picks[pickId] ?? null);
  }

  async putPick(session: PickSession) {
    await this.write((d) => {
      if (d.picks[session.pick_id]?.status === "cancelled" && session.status !== "cancelled") {
        throw new PickCancelled(session.pick_id);
      }
      d.picks[session.pick_id] = clone(session);
    });
  }

  /** Picks that are neither done, failed nor cancelled (F13.1). */
  async unfinishedPicks(): Promise<PickSession[]> {
    return this.read((d) => Object.values(d.picks).filter((p) => !isFinished(p.status)));
  }

  async getGuess(placeId: string, promptVersion: number) {
    return this.read((d) => d.guesses[`${placeId}#v${promptVersion}`] ?? null);
  }

  async putGuess(guess: CachedGuess) {
    await this.write((d) => {
      d.guesses[`${guess.guess.place_id}#v${guess.prompt_version}`] = clone(guess);
    });
  }

  async getGeocode(key: string) {
    return this.read((d) => d.geocodes[key] ?? null);
  }

  async putGeocode(key: string, value: CachedLocation) {
    await this.write((d) => {
      d.geocodes[key] = clone(value);
    });
  }
}

/** A fresh in-memory store for tests and offline runs. */
export class MemoryStore extends StateStore {
  constructor() {
    super(emptyRoot());
  }
}
