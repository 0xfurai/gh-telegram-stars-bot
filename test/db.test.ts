import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ensureChat,
  getStats,
  listDueNotifications,
  listRepositoriesToCheck,
  listSubscribers,
  listSubscriptions,
  markNotified,
  pruneStarGains,
  recordStarCheck,
  repositoryUrl,
  setChatActive,
  subscribe,
  unsubscribe,
  upsertRepository,
  utcDay,
  type RepositoryInfo,
  type StarCheckUpdate,
} from "../src/db";
import { err, ok } from "../src/result";

const db = env.DB;
const DAY = "2026-11-07";

function repo(id: number, overrides: Partial<RepositoryInfo> = {}): RepositoryInfo {
  return {
    id,
    nodeId: `R_${id}`,
    fullName: `owner/repo-${id}`,
    description: `Repo ${id}`,
    starsCount: 100,
    isArchived: false,
    ...overrides,
  };
}

function update(id: number, starsCount: number, overrides: Partial<StarCheckUpdate> = {}): StarCheckUpdate {
  return { id, fullName: `owner/repo-${id}`, description: `Repo ${id}`, starsCount, isArchived: false, ...overrides };
}

async function lastNotified(chatId: number, repositoryId: number): Promise<number | undefined> {
  const row = await db
    .prepare("SELECT last_notified_stars AS n FROM chat_repositories WHERE chat_id = ? AND repository_id = ?")
    .bind(chatId, repositoryId)
    .first<{ n: number }>();
  return row?.n;
}

async function stored(id: number) {
  return db
    .prepare("SELECT full_name, stars_count, is_archived FROM repositories WHERE id = ?")
    .bind(id)
    .first<{ full_name: string; stars_count: number; is_archived: number }>();
}

async function isActive(chatId: number): Promise<number | null> {
  return db.prepare("SELECT is_active FROM chats WHERE id = ?").bind(chatId).first<number>("is_active");
}

async function gains() {
  const { results } = await db
    .prepare("SELECT repository_id, day, stars_gained FROM daily_star_gains ORDER BY repository_id, day")
    .all();
  return results;
}

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM daily_star_gains"),
    db.prepare("DELETE FROM chat_repositories"),
    db.prepare("DELETE FROM repositories"),
    db.prepare("DELETE FROM chats"),
  ]);
});

describe("chats", () => {
  it("ensureChat creates a chat once, then writes nothing while it's active", async () => {
    expect(await ensureChat(db, 1)).toBe(true);
    expect(await ensureChat(db, 1)).toBe(false);
    expect(await isActive(1)).toBe(1);
  });

  it("ensureChat reactivates a chat marked inactive", async () => {
    await setChatActive(db, 1, false);

    expect(await ensureChat(db, 1)).toBe(true);
    expect(await isActive(1)).toBe(1);
  });

  it("setChatActive deactivates and reactivates, creating the chat if needed", async () => {
    await setChatActive(db, 5, false);
    expect(await isActive(5)).toBe(0);

    await setChatActive(db, 5, true);
    expect(await isActive(5)).toBe(1);
  });
});

describe("repositories", () => {
  it("upsertRepository inserts, then refreshes on rename", async () => {
    await upsertRepository(db, repo(10), DAY);
    await upsertRepository(db, repo(10, { fullName: "new-owner/renamed", isArchived: true }), DAY);

    expect(await stored(10)).toEqual({ full_name: "new-owner/renamed", stars_count: 100, is_archived: 1 });
  });

  it("upsertRepository records stars gained since the last check instead of losing them", async () => {
    await upsertRepository(db, repo(10, { starsCount: 100 }), DAY);
    await upsertRepository(db, repo(10, { starsCount: 120 }), DAY);
    await upsertRepository(db, repo(10, { starsCount: 118 }), DAY);

    expect(await gains()).toEqual([{ repository_id: 10, day: DAY, stars_gained: 20 }]);
    expect((await stored(10))?.stars_count).toBe(118);
  });

  it("builds repository URLs from the name", () => {
    expect(repositoryUrl("facebook/react")).toBe("https://github.com/facebook/react");
  });

  it("checks repositories with an active subscriber and a node ID, archived ones included", async () => {
    for (const info of [repo(1), repo(2, { isArchived: true }), repo(3), repo(4), repo(5)]) {
      await upsertRepository(db, info, DAY);
    }
    await db.prepare("UPDATE repositories SET github_node_id = NULL WHERE id = 4").run();
    for (const id of [1, 2, 4]) {
      await subscribe(db, 1, id, 50);
    }
    await subscribe(db, 2, 5, 50);
    await setChatActive(db, 2, false);
    // 3 has no subscribers, 4 has no node ID, 5's only subscriber is inactive.

    expect((await listRepositoriesToCheck(db)).map((r) => r.id)).toEqual([1, 2]);
  });
});

