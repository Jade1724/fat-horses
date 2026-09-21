import { describe, expect, it } from "vitest";
import {
  Countries,
  bundledCountries,
  validateCountries,
  type Country,
  type CountriesFile,
} from "./countries";

function country(over: Partial<Country> = {}): Country {
  return {
    iso2: "JP",
    name: "Japan",
    flag: "🇯🇵",
    population: 124_000_000,
    cuisine_tags: ["japanese", "sushi"],
    dishes: ["sushi", "ramen", "miso"],
    ...over,
  };
}

function file(countries: Country[]): CountriesFile {
  return { source: { population: "World Bank WDI SP.POP.TOTL", year: 2025 }, countries };
}

describe("validateCountries", () => {
  it("accepts a valid file", () => {
    expect(validateCountries(file([country()]))).toEqual([]);
  });

  it("rejects an empty file", () => {
    expect(validateCountries(file([]))).toEqual(["no countries"]);
  });

  it.each(["jp", "JPN", "J", "J1", ""])("rejects iso2 %j", (iso2) => {
    expect(validateCountries(file([country({ iso2 })])).join()).toContain("iso2 must be");
  });

  it("rejects duplicates", () => {
    expect(validateCountries(file([country(), country()]))).toEqual(["JP: duplicate iso2"]);
  });

  it("rejects empty name, flag and population", () => {
    const errs = validateCountries(file([country({ name: " ", flag: "", population: 0 })]));
    expect(errs).toEqual(["JP: name is empty", "JP: flag is empty", "JP: population must be > 0"]);
  });

  it.each(["Japanese", "sushi bar", "sushi-bar", "", "ramen1"])("rejects tag %j", (tag) => {
    expect(validateCountries(file([country({ cuisine_tags: [tag] })]))).toEqual([
      `JP: cuisine tag ${JSON.stringify(tag)} must match [a-z_]+`,
    ]);
  });

  it("requires cuisine tags and bounded dishes", () => {
    expect(validateCountries(file([country({ cuisine_tags: [] })]))).toEqual(["JP: cuisine_tags is empty"]);
    expect(validateCountries(file([country({ dishes: ["a", "b"] })]))).toEqual([
      "JP: has 2 dishes, expected 3..12",
    ]);
    expect(validateCountries(file([country({ dishes: Array(13).fill("x") })]))).toHaveLength(1);
    expect(validateCountries(file([country({ dishes: Array(12).fill("x") })]))).toEqual([]);
    expect(validateCountries(file([country({ dishes: ["a", " ", "c"] })]))).toEqual(["JP: dish is empty"]);
  });

  it("Countries refuses an invalid file", () => {
    expect(() => new Countries(file([]))).toThrow(/invalid/);
  });

  it("knownTags is the union", () => {
    const c = new Countries(file([country(), country({ iso2: "FR", cuisine_tags: ["french", "sushi"] })]));
    expect([...c.knownTags()].sort()).toEqual(["french", "japanese", "sushi"]);
    expect(c.get("FR")?.iso2).toBe("FR");
    expect(c.get("XX")).toBeUndefined();
  });
});

describe("bundled data/countries.json", () => {
  it("is valid and covers the default pool", () => {
    const c = bundledCountries();
    expect(c.file.source.population).toBe("World Bank WDI SP.POP.TOTL");
    expect(c.all.filter((x) => x.population >= 10_000_000).length).toBeGreaterThanOrEqual(90);
    for (const iso of ["JP", "IT", "MX", "IN", "CN", "FR", "TH", "ET"]) expect(c.get(iso)).toBeDefined();
  });
});
