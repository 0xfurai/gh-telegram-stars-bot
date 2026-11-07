import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireStarCheckLock, getStarCheckCursor, markChatReachable, releaseStarCheckLock } from "../src/db";
import { MAX_UPDATES_PER_MESSAGE, starNotifications } from "../src/messages";
import { handleFetch } from "../src/http";
import {
  failurePolicy,
  groupDeliveries,
  isPruneRun,
  runStarCheck,
  SUBREQUEST_BUDGET,
  type StarCheckLimits,
} from "../src/star-check";
import type { SendError } from "../src/telegram";
import { failingDb } from "./failing-db";
import { fakeTelegram as fakeBotApi, messageUpdate, testConfig, webhookRequest } from "./telegram";

const db = env.DB;
const NOON = Date.UTC(2026, 10, 7, 12, 0);

// --- Fakes ---------------------------------------------------------------------

/** GitHub's current star counts, by repository ID. */
let githubStars = new Map<number, number>();

const githubFetch: typeof fetch = (_input, init) => {
  const { variables } = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
    variables: { ids: string[] };
  };
  const nodes = variables.ids.map((nodeId) => {
    const id = Number(nodeId.slice(2));
    const stars = githubStars.get(id);
    return stars === undefined
      ? null
      : {
          id: nodeId,
          databaseId: id,
          nameWithOwner: `owner/repo-${id}`,
          description: null,
          stargazerCount: stars,
          isArchived: false,
          isPrivate: false,
        };
  });
  return Promise.resolve(
    Response.json({ data: { rateLimit: { remaining: 4000, resetAt: "2026-11-07T13:00:00Z", cost: 1 }, nodes } }),
  );
};

type TelegramReply = "ok" | "blocked" | "chat-not-found" | "migrated" | "too-long" | "rate-limited" | "down";

interface Sent {
  chatId: number;
  text: string;
}

/** A fake Telegram API: `replyFor` decides how each chat's message goes. */
function fakeTelegram(replyFor: (chatId: number) => TelegramReply = () => "ok") {
  const sent: Sent[] = [];
  const attempts: number[] = [];
  const fetch: typeof globalThis.fetch = (_input, init) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { chat_id: number; text: string };
    attempts.push(body.chat_id);
    const reply = replyFor(body.chat_id);
    const responses: Record<TelegramReply, () => Response> = {
      ok: () => {
        sent.push({ chatId: body.chat_id, text: body.text });
        return Response.json({ ok: true, result: { message_id: sent.length, date: 0, chat: { id: body.chat_id } } });
      },
      blocked: () =>
        Response.json({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, { status: 403 }),
      "chat-not-found": () =>
        Response.json({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, { status: 400 }),
      migrated: () =>
        Response.json(
          {
            ok: false,
            error_code: 400,
            description: "Bad Request: group chat was upgraded to a supergroup chat",
            parameters: { migrate_to_chat_id: -1009 },
          },
          { status: 400 },
        ),
      "too-long": () =>
        Response.json({ ok: false, error_code: 400, description: "Bad Request: message is too long" }, { status: 400 }),
      "rate-limited": () =>
        Response.json(
          { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 3 } },
          { status: 429 },
        ),
      down: () => Response.json({ ok: false, error_code: 502, description: "Bad Gateway" }, { status: 502 }),
    };
    return Promise.resolve(responses[reply]());
  };
  return { fetch, sent, attempts };
}

// --- Setup ---------------------------------------------------------------------

async function addRepo(id: number, stars: number) {
  githubStars.set(id, stars);
  await db
    .prepare("INSERT INTO repositories (id, github_node_id, full_name, stars_count) VALUES (?, ?, ?, ?)")
    .bind(id, `R_${id}`, `owner/repo-${id}`, stars)
    .run();
}