describe("subscribe", () => {
  beforeEach(async () => {
    await upsertRepository(db, repo(10, { starsCount: 250 }), DAY);
  });

  it("subscribes, creating the chat and starting at the current star count", async () => {
    expect(await subscribe(db, 1, 10, 50)).toBe("subscribed");
    expect(await lastNotified(1, 10)).toBe(250);
    expect(await isActive(1)).toBe(1);
  });

  it("reactivates the chat", async () => {
    await setChatActive(db, 1, false);

    await subscribe(db, 1, 10, 50);

    expect(await isActive(1)).toBe(1);
  });

  it("reports a second subscription to the same repository", async () => {
    await subscribe(db, 1, 10, 50);

    expect(await subscribe(db, 1, 10, 50)).toBe("already-subscribed");
  });

  it("enforces the per-chat limit in the same statement", async () => {
    await upsertRepository(db, repo(11), DAY);
    await upsertRepository(db, repo(12), DAY);

    expect(await subscribe(db, 1, 10, 2)).toBe("subscribed");
    expect(await subscribe(db, 1, 11, 2)).toBe("subscribed");
    expect(await subscribe(db, 1, 12, 2)).toBe("limit-reached");
    // Already subscribed wins over the limit: nothing new would be added.
    expect(await subscribe(db, 1, 10, 2)).toBe("already-subscribed");
    expect(await db.prepare("SELECT COUNT(*) AS n FROM chat_repositories").first("n")).toBe(2);
  });

  it("keeps the limit per chat", async () => {
    expect(await subscribe(db, 1, 10, 1)).toBe("subscribed");
    expect(await subscribe(db, 2, 10, 1)).toBe("subscribed");
  });

  it("reports a repository that isn't stored", async () => {
    expect(await subscribe(db, 1, 999, 50)).toBe("unknown-repository");
  });
});

describe("unsubscribe", () => {
  beforeEach(async () => {
    await upsertRepository(db, repo(10, { fullName: "facebook/react" }), DAY);
    await subscribe(db, 1, 10, 50);
    await subscribe(db, 2, 10, 50);
  });

  it("matches the name case-insensitively and returns the stored name", async () => {
    expect(await unsubscribe(db, 1, "Facebook/React")).toEqual(ok("facebook/react"));
    expect(await listSubscriptions(db, 1)).toEqual([]);
  });

  it("leaves other chats' subscriptions alone", async () => {
    await unsubscribe(db, 1, "facebook/react");

    expect(await listSubscribers(db, 10)).toEqual([2]);
  });

  it("removes every subscription with the name, including a stale one", async () => {
    // A deleted repo whose stored name is now used by a new repo.
    await upsertRepository(db, repo(20, { fullName: "facebook/react" }), DAY);
    await subscribe(db, 1, 20, 50);

    expect(await unsubscribe(db, 1, "facebook/react")).toEqual(ok("facebook/react"));
    expect(await listSubscriptions(db, 1)).toEqual([]);
  });

  it("reports when the chat isn't subscribed", async () => {
    expect(await unsubscribe(db, 3, "facebook/react")).toEqual(err("not-subscribed"));
    expect(await unsubscribe(db, 1, "facebook/vue")).toEqual(err("not-subscribed"));
  });
});

describe("listing", () => {
  it("lists a chat's subscriptions, most-starred first", async () => {
    await upsertRepository(db, repo(1, { starsCount: 5 }), DAY);
    await upsertRepository(db, repo(2, { starsCount: 500, isArchived: true }), DAY);
    await subscribe(db, 1, 1, 50);
    await subscribe(db, 1, 2, 50);

    expect(await listSubscriptions(db, 1)).toEqual([
      { id: 2, nodeId: "R_2", fullName: "owner/repo-2", description: "Repo 2", starsCount: 500, isArchived: true },
      { id: 1, nodeId: "R_1", fullName: "owner/repo-1", description: "Repo 1", starsCount: 5, isArchived: false },
    ]);
  });

  it("lists only active subscribers", async () => {
    await upsertRepository(db, repo(10), DAY);
    for (const chatId of [1, 2, 3]) {
      await subscribe(db, chatId, 10, 50);
    }
    await setChatActive(db, 2, false);

    expect(await listSubscribers(db, 10)).toEqual([1, 3]);
  });
});

