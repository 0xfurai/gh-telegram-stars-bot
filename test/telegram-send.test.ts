import { GrammyError, HttpError } from "grammy";
import { describe, expect, it } from "vitest";
import { err, ok } from "../src/result";
import { classifySendError, send } from "../src/telegram";

function apiError(error_code: number, description: string, parameters = {}) {
  return new GrammyError("Call failed", { ok: false, error_code, description, parameters }, "sendMessage", {});
}

describe("classifySendError", () => {
  it.each([
    [apiError(403, "Forbidden: bot was blocked by the user"), { kind: "blocked", description: "Forbidden: bot was blocked by the user" }],
    [apiError(429, "Too Many Requests", { retry_after: 7 }), { kind: "rate-limited", retryAfter: 7 }],
    [apiError(429, "Too Many Requests"), { kind: "rate-limited", retryAfter: 1 }],
    [apiError(400, "Bad Request: chat not found"), { kind: "chat-not-found" }],
    [apiError(400, "Bad Request: message is too long"), { kind: "rejected", code: 400, description: "Bad Request: message is too long" }],
    [apiError(502, "Bad Gateway"), { kind: "unavailable", message: "Bad Gateway" }],
    [new HttpError("Network request failed", new Error("reset")), { kind: "unavailable", message: "Network request failed" }],
  ])("classifies %s", (error, expected) => {
    expect(classifySendError(error)).toEqual(expected);
  });

  it("returns null for errors that aren't from Telegram", () => {
    expect(classifySendError(new TypeError("bug"))).toBeNull();
  });
});

describe("send", () => {
  it("wraps a successful call", async () => {
    expect(await send(() => Promise.resolve(42))).toEqual(ok(42));
  });

  it("turns a Telegram refusal into an Err", async () => {
    expect(await send(() => Promise.reject(apiError(403, "Forbidden: bot was kicked")))).toEqual(
      err({ kind: "blocked", description: "Forbidden: bot was kicked" }),
    );
  });

  it("rethrows other errors: they're bugs, not outcomes", async () => {
    await expect(send(() => Promise.reject(new TypeError("bug")))).rejects.toThrow("bug");
  });
});
