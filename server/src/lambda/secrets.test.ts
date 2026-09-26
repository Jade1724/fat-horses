import { describe, expect, it } from "vitest";
import { Cached } from "./secrets";

describe("Cached (F11.1)", () => {
  it("re-reads after the TTL and doesn't cache failures", async () => {
    let n = 0;
    let fail = false;
    const cache = new Cached(async () => {
      if (fail) throw new Error("ssm down");
      return { hash: `hash${++n}` };
    }, 1000);
    expect(await cache.get(0)).toEqual({ hash: "hash1" });
    expect(await cache.get(999)).toEqual({ hash: "hash1" });
    expect(await cache.get(1000)).toEqual({ hash: "hash2" });
    fail = true;
    await expect(cache.get(5000)).rejects.toThrow("ssm down");
    fail = false;
    expect(await cache.get(5001)).toEqual({ hash: "hash3" });
  });
});
