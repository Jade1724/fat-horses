// HTTP API handlers (SPEC.md §5, F11.1), independent of any HTTP framework.

import { z } from "zod";
import {
  SESSION_TTL_SECONDS,
  signSession,
  verifyPassword,
  verifySession,
  type SessionProblem,
} from "../domain/auth";
import type { Countries, Country } from "../domain/countries";
import { GeocoderUnavailable, type Geocoder } from "../domain/places";
import { DEFAULT_MIN_POPULATION } from "../domain/pool";
import { DEFAULT_MAX_WAIT_MIN } from "../domain/race";
import type { PickSession } from "../domain/session";
import { InvalidTransition, type Restaurant } from "../domain/status";
import {
  ConflictError,
  cancelPick,
  HISTORY_PAGE,
  NotFoundError,
  recordSkip,
  recordVisit,
  type Store,
} from "../domain/store";
import type { Iso } from "../domain/time";
import { log } from "../log";
import {
  AddressNotFound,
  AmbiguousAddress,
  InvalidRequest,
  lookupAddress,
  newPickId,
  startInput,
  startPick,
} from "./start";
import { clearedSessionCookie, cookieValue, SESSION_COOKIE, sessionCookie } from "./cookies";

export interface ApiRequest {
  method: string;
  /** Path after `/api`, e.g. `/picks/01J…`; may be percent-encoded. */
  path: string;
  query: Record<string, string | undefined>;
  /** A `Cookie:` header, or API Gateway's list of `name=value` strings. */
  cookies: string | readonly string[] | undefined;
  body: string | undefined;
}

export interface ApiResponse {
  status: number;
  body: unknown;
  /** A `Set-Cookie` value, set when logging in or out. */
  setCookie?: string;
}

/** Starts and stops the workflow for a stored pick (Step Functions in AWS, a task locally). */
export interface WorkflowStarter {
  start(pickId: string): Promise<void>;
  /** Stop a running pick's workflow; best effort, the stored `cancelled` status is what counts. */
  cancel(pickId: string): Promise<void>;
}

export interface ApiDeps {
  geocoder: Geocoder;
  store: Store;
  starter: WorkflowStarter;
  countries: Countries;
  auth: AuthConfig;
}

/**
 * What logins are checked against (F11.1). The Lambda re-reads these from SSM
 * every few minutes, so rotating either one applies without a redeploy.
 */
export interface AuthConfig {
  /** scrypt hash of the shared password, as `scrypt$…`. */
  passwordHash: string;
  /** HMAC key for session tokens. A new one ends every session. */
  sessionSecret: string;
  /** Whether the cookie gets `Secure`; false for the local http server. */
  secureCookie: boolean;
}

const ok = (body: unknown): ApiResponse => ({ status: 200, body });
const error = (status: number, code: string, message: string): ApiResponse => ({
  status,
  body: { error: code, message },
});

/** Every unusable session gets the same 401; the reason is only for the log. */
function unauthorized(reason: SessionProblem): ApiResponse {
  log.debug("no session", { reason });
  return error(401, "unauthorized", reason === "expired" ? "session expired" : "log in first");
}

/** Token lifetimes are in whole seconds; the rest of the API works in ISO time. */
const seconds = (now: Iso): number => Math.floor(Date.parse(now) / 1000);

function storeError(e: unknown): ApiResponse {
  if (e instanceof ConflictError) return error(409, "conflict", e.message);
  if (e instanceof InvalidTransition) return error(409, "invalid_transition", e.message);
  if (e instanceof NotFoundError) return error(404, "not_found", e.message);
  log.error("store failure", { error: String(e) });
  return error(503, "internal", "storage unavailable");
}

type Route =
  | { kind: "login" }
  | { kind: "logout" }
  | { kind: "start" }
  | { kind: "pick"; id: string }
  | { kind: "cancel"; id: string }
  | { kind: "picked" }
  | { kind: "visit"; id: string }
  | { kind: "skip"; id: string }
  | { kind: "countries" }
  | { kind: "geocode" }
  | { kind: "history" };

