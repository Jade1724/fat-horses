// In-process store state shared by the memory and JSON-file stores.

import type { PickSession } from "../domain/session";
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

export interface StateData {
  restaurants: Record<string, Restaurant>;
  picked: string | null;
  countries: Record<string, CountryVisits>;
  /** Keyed by logKey; read in reverse key order for newest first. */
  log: Record<string, LogEntry>;
  picks: Record<string, PickSession>;
  /** Keyed by `<place_id>#v<prompt_version>`. */
  guesses: Record<string, CachedGuess>;
  geocodes: Record<string, CachedLocation>;
}

export function emptyState(): StateData {
  return { restaurants: {}, picked: null, countries: {}, log: {}, picks: {}, guesses: {}, geocodes: {} };
}

const clone = <T>(v: T): T => structuredClone(v);

/** A Store over a plain object. `save` persists after every write (no-op in memory). */
export class StateStore implements Store {
  constructor(
    protected data: StateData,
    private readonly save: (data: StateData) => Promise<void> = async () => {},
  ) {}

  /** Apply `f` to a copy, save it, then keep it; on error nothing changes. */
  private async write(f: (d: StateData) => void): Promise<void> {
    const next = clone(this.data);
    f(next);
    await this.save(next);
    this.data = next;
  }

  async getRestaurant(id: string) {
    return clone(this.data.restaurants[id] ?? null);
  }

  async currentlyPicked() {
    return this.data.picked ? clone(this.data.restaurants[this.data.picked] ?? null) : null;
  }

  async apply(change: Change) {
    if (this.data.picked !== change.expected_picked) throw new ConflictError();
    for (const t of change.transitions) {
      if ((this.data.restaurants[t.restaurant.id]?.status ?? null) !== t.expected_status)
        throw new ConflictError();
    }
    await this.write((d) => {
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
    return clone(Object.values(this.data.countries).sort((a, b) => a.iso2.localeCompare(b.iso2)));
  }

  async history(cursor: string | null, limit: number): Promise<HistoryPage> {
    const keys = Object.keys(this.data.log)
      .sort()
      .reverse()
      .filter((k) => cursor === null || k < cursor);
    const page = keys.slice(0, limit);
    return {
      entries: clone(page.map((k) => this.data.log[k] as LogEntry)),
      next_cursor: keys.length > limit ? (page.at(-1) ?? null) : null,
    };
  }

  async getPick(pickId: string) {
    return clone(this.data.picks[pickId] ?? null);
  }

  async putPick(session: PickSession) {
    if (this.data.picks[session.pick_id]?.status === "cancelled" && session.status !== "cancelled") {
      throw new PickCancelled(session.pick_id);
    }
    await this.write((d) => {
      d.picks[session.pick_id] = clone(session);
    });
  }

  async getGuess(placeId: string, promptVersion: number) {
    return clone(this.data.guesses[`${placeId}#v${promptVersion}`] ?? null);
  }

  async putGuess(guess: CachedGuess) {
    await this.write((d) => {
      d.guesses[`${guess.guess.place_id}#v${guess.prompt_version}`] = clone(guess);
    });
  }

  async getGeocode(key: string) {
    return clone(this.data.geocodes[key] ?? null);
  }

  async putGeocode(key: string, value: CachedLocation) {
    await this.write((d) => {
      d.geocodes[key] = clone(value);
    });
  }
}

/** In-memory store for tests and offline runs. */
export class MemoryStore extends StateStore {
  constructor() {
    super(emptyState());
  }
}
