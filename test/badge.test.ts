import { describe, expect, it } from "vitest";
import { coverageBadge } from "../scripts/badge";

describe("coverageBadge", () => {
  it("is a shields.io endpoint badge with one decimal", () => {
    expect(coverageBadge(80.59)).toEqual({ schemaVersion: 1, label: "coverage", message: "80.6%", color: "green" });
  });

  it("picks the colour by threshold", () => {
    expect([100, 90, 89.9, 70, 60, 59.9, 0].map((percent) => coverageBadge(percent).color)).toEqual([
      "brightgreen",
      "brightgreen",
      "green",
      "yellowgreen",
      "yellow",
      "red",
      "red",
    ]);
  });

  it("refuses a number that isn't a percentage", () => {
    for (const percent of [-1, 101, Number.NaN]) {
      expect(() => coverageBadge(percent)).toThrow(RangeError);
    }
  });
});
