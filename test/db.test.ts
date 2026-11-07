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
  markRepositoryGone,
  pruneStarGains,
  recordStarCheck,
  repositoryUrl,
  setChatActive,
  subscribe,
  unsubscribe,
  upsertRepository,
  utcDay,
  type RepositoryInfo,
} from "../src/db";

const db = env.DB;

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

async function gains() {
  const { results } = await db
    .prepare("SELECT repository_id, day, stars_gained FROM daily_star_gains ORDER BY repository_id, day")
    .all();
  return results;
}

/** rows_written of a single statement, to check write costs. */
async function rowsWritten(sql: string, ...params: unknown[]): Promise<number> {
  const result = await db.prepare(sql).bind(...params).run();
  return result.meta.rows_written;
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
  it("ensureChat creates a chat once and costs nothing when it exists", async () => {
    await ensureChat(db, 1);
    await ensureChat(db, 1);

    const written = await rowsWritten("INSERT INTO chats (id) VALUES (?) ON CONFLICT (id) DO NOTHING", 1);
    const rows = await db.prepare("SELECT id, is_active FROM chats").all();

    expect(rows.results).toEqual([{ id: 1, is_active: 1 }]);
    expect(written).toBe(0);
  });

  it("setChatActive deactivates and reactivates, creating the chat if needed", async () => {
    await setChatActive(db, 5, false);
    expect(await db.prepare("SELECT is_active FROM chats WHERE id = 5").first("is_active")).toBe(0);

    await setChatActive(db, 5, true);
    expect(await db.prepare("SELECT is_active FROM chats WHERE id = 5").first("is_active")).toBe(1);
  });
});

describe("repositories", () => {
  it("upsertRepository inserts, then refreshes on rename", async () => {
    await upsertRepository(db, repo(10));
    await upsertRepository(db, repo(10, { fullName: "new-owner/renamed", starsCount: 150 }));

    expect(await stored(10)).toEqual({ full_name: "new-owner/renamed", stars_count: 150, is_archived: 0 });
  });

  it("builds repository URLs from the name", () => {
    expect(repositoryUrl("facebook/react")).toBe("https://github.com/facebook/react");
  });

  it("lists only repositories worth checking", async () => {
    await ensureChat(db, 1);
    for (const info of [
      repo(1),
      repo(2, { isArchived: true }),
      repo(3),
      repo(4),
    ]) {
      await upsertRepository(db, info);
    }
    await db.prepare("UPDATE repositories SET github_node_id = NULL WHERE id = 4").run();
    for (const id of [1, 2, 4]) {
      await subscribe(db, 1, id, 50);
    }
    // 2 is archived, 3 has no subscribers, 4 has no node ID.

    expect(await listRepositoriesToCheck(db)).toEqual([
      { id: 1, nodeId: "R_1", fullName: "owner/repo-1", starsCount: 100 },
    ]);
  });

  it("markRepositoryGone archives a repository", async () => {
    await upsertRepository(db, repo(10));
    await markRepositoryGone(db, 10);

    expect((await stored(10))?.is_archived).toBe(1);
  });
});

describe("subscribe", () => {
  beforeEach(async () => {
    await ensureChat(db, 1);
    await upsertRepository(db, repo(10, { starsCount: 250 }));
  });

  it("subscribes, starting at the current star count", async () => {
    expect(await subscribe(db, 1, 10, 50)).toBe("subscribed");
    expect(await lastNotified(1, 10)).toBe(250);
  });

  it("reports a second subscription to the same repository", async () => {
    await subscribe(db, 1, 10, 50);

    expect(await subscribe(db, 1, 10, 50)).toBe("already-subscribed");
  });

  it("enforces the per-chat limit in the same statement", async () => {
    await upsertRepository(db, repo(11));
    await upsertRepository(db, repo(12));

    expect(await subscribe(db, 1, 10, 2)).toBe("subscribed");
    expect(await subscribe(db, 1, 11, 2)).toBe("subscribed");
    expect(await subscribe(db, 1, 12, 2)).toBe("limit-reached");
    // Already subscribed wins over the limit: nothing new would be added.
    expect(await subscribe(db, 1, 10, 2)).toBe("already-subscribed");

    const count = await db.prepare("SELECT COUNT(*) AS n FROM chat_repositories").first("n");
    expect(count).toBe(2);
  });

  it("keeps the limit per chat", async () => {
    await ensureChat(db, 2);

    expect(await subscribe(db, 1, 10, 1)).toBe("subscribed");
    expect(await subscribe(db, 2, 10, 1)).toBe("subscribed");
  });

  it("reports a repository that isn't stored", async () => {
    expect(await subscribe(db, 1, 999, 50)).toBe("unknown-repository");
  });
});