function route(method: string, rawPath: string): Route | null {
  let path: string;
  try {
    path = decodeURIComponent(rawPath).replace(/\/+$/, "");
  } catch {
    return null;
  }
  if (method === "GET") {
    if (path === "/restaurants/picked") return { kind: "picked" };
    if (path === "/countries") return { kind: "countries" };
    if (path === "/geocode") return { kind: "geocode" };
    if (path === "/history") return { kind: "history" };
    const m = /^\/picks\/([^/]+)$/.exec(path);
    return m?.[1] ? { kind: "pick", id: m[1] } : null;
  }
  if (method === "POST") {
    if (path === "/login") return { kind: "login" };
    if (path === "/logout") return { kind: "logout" };
    if (path === "/picks") return { kind: "start" };
    const c = /^\/picks\/([^/]+)\/cancel$/.exec(path);
    if (c?.[1]) return { kind: "cancel", id: c[1] };
    // Restaurant ids contain '/' (osm:node/1), so match from both ends.
    const m = /^\/restaurants\/(.+)\/(visit|skip)$/.exec(path);
    if (m?.[1]) return { kind: m[2] === "visit" ? "visit" : "skip", id: m[1] };
  }
  return null;
}

const loginBody = z.object({ password: z.string().min(1) });

const visitBody = z.object({
  restaurant: z
    .object({
      name: z.string(),
      lat: z.number(),
      lon: z.number(),
      address: z.string().nullish(),
      cuisine: z.array(z.string()).default([]),
      country_iso: z.string(),
    })
    .optional(),
});

function parseBody<T>(schema: z.ZodType<T>, body: string | undefined): T | ApiResponse {
  let value: unknown = {};
  if (body?.trim()) {
    try {
      value = JSON.parse(body);
    } catch {
      return error(422, "invalid_request", "body is not JSON");
    }
  }
  const r = schema.safeParse(value);
  return r.success ? r.data : error(422, "invalid_request", r.error.message);
}

const isResponse = (v: unknown): v is ApiResponse =>
  typeof v === "object" && v !== null && "status" in v && "body" in v;

const countryView = (c: Country | undefined) => (c ? { iso2: c.iso2, name: c.name, flag: c.flag } : null);

export class Api {
  constructor(private readonly deps: ApiDeps) {}

  async handle(req: ApiRequest, now: Iso): Promise<ApiResponse> {
    const r = route(req.method.toUpperCase(), req.path);
    if (!r) return error(404, "not_found", "no such endpoint");

    // Logging in is the one thing a request without a session may do.
    if (r.kind === "login") return await this.login(req.body, now);
    if (r.kind === "logout") return this.logout();

    const check = verifySession(
      this.deps.auth.sessionSecret,
      cookieValue(SESSION_COOKIE, req.cookies),
      seconds(now),
    );
    if (!check.valid) return unauthorized(check.reason);

    try {
      switch (r.kind) {
        case "start":
          return await this.start(req.body, now);
        case "pick":
          return await this.getPick(r.id);
        case "cancel":
          return await this.cancel(r.id);
        case "picked":
          return ok(await this.deps.store.currentlyPicked());
        case "visit":
          return await this.visit(r.id, req.body, now);
        case "skip":
          return ok(await recordSkip(this.deps.store, r.id, now));
        case "countries":
          return await this.countries(req.query.min_population);
        case "geocode":
          return await this.geocode(req.query.q, now);
        case "history":
          return ok(await this.deps.store.history(req.query.cursor ?? null, HISTORY_PAGE));
      }
    } catch (e) {
      return storeError(e);
    }
  }

