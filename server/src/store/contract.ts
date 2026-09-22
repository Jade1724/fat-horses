// The contract every store must pass (SPEC.md §4.2). Call `runContract` with a
// factory for fresh, empty stores; failures throw with the scenario name.

import assert from "node:assert/strict";
import type { PickSession } from "../domain/session";
import { newSession } from "../domain/session";
import { applyEvent, type Restaurant } from "../domain/status";
import {
  cancelPick,
  ConflictError,
  NotFoundError,
  PickCancelled,
  recordPick,
  recordSkip,
  recordVisit,
  type CachedGuess,
  type HistoryPage,
  type Store,
} from "../domain/store";
import { InvalidTransition } from "../domain/status";
import { addMs, MINUTE } from "../domain/time";

const T0 = "2026-09-21T10:00:00.000Z";
const at = (m: number) => addMs(T0, m * MINUTE);

export function contractRestaurant(id: string, countryIso: string): Restaurant {
  return {
    id,
    name: `Restaurant ${id}`,
    lat: -36.85,
    lon: 174.76,
    address: "1 Queen Street",
    cuisine: ["japanese"],
    country_iso: countryIso,
    status: null,
    status_before_pick: null,
    picked_at: null,
    visited_at: null,
    visit_count: 0,
    pick_id: null,
    match: "tagged",
    reason: null,
  };
}
const r = contractRestaurant;

async function rejects(p: Promise<unknown>, type: new (...args: never[]) => Error): Promise<void> {
  await assert.rejects(p, (e) => e instanceof type);
}

