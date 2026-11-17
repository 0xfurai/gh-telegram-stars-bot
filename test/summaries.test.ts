// Weekly, monthly and yearly summaries, end to end through the star check:
// local D1, a fake GitHub and a fake Telegram.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateChat } from "../src/db";
import { starNotifications, starSummary } from "../src/messages";
import { runStarCheck, type StarCheckLimits } from "../src/star-check";
import { testConfig } from "./telegram";

const db = env.DB;

// 2026-11-09 and 2026-11-16 are Mondays.
const MONDAY = "2026-11-09";
const NEXT_MONDAY = "2026-11-16";
const WEEK = { kind: "weekly", start: MONDAY, end: NEXT_MONDAY } as const;
const at = (iso: string) => Date.parse(iso);
const SEND_TIME = at(`${NEXT_MONDAY}T15:00:00Z`);

/** GitHub's current star counts, by repository ID. */
let githubStars = new Map<number, number>();

const githubFetch: typeof fetch = (_input, init) => {
  const { variables } = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { variables: { ids: string[] } };
  const nodes = variables.ids.map((nodeId) => {
    const id = Number(nodeId.slice(2));
    return {
      id: nodeId,
      databaseId: id,
      nameWithOwner: `owner/repo-${id}`,
      description: null,
      stargazerCount: githubStars.get(id) ?? 0,
      isArchived: false,
      isPrivate: false,
    };
  });
  return Promise.resolve(
    Response.json({ data: { rateLimit: { remaining: 4000, resetAt: "2026-11-07T13:00:00Z", cost: 1 }, nodes } }),
  );
};

interface Sent {
  chatId: number;
  text: string;
}

/** A fake Telegram: chats in `blocked` get a 403. */
function fakeTelegram(blocked: ReadonlySet<number> = new Set()) {
  const sent: Sent[] = [];
  const fetch: typeof globalThis.fetch = (_input, init) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { chat_id: number; text: string };
    if (blocked.has(body.chat_id)) {
      return Promise.resolve(
        Response.json({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, { status: 403 }),
      );
    }
    sent.push({ chatId: body.chat_id, text: body.text });
    return Promise.resolve(Response.json({ ok: true, result: { message_id: sent.length, date: 0, chat: { id: body.chat_id } } }));
  };
  return { fetch, sent };
}

async function addRepo(id: number, stars: number) {
  githubStars.set(id, stars);
  await db
    .prepare("INSERT INTO repositories (id, github_node_id, full_name, stars_count) VALUES (?, ?, ?, ?)")
    .bind(id, `R_${id}`, `owner/repo-${id}`, stars)
    .run();
}

/** A chat created long before the periods in these tests. */
async function subscribe(chatId: number, repoId: number, createdAt = "2026-01-01T00:00:00.000Z") {
  await db.batch([
    db.prepare("INSERT INTO chats (id, created_at) VALUES (?, ?) ON CONFLICT DO NOTHING").bind(chatId, createdAt),
    db
      .prepare(
        "INSERT INTO chat_repositories (chat_id, repository_id, last_notified_stars) SELECT ?, id, stars_count FROM repositories WHERE id = ?",
      )
      .bind(chatId, repoId),
  ]);
}

/** Snapshots as the star check would have stored them on `day`. */
async function snapshot(day: string, counts: Record<number, number>) {
  await db.batch([
    ...Object.entries(counts).map(([id, stars]) =>
      db.prepare("INSERT INTO star_snapshots (repository_id, day, stars_count) VALUES (?, ?, ?)").bind(Number(id), day, stars),
    ),
    db.prepare("UPDATE star_check_state SET last_snapshot_day = ? WHERE id = 1").bind(day),
  ]);
}

async function chat(chatId: number) {
  return db
    .prepare("SELECT is_active, weekly_summary_sent, monthly_summary_sent, yearly_summary_sent FROM chats WHERE id = ?")
    .bind(chatId)
    .first();
}

function run(
  time: number,
  options: { telegram?: ReturnType<typeof fakeTelegram>; settings?: Record<string, string>; limits?: Partial<StarCheckLimits> } = {},
) {
  return runStarCheck({ scheduledTime: time }, testConfig({ NOTIFICATIONS: "on", ...options.settings }), {
    db,
    githubFetch,
    telegramFetch: (options.telegram ?? fakeTelegram()).fetch,
    limits: options.limits,
  });
}

