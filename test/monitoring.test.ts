import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubError } from "../src/github";
import { handleFetch } from "../src/http";
import { alertAdmin, recordRun, starCheckHealth, STALE_AFTER_MS } from "../src/monitoring";
import { githubSeverity, handleScheduled, judge, type GitHubSeverity } from "../src/scheduled";
import type { RunSummary } from "../src/star-check";
import { failingDb } from "./failing-db";
import { fakeTelegram, testConfig } from "./telegram";

const db = env.DB;
const NOON = Date.UTC(2026, 10, 7, 12, 0);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function run(scheduledTime: number, ok: boolean) {
  return recordRun(db, { scheduledTime, ok, details: { ok } }, null);
}

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
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("run log", () => {
  it("records runs, and prunes runs older than 7 days in the same call", async () => {
    await run(NOON - 8 * DAY, true);
    await run(NOON - 6 * DAY, true);

    await recordRun(db, { scheduledTime: NOON, ok: true, details: {} }, { now: NOON });

    const { results } = await db.prepare("SELECT scheduled_at FROM star_check_runs ORDER BY id").all();
    expect(results.map((r) => r.scheduled_at)).toEqual([
      new Date(NOON - 6 * DAY).toISOString(),
      new Date(NOON).toISOString(),
    ]);
  });
});

