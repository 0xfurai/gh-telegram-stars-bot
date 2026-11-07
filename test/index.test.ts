import { createScheduledController } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as mainModule from "../src/index";
import worker from "../src/index";

describe("main module", () => {
  it("exports only the default handler, so no extra entrypoints are registered", () => {
    expect(Object.keys(mainModule)).toEqual(["default"]);
  });
});

describe("fetch", () => {
  it("answers GET /health", async () => {
    const response = await exports.default.fetch("https://bot.test/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("answers HEAD /health without a body", async () => {
    const response = await exports.default.fetch("https://bot.test/health", {
      method: "HEAD",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.text()).toBe("");
  });

  it("returns 405 with an Allow header for other methods on /health", async () => {
    const response = await exports.default.fetch("https://bot.test/health", {
      method: "POST",
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(await response.json()).toEqual({ error: "Method not allowed" });
  });

  it("returns 404 for unknown paths", async () => {
    const response = await exports.default.fetch("https://bot.test/nope");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });
});

describe("scheduled", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs the placeholder star check and logs the run", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const controller = createScheduledController({
      scheduledTime: new Date("2026-11-06T12:00:00Z"),
      cron: "*/5 * * * *",
    });

    worker.scheduled(controller);

    expect(log).toHaveBeenCalledOnce();
    const entry: unknown = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(entry).toEqual({
      message: "Star check placeholder ran",
      cron: "*/5 * * * *",
      scheduledTime: "2026-11-06T12:00:00.000Z",
    });
  });
});