/** One repository that gained 50 stars over the week, followed by chat 10. */
async function weekWithGain() {
  await addRepo(1, 150);
  await subscribe(10, 1);
  await snapshot(MONDAY, { 1: 100 });
  await snapshot(NEXT_MONDAY, { 1: 150 });
}

beforeEach(async () => {
  githubStars = new Map();
  await db.batch([
    db.prepare("DELETE FROM star_snapshots"),
    db.prepare("DELETE FROM chat_repositories"),
    db.prepare("DELETE FROM repositories"),
    db.prepare("DELETE FROM chats"),
    db.prepare("UPDATE star_check_state SET cursor = 0, locked_until = NULL, last_snapshot_day = NULL"),
  ]);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("snapshots", () => {
  async function snapshots() {
    const { results } = await db.prepare("SELECT repository_id, day, stars_count FROM star_snapshots ORDER BY repository_id, day").all();
    return results;
  }

  it("stores each subscribed repository's count, after this run's check, on Mondays and 1sts only", async () => {
    await addRepo(1, 100);
    await addRepo(2, 7); // nobody follows it
    await subscribe(10, 1);
    githubStars.set(1, 103);

    await run(at("2026-11-08T23:55:00Z"));
    await run(at(`${MONDAY}T00:00:00Z`));
    await run(at("2026-12-01T00:00:00Z"));

    expect(await snapshots()).toEqual([
      { repository_id: 1, day: MONDAY, stars_count: 103 },
      { repository_id: 1, day: "2026-12-01", stars_count: 103 },
    ]);
    expect(await db.prepare("SELECT last_snapshot_day FROM star_check_state").first("last_snapshot_day")).toBe("2026-12-01");
  });

  it("writes nothing more in later runs that day, except for repositories first followed since", async () => {
    await addRepo(1, 100);
    await subscribe(10, 1);
    await run(at(`${MONDAY}T00:00:00Z`));
    githubStars.set(1, 120);

    const later = await run(at(`${MONDAY}T00:05:00Z`));
    await addRepo(2, 5);
    await subscribe(10, 2);
    await run(at(`${MONDAY}T00:10:00Z`));

    expect(later.rowsWritten).toBe(2); // the new count and today's gain, no snapshot
    expect(await snapshots()).toEqual([
      { repository_id: 1, day: MONDAY, stars_count: 100 },
      { repository_id: 2, day: MONDAY, stars_count: 5 },
    ]);
  });

  it("are pruned after 400 days, in the first run after midnight", async () => {
    await addRepo(1, 100);
    await subscribe(10, 1);
    await snapshot("2025-10-01", { 1: 50 });
    await snapshot("2025-11-03", { 1: 60 });

    const summary = await run(at("2026-11-07T00:02:00Z"));

    expect(summary.prunedSnapshots).toBe(1);
    expect((await snapshots()).map((row) => row.day)).toEqual(["2025-11-03"]);
  });
});

describe("weekly summary", () => {
  it("goes out at 15:00 UTC on Monday, once, with the week's change", async () => {
    await weekWithGain();
    const telegram = fakeTelegram();

    const early = await run(SEND_TIME - 5 * 60 * 1000, { telegram });
    expect(telegram.sent).toEqual([]);
    expect(early.summariesSent).toBe(0);

    const due = await run(SEND_TIME, { telegram });
    await run(SEND_TIME + 5 * 60 * 1000, { telegram });

    expect(telegram.sent).toEqual([
      { chatId: 10, text: starSummary(WEEK, [{ fullName: "owner/repo-1", stars: 150, change: 50 }]) },
    ]);
    expect(due).toMatchObject({ summariesSent: 1, messagesSent: 1, summariesLeft: 0 });
    expect(await chat(10)).toMatchObject({ weekly_summary_sent: MONDAY });
  });

  it("works from the star check's own snapshots, losses included", async () => {
    await addRepo(1, 100);
    await addRepo(2, 30);
    await subscribe(10, 1);
    await subscribe(10, 2);
    await run(at(`${MONDAY}T00:00:00Z`));
    githubStars.set(1, 112);
    githubStars.set(2, 28);
    await run(at("2026-11-12T12:00:00Z"));
    await run(at(`${NEXT_MONDAY}T00:00:00Z`));
    const telegram = fakeTelegram();

    await run(SEND_TIME, { telegram });

    expect(telegram.sent.map((m) => m.text)).toEqual([
      starSummary(WEEK, [
        { fullName: "owner/repo-1", stars: 112, change: 12 },
        { fullName: "owner/repo-2", stars: 28, change: -2 },
      ]),
    ]);
  });

  it("goes out at 10:00 in the chat's time zone", async () => {
    await weekWithGain();
    await subscribe(20, 1);
    await subscribe(30, 1);
    await db.batch([
      db.prepare("UPDATE chats SET time_zone = 'Europe/Berlin' WHERE id = 20"),
      db.prepare("UPDATE chats SET time_zone = 'America/Los_Angeles' WHERE id = 30"),
    ]);
    const telegram = fakeTelegram();

    await run(at(`${NEXT_MONDAY}T08:55:00Z`), { telegram });
    await run(at(`${NEXT_MONDAY}T09:00:00Z`), { telegram });
    await run(SEND_TIME, { telegram });
    await run(at(`${NEXT_MONDAY}T18:00:00Z`), { telegram });

    expect(telegram.sent.map((m) => m.chatId)).toEqual([20, 10, 30]);
  });

  it("is not sent, only marked, when nothing changed", async () => {
    await addRepo(1, 100);
    await subscribe(10, 1);
    await snapshot(MONDAY, { 1: 100 });
    await snapshot(NEXT_MONDAY, { 1: 100 });
    const telegram = fakeTelegram();

    const summary = await run(SEND_TIME, { telegram });

    expect(telegram.sent).toEqual([]);
    expect(summary.summariesEmpty).toBeGreaterThanOrEqual(1);
    expect(await chat(10)).toMatchObject({ weekly_summary_sent: MONDAY });
  });

  it("leaves out repositories without a snapshot at the start of the week", async () => {
    await weekWithGain();
    await addRepo(2, 80);
    await subscribe(10, 2);
    await db.prepare(`INSERT INTO star_snapshots (repository_id, day, stars_count) VALUES (2, '${NEXT_MONDAY}', 80)`).run();
    const telegram = fakeTelegram();

    await run(SEND_TIME, { telegram });

    expect(telegram.sent.map((m) => m.text)).toEqual([
      starSummary(WEEK, [{ fullName: "owner/repo-1", stars: 150, change: 50 }]),
    ]);
  });

  it("waits for the end snapshot, so a missed midnight run can't send one from missing data", async () => {
    await addRepo(1, 150);
    await subscribe(10, 1);
    await snapshot(MONDAY, { 1: 100 });
    const telegram = fakeTelegram();

    // Every Monday run failed; Tuesday's run has no snapshot for Monday.
    await run(at("2026-11-17T15:00:00Z"), { telegram });

    expect(telegram.sent).toEqual([]);
    expect(await chat(10)).toMatchObject({ weekly_summary_sent: null });
  });

  it("isn't sent to a chat that turned it off, or that started after the week ended", async () => {
    await weekWithGain();
    await subscribe(20, 1);
    await subscribe(30, 1, `${NEXT_MONDAY}T10:00:00.000Z`);
    await db.prepare("UPDATE chats SET weekly_summary = 0 WHERE id = 20").run();
    const telegram = fakeTelegram();

    await run(SEND_TIME, { telegram });

    expect(telegram.sent.map((m) => m.chatId)).toEqual([10]);
    expect(await chat(20)).toMatchObject({ weekly_summary_sent: null });
    expect(await chat(30)).toMatchObject({ weekly_summary_sent: null });
  });

  it("stays due for a chat that blocked the bot, which is deactivated", async () => {
    await weekWithGain();

    const summary = await run(SEND_TIME, { telegram: fakeTelegram(new Set([10])) });

    expect(summary.chatsDeactivated).toBe(1);
    expect(await chat(10)).toMatchObject({ is_active: 0, weekly_summary_sent: null });
  });
});

describe("monthly and yearly summaries", () => {
  it("go out on the 1st and on 1 January, each as its own message", async () => {
    await addRepo(1, 400);
    await subscribe(10, 1);
    await snapshot("2026-01-01", { 1: 100 });
    await snapshot("2026-12-01", { 1: 350 });
    await snapshot("2026-12-28", { 1: 390 });
    await snapshot("2027-01-01", { 1: 400 });
    const telegram = fakeTelegram();

    await run(at("2027-01-01T15:00:00Z"), { telegram });

    expect(telegram.sent.map((m) => m.text)).toEqual([
      starSummary({ kind: "monthly", start: "2026-12-01", end: "2027-01-01" }, [
        { fullName: "owner/repo-1", stars: 400, change: 50 },
      ]),
      starSummary({ kind: "yearly", start: "2026-01-01", end: "2027-01-01" }, [
        { fullName: "owner/repo-1", stars: 400, change: 300 },
      ]),
    ]);
    expect(await chat(10)).toMatchObject({ monthly_summary_sent: "2026-12-01", yearly_summary_sent: "2026-01-01" });
  });
});

describe("delivery", () => {
  it("lets star notifications go first, and sends the summary next run", async () => {
    await weekWithGain();
    githubStars.set(1, 151);
    const telegram = fakeTelegram();

    const first = await run(SEND_TIME, { telegram, limits: { messages: 1 } });
    await run(SEND_TIME + 5 * 60 * 1000, { telegram, limits: { messages: 1 } });

    expect(first).toMatchObject({ notificationsSent: 1, summariesSent: 0, summariesLeft: 1 });
    expect(telegram.sent.map((m) => m.text)).toEqual([
      starNotifications([{ fullName: "owner/repo-1", change: 1, total: 151 }]),
      starSummary(WEEK, [{ fullName: "owner/repo-1", stars: 150, change: 50 }]),
    ]);
  });

  it("dry-run logs the summary and marks it, without sending", async () => {
    await weekWithGain();
    const telegram = fakeTelegram();

    const summary = await run(SEND_TIME, { telegram, settings: { NOTIFICATIONS: "dry-run" } });

    expect(telegram.sent).toEqual([]);
    expect(summary.summariesSkipped).toBe(1);
    expect(await chat(10)).toMatchObject({ weekly_summary_sent: MONDAY });
  });

  it("off sends and marks nothing", async () => {
    await weekWithGain();

    await run(SEND_TIME, { settings: { NOTIFICATIONS: "off" } });

    expect(await chat(10)).toMatchObject({ weekly_summary_sent: null, monthly_summary_sent: null });
  });

  it("only sends to chats in ALLOWED_CHAT_IDS when it's set", async () => {
    await weekWithGain();
    await subscribe(20, 1);
    const telegram = fakeTelegram();

    const summary = await run(SEND_TIME, { telegram, settings: { ALLOWED_CHAT_IDS: "20" } });

    expect(telegram.sent.map((m) => m.chatId)).toEqual([20]);
    expect(summary.summariesSkipped).toBe(1);
    expect(await chat(10)).toMatchObject({ weekly_summary_sent: MONDAY });
  });

  it("reads at most summaryReads summaries per run, and the rest next run", async () => {
    await weekWithGain();
    await subscribe(20, 1);
    await subscribe(30, 1);
    const telegram = fakeTelegram();

    const first = await run(SEND_TIME, { telegram, limits: { summaryReads: 3 } });

    expect(first.summariesLeft).toBeGreaterThan(0);
    await run(SEND_TIME + 5 * 60 * 1000, { telegram, limits: { summaryReads: 3 } });
    await run(SEND_TIME + 10 * 60 * 1000, { telegram, limits: { summaryReads: 3 } });
    expect(telegram.sent.map((m) => m.chatId).sort()).toEqual([10, 20, 30]);
  });
});

describe("chat migration", () => {
  it("moves summary settings, the time zone and what was sent to the new ID", async () => {
    await weekWithGain();
    await db
      .prepare(`UPDATE chats SET monthly_summary = 0, time_zone = 'Europe/Kyiv', weekly_summary_sent = '${MONDAY}' WHERE id = 10`)
      .run();

    await migrateChat(db, 10, -1009);

    expect(
      await db
        .prepare("SELECT monthly_summary, time_zone, weekly_summary_sent FROM chats WHERE id = -1009")
        .first(),
    ).toEqual({ monthly_summary: 0, time_zone: "Europe/Kyiv", weekly_summary_sent: MONDAY });
  });
});
