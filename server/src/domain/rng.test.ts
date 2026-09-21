import { describe, expect, it } from "vitest";
import { choose, randomIndex, seeded, shuffle, systemRng } from "./rng";

describe("rng", () => {
  it("systemRng stays in [0, 1)", () => {
    for (let i = 0; i < 1000; i++) {
      const x = systemRng();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it("seeded is deterministic and in range", () => {
    const a = seeded(1);
    const b = seeded(1);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it("helpers work with the system generator", () => {
    expect(randomIndex(1, systemRng)).toBe(0);
    expect(shuffle([1, 2, 3], systemRng).sort()).toEqual([1, 2, 3]);
    expect([1, 2, 3]).toContain(choose([1, 2, 3], systemRng));
    expect(choose([], systemRng)).toBeUndefined();
  });
});