describe("unsubscribe", () => {
  beforeEach(async () => {
    await ensureChat(db, 1);
    await ensureChat(db, 2);
    await upsertRepository(db, repo(10, { fullName: "facebook/react" }));
    await subscribe(db, 1, 10, 50);
    await subscribe(db, 2, 10, 50);
  });

  it("matches the name case-insensitively and returns the stored name", async () => {
    expect(await unsubscribe(db, 1, "Facebook/React")).toBe("facebook/react");
    expect(await listSubscriptions(db, 1)).toEqual([]);
  });

  it("leaves other chats' subscriptions alone", async () => {
    await unsubscribe(db, 1, "facebook/react");

    expect(await listSubscribers(db, 10)).toEqual([2]);
  });

  it("returns null when the chat isn't subscribed", async () => {
    await ensureChat(db, 3);

    expect(await unsubscribe(db, 3, "facebook/react")).toBeNull();
    expect(await unsubscribe(db, 1, "facebook/vue")).toBeNull();
  });
});

describe("listing", () => {
  it("lists a chat's subscriptions, most-starred first", async () => {
    await ensureChat(db, 1);
    await upsertRepository(db, repo(1, { starsCount: 5 }));
    await upsertRepository(db, repo(2, { starsCount: 500, isArchived: true }));
    await subscribe(db, 1, 1, 50);
    await subscribe(db, 1, 2, 50);

    expect(await listSubscriptions(db, 1)).toEqual([
      { id: 2, nodeId: "R_2", fullName: "owner/repo-2", description: "Repo 2", starsCount: 500, isArchived: true },
      { id: 1, nodeId: "R_1", fullName: "owner/repo-1", description: "Repo 1", starsCount: 5, isArchived: false },
    ]);
  });

  it("lists only active subscribers", async () => {
    await upsertRepository(db, repo(10));
    for (const chatId of [1, 2, 3]) {
      await ensureChat(db, chatId);
      await subscribe(db, chatId, 10, 50);
    }
    await setChatActive(db, 2, false);

    expect(await listSubscribers(db, 10)).toEqual([1, 3]);
  });
});