describe("star check", () => {
  beforeEach(async () => {
    await upsertRepository(db, repo(10, { starsCount: 100 }), DAY);
    await upsertRepository(db, repo(20, { starsCount: 50 }), DAY);
    await subscribe(db, 1, 10, 50);
    await subscribe(db, 1, 20, 50);
  });

  it("saves increases with today's gain, and decreases without one", async () => {
    await recordStarCheck(db, [update(10, 105), update(20, 48, { fullName: "owner/renamed", isArchived: true })], DAY);
    await recordStarCheck(db, [update(10, 108)], DAY);

    expect(await stored(10)).toEqual({ full_name: "owner/repo-10", stars_count: 108, is_archived: 0 });
    expect(await stored(20)).toEqual({ full_name: "owner/renamed", stars_count: 48, is_archived: 1 });
    expect(await gains()).toEqual([{ repository_id: 10, day: DAY, stars_gained: 8 }]);
  });

  it("records a gain once when overlapping runs see the same new count", async () => {
    await recordStarCheck(db, [update(10, 105)], DAY);
    await recordStarCheck(db, [update(10, 105)], DAY);

    expect(await gains()).toEqual([{ repository_id: 10, day: DAY, stars_gained: 5 }]);
  });

  it("does nothing for an empty run", async () => {
    expect(await recordStarCheck(db, [], DAY)).toEqual({ rowsWritten: 0 });
    expect(await gains()).toEqual([]);
  });

  it("costs two written rows per increase and one per decrease", async () => {
    expect((await recordStarCheck(db, [update(10, 105)], DAY)).rowsWritten).toBe(2);
    expect((await recordStarCheck(db, [update(10, 107)], DAY)).rowsWritten).toBe(2);
    expect((await recordStarCheck(db, [update(20, 49)], DAY)).rowsWritten).toBe(1);
  });

  it("lists due notifications only for active chats with new stars", async () => {
    await subscribe(db, 2, 10, 50);
    await subscribe(db, 3, 10, 50);
    await setChatActive(db, 3, false);
    await recordStarCheck(db, [update(10, 105)], DAY);

    const due = await listDueNotifications(db, 100);
    expect(due.sort((a, b) => a.chatId - b.chatId)).toEqual([
      { chatId: 1, repositoryId: 10, fullName: "owner/repo-10", starsCount: 105, lastNotifiedStars: 100 },
      { chatId: 2, repositoryId: 10, fullName: "owner/repo-10", starsCount: 105, lastNotifiedStars: 100 },
    ]);
    expect(await listDueNotifications(db, 1)).toHaveLength(1);
  });

  it("returns due notifications in varying order, so failing rows can't block the rest", async () => {
    for (let chatId = 2; chatId <= 30; chatId++) {
      await subscribe(db, chatId, 10, 50);
    }
    await recordStarCheck(db, [update(10, 105)], DAY);

    const firstPicks = new Set<number>();
    for (let run = 0; run < 20; run++) {
      const [first] = await listDueNotifications(db, 1);
      firstPicks.add(first?.chatId ?? 0);
    }
    expect(firstPicks.size).toBeGreaterThan(1);
  });

  it("markNotified raises last_notified_stars but never lowers it", async () => {
    await markNotified(db, 1, 10, 105);
    await markNotified(db, 1, 10, 103);

    expect(await lastNotified(1, 10)).toBe(105);
  });

  it("prunes gains older than a day", async () => {
    for (const [day, stars] of [["2026-08-08", 101], ["2026-08-09", 102], [DAY, 103]] as const) {
      await recordStarCheck(db, [update(10, stars)], day);
    }

    expect(await pruneStarGains(db, "2026-08-09")).toBe(1);
    expect((await gains()).map((row) => row.day)).toEqual(["2026-08-09", DAY]);
  });

  it("formats UTC days", () => {
    expect(utcDay(new Date("2026-11-07T23:59:59.999Z"))).toBe("2026-11-07");
    expect(utcDay(new Date("2026-11-08T00:00:00.000Z"))).toBe("2026-11-08");
  });
});

describe("stats", () => {
  it("counts repositories, active chats, subscriptions and gains since a day", async () => {
    await upsertRepository(db, repo(10), DAY);
    await subscribe(db, 1, 10, 50);
    await subscribe(db, 2, 10, 50);
    await setChatActive(db, 2, false);
    await recordStarCheck(db, [update(10, 103)], "2026-07-01");
    await recordStarCheck(db, [update(10, 110)], DAY);

    // The July gain is older than the cut-off, even though it wasn't pruned.
    expect(await getStats(db, "2026-08-09")).toEqual({
      repositories: 1,
      activeChats: 1,
      subscriptions: 2,
      starsGained: 7,
    });
  });

  it("returns zeros for an empty database", async () => {
    expect(await getStats(db, "2026-08-09")).toEqual({
      repositories: 0,
      activeChats: 0,
      subscriptions: 0,
      starsGained: 0,
    });
  });
});
