import { describe, expect, it } from "vitest";
import { directionsUrl } from "./format";

describe("directionsUrl", () => {
  it("points Google Maps at the coordinates", () => {
    expect(directionsUrl(-36.8, 174.7)).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=-36.8,174.7",
    );
  });
});
