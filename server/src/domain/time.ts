// Times are ISO 8601 strings in UTC everywhere they are stored or sent.

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export type Iso = string;

export function ms(t: Iso): number {
  return Date.parse(t);
}

export function iso(msSinceEpoch: number): Iso {
  return new Date(msSinceEpoch).toISOString();
}

export function addMs(t: Iso, delta: number): Iso {
  return iso(ms(t) + delta);
}
