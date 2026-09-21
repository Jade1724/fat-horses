import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyEvent } from "../domain/status";
import { recordPick, recordVisit } from "../domain/store";
import { contractRestaurant, runContract } from "./contract";
import { DynamoStore, pointerOp } from "./dynamo";
import { defaultStorePath, FileStore } from "./file";
import { MemoryStore } from "./state";

const NOW = "2026-09-21T10:00:00.000Z";

describe("store contract", () => {
  it("memory store passes", async () => {
    await runContract(() => new MemoryStore());
  });

  it("file store passes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fat-horses-"));
    let i = 0;
    await runContract(() => new FileStore(join(dir, `store-${i++}.json`)));
  });
});

describe("file store", () => {
  it("keeps data across reopening", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "fat-horses-")), "nested", "store.json");
    const s = new FileStore(path);
    await recordPick(s, contractRestaurant("osm:node/1", "JP"), "p1", NOW);
    await recordVisit(s, "osm:node/1", null, NOW);
    const again = new FileStore(path);
    expect((await again.getRestaurant("osm:node/1"))?.status).toBe("VISITED");
    expect((await again.countryVisits())[0]?.iso2).toBe("JP");
    expect((await again.history(null, 10)).entries).toHaveLength(2);
  });

  it("refuses a corrupt file", () => {
    const path = join(mkdtempSync(join(tmpdir(), "fat-horses-")), "store.json");
    writeFileSync(path, "{not json");
    expect(() => new FileStore(path)).toThrow();
  });

  it("default path follows XDG", () => {
    expect(defaultStorePath({ XDG_DATA_HOME: "/data", HOME: "/home/a" })).toBe("/data/fat-horses/store.json");
    expect(defaultStorePath({ HOME: "/home/a" })).toBe("/home/a/.local/share/fat-horses/store.json");
  });
});

describe("DynamoDB store (no network)", () => {
  const pick = (id: string) => applyEvent(contractRestaurant(id, "JP"), { kind: "pick", pick_id: "p" }, NOW);

  it("sets, clears or checks the PICKED pointer", () => {
    expect(pointerOp({ transitions: [pick("a")], expected_picked: null })).toEqual({ op: "set", expected: null, to: "a" });
    const skip = applyEvent(pick("a").restaurant, { kind: "skip" }, NOW);
    expect(pointerOp({ transitions: [skip], expected_picked: "a" })).toEqual({ op: "clear", expected: "a" });
    const visit = applyEvent(contractRestaurant("b", "IT"), { kind: "visit" }, NOW);
    expect(pointerOp({ transitions: [visit], expected_picked: "a" })).toEqual({ op: "check", expected: "a" });
  });

  it("builds a conditional transaction", () => {
    const visit = applyEvent(contractRestaurant("b", "IT"), { kind: "visit" }, NOW);
    const items = new DynamoStore("t").transactItems({ transitions: [visit], expected_picked: null });
    expect(items.map((i) => Object.keys(i)[0])).toEqual(["Put", "Put", "Update", "ConditionCheck"]);
    expect(items[0]?.Put?.ConditionExpression).toBe("attribute_not_exists(#s)");
    expect(items[0]?.Put?.Item?.status).toBe("VISITED");
    expect(items[1]?.Put?.Item?.sk).toBe("2026-09-21T10:00:00.000000Z#b#visited");
    expect(items[2]?.Update?.Key).toEqual({ pk: "COUNTRY", sk: "IT" });
    expect(items[3]?.ConditionCheck?.ConditionExpression).toBe("attribute_not_exists(pk)");
  });
});
