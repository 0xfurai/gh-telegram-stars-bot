import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleFetch } from "../src/http";
import { alertAdmin, pruneRuns, recordRun, starCheckHealth, STALE_AFTER_MS } from "../src/monitoring";
import { err, ok } from "../src/result";
import { handleScheduled } from "../src/scheduled";
import { fakeTelegram, testConfig } from "./telegram";

const db = env.DB;
const NOON = Date.UTC(2026, 10, 7, 12, 0);
const MINUTE = 60_000;

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM star_check_runs"),
    db.prepare("DELETE FROM chat_repositories"),
    db.prepare("DELETE FROM repositories"),
    db.prepare("DELETE FROM chats"),
    db.prepare("UPDATE star_check_state SET cursor = 0, locked_until = NULL, last_alert_at = NULL"),
  ]);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const succeeded = ok({ repositoriesChecked: 1 });
const failed = err({ reason: "GitHub check failed: timeout", summary: null });

describe("starCheckHealth", () => {
  it("reports no successful run yet", async () => {
    expect(await starCheckHealth(db, NOON)).toEqual({ status: "no-successful-run", lastSuccessAt: null, lastRunOk: null });

    await recordRun(db, NOON, failed);
    expect(await starCheckHealth(db, NOON)).toMatchObject({ status: "no-successful-run", lastRunOk: false });
  });

  it("is ok within 15 minutes of the last successful run, even if the latest run failed", async () => {
    await recordRun(db, NOON, succeeded);
    await recordRun(db, NOON + 5 * MINUTE, failed);

    expect(await starCheckHealth(db, NOON + STALE_AFTER_MS)).toEqual({
      status: "ok",
      lastSuccessAt: new Date(NOON).toISOString(),
      lastRunOk: false,
    });
  });

  it("is stale once the last successful run is more than 15 minutes old", async () => {
    await recordRun(db, NOON, succeeded);

    expect((await starCheckHealth(db, NOON + STALE_AFTER_MS + 1)).status).toBe("stale");
  });
});

describe("GET /health/star-check", () => {
  async function get(now: number) {
    return handleFetch(new Request("https://bot.test/health/star-check"), {
      config: testConfig(),
      db,
      now: () => new Date(now),
    });
  }

  it("answers 200 while star checks run, and 503 when they stop", async () => {
    await recordRun(db, NOON, succeeded);

    expect((await get(NOON + 5 * MINUTE)).status).toBe(200);
    const stale = await get(NOON + 20 * MINUTE);
    expect(stale.status).toBe(503);
    expect(await stale.json()).toMatchObject({ status: "stale" });
  });

  it("answers 503 before the first successful run", async () => {
    expect((await get(NOON)).status).toBe(503);
  });
});

describe("pruneRuns", () => {
  it("keeps 7 days of runs", async () => {
    const day = 24 * 60 * MINUTE;
    await recordRun(db, NOON - 8 * day, succeeded);
    await recordRun(db, NOON - 6 * day, succeeded);

    expect(await pruneRuns(db, NOON)).toBe(1);
  });
});

describe("alertAdmin", () => {
  const withAdmin = testConfig({ ADMIN_CHAT_ID: "42" });

  it("does nothing without ADMIN_CHAT_ID", async () => {
    expect(await alertAdmin(testConfig(), { db }, "boom", NOON)).toBe("no-admin-chat");
  });

  it("alerts at most once an hour", async () => {
    const telegram = fakeTelegram();

    expect(await alertAdmin(withAdmin, { db, telegramFetch: telegram.fetch }, "boom <1>", NOON)).toBe("sent");
    expect(await alertAdmin(withAdmin, { db, telegramFetch: telegram.fetch }, "boom", NOON + 30 * MINUTE)).toBe("throttled");
    expect(await alertAdmin(withAdmin, { db, telegramFetch: telegram.fetch }, "boom", NOON + 61 * MINUTE)).toBe("sent");

    expect(telegram.calls).toHaveLength(2);
    expect(telegram.calls[0]?.body).toMatchObject({ chat_id: 42, parse_mode: "HTML" });
    expect(String(telegram.calls[0]?.body.text)).toContain("boom &lt;1&gt;");
  });

  it("reports an alert Telegram refused", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await alertAdmin(withAdmin, { db, telegramFetch: fakeTelegram({ fail: true }).fetch }, "boom", NOON)).toBe(
      "not-delivered",
    );
  });
});

describe("handleScheduled", () => {
  async function runs() {
    const { results } = await db.prepare("SELECT ok, summary FROM star_check_runs ORDER BY id").all<{ ok: number; summary: string }>();
    return results;
  }

  const githubDown: typeof fetch = () => Promise.resolve(new Response("", { status: 502 }));

  it("records a successful run", async () => {
    await handleScheduled({ scheduledTime: NOON }, testConfig(), { db });

    const [run] = await runs();
    expect(run?.ok).toBe(1);
    expect(JSON.parse(run?.summary ?? "{}")).toMatchObject({ repositoriesChecked: 0 });
  });

  it("records a failed GitHub check, alerts the admin chat once, and fails the run", async () => {
    await db.batch([
      db.prepare("INSERT INTO chats (id) VALUES (1)"),
      db.prepare("INSERT INTO repositories (id, github_node_id, full_name, stars_count) VALUES (1, 'R_1', 'o/r', 1)"),
      db.prepare("INSERT INTO chat_repositories (chat_id, repository_id, last_notified_stars) VALUES (1, 1, 1)"),
    ]);
    const telegram = fakeTelegram();
    const deps = { db, githubFetch: githubDown, telegramFetch: telegram.fetch, now: () => NOON };
    const config = testConfig({ ADMIN_CHAT_ID: "42" });

    await expect(handleScheduled({ scheduledTime: NOON }, config, deps)).rejects.toThrow("GitHub check failed: http");
    await expect(handleScheduled({ scheduledTime: NOON + 5 * MINUTE }, config, deps)).rejects.toThrow();

    expect((await runs()).map((run) => run.ok)).toEqual([0, 0]);
    expect(telegram.calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
  });

  it("doesn't record a run skipped because another run holds the lock", async () => {
    await db.prepare("UPDATE star_check_state SET locked_until = '2999-01-01T00:00:00.000Z'").run();

    await handleScheduled({ scheduledTime: NOON }, testConfig(), { db });

    expect(await runs()).toEqual([]);
  });

  it("records a crashed run", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = new Proxy(db, {
      get(target, prop) {
        if (prop === "batch") {
          return () => Promise.reject(new Error("D1 down"));
        }
        const value: unknown = Reflect.get(target, prop);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });

    await expect(handleScheduled({ scheduledTime: NOON }, testConfig(), { db: broken })).rejects.toThrow(
      "Star check crashed: D1 down",
    );
    expect((await runs()).map((run) => run.ok)).toEqual([0]);
  });
});
