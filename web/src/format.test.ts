import { describe, expect, it } from "vitest";
import {
  circleRing,
  countdown,
  directionsUrl,
  distanceText,
  errorText,
  isFinished,
  osmUrl,
  pinKind,
  shortAddress,
  statusText,
  winReasonText,
} from "./format";

describe("directionsUrl", () => {
  it("points Google Maps at the coordinates", () => {
    expect(directionsUrl(-36.8, 174.7)).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=-36.8,174.7",
    );
  });
});

describe("countdown", () => {
  const now = new Date("2026-09-21T10:00:00Z");
  it("formats minutes and seconds", () => {
    expect(countdown(new Date("2026-09-21T10:04:05Z"), now)).toBe("4:05");
    expect(countdown(new Date("2026-09-21T10:00:00.400Z"), now)).toBe("0:01");
  });
  it("adds hours when needed", () => {
    expect(countdown(new Date("2026-09-21T11:02:03Z"), now)).toBe("1:02:03");
  });
  it("is null once started", () => {
    expect(countdown(now, now)).toBeNull();
    expect(countdown(new Date("2026-09-21T09:59:00Z"), now)).toBeNull();
  });
});

describe("status and error text", () => {
  it("covers every status", () => {
    for (const s of [
      "finding_race",
      "waiting_start",
      "running",
      "resolving",
      "searching",
      "done",
      "failed",
      "cancelled",
    ] as const) {
      expect(statusText(s)).not.toBe("");
    }
    expect(isFinished("done")).toBe(true);
    expect(isFinished("failed")).toBe(true);
    expect(isFinished("cancelled")).toBe(true);
    expect(isFinished("running")).toBe(false);
  });
  it("explains errors", () => {
    expect(errorText("no_upcoming_race")).toBe(
      "No gallops race starts in the next 10 minutes. Try again later, or allow a longer wait in Options.",
    );
    expect(errorText("no_upcoming_race", 180)).toContain("next 3 hours");
    expect(errorText("no_upcoming_race", 60)).toContain("next hour");
    expect(errorText("places_unavailable")).toContain("OpenStreetMap");
    expect(errorText("no_matching_places", 10, 500)).toBe(
      "No restaurant within 500 m has a cuisine we can match to a country, so there's nobody to race. Try a bigger radius in Options.",
    );
    expect(errorText("no_matching_places", 10, 2000)).toContain("within 2.0 km");
    expect(errorText(null)).not.toBe("");
  });
  it("explains unusual wins", () => {
    expect(winReasonText("result")).toBeNull();
    expect(winReasonText("dead_heat", [1, 4])).toBe("Dead heat between #1 and #4, drawn at random");
    expect(winReasonText("abandoned")).toContain("abandoned");
    expect(winReasonText("timeout")).toContain("No result");
  });
});

describe("pinKind", () => {
  it("colours by status, chosen first", () => {
    expect(pinKind(null, false)).toBe("new");
    expect(pinKind("PICKED", false)).toBe("picked");
    expect(pinKind("VISITED", false)).toBe("visited");
    expect(pinKind("VISITED", true)).toBe("chosen");
  });
});

describe("distanceText", () => {
  it("uses metres then kilometres", () => {
    expect(distanceText(123.4)).toBe("123 m");
    expect(distanceText(1530)).toBe("1.5 km");
  });
});

describe("circleRing", () => {
  it("is closed and roughly the right size", () => {
    const ring = circleRing(-36.85, 174.76, 200, 8);
    expect(ring).toHaveLength(9);
    expect(ring[0]![0]).toBeCloseTo(ring[8]![0], 9);
    expect(ring[0]![1]).toBeCloseTo(ring[8]![1], 9);
    const [lon, lat] = ring[2]!; // 90°: due north
    expect(lon).toBeCloseTo(174.76, 6);
    expect((lat + 36.85) * 111_195).toBeCloseTo(200, 0);
  });
});

describe("shortAddress", () => {
  it("drops the country", () => {
    expect(shortAddress("50, Albert Street, City Centre, Auckland, 1010, New Zealand / Aotearoa")).toBe(
      "50, Albert Street, City Centre, Auckland, 1010",
    );
    expect(shortAddress("Auckland, New Zealand")).toBe("Auckland, New Zealand");
  });
});

describe("osmUrl", () => {
  it("links OSM objects", () => {
    expect(osmUrl("osm:way/42")).toBe("https://www.openstreetmap.org/way/42");
    expect(osmUrl("something")).toBeNull();
  });
});
