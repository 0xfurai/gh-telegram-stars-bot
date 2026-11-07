import { createScheduledController } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

describe("fetch", () => {
  it("answers GET /health", async () => {
    const response = await exports.default.fetch("https://bot.test/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("returns 404 for unknown paths", async () => {
    const response = await exports.default.fetch("https://bot.test/nope");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });

  it("returns 404 for non-GET requests to /health", async () => {
    const response = await exports.default.fetch("https://bot.test/health", {
      method: "POST",
    });

    expect(response.status).toBe(404);
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