describe("star check", () => {
  beforeEach(async () => {
    await ensureChat(db, 1);
    await upsertRepository(db, repo(10, { starsCount: 100 }));
    await upsertRepository(db, repo(20, { starsCount: 50 }));
    await subscribe(db, 1, 10, 50);
    await subscribe(db, 1, 20, 50);
  });

  it("saves increases with today's gain, and decreases without one", async () => {
    await recordStarCheck(
      db,
      [
        { id: 10, fullName: "owner/repo-10", starsCount: 105, isArchived: false, previousStarsCount: 100 },
        { id: 20, fullName: "owner/renamed", starsCount: 48, isArchived: true, previousStarsCount: 50 },
      ],
      "2026-11-07",
    );
    await recordStarCheck(
      db,
      [{ id: 10, fullName: "owner/repo-10", starsCount: 108, isArchived: false, previousStarsCount: 105 }],
      "2026-11-07",
    );

    expect(await stored(10)).toEqual({ full_name: "owner/repo-10", stars_count: 108, is_archived: 0 });
    expect(await stored(20)).toEqual({ full_name: "owner/renamed", stars_count: 48, is_archived: 1 });
    expect(await gains()).toEqual([{ repository_id: 10, day: "2026-11-07", stars_gained: 8 }]);
  });

  it("does nothing for an empty run", async () => {
    expect(await recordStarCheck(db, [], "2026-11-07")).toEqual({ rowsWritten: 0 });
    expect(await gains()).toEqual([]);
  });

  it("costs two written rows per increase and one per decrease", async () => {
    const increase = await recordStarCheck(
      db,
      [{ id: 10, fullName: "owner/repo-10", starsCount: 105, isArchived: false, previousStarsCount: 100 }],
      "2026-11-07",
    );
    const laterIncreaseSameDay = await recordStarCheck(
      db,
      [{ id: 10, fullName: "owner/repo-10", starsCount: 107, isArchived: false, previousStarsCount: 105 }],
      "2026-11-07",
    );
    const decrease = await recordStarCheck(
      db,
      [{ id: 20, fullName: "owner/repo-20", starsCount: 49, isArchived: false, previousStarsCount: 50 }],
      "2026-11-07",
    );

    expect(increase.rowsWritten).toBe(2);
    expect(laterIncreaseSameDay.rowsWritten).toBe(2);
    expect(decrease.rowsWritten).toBe(1);
  });

  it("lists due notifications only for active chats with new stars", async () => {
    await ensureChat(db, 2);
    await subscribe(db, 2, 10, 50);
    await ensureChat(db, 3);
    await subscribe(db, 3, 10, 50);
    await setChatActive(db, 3, false);
    await recordStarCheck(
      db,
      [{ id: 10, fullName: "owner/repo-10", starsCount: 105, isArchived: false, previousStarsCount: 100 }],
      "2026-11-07",
    );

    expect(await listDueNotifications(db, 100)).toEqual([
      { chatId: 1, repositoryId: 10, fullName: "owner/repo-10", starsCount: 105, lastNotifiedStars: 100 },
      { chatId: 2, repositoryId: 10, fullName: "owner/repo-10", starsCount: 105, lastNotifiedStars: 100 },
    ]);
    expect(await listDueNotifications(db, 1)).toHaveLength(1);
  });

  it("markNotified raises last_notified_stars but never lowers it", async () => {
    await markNotified(db, 1, 10, 105);
    await markNotified(db, 1, 10, 103);

    expect(await lastNotified(1, 10)).toBe(105);
    expect(await listDueNotifications(db, 100)).toEqual([]);
  });

  it("prunes gains older than a day", async () => {
    for (const day of ["2026-08-08", "2026-08-09", "2026-11-07"]) {
      await recordStarCheck(
        db,
        [{ id: 10, fullName: "owner/repo-10", starsCount: 101, isArchived: false, previousStarsCount: 100 }],
        day,
      );
    }

    expect(await pruneStarGains(db, "2026-08-09")).toBe(1);
    expect((await gains()).map((row) => row.day)).toEqual(["2026-08-09", "2026-11-07"]);
  });

  it("formats UTC days", () => {
    expect(utcDay(new Date("2026-11-07T23:59:59.999Z"))).toBe("2026-11-07");
    expect(utcDay(new Date("2026-11-08T00:00:00.000Z"))).toBe("2026-11-08");
  });
});

describe("stats", () => {
  it("counts repositories, active chats, subscriptions and recent gains", async () => {
    await ensureChat(db, 1);
    await ensureChat(db, 2);
    await setChatActive(db, 2, false);
    await upsertRepository(db, repo(10));
    await subscribe(db, 1, 10, 50);
    await subscribe(db, 2, 10, 50);
    await recordStarCheck(
      db,
      [{ id: 10, fullName: "owner/repo-10", starsCount: 107, isArchived: false, previousStarsCount: 100 }],
      "2026-11-07",
    );

    expect(await getStats(db)).toEqual({
      repositories: 1,
      activeChats: 1,
      subscriptions: 2,
      starsGainedLast90Days: 7,
    });
  });

  it("returns zeros for an empty database", async () => {
    expect(await getStats(db)).toEqual({
      repositories: 0,
      activeChats: 0,
      subscriptions: 0,
      starsGainedLast90Days: 0,
    });
  });
});