const scenarios: Record<string, (s: Store) => Promise<void>> = {
  async "empty store"(s) {
    assert.equal(await s.getRestaurant("osm:node/1"), null);
    assert.equal(await s.currentlyPicked(), null);
    assert.deepEqual(await s.countryVisits(), []);
    assert.deepEqual(await s.history(null, 10), { entries: [], next_cursor: null });
  },

  async "a pick stores the restaurant"(s) {
    const got = await recordPick(s, r("osm:node/1", "JP"), "p1", at(0));
    assert.equal(got.status, "PICKED");
    assert.deepEqual(await s.getRestaurant("osm:node/1"), got);
    assert.equal((await s.currentlyPicked())?.id, "osm:node/1");
    const h = await s.history(null, 10);
    assert.equal(h.entries.length, 1);
    assert.equal(h.entries[0]?.reason, "picked");
    assert.equal(h.entries[0]?.pick_id, "p1");
  },

  async "a new pick supersedes the old one"(s) {
    await recordPick(s, r("osm:node/1", "JP"), "p1", at(0));
    await recordPick(s, r("osm:node/2", "IT"), "p2", at(1));
    assert.equal((await s.getRestaurant("osm:node/1"))?.status, null);
    assert.equal((await s.currentlyPicked())?.id, "osm:node/2");
    const reasons = (await s.history(null, 10)).entries.map((e) => e.reason);
    assert.deepEqual(reasons, ["picked", "superseded", "picked"]);
  },

  async "the same restaurant picked twice"(s) {
    await recordPick(s, r("osm:node/1", "JP"), "p1", at(0));
    const again = await recordPick(s, r("osm:node/1", "JP"), "p2", at(1));
    assert.equal(again.status, "PICKED");
    assert.equal(again.pick_id, "p2");
    assert.equal((await s.currentlyPicked())?.id, "osm:node/1");
  },

  async "visit after a pick, then again"(s) {
    await recordPick(s, r("osm:node/1", "JP"), "p1", at(0));
    const v = await recordVisit(s, "osm:node/1", null, at(30));
    assert.equal(v.status, "VISITED");
    assert.equal(v.visit_count, 1);
    assert.equal(await s.currentlyPicked(), null);
    let c = await s.countryVisits();
    assert.deepEqual(c, [{ iso2: "JP", visit_count: 1, first_visited_at: at(30), last_visited_at: at(30) }]);
    await recordPick(s, r("osm:node/1", "JP"), "p2", at(60));
    assert.equal((await s.getRestaurant("osm:node/1"))?.status_before_pick, "VISITED");
    assert.equal((await recordVisit(s, "osm:node/1", null, at(90))).visit_count, 2);
    c = await s.countryVisits();
    assert.deepEqual(c, [{ iso2: "JP", visit_count: 2, first_visited_at: at(30), last_visited_at: at(90) }]);
  },

  async "visit from the map"(s) {
    await rejects(recordVisit(s, "osm:node/7", null, at(0)), NotFoundError);
    const v = await recordVisit(s, "osm:node/7", r("osm:node/7", "MX"), at(0));
    assert.equal(v.status, "VISITED");
    assert.equal((await s.countryVisits())[0]?.iso2, "MX");
    await recordPick(s, r("osm:node/8", "JP"), "p1", at(1));
    await recordVisit(s, "osm:node/7", null, at(2));
    assert.equal((await s.currentlyPicked())?.id, "osm:node/8", "a map visit leaves the PICKED one alone");
  },

  async "skip restores"(s) {
    await recordPick(s, r("osm:node/1", "JP"), "p1", at(0));
    assert.equal((await recordSkip(s, "osm:node/1", at(1))).status, null);
    assert.equal(await s.currentlyPicked(), null);
    assert.deepEqual(await s.countryVisits(), []);
  },

  async "invalid transitions"(s) {
    await rejects(recordSkip(s, "osm:node/1", at(0)), NotFoundError);
    await recordVisit(s, "osm:node/1", r("osm:node/1", "JP"), at(0));
    await rejects(recordSkip(s, "osm:node/1", at(1)), InvalidTransition);
  },

  async "stale writes conflict and write nothing"(s) {
    await recordPick(s, r("osm:node/1", "JP"), "p1", at(0));
    const stale = applyEvent(r("osm:node/1", "JP"), { kind: "visit" }, at(1));
    await rejects(s.apply({ transitions: [stale], expected_picked: "osm:node/1" }), ConflictError);
    const fresh = applyEvent(r("osm:node/2", "IT"), { kind: "visit" }, at(2));
    await rejects(s.apply({ transitions: [fresh], expected_picked: null }), ConflictError);
    assert.equal(await s.getRestaurant("osm:node/2"), null);
    assert.equal((await s.history(null, 10)).entries.length, 1);
    assert.deepEqual(await s.countryVisits(), []);
  },

  async "history pages"(s) {
    for (let i = 0; i < 5; i++) await recordVisit(s, `osm:node/${i}`, r(`osm:node/${i}`, "JP"), at(i));
    const ids = (p: HistoryPage) => p.entries.map((e) => e.restaurant_id);
    const p1 = await s.history(null, 2);
    assert.deepEqual(ids(p1), ["osm:node/4", "osm:node/3"]);
    const p2 = await s.history(p1.next_cursor, 2);
    assert.deepEqual(ids(p2), ["osm:node/2", "osm:node/1"]);
    const p3 = await s.history(p2.next_cursor, 2);
    assert.deepEqual(ids(p3), ["osm:node/0"]);
    assert.equal(p3.next_cursor, null);
  },

  async "pick sessions"(s) {
    assert.equal(await s.getPick("p1"), null);
    const session: PickSession = newSession(
      "p1",
      T0,
      { radius_m: 200, min_population: 10_000_000, include_visited: false },
      { lat: -36.85, lon: 174.76, display_name: "Sky Tower" },
    );
    await s.putPick(session);
    assert.deepEqual(await s.getPick("p1"), session);
    const done = { ...session, status: "done" as const, pick: "osm:node/1" };
    await s.putPick(done);
    assert.deepEqual(await s.getPick("p1"), done);
  },

  async "a cancelled pick stays cancelled"(s) {
    const session: PickSession = newSession(
      "p9",
      T0,
      { radius_m: 200, min_population: 10_000_000, include_visited: false, max_wait_min: 10 },
      { lat: -36.85, lon: 174.76, display_name: "Sky Tower" },
    );
    await s.putPick({ ...session, status: "waiting_start" });
    const cancelled = await cancelPick(s, "p9");
    assert.equal(cancelled.status, "cancelled");
    assert.equal((await s.getPick("p9"))?.status, "cancelled");
    await rejects(s.putPick({ ...session, status: "running" }), PickCancelled);
    assert.equal((await s.getPick("p9"))?.status, "cancelled");
    // Cancelling again, or a finished pick, changes nothing.
    assert.equal((await cancelPick(s, "p9")).status, "cancelled");
    await s.putPick({ ...session, pick_id: "p10", status: "done" });
    assert.equal((await cancelPick(s, "p10")).status, "done");
    await rejects(cancelPick(s, "missing"), NotFoundError);
  },

  async "guess cache"(s) {
    const g = (v: number, tag: string): CachedGuess => ({
      guess: { place_id: "osm:node/1", cuisines: [{ tag, confidence: 0.9 }], reason: "name" },
      prompt_version: v,
      input_hash: "abc",
      model_id: "model",
      created_at: T0,
    });
    assert.equal(await s.getGuess("osm:node/1", 1), null);
    await s.putGuess(g(1, "japanese"));
    await s.putGuess(g(2, "sushi"));
    assert.deepEqual(await s.getGuess("osm:node/1", 1), g(1, "japanese"));
    assert.deepEqual(await s.getGuess("osm:node/1", 2), g(2, "sushi"));
    assert.equal(await s.getGuess("osm:node/2", 1), null);
  },

  async "geocode cache"(s) {
    const v = { location: { lat: 1, lon: 2, display_name: "x" }, created_at: T0 };
    assert.equal(await s.getGeocode("1 queen street"), null);
    await s.putGeocode("1 queen street", v);
    assert.deepEqual(await s.getGeocode("1 queen street"), v);
  },
};

export const CONTRACT_SCENARIOS = Object.keys(scenarios);

/** Run every scenario, each on a fresh store. */
export async function runContract(make: () => Store | Promise<Store>): Promise<void> {
  for (const [name, run] of Object.entries(scenarios)) {
    try {
      await run(await make());
    } catch (e) {
      throw new Error(`store contract "${name}" failed: ${e instanceof Error ? e.message : String(e)}`, {
        cause: e,
      });
    }
  }
}
