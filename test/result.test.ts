import { describe, expect, it } from "vitest";
import { assertNever, err, ok, type Result } from "../src/result";

type Outcome = "a" | "b";

function describeOutcome(outcome: Outcome): string {
  switch (outcome) {
    case "a":
      return "first";
    case "b":
      return "second";
    default:
      return assertNever(outcome);
  }
}

function half(n: number): Result<number, "odd"> {
  return n % 2 === 0 ? ok(n / 2) : err("odd");
}

describe("Result", () => {
  it("narrows on .ok", () => {
    const even = half(4);
    const odd = half(3);

    expect(even.ok && even.value).toBe(2);
    expect(!odd.ok && odd.error).toBe("odd");
  });
});

describe("assertNever", () => {
  it("lets an exhaustive switch compile and run", () => {
    expect(describeOutcome("a")).toBe("first");
    expect(describeOutcome("b")).toBe("second");
  });

  it("throws if an unexpected value gets through at runtime", () => {
    expect(() => describeOutcome("c" as Outcome)).toThrow('Unhandled case: "c"');
  });
});