describe("starCheckHealth", () => {
  it("reports no successful run yet", async () => {
    expect(await starCheckHealth(db, NOON)).toEqual({ status: "no-successful-run", lastSuccessAt: null, lastRunOk: null });

    await run(NOON, false);
    expect(await starCheckHealth(db, NOON)).toMatchObject({ status: "no-successful-run", lastRunOk: false });
  });

  it("is ok within 15 minutes of the last successful run, even if the latest run failed", async () => {
    await run(NOON, true);
    await run(NOON + 5 * MINUTE, false);

    expect(await starCheckHealth(db, NOON + STALE_AFTER_MS)).toEqual({
      status: "ok",
      lastSuccessAt: new Date(NOON).toISOString(),
      lastRunOk: false,
    });
  });

  it("is stale once the last successful run is more than 15 minutes old", async () => {
    await run(NOON, true);

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

  it("answers 200 while star checks run, and 503 when they stop or haven't started", async () => {
    expect((await get(NOON)).status).toBe(503);

    await run(NOON, true);
    expect((await get(NOON + 5 * MINUTE)).status).toBe(200);
    const stale = await get(NOON + 20 * MINUTE);
    expect(stale.status).toBe(503);
    expect(await stale.json()).toMatchObject({ status: "stale" });
  });

  it("answers 503 unknown, and logs, when D1 can't be read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await handleFetch(new Request("https://bot.test/health/star-check"), {
      config: testConfig(),
      db: failingDb(db, "everything"),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unknown", lastSuccessAt: null, lastRunOk: null });
    expect(String(error.mock.calls[0]?.[0])).toContain("Star check health unknown");
  });
});

describe("alertAdmin", () => {
  const withAdmin = testConfig({ ADMIN_CHAT_ID: "42" });

  it("does nothing without ADMIN_CHAT_ID", async () => {
    expect(await alertAdmin(testConfig(), { db }, "boom", NOON)).toBe("no-admin-chat");
  });

  it("alerts at most once an hour, with the reason escaped", async () => {
    const telegram = fakeTelegram();
    const deps = { db, telegramFetch: telegram.fetch };

    expect(await alertAdmin(withAdmin, deps, "boom <1>", NOON)).toBe("sent");
    expect(await alertAdmin(withAdmin, deps, "boom", NOON + 30 * MINUTE)).toBe("throttled");
    expect(await alertAdmin(withAdmin, deps, "boom", NOON + 61 * MINUTE)).toBe("sent");

    expect(telegram.calls).toHaveLength(2);
    expect(telegram.calls[0]?.body).toMatchObject({ chat_id: 42, parse_mode: "HTML" });
    expect(String(telegram.calls[0]?.body.text)).toContain("boom &lt;1&gt;");
    expect(String(telegram.calls[0]?.body.text)).toContain("Star check problem (production)");
  });

  it("gives the hour back when the alert isn't delivered, so the next one can go out", async () => {
    expect(await alertAdmin(withAdmin, { db, telegramFetch: fakeTelegram({ fail: true }).fetch }, "boom", NOON)).toBe(
      "not-delivered",
    );

    expect(await alertAdmin(withAdmin, { db, telegramFetch: fakeTelegram().fetch }, "boom", NOON + MINUTE)).toBe("sent");
  });

  it("still alerts when D1 is down, because that's when it matters", async () => {
    const telegram = fakeTelegram();

    const outcome = await alertAdmin(withAdmin, { db: failingDb(db, /last_alert_at/), telegramFetch: telegram.fetch }, "D1 down", NOON);

    expect(outcome).toBe("sent");
    expect(telegram.calls).toHaveLength(1);
  });
});

describe("judging a run", () => {
  it.each<[GitHubError, GitHubSeverity]>([
    [{ kind: "rate-limited", resetAt: null }, "transient"],
    [{ kind: "network", message: "reset" }, "transient"],
    [{ kind: "timeout" }, "transient"],
    [{ kind: "http", status: 502 }, "transient"],
    [{ kind: "http", status: 422 }, "bug"],
    [{ kind: "unauthorized" }, "operator"],
    [{ kind: "forbidden" }, "operator"],
    [{ kind: "graphql", message: "bad" }, "bug"],
    [{ kind: "bad-response" }, "bug"],
  ])("%j is %s", (error, severity) => {
    expect(githubSeverity(error)).toBe(severity);
  });

  const summary = (overrides: Partial<RunSummary>) => ({ skipped: null, githubError: null, repositoriesChecked: 0, ...overrides }) as RunSummary;

  it("counts a temporary error after some progress as a (degraded) success", () => {
    expect(judge(summary({ githubError: { kind: "timeout" }, repositoriesChecked: 100 })).kind).toBe("degraded");
  });

  it("alerts a temporary error with no progress only if star checks go stale", () => {
    expect(judge(summary({ githubError: { kind: "timeout" } }))).toMatchObject({ kind: "failed", alert: "if-stale" });
  });

  it("alerts a token problem or a likely bug at once", () => {
    expect(judge(summary({ githubError: { kind: "unauthorized" }, repositoriesChecked: 5 }))).toMatchObject({ alert: "now" });
    expect(judge(summary({ githubError: { kind: "bad-response" } }))).toMatchObject({ alert: "now" });
  });
});

describe("handleScheduled", () => {
  async function runs() {
    const { results } = await db.prepare("SELECT ok, summary FROM star_check_runs ORDER BY id").all<{ ok: number; summary: string }>();
    return results;
  }

  const githubAnswering = (status: number): typeof fetch => () => Promise.resolve(new Response("", { status }));
  const config = testConfig({ ADMIN_CHAT_ID: "42" });

  async function withRepository() {
    await db.batch([
      db.prepare("INSERT INTO chats (id) VALUES (1)"),
      db.prepare("INSERT INTO repositories (id, github_node_id, full_name, stars_count) VALUES (1, 'R_1', 'o/r', 1)"),
      db.prepare("INSERT INTO chat_repositories (chat_id, repository_id, last_notified_stars) VALUES (1, 1, 1)"),
    ]);
  }

  function sentAlerts(telegram: ReturnType<typeof fakeTelegram>) {
    return telegram.calls.filter((call) => call.method === "sendMessage");
  }

  it("records a successful run", async () => {
    await handleScheduled({ scheduledTime: NOON }, testConfig(), { db });

    const [first] = await runs();
    expect(first?.ok).toBe(1);
    expect(JSON.parse(first?.summary ?? "{}")).toMatchObject({ repositoriesChecked: 0 });
  });

  it("alerts at once on a rejected GitHub token, and fails the invocation", async () => {
    await withRepository();
    const telegram = fakeTelegram();

    await expect(
      handleScheduled({ scheduledTime: NOON }, config, { db, githubFetch: githubAnswering(401), telegramFetch: telegram.fetch, now: () => NOON }),
    ).rejects.toThrow("Check GITHUB_TOKEN");

    expect((await runs()).map((r) => r.ok)).toEqual([0]);
    expect(sentAlerts(telegram)).toHaveLength(1);
  });

  it("doesn't alert on a GitHub outage while star checks are fresh, and doesn't fail the invocation", async () => {
    await run(NOON - 5 * MINUTE, true);
    await withRepository();
    const telegram = fakeTelegram();

    await handleScheduled({ scheduledTime: NOON }, config, {
      db,
      githubFetch: githubAnswering(502),
      telegramFetch: telegram.fetch,
      now: () => NOON,
    });

    expect((await runs()).map((r) => r.ok)).toEqual([1, 0]);
    expect(sentAlerts(telegram)).toEqual([]);
  });

  it("alerts once a GitHub outage makes star checks stale", async () => {
    await run(NOON - 20 * MINUTE, true);
    await withRepository();
    const telegram = fakeTelegram();
    const deps = { db, githubFetch: githubAnswering(502), telegramFetch: telegram.fetch, now: () => NOON };

    await handleScheduled({ scheduledTime: NOON }, config, deps);
    await handleScheduled({ scheduledTime: NOON + 5 * MINUTE }, config, { ...deps, now: () => NOON + 5 * MINUTE });

    // Stale from the first failure on, but alerted once an hour.
    expect(sentAlerts(telegram)).toHaveLength(1);
  });

  it("rethrows a crash with its original error, after recording it", async () => {
    const crashing = failingDb(db, "everything");
    let thrown: unknown;

    try {
      await handleScheduled({ scheduledTime: NOON }, testConfig(), { db: crashing });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("D1 down");
  });

  it("alerts on a crash when D1 is down, though the health can't be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const telegram = fakeTelegram();

    await expect(
      handleScheduled({ scheduledTime: NOON }, testConfig({ ADMIN_CHAT_ID: "42" }), {
        db: failingDb(db, "everything"),
        telegramFetch: telegram.fetch,
      }),
    ).rejects.toThrow("D1 down");

    expect(telegram.calls.filter((call) => call.method === "sendMessage")).toHaveLength(1);
  });

  it("doesn't record a run skipped because another run holds the lock", async () => {
    await db.prepare("UPDATE star_check_state SET locked_until = '2999-01-01T00:00:00.000Z'").run();

    await handleScheduled({ scheduledTime: NOON }, testConfig(), { db });

    expect(await runs()).toEqual([]);
  });
});
