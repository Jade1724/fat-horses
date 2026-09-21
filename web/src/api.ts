// Typed client for the HTTP API (SPEC.md §5).

export type PickStatus =
  | "finding_race"
  | "waiting_start"
  | "running"
  | "resolving"
  | "searching"
  | "done"
  | "failed";

export type PickError =
  | "no_upcoming_race"
  | "race_source_unavailable"
  | "places_unavailable"
  | "internal";

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
  private readonly key: string;
  private readonly onUnauthorized: () => void;
  private readonly fetchFn: Fetch;
  private readonly base: string;

  constructor(
    key: string,
    onUnauthorized: () => void,
    fetchFn: Fetch = (...args) => fetch(...args),
    base = "/api",
  ) {
    this.key = key;
    this.onUnauthorized = onUnauthorized;
    this.fetchFn = fetchFn;
    this.base = base;
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { "x-api-key": this.key };
    if (body !== undefined) headers["content-type"] = "application/json";
    const resp = await this.fetchFn(this.base + path, {
      method,
      headers,
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

  startPick(input: StartPick): Promise<{ pick_id: string }> {
    return this.call("POST", "/picks", input);
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