async function subscribe(chatId: number, repoId: number) {
  await db.batch([
    db.prepare("INSERT INTO chats (id) VALUES (?) ON CONFLICT DO NOTHING").bind(chatId),
    db
      .prepare(
        "INSERT INTO chat_repositories (chat_id, repository_id, last_notified_stars) SELECT ?, id, stars_count FROM repositories WHERE id = ?",
      )
      .bind(chatId, repoId),
  ]);
}

async function lastNotified(chatId: number, repoId: number) {
  return db
    .prepare("SELECT last_notified_stars FROM chat_repositories WHERE chat_id = ? AND repository_id = ?")
    .bind(chatId, repoId)
    .first<number>("last_notified_stars");
}

function run(options: {
  telegram?: ReturnType<typeof fakeTelegram>;
  settings?: Record<string, string>;
  limits?: Partial<StarCheckLimits>;
  at?: number;
  database?: D1Database;
} = {}) {
  return runStarCheck(
    { scheduledTime: options.at ?? NOON },
    testConfig({ NOTIFICATIONS: "on", ...options.settings }),
    {
      db: options.database ?? db,
      githubFetch,
      telegramFetch: (options.telegram ?? fakeTelegram()).fetch,
      limits: options.limits,
    },
  );
}

beforeEach(async () => {
  githubStars = new Map();
  await db.batch([
    db.prepare("DELETE FROM daily_star_gains"),
    db.prepare("DELETE FROM chat_repositories"),
    db.prepare("DELETE FROM repositories"),
    db.prepare("DELETE FROM chats"),
    db.prepare("UPDATE star_check_state SET cursor = 0, locked_until = NULL"),
  ]);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- Tests -----------------------------------------------------------------------

describe("star check", () => {
  it("records new stars and notifies the subscriber", async () => {
    await addRepo(1, 100);
    await subscribe(10, 1);
    githubStars.set(1, 105);
    const telegram = fakeTelegram();

    const summary = await run({ telegram });

    expect(telegram.sent).toEqual([{ chatId: 10, text: starNotifications([{ fullName: "owner/repo-1", gained: 5, total: 105 }]) }]);
    expect(await lastNotified(10, 1)).toBe(105);
    expect(await db.prepare("SELECT stars_gained FROM daily_star_gains").first("stars_gained")).toBe(5);
    expect(summary).toMatchObject({
      notifications: "on",
      repositoriesChecked: 1,
      repositoriesChanged: 1,
      githubRequests: 1,
      rowsWritten: 2,
      messagesSent: 1,
      notificationsLeft: 0,
      sendErrors: [],
      prunedStarGains: null,
    });
  });

  it("notifies every subscriber of a repository", async () => {
    await addRepo(1, 100);
    await subscribe(10, 1);
    await subscribe(20, 1);
    githubStars.set(1, 101);
    const telegram = fakeTelegram();

    await run({ telegram });

    expect(telegram.sent.map((m) => m.chatId).sort()).toEqual([10, 20]);
  });

  it("sends one message per chat for several repositories", async () => {
    await addRepo(1, 100);
    await addRepo(2, 50);
    await subscribe(10, 1);
    await subscribe(10, 2);
    githubStars.set(1, 103);
    githubStars.set(2, 52);
    const telegram = fakeTelegram();

    await run({ telegram });

    expect(telegram.sent).toHaveLength(1);
    expect(telegram.sent[0]?.text).toContain("owner/repo-1");
    expect(telegram.sent[0]?.text).toContain("owner/repo-2");
  });

  it("sends nothing for a star decrease", async () => {
    await addRepo(1, 100);
    await subscribe(10, 1);
    githubStars.set(1, 98);
    const telegram = fakeTelegram();

    const summary = await run({ telegram });

    expect(telegram.attempts).toEqual([]);
    expect(summary.repositoriesChanged).toBe(1);
    expect((await db.prepare("SELECT stars_count FROM repositories").first("stars_count")) as number).toBe(98);
  });

  it("retries a failed send next run, with the newer stars", async () => {
    await addRepo(1, 100);
    await subscribe(10, 1);
    githubStars.set(1, 105);

    const failed = await run({ telegram: fakeTelegram(() => "down") });
    expect(failed.sendErrors).toEqual(["unavailable"]);
    expect(await lastNotified(10, 1)).toBe(100);

    githubStars.set(1, 107);
    const telegram = fakeTelegram();
    await run({ telegram });

    expect(telegram.sent[0]?.text).toBe(starNotifications([{ fullName: "owner/repo-1", gained: 7, total: 107 }]));
    expect(await lastNotified(10, 1)).toBe(107);
  });

  it("stops sending on a rate limit, leaving the rest for next run", async () => {
    await addRepo(1, 100);
    for (const chatId of [10, 20, 30]) {
      await subscribe(chatId, 1);
    }
    githubStars.set(1, 101);
    const telegram = fakeTelegram(() => "rate-limited");

    const summary = await run({ telegram });

    expect(telegram.attempts).toHaveLength(1);
    expect(summary.sendErrors).toEqual(["rate-limited"]);
    expect(summary.notificationsLeft).toBe(2);
  });

  it("keeps going to other chats after a blocked one", async () => {
    await addRepo(1, 100);
    await subscribe(10, 1);
    await subscribe(20, 1);
    githubStars.set(1, 101);
    const telegram = fakeTelegram((chatId) => (chatId === 10 ? "blocked" : "ok"));

    const summary = await run({ telegram });

    expect(telegram.sent.map((m) => m.chatId)).toEqual([20]);
    expect(summary.sendErrors).toEqual(["blocked"]);
    expect(await lastNotified(10, 1)).toBe(100);
  });

  it("sends at most the message budget per run, and the rest next run", async () => {
    await addRepo(1, 100);
    for (const chatId of [10, 20, 30]) {
      await subscribe(chatId, 1);
    }
    githubStars.set(1, 101);
    const first = fakeTelegram();
    const second = fakeTelegram();

    const summary = await run({ telegram: first, limits: { messages: 2 } });
    await run({ telegram: second, limits: { messages: 2 } });

    expect(first.sent).toHaveLength(2);
    expect(summary.notificationsLeft).toBe(1);
    expect(second.sent).toHaveLength(1);
  });

  it("continues the GitHub check from the cursor when the request budget runs out", async () => {
    for (let id = 1; id <= 150; id++) {
      await addRepo(id, 10);
      await subscribe(1, id);
    }

    const summary = await run({ limits: { githubRequests: 1 } });

    expect(summary.repositoriesChecked).toBe(100);
    expect(await getStarCheckCursor(db)).toBe(100);
  });
});

describe("chats that can't be reached", () => {
  async function isActive(chatId: number) {
    return db.prepare("SELECT is_active FROM chats WHERE id = ?").bind(chatId).first<number>("is_active");
  }

  beforeEach(async () => {
    await addRepo(1, 100);
    await subscribe(10, 1);
    githubStars.set(1, 101);
  });

  it("marks a chat that blocked the bot inactive, and the next run doesn't send to it", async () => {
    const summary = await run({ telegram: fakeTelegram(() => "blocked") });

    expect(summary.chatsDeactivated).toBe(1);
    expect(await isActive(10)).toBe(0);

    githubStars.set(1, 102);
    const next = fakeTelegram();
    await run({ telegram: next });
    expect(next.attempts).toEqual([]);
  });

  it("marks a chat that no longer exists inactive", async () => {
    await run({ telegram: fakeTelegram(() => "chat-not-found") });

    expect(await isActive(10)).toBe(0);
  });

  it("keeps a chat active after other errors, which are likely our bug", async () => {
    const summary = await run({ telegram: fakeTelegram(() => "too-long") });

    expect(summary.chatsDeactivated).toBe(0);
    expect(await isActive(10)).toBe(1);
  });

  it("notifies again after the chat sends /start, with the stars it missed", async () => {
    await run({ telegram: fakeTelegram(() => "blocked") });
    githubStars.set(1, 104);
    await run({ telegram: fakeTelegram() });

    await handleFetch(webhookRequest(messageUpdate("/start", 10)), {
      config: testConfig(),
      db,
      telegramFetch: fakeBotApi().fetch,
    });
    expect(await isActive(10)).toBe(1);

    const telegram = fakeTelegram();
    await run({ telegram });
    expect(telegram.sent[0]?.text).toBe(starNotifications([{ fullName: "owner/repo-1", gained: 4, total: 104 }]));
  });

  it("skips a deactivated chat's remaining messages in the same run", async () => {
    for (let id = 2; id <= 25; id++) {
      await addRepo(id, 10);
      await subscribe(10, id);
      githubStars.set(id, 11);
    }
    const telegram = fakeTelegram(() => "blocked");

    const summary = await run({ telegram });

    // 25 repositories need 2 messages; only the first is tried.
    expect(telegram.attempts).toEqual([10]);
    expect(summary.notificationsForUnreachableChats).toBe(5);
    expect(summary.chatsDeactivated).toBe(1);
  });

  it("doesn't deactivate a chat that became reachable while the send was in flight", async () => {
    const telegram = fakeTelegram(() => "blocked");
    const slowBlocked: typeof fetch = async (input, init) => {
      // The user unblocks the bot (my_chat_member) while the send is still out.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await markChatReachable(db, 10);
      return telegram.fetch(input, init);
    };

    const summary = await run({ telegram: { ...telegram, fetch: slowBlocked } });

    expect(summary.chatsDeactivated).toBe(0);
    expect(await isActive(10)).toBe(1);
  });

  it("moves a group that became a supergroup to its new ID, and notifies it there next run", async () => {
    const summary = await run({ telegram: fakeTelegram(() => "migrated") });

    expect(summary.chatsMigrated).toBe(1);
    expect(await isActive(10)).toBe(0);
    expect(await lastNotified(-1009, 1)).toBe(100);
    expect(await lastNotified(10, 1)).toBeNull();

    const telegram = fakeTelegram();
    await run({ telegram });
    expect(telegram.sent.map((m) => m.chatId)).toEqual([-1009]);
  });

  it("stops sending, and still finishes the run, when D1 fails while updating the chat", async () => {
    await subscribe(20, 1);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const summary = await run({ telegram: fakeTelegram(() => "blocked"), database: failingDb(db, /SET is_active = 0/) });

    expect(summary.sendErrors).toEqual(["blocked"]);
    expect(summary.notificationsLeft).toBe(1);
    expect(error.mock.calls.map((call) => String(call[0])).join(" ")).toContain("Chat not updated");
  });
});

describe("run safety", () => {
  it("skips the run when another run holds the lock", async () => {
    await addRepo(1, 100);
    await subscribe(10, 1);
    githubStars.set(1, 105);
    await acquireStarCheckLock(db, Date.now(), Date.now() + 600_000);
    const telegram = fakeTelegram();

    const summary = await run({ telegram });

    expect(summary.skipped).toBe("another-run-in-progress");
    expect(telegram.attempts).toEqual([]);
    expect(await lastNotified(10, 1)).toBe(100);
    await releaseStarCheckLock(db);
  });

  it("releases the lock after a run, even a failed one", async () => {
    await run();
    expect(await acquireStarCheckLock(db, Date.now(), Date.now() + 1000)).toBe(true);
    await releaseStarCheckLock(db);

    const broken = new Proxy(db, {
      get(target, prop) {
        if (prop === "batch") {
          return () => Promise.reject(new Error("D1 down"));
        }
        const value: unknown = Reflect.get(target, prop);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    await expect(run({ database: broken })).rejects.toThrow("D1 down");
    expect(await acquireStarCheckLock(db, Date.now(), Date.now() + 1000)).toBe(true);
    await releaseStarCheckLock(db);
  });

  it("reports the run's own error when releasing the lock fails too", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const outage = failingDb(failingDb(db, /locked_until = NULL/, "release failed"), /SELECT cursor/, "load failed");

    await expect(run({ database: outage })).rejects.toThrow("load failed");

    expect(error.mock.calls.map((call) => String(call[0])).join(" ")).toContain("Star check lock not released");
    await releaseStarCheckLock(db);
  });

  it("stays within the subrequest budget with 1,000 repositories", async () => {
    for (let id = 1; id <= 1000; id++) {
      githubStars.set(id, 11);
    }
    await db.batch(
      Array.from({ length: 1000 }, (_, i) =>
        db
          .prepare("INSERT INTO repositories (id, github_node_id, full_name, stars_count) VALUES (?, ?, ?, 10)")
          .bind(i + 1, `R_${i + 1}`, `owner/repo-${i + 1}`),
      ),
    );
    // Chat 99 follows every repository and is already up to date, so all
    // 1,000 are checked; 30 other chats are due one notification each.
    await db.prepare("INSERT INTO chats (id) VALUES (99)").run();
    await db.batch(
      Array.from({ length: 1000 }, (_, i) =>
        db
          .prepare("INSERT INTO chat_repositories (chat_id, repository_id, last_notified_stars) VALUES (99, ?, 11)")
          .bind(i + 1),
      ),
    );
    await db.batch(
      Array.from({ length: 30 }, (_, i) => [
        db.prepare("INSERT INTO chats (id) VALUES (?)").bind(100 + i),
        db
          .prepare("INSERT INTO chat_repositories (chat_id, repository_id, last_notified_stars) VALUES (?, ?, 10)")
          .bind(100 + i, i + 1),
      ]).flat(),
    );
    const telegram = fakeTelegram();

    const summary = await run({ telegram });

    expect(summary.githubRequests).toBe(10);
    expect(summary.subrequests).toBeLessThanOrEqual(SUBREQUEST_BUDGET);
    expect(telegram.sent.length).toBeLessThan(20);
    expect(summary.notificationsLeft).toBe(30 - telegram.sent.length);
  });

  it("drops a message Telegram rejects, so it can't take a slot every run", async () => {
    await addRepo(1, 100);
    await subscribe(10, 1);
    githubStars.set(1, 105);

    const summary = await run({ telegram: fakeTelegram(() => "too-long") });

    expect(summary.sendErrors).toEqual(["rejected"]);
    expect(summary.notificationsSkipped).toBe(1);
    expect(await lastNotified(10, 1)).toBe(105);
  });

  it("stops sending when marking a sent message fails, and logs the possible duplicate", async () => {
    await addRepo(1, 100);
    await subscribe(10, 1);
    await subscribe(20, 1);
    githubStars.set(1, 105);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const telegram = fakeTelegram();
    // D1 batches fail once the first message is out.
    const flaky = new Proxy(db, {
      get(target, prop) {
        if (prop === "batch" && telegram.sent.length > 0) {
          return () => Promise.reject(new Error("D1 down"));
        }
        const value: unknown = Reflect.get(target, prop);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });

    const summary = await run({ telegram, database: flaky });

    expect(telegram.sent).toHaveLength(1);
    expect(summary.notificationsLeft).toBe(1);
    expect(error.mock.calls.map((call) => String(call[0])).join(" ")).toContain("may be sent again");
  });
});

describe("NOTIFICATIONS modes", () => {
  beforeEach(async () => {
    await addRepo(1, 100);
    await subscribe(10, 1);
    githubStars.set(1, 105);
  });

  it("dry-run logs the notification and marks it sent, without sending", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const telegram = fakeTelegram();

    const summary = await run({ telegram, settings: { NOTIFICATIONS: "dry-run" } });

    expect(telegram.attempts).toEqual([]);
    expect(summary.notificationsSkipped).toBe(1);
    expect(await lastNotified(10, 1)).toBe(105);
    const logged = log.mock.calls.map((call) => String(call[0]));
    expect(logged.some((line) => line.includes('"Notification skipped"') && line.includes('"dry-run"'))).toBe(true);
  });

  it("dry-run follows the same message budget as sending", async () => {
    for (const chatId of [20, 30]) {
      await subscribe(chatId, 1);
    }

    const summary = await run({ settings: { NOTIFICATIONS: "dry-run" }, limits: { messages: 2 } });

    expect(summary.notificationsSkipped).toBe(2);
    expect(summary.notificationsLeft).toBe(1);
  });

  it("off sends nothing and keeps the notification due for later", async () => {
    const off = fakeTelegram();
    await run({ telegram: off, settings: { NOTIFICATIONS: "off" } });

    expect(off.attempts).toEqual([]);
    expect(await lastNotified(10, 1)).toBe(100);

    const on = fakeTelegram();
    await run({ telegram: on });
    expect(on.sent).toHaveLength(1);
  });

  it("only notifies chats in ALLOWED_CHAT_IDS when it's set", async () => {
    await subscribe(20, 1);
    const telegram = fakeTelegram();

    const summary = await run({ telegram, settings: { ALLOWED_CHAT_IDS: "20" } });

    expect(telegram.sent.map((m) => m.chatId)).toEqual([20]);
    expect(summary.notificationsSkipped).toBe(1);
  });
});

describe("daily cleanup", () => {
  it("prunes old star gains in the first run after midnight UTC only", async () => {
    await addRepo(1, 100);
    await db.prepare("INSERT INTO daily_star_gains (repository_id, day, stars_gained) VALUES (1, '2026-01-01', 5)").run();

    expect((await run()).prunedStarGains).toBeNull();
    expect((await run({ at: Date.UTC(2026, 10, 7, 0, 2) })).prunedStarGains).toBe(1);
  });

  it("knows which runs are prune runs", () => {
    expect(isPruneRun(Date.UTC(2026, 10, 7, 0, 0))).toBe(true);
    expect(isPruneRun(Date.UTC(2026, 10, 7, 0, 4, 59))).toBe(true);
    expect(isPruneRun(Date.UTC(2026, 10, 7, 0, 5))).toBe(false);
    expect(isPruneRun(Date.UTC(2026, 10, 7, 23, 59))).toBe(false);
  });
});

describe("building deliveries", () => {
  it("splits a chat's notifications into messages of at most 20 repositories", () => {
    const due = Array.from({ length: 45 }, (_, i) => ({
      chatId: 1,
      repositoryId: i,
      fullName: `o/r-${i}`,
      starsCount: 2,
      lastNotifiedStars: 1,
    }));

    expect(groupDeliveries(due).map((d) => d.items.length)).toEqual([20, 20, 5]);
  });

  it("refuses to build a notification with no repositories or too many", () => {
    const update = { fullName: "o/r", gained: 1, total: 2 };

    expect(() => starNotifications([])).toThrow(RangeError);
    expect(() => starNotifications(Array.from({ length: MAX_UPDATES_PER_MESSAGE + 1 }, () => update))).toThrow(RangeError);
  });

  it.each<[SendError, string, string, string]>([
    [{ kind: "rate-limited", retryAfter: 3 }, "keep", "retry", "stop-sending"],
    [{ kind: "unavailable", message: "down" }, "keep", "retry", "stop-sending"],
    [{ kind: "blocked", description: "blocked" }, "deactivate", "retry", "next-delivery"],
    [{ kind: "chat-not-found" }, "deactivate", "retry", "next-delivery"],
    [{ kind: "chat-migrated", newChatId: -1009 }, "migrate", "retry", "next-delivery"],
    [{ kind: "rejected", code: 400, description: "too long" }, "keep", "drop", "next-delivery"],
  ])("after %j: chat %s, notification %s, %s", (error, chat, notification, sending) => {
    const policy = failurePolicy(error);
    expect([policy.chat.kind, policy.notification, policy.sending]).toEqual([chat, notification, sending]);
  });
});
