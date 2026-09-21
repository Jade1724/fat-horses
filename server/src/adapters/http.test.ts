import { getDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { CONNECT_ATTEMPT_TIMEOUT_MS, fetchText, HttpError, USER_AGENT } from "./http";

describe("http", () => {
  it("gives slow IPv4 connects time before giving up on an address", () => {
    expect(getDefaultAutoSelectFamilyAttemptTimeout()).toBe(CONNECT_ATTEMPT_TIMEOUT_MS);
  });

  it("sends the User-Agent and fails on non-2xx", async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      void url;
      expect((init?.headers as Record<string, string>)["user-agent"]).toBe(USER_AGENT);
      return new Response("busy", { status: 504 });
    });
    await expect(fetchText("https://x.test", { fetchFn: fetchFn as typeof fetch })).rejects.toBeInstanceOf(
      HttpError,
    );
  });
});
