// In-process stores (memory and JSON file): one root object with a section per
// user (F14) and the shared caches.

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
  type Stores,
} from "../domain/store";
import { DEFAULT_USER } from "../domain/users";

/** One user's data. */
export interface UserData {
  restaurants: Record<string, Restaurant>;
  picked: string | null;
  countries: Record<string, CountryVisits>;
  /** Keyed by logKey; read in reverse key order for newest first. */
  log: Record<string, LogEntry>;
  picks: Record<string, PickSession>;
}

export interface RootData {
  users: Record<string, UserData>;
  /** Shared: public map data only. Keyed by `<place_id>#v<prompt_version>`. */
  guesses: Record<string, CachedGuess>;
  geocodes: Record<string, CachedLocation>;
}

export const emptyUser = (): UserData => ({
  restaurants: {},
  picked: null,
  countries: {},
  log: {},
  picks: {},
});
export const emptyRoot = (): RootData => ({ users: {}, guesses: {}, geocodes: {} });

/** Read a stored root, moving data saved before users existed to the default user. */
export function upgradeRoot(raw: Record<string, unknown>): RootData {
  if (raw.users) return { ...emptyRoot(), ...(raw as Partial<RootData>) } as RootData;
  const old = raw as Partial<UserData> & Partial<RootData>;
  return {
    users: {
      [DEFAULT_USER]: {
        restaurants: old.restaurants ?? {},
        picked: old.picked ?? null,
        countries: old.countries ?? {},
        log: old.log ?? {},
        picks: old.picks ?? {},
      },
    },
    guesses: old.guesses ?? {},
    geocodes: old.geocodes ?? {},
  };
}

const clone = <T>(v: T): T => structuredClone(v);

/** Every user's data plus the caches; `save` persists after each write (no-op in memory). */
export class StateStores implements Stores {
  /** Writes run one at a time, so none starts from a copy another is about to replace (F13.2). */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private root: RootData,
    private readonly save: (data: RootData) => Promise<void> = async () => {},
  ) {}

  forUser(user: string): UserStore {
    return new UserStore(this, user);
  }

  /** Apply `f` to a copy, save it, then keep it; on error nothing changes. */
  write(f: (d: RootData) => void): Promise<void> {
    const run = this.queue.then(async () => {
      const next = clone(this.root);
      f(next);
      await this.save(next);
      this.root = next;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  read<T>(f: (d: RootData) => T): T {
    return clone(f(this.root));
  }

  /** Picks that are neither done, failed nor cancelled, for every user (F13.1). */
  async unfinishedPicks(): Promise<{ user: string; session: PickSession }[]> {
    return this.read((d) =>
      Object.entries(d.users).flatMap(([user, u]) =>
        Object.values(u.picks)
          .filter((p) => !isFinished(p.status))
          .map((session) => ({ user, session })),
      ),
    );
  }
}

/** One user's view of a StateStores. */
export class UserStore implements Store {
  constructor(
    private readonly all: StateStores,
    readonly user: string,
  ) {}

  private get<T>(f: (u: UserData) => T): T {
    return this.all.read((d) => f(d.users[this.user] ?? emptyUser()));
  }

  private write(f: (u: UserData, d: RootData) => void): Promise<void> {
    return this.all.write((d) => f((d.users[this.user] ??= emptyUser()), d));
  }

  async getRestaurant(id: string) {
    return this.get((u) => u.restaurants[id] ?? null);
  }

  async currentlyPicked() {
    return this.get((u) => (u.picked ? (u.restaurants[u.picked] ?? null) : null));
  }

  async apply(change: Change) {
    // Conditions are checked inside the write, against the latest state.
    await this.write((u) => {
      if (u.picked !== change.expected_picked) throw new ConflictError();
      for (const t of change.transitions) {
        if ((u.restaurants[t.restaurant.id]?.status ?? null) !== t.expected_status) throw new ConflictError();
      }
      u.picked = pickedAfter(change);
      for (const t of change.transitions) {
        if (t.country_visited) {
          const iso = t.log.country_iso;
          const c = (u.countries[iso] ??= {
            iso2: iso,
            visit_count: 0,
            first_visited_at: null,
            last_visited_at: null,
          });
          c.visit_count += 1;
          c.first_visited_at ??= t.log.at;
          c.last_visited_at = t.log.at;
        }
        u.log[logKey(t.log)] = t.log;
        u.restaurants[t.restaurant.id] = t.restaurant;
      }
    });
  }

  async countryVisits() {
    return this.get((u) => Object.values(u.countries).sort((a, b) => a.iso2.localeCompare(b.iso2)));
  }

  async history(cursor: string | null, limit: number): Promise<HistoryPage> {
    return this.get((u) => {
      const keys = Object.keys(u.log)
        .sort()
        .reverse()
        .filter((k) => cursor === null || k < cursor);
      const page = keys.slice(0, limit);
      return {
        entries: page.map((k) => u.log[k] as LogEntry),
        next_cursor: keys.length > limit ? (page.at(-1) ?? null) : null,
      };
    });
  }

  async getPick(pickId: string) {
    return this.get((u) => u.picks[pickId] ?? null);
  }

  async putPick(session: PickSession) {
    await this.write((u) => {
      if (u.picks[session.pick_id]?.status === "cancelled" && session.status !== "cancelled") {
        throw new PickCancelled(session.pick_id);
      }
      u.picks[session.pick_id] = clone(session);
    });
  }

  /** This user's unfinished picks (F13.1). */
  async unfinishedPicks(): Promise<PickSession[]> {
    return this.get((u) => Object.values(u.picks).filter((p) => !isFinished(p.status)));
  }

  async getGuess(placeId: string, promptVersion: number) {
    return this.all.read((d) => d.guesses[`${placeId}#v${promptVersion}`] ?? null);
  }

  async putGuess(guess: CachedGuess) {
    await this.write((_u, d) => {
      d.guesses[`${guess.guess.place_id}#v${guess.prompt_version}`] = clone(guess);
    });
  }

  async getGeocode(key: string) {
    return this.all.read((d) => d.geocodes[key] ?? null);
  }

  async putGeocode(key: string, value: CachedLocation) {
    await this.write((_u, d) => {
      d.geocodes[key] = clone(value);
    });
  }
}

/** In-memory stores for tests and offline runs. */
export class MemoryStores extends StateStores {
  constructor() {
    super(emptyRoot());
  }
}

/** A fresh in-memory store for the default user. */
export class MemoryStore extends UserStore {
  constructor() {
    super(new MemoryStores(), DEFAULT_USER);
  }
}
