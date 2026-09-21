// Country data (SPEC.md §4.1): the `data/countries.json` model and validation.

import bundledJson from "../../../data/countries.json";

export const DISHES_MIN = 3;
export const DISHES_MAX = 12;

export interface Country {
  /** ISO 3166-1 alpha-2, uppercase. */
  iso2: string;
  name: string;
  flag: string;
  population: number;
  /** OSM `cuisine=*` values that count as this country's food. */
  cuisine_tags: string[];
  /** Signature dishes and ingredients, used by the LLM fallback. */
  dishes: string[];
}

export interface CountriesFile {
  source: { population: string; year: number };
  countries: Country[];
}

/** Every rule of §4.1 the file breaks; empty means valid. */
export function validateCountries(file: CountriesFile): string[] {
  const errors: string[] = [];
  if (file.countries.length === 0) errors.push("no countries");
  const seen = new Set<string>();
  for (const c of file.countries) {
    const id = c.iso2;
    if (!/^[A-Z]{2}$/.test(c.iso2)) errors.push(`${JSON.stringify(id)}: iso2 must be two uppercase letters`);
    if (seen.has(c.iso2)) errors.push(`${id}: duplicate iso2`);
    seen.add(c.iso2);
    if (!c.name.trim()) errors.push(`${id}: name is empty`);
    if (!c.flag.trim()) errors.push(`${id}: flag is empty`);
    if (!(c.population > 0)) errors.push(`${id}: population must be > 0`);
    if (c.cuisine_tags.length === 0) errors.push(`${id}: cuisine_tags is empty`);
    for (const tag of c.cuisine_tags) {
      if (!/^[a-z_]+$/.test(tag)) errors.push(`${id}: cuisine tag ${JSON.stringify(tag)} must match [a-z_]+`);
    }
    if (c.dishes.length < DISHES_MIN || c.dishes.length > DISHES_MAX) {
      errors.push(`${id}: has ${c.dishes.length} dishes, expected ${DISHES_MIN}..${DISHES_MAX}`);
    }
    if (c.dishes.some((d) => !d.trim())) errors.push(`${id}: dish is empty`);
  }
  return errors;
}

export class Countries {
  readonly file: CountriesFile;
  private readonly byIso: Map<string, Country>;

  constructor(file: CountriesFile) {
    const errors = validateCountries(file);
    if (errors.length > 0) throw new Error(`countries file is invalid:\n  - ${errors.join("\n  - ")}`);
    this.file = file;
    this.byIso = new Map(file.countries.map((c) => [c.iso2, c]));
  }

  get all(): readonly Country[] {
    return this.file.countries;
  }

  get(iso2: string): Country | undefined {
    return this.byIso.get(iso2);
  }

  /** The only tags the LLM may return (SPEC.md L4). */
  knownTags(): Set<string> {
    return new Set(this.file.countries.flatMap((c) => c.cuisine_tags));
  }
}

let bundled: Countries | undefined;

/** `data/countries.json` as built into the bundle. */
export function bundledCountries(): Countries {
  bundled ??= new Countries(bundledJson as CountriesFile);
  return bundled;
}