  private async start(body: string | undefined, now: Iso): Promise<ApiResponse> {
    const input = parseBody(startInput, body);
    if (isResponse(input)) return input;
    let session: PickSession;
    try {
      session = await startPick(this.deps.geocoder, this.deps.store, input, newPickId(), now);
    } catch (e) {
      if (e instanceof InvalidRequest) return error(422, "invalid_request", e.message);
      if (e instanceof AddressNotFound) return error(422, "address_not_found", e.message);
      if (e instanceof AmbiguousAddress) {
        return {
          status: 409,
          body: { error: "ambiguous_address", message: e.message, matches: e.matches },
        };
      }
      if (e instanceof GeocoderUnavailable) {
        log.error("geocoder unavailable", { error: e.message });
        return error(503, "internal", "geocoder unavailable");
      }
      throw e;
    }
    await this.deps.store.putPick(session);
    try {
      await this.deps.starter.start(session.pick_id);
    } catch (e) {
      log.error("workflow start failed", { pick_id: session.pick_id, error: String(e) });
      await this.deps.store
        .putPick({ ...session, status: "failed", error: "internal" })
        .catch(() => undefined);
      return error(503, "internal", "could not start the pick");
    }
    return { status: 202, body: { pick_id: session.pick_id } };
  }

  /** F12: mark the pick cancelled, then stop its workflow. Finished picks are left as they are. */
  private async cancel(id: string): Promise<ApiResponse> {
    const s = await cancelPick(this.deps.store, id);
    if (s.status === "cancelled") {
      await this.deps.starter
        .cancel(id)
        .catch((e: unknown) => log.warn("workflow stop failed", { pick_id: id, error: String(e) }));
    }
    return ok(await this.pickView(s, this.deps.store));
  }

  /**
   * F11.1: exchange the shared password for a session cookie. The reply carries
   * no token of its own, so nothing on the page can read or store one.
   */
  private async login(body: string | undefined, now: Iso): Promise<ApiResponse> {
    const { passwordHash, sessionSecret, secureCookie } = this.deps.auth;
    if (!passwordHash.startsWith("scrypt$")) {
      log.error("no password set", {});
      return error(503, "internal", "no password set (scripts/set-password.sh)");
    }
    const parsed = parseBody(loginBody, body);
    if (isResponse(parsed)) return parsed;
    if (!(await verifyPassword(parsed.password, passwordHash))) {
      log.warn("login refused", {});
      return error(401, "unauthorized", "wrong password");
    }
    log.info("login", {});
    return {
      status: 200,
      body: { expires_in: SESSION_TTL_SECONDS },
      setCookie: sessionCookie(signSession(sessionSecret, seconds(now)), SESSION_TTL_SECONDS, secureCookie),
    };
  }

  /** Ends this browser's session. Other sessions are unaffected. */
  private logout(): ApiResponse {
    return { status: 200, body: { ok: true }, setCookie: clearedSessionCookie(this.deps.auth.secureCookie) };
  }

  /** F1.2: the distinct places matching an address, so the user can choose one. */
  private async geocode(q: string | undefined, now: Iso): Promise<ApiResponse> {
    const address = q?.trim();
    if (!address) return error(422, "invalid_request", "q is required");
    if (address.length > 300) return error(422, "invalid_request", "q is too long");
    try {
      return ok({ matches: await lookupAddress(this.deps.geocoder, this.deps.store, address, now) });
    } catch (e) {
      if (e instanceof GeocoderUnavailable) {
        log.error("geocoder unavailable", { error: e.message });
        return error(503, "internal", "geocoder unavailable");
      }
      throw e;
    }
  }

  private async getPick(id: string): Promise<ApiResponse> {
    const s = await this.deps.store.getPick(id);
    return s ? ok(await this.pickView(s, this.deps.store)) : error(404, "not_found", "no such pick");
  }

