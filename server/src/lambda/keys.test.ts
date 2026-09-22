import { describe, expect, it } from "vitest";
import { KeyCache } from "./keys";

describe("KeyCache (F11.1)", () => {
  it("re-reads after the TTL and doesn't cache failures", async () => {
    let n = 0;
    let fail = false;
    const cache = new KeyCache(async () => {
      if (fail) throw new Error("ssm down");
      return { me: `key${++n}` };
    }, 1000);
    expect(await cache.get(0)).toEqual({ me: "key1" });
    expect(await cache.get(999)).toEqual({ me: "key1" });
    expect(await cache.get(1000)).toEqual({ me: "key2" });
    fail = true;
    await expect(cache.get(5000)).rejects.toThrow("ssm down");
    fail = false;
    expect(await cache.get(5001)).toEqual({ me: "key3" });
  });
});
