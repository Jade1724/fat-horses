// Each API key is one user with separate data (SPEC.md F14).

import { describe, expect, it } from "vitest";
import { bundledCountries } from "../domain/countries";
import type { Geocoder } from "../domain/places";
import { recordPick } from "../domain/store";
import { apiKeysFromEnv, parseApiKeyList, parseApiKeysJson } from "../domain/users";
import { stepInput } from "../lambda/workflow";
import { contractRestaurant } from "../store/contract";
import { MemoryStores, upgradeRoot } from "../store/state";
import { Api, userForKey, type ApiRequest, type WorkflowStarter } from "./api";

const NOW = "2026-09-22T10:00:00.000Z";
const KEYS = { haruka: "key-haruka-0123456789", friend: "key-friend-9876543210" };

class Starter implements WorkflowStarter {
  started: [string, string][] = [];
  cancelled: [string, string][] = [];
  async start(id: string, user: string) {
    this.started.push([id, user]);
  }
  async cancel(id: string, user: string) {
    this.cancelled.push([id, user]);
  }
}

const geocoder: Geocoder = {
  scope: "nz",
  search: async () => [{ lat: -36.8485, lon: 174.7622, display_name: "Sky Tower" }],
};

function setup() {
  const stores = new MemoryStores();
  const starter = new Starter();
  const api = new Api({ geocoder, stores, starter, countries: bundledCountries(), apiKeys: KEYS });
  return { api, stores, starter };
}

const as = (user: keyof typeof KEYS, method: string, path: string, body?: unknown): ApiRequest => ({
  method,
  path,
  query: {},
  apiKey: KEYS[user],
  body: body === undefined ? undefined : JSON.stringify(body),
});

describe("users (F14)", () => {
  it("a key identifies its user; unknown keys are refused", async () => {
    expect(userForKey(KEYS, KEYS.friend)).toBe("friend");
    expect(userForKey(KEYS, "nope")).toBeNull();
    expect(userForKey(KEYS, undefined)).toBeNull();
    const { api } = setup();
    const r = await api.handle({ ...as("haruka", "GET", "/history"), apiKey: "nope" }, NOW);
    expect(r.status).toBe(401);
  });

  it("picks, passports and history are separate", async () => {
    const { api, stores, starter } = setup();
    const r = await api.handle(as("haruka", "POST", "/picks", { address: "Sky Tower" }), NOW);
    const id = (r.body as { pick_id: string }).pick_id;
    expect(starter.started).toEqual([[id, "haruka"]]);
    expect((await api.handle(as("haruka", "GET", `/picks/${id}`), NOW)).status).toBe(200);
    // The friend can't see or cancel it.
    expect((await api.handle(as("friend", "GET", `/picks/${id}`), NOW)).status).toBe(404);
    expect((await api.handle(as("friend", "POST", `/picks/${id}/cancel`), NOW)).status).toBe(404);
    expect(starter.cancelled).toEqual([]);

    await recordPick(stores.forUser("haruka"), contractRestaurant("osm:node/1", "JP"), id, NOW);
    await api.handle(as("haruka", "POST", "/restaurants/osm:node/1/visit"), NOW);
    const mine = (await api.handle(as("haruka", "GET", "/countries"), NOW)).body as { visited: number };
    const theirs = (await api.handle(as("friend", "GET", "/countries"), NOW)).body as { visited: number };
    expect([mine.visited, theirs.visited]).toEqual([1, 0]);
    const friendHistory = (await api.handle(as("friend", "GET", "/history"), NOW)).body as { entries: [] };
    expect(friendHistory.entries).toEqual([]);
    expect((await api.handle(as("friend", "GET", "/restaurants/picked"), NOW)).body).toBeNull();
  });

  it("the friend's pick doesn't replace mine", async () => {
    const { stores } = setup();
    await recordPick(stores.forUser("haruka"), contractRestaurant("osm:node/1", "JP"), "p1", NOW);
    await recordPick(stores.forUser("friend"), contractRestaurant("osm:node/2", "IT"), "p2", NOW);
    expect((await stores.forUser("haruka").currentlyPicked())?.id).toBe("osm:node/1");
    expect((await stores.forUser("friend").currentlyPicked())?.id).toBe("osm:node/2");
  });

  it("caches are shared between users", async () => {
    const { stores } = setup();
    await stores.forUser("haruka").putGeocode("nz|sky tower", { results: [], created_at: NOW });
    expect(await stores.forUser("friend").getGeocode("nz|sky tower")).not.toBeNull();
  });

  it("unfinished picks are listed with their user", async () => {
    const { api, stores } = setup();
    await api.handle(as("friend", "POST", "/picks", { address: "Sky Tower" }), NOW);
    const all = await stores.unfinishedPicks();
    expect(all.map((p) => p.user)).toEqual(["friend"]);
  });
});

describe("key configuration", () => {
  it("reads a list, a single key, or JSON", () => {
    expect(parseApiKeyList("haruka:abc, friend:def")).toEqual({ haruka: "abc", friend: "def" });
    expect(apiKeysFromEnv({ FAT_HORSES_API_KEYS: "a:1" })).toEqual({ a: "1" });
    expect(apiKeysFromEnv({ FAT_HORSES_API_KEY: "dev" })).toEqual({ me: "dev" });
    expect(apiKeysFromEnv({})).toEqual({});
    expect(parseApiKeysJson('{"haruka":"abc"}')).toEqual({ haruka: "abc" });
  });

  it.each(["noseparator", ":key", "Bad User:key", "user:"])("rejects list entry %j", (entry) => {
    expect(() => parseApiKeyList(entry)).toThrow();
  });

  it.each(['["a"]', '{"a":1}', '{"A B":"k"}', "null"])("rejects JSON %s", (json) => {
    expect(() => parseApiKeysJson(json)).toThrow();
  });
});

describe("data saved before users existed", () => {
  it("moves to the user 'me', caches stay shared", () => {
    const root = upgradeRoot({
      restaurants: { "osm:node/1": contractRestaurant("osm:node/1", "JP") },
      picked: null,
      countries: {},
      log: {},
      picks: {},
      guesses: {},
      geocodes: { k: { results: [], created_at: NOW } },
    });
    expect(Object.keys(root.users)).toEqual(["me"]);
    expect(root.users.me?.restaurants["osm:node/1"]).toBeDefined();
    expect(root.geocodes.k).toBeDefined();
    // An already upgraded file is left as it is.
    expect(upgradeRoot(root as unknown as Record<string, unknown>)).toEqual(root);
  });
});

describe("Step Functions input", () => {
  it("carries the user, defaulting to 'me'", () => {
    expect(stepInput.parse({ step: "start", pick_id: "p" }).user).toBe("me");
    expect(stepInput.parse({ step: "start", pick_id: "p", user: "friend" }).user).toBe("friend");
    expect(() => stepInput.parse({ step: "start", pick_id: "p", user: "Bad User" })).toThrow();
  });
});