  /** The §5 pick view, with each restaurant's current stored status. */
  async pickView(s: PickSession, store: Store) {
    const { countries } = this.deps;
    const restaurants = [];
    for (const m of s.matches) {
      const p = s.places.find((x) => x.id === m.place_id);
      if (!p) continue;
      const stored = await store.getRestaurant(p.id);
      restaurants.push({
        id: p.id,
        name: p.name,
        lat: p.lat,
        lon: p.lon,
        address: p.address,
        cuisine: p.cuisine,
        match: m.match,
        reason: m.reason,
        status: stored?.status ?? null,
        visit_count: stored?.visit_count ?? 0,
        distance_m: p.distance_m,
      });
    }
    const w = s.winner;
    return {
      pick_id: s.pick_id,
      status: s.status,
      error: s.error,
      created_at: s.created_at,
      location: { ...s.location, radius_m: s.request.radius_m },
      max_wait_min: s.request.max_wait_min ?? DEFAULT_MAX_WAIT_MIN,
      world_complete: s.world_complete,
      race:
        s.race && s.card
          ? {
              venue: s.race.venue,
              race_number: s.race.race_number,
              name: s.race.name,
              start_time: s.race.start_time,
              url: s.race.url ?? null,
              runners: s.card.entries.map((e) => ({
                number: e.number,
                horse: e.horse,
                country: e.country_iso ? countryView(countries.get(e.country_iso)) : null,
                scratched: e.scratched,
              })),
            }
          : null,
      winner: w
        ? {
            number: w.number,
            horse: s.card?.entries.find((e) => e.number === w.number)?.horse ?? null,
            country: countryView(countries.get(w.country_iso)),
            reason: w.reason,
            ...(w.tied.length > 0 ? { tied: w.tied } : {}),
          }
        : null,
      restaurants,
      pick: s.pick,
      dishes:
        w && s.status === "done" && s.matches.length === 0
          ? (countries.get(w.country_iso)?.dishes ?? null)
          : null,
      llm_unavailable: s.llm_unavailable,
    };
  }

  private async visit(id: string, body: string | undefined, now: Iso): Promise<ApiResponse> {
    const parsed = parseBody(visitBody, body);
    if (isResponse(parsed)) return parsed;
    let details: Restaurant | null = null;
    if (parsed.restaurant) {
      const d = parsed.restaurant;
      if (!this.deps.countries.get(d.country_iso))
        return error(422, "invalid_request", "unknown country_iso");
      details = {
        id,
        name: d.name,
        lat: d.lat,
        lon: d.lon,
        address: d.address ?? null,
        cuisine: d.cuisine,
        country_iso: d.country_iso,
        status: null,
        status_before_pick: null,
        picked_at: null,
        visited_at: null,
        visit_count: 0,
        pick_id: null,
        match: null,
        reason: null,
      };
    }
    try {
      return ok(await recordVisit(this.deps.store, id, details, now));
    } catch (e) {
      if (e instanceof NotFoundError) {
        return error(
          422,
          "invalid_request",
          "restaurant details are required for a restaurant that was never picked",
        );
      }
      throw e;
    }
  }

  private async countries(minPopulation: string | undefined): Promise<ApiResponse> {
    const min = minPopulation === undefined ? DEFAULT_MIN_POPULATION : Number(minPopulation);
    if (!Number.isFinite(min) || min < 0) return error(422, "invalid_request", "bad min_population");
    const visits = new Map((await this.deps.store.countryVisits()).map((v) => [v.iso2, v]));
    const rows = this.deps.countries.all
      .filter((c) => c.population >= min)
      .map((c) => {
        const v = visits.get(c.iso2);
        const count = v?.visit_count ?? 0;
        return {
          iso2: c.iso2,
          name: c.name,
          flag: c.flag,
          visited: count > 0,
          visit_count: count,
          last_visited_at: v?.last_visited_at ?? null,
        };
      });
    return ok({ visited: rows.filter((r) => r.visited).length, total: rows.length, countries: rows });
  }
}
