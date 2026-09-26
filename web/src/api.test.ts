import { describe, expect, it, vi } from "vitest";
import { Api, ApiError } from "./api";

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    void url;
    void init;
    return new Response(JSON.stringify(body), { status });
  });
}

describe("Api", () => {
  it("sends the JSON body and no auth header of its own", async () => {
    const f = fakeFetch(202, { pick_id: "p1" });
    const api = new Api(() => {}, f);
    const r = await api.startPick({ address: "Sky Tower" });
    expect(r.pick_id).toBe("p1");
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("/api/picks");
    expect(init?.method).toBe("POST");
    // The session is an HttpOnly cookie the browser attaches itself.
    expect(init?.headers).toEqual({ "content-type": "application/json" });
    expect(init?.credentials).toBe("same-origin");
    expect(init?.body).toBe(JSON.stringify({ address: "Sky Tower" }));
  });

  it("posts the password to /login", async () => {
    const f = fakeFetch(200, { expires_in: 43200 });
    expect(await new Api(() => {}, f).login("open sesame")).toEqual({ expires_in: 43200 });
    expect(f.mock.calls[0]![0]).toBe("/api/login");
    expect(f.mock.calls[0]![1]?.body).toBe(JSON.stringify({ password: "open sesame" }));
  });

  it("percent-encodes restaurant ids", async () => {
    const f = fakeFetch(200, {});
    await new Api(() => {}, f).visit("osm:node/1");
    expect(f.mock.calls[0]![0]).toBe("/api/restaurants/osm%3Anode%2F1/visit");
    expect(f.mock.calls[0]![1]?.body).toBe("{}");
  });

  it("sends visit details for map visits", async () => {
    const f = fakeFetch(200, {});
    const details = {
      name: "Taqueria",
      lat: 1,
      lon: 2,
      address: null,
      cuisine: ["mexican"],
      country_iso: "MX",
    };
    await new Api(() => {}, f).visit("osm:way/2", details);
    expect(JSON.parse(f.mock.calls[0]![1]?.body as string)).toEqual({ restaurant: details });
  });

  it("looks up addresses", async () => {
    const f = fakeFetch(200, { matches: [] });
    await new Api(() => {}, f).geocode("50 Albert St");
    expect(f.mock.calls[0]![0]).toBe("/api/geocode?q=50%20Albert%20St");
  });

  it("cancels a pick", async () => {
    const f = fakeFetch(200, { pick_id: "01J", status: "cancelled" });
    const view = await new Api(() => {}, f).cancelPick("01J");
    expect(view.status).toBe("cancelled");
    expect(f.mock.calls[0]![0]).toBe("/api/picks/01J/cancel");
    expect(f.mock.calls[0]![1]?.method).toBe("POST");
  });

  it("builds query strings", async () => {
    const f = fakeFetch(200, { entries: [], next_cursor: null });
    const api = new Api(() => {}, f);
    await api.history("2026#x");
    expect(f.mock.calls[0]![0]).toBe("/api/history?cursor=2026%23x");
    await api.countries(1000);
    expect(f.mock.calls[1]![0]).toBe("/api/countries?min_population=1000");
  });

  it("turns errors into ApiError", async () => {
    const f = fakeFetch(422, { error: "address_not_found", message: "address not found" });
    const err = await new Api(() => {}, f).startPick({ address: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(422);
    expect(err.code).toBe("address_not_found");
  });

  it("calls onUnauthorized on 401", async () => {
    const onUnauthorized = vi.fn();
    const f = fakeFetch(401, { error: "unauthorized", message: "no" });
    await expect(new Api(onUnauthorized, f).picked()).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
});
