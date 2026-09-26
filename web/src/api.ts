// Typed client for the HTTP API (SPEC.md §5).

export type PickStatus =
  "finding_race" | "waiting_start" | "running" | "resolving" | "searching" | "done" | "failed" | "cancelled";

export type PickError =
  "no_upcoming_race" | "race_source_unavailable" | "places_unavailable" | "no_matching_places" | "internal";

export type RestaurantStatus = "PICKED" | "VISITED" | null;
export type MatchKind = "tagged" | "inferred" | "fallback";
export type WinReason = "result" | "dead_heat" | "abandoned" | "timeout";

export interface Country {
  iso2: string;
  name: string;
  flag: string;
}

export interface Runner {
  number: number;
  horse: string;
  country: Country | null;
  scratched: boolean;
}

export interface Race {
  venue: string;
  race_number: number;
  name: string;
  start_time: string;
  runners: Runner[];
  /** The race's page on tab.co.nz, where it can be watched; null for older picks. */
  url: string | null;
}

export interface Winner {
  number: number;
  horse: string | null;
  country: Country | null;
  reason: WinReason;
  tied?: number[];
}

export interface PickRestaurant {
  id: string;
  name: string;
  lat: number;
  lon: number;
  address: string | null;
  cuisine: string[];
  match: MatchKind;
  reason: string | null;
  status: RestaurantStatus;
  visit_count: number;
  distance_m: number;
}

export interface PickView {
  pick_id: string;
  status: PickStatus;
  error: PickError | null;
  created_at: string;
  location: { lat: number; lon: number; display_name: string; radius_m: number };
  /** Races had to start within this many minutes (F3.2). */
  max_wait_min: number;
  world_complete: boolean;
  race: Race | null;
  winner: Winner | null;
  restaurants: PickRestaurant[];
  pick: string | null;
  dishes: string[] | null;
  llm_unavailable: boolean;
}

/** A stored restaurant (`/restaurants/...` responses). */
export interface StoredRestaurant {
  id: string;
  name: string;
  lat: number;
  lon: number;
  address: string | null;
  cuisine: string[];
  country_iso: string;
  status: RestaurantStatus;
  visit_count: number;
  visited_at: string | null;
  picked_at: string | null;
}

export interface PassportCountry extends Country {
  visited: boolean;
  visit_count: number;
  last_visited_at: string | null;
}

export interface Passport {
  visited: number;
  total: number;
  countries: PassportCountry[];
}

export interface HistoryEntry {
  at: string;
  restaurant_id: string;
  restaurant_name: string;
  country_iso: string;
  from: RestaurantStatus;
  to: RestaurantStatus;
  reason: "picked" | "visited" | "skipped" | "superseded";
  pick_id: string | null;
}

export interface HistoryPage {
  entries: HistoryEntry[];
  next_cursor: string | null;
}

export interface StartPick {
  address?: string;
  lat?: number;
  lon?: number;
  radius_m?: number;
  min_population?: number;
  include_visited?: boolean;
  max_wait_min?: number;
  /** With lat+lon: the address to show (a match chosen from `geocode`). */
  label?: string;
}

export interface AddressMatch {
  lat: number;
  lon: number;
  display_name: string;
}

export interface VisitDetails {
  name: string;
  lat: number;
  lon: number;
  address: string | null;
  cuisine: string[];
  country_iso: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type Fetch = typeof fetch;

export class Api {
  private readonly onUnauthorized: () => void;
  private readonly fetchFn: Fetch;
  private readonly base: string;

  constructor(onUnauthorized: () => void, fetchFn: Fetch = (...args) => fetch(...args), base = "/api") {
    this.onUnauthorized = onUnauthorized;
    this.fetchFn = fetchFn;
    this.base = base;
  }

  /**
   * The session is an HttpOnly cookie (F11.2), so there is no token here to
   * send, store or leak: the browser attaches it to every same-origin call.
   */
  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    const resp = await this.fetchFn(this.base + path, {
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data: unknown = await resp.json().catch(() => null);
    if (!resp.ok) {
      if (resp.status === 401) this.onUnauthorized();
      const err = (data ?? {}) as { error?: string; message?: string };
      throw new ApiError(resp.status, err.error ?? "http_error", err.message ?? resp.statusText);
    }
    return data as T;
  }

  /** Trade the shared password for a session cookie (F11.1). */
  login(password: string): Promise<{ expires_in: number }> {
    return this.call("POST", "/login", { password });
  }

  /** End this browser's session. */
  logout(): Promise<{ ok: boolean }> {
    return this.call("POST", "/logout", {});
  }

  startPick(input: StartPick): Promise<{ pick_id: string }> {
    return this.call("POST", "/picks", input);
  }

  /** Places matching an address, best first (F1.2). */
  geocode(q: string): Promise<{ matches: AddressMatch[] }> {
    return this.call("GET", `/geocode?q=${encodeURIComponent(q)}`);
  }

  /** Cancel a pick that is still in progress (F12); returns the updated view. */
  cancelPick(id: string): Promise<PickView> {
    return this.call("POST", `/picks/${encodeURIComponent(id)}/cancel`, {});
  }

  getPick(id: string): Promise<PickView> {
    return this.call("GET", `/picks/${encodeURIComponent(id)}`);
  }

  picked(): Promise<StoredRestaurant | null> {
    return this.call("GET", "/restaurants/picked");
  }

  visit(id: string, details?: VisitDetails): Promise<StoredRestaurant> {
    return this.call(
      "POST",
      `/restaurants/${encodeURIComponent(id)}/visit`,
      details ? { restaurant: details } : {},
    );
  }

  skip(id: string): Promise<StoredRestaurant> {
    return this.call("POST", `/restaurants/${encodeURIComponent(id)}/skip`, {});
  }

  countries(minPopulation?: number): Promise<Passport> {
    const q = minPopulation === undefined ? "" : `?min_population=${minPopulation}`;
    return this.call("GET", `/countries${q}`);
  }

  history(cursor?: string | null): Promise<HistoryPage> {
    const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    return this.call("GET", `/history${q}`);
  }
}
