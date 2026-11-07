import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const db = env.DB;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function addChat(id: number) {
  return db.prepare("INSERT INTO chats (id) VALUES (?)").bind(id).run();
}

function addRepo(id: number, stars = 100) {
  return db
    .prepare(
      "INSERT INTO repositories (id, github_node_id, full_name, stars_count) VALUES (?, ?, ?, ?)",
    )
    .bind(id, `R_${id}`, `owner/repo-${id}`, stars)
    .run();
}

function subscribe(chatId: number, repoId: number, lastNotifiedStars = 100) {
  return db
    .prepare(
      "INSERT INTO chat_repositories (chat_id, repository_id, last_notified_stars) VALUES (?, ?, ?)",
    )
    .bind(chatId, repoId, lastNotifiedStars)
    .run();
}

// The upsert the star check runs when it finds new stars.
function recordGain(repoId: number, day: string, starsGained: number) {
  return db
    .prepare(
      `INSERT INTO daily_star_gains (repository_id, day, stars_gained) VALUES (?, ?, ?)
       ON CONFLICT (repository_id, day) DO UPDATE SET stars_gained = stars_gained + excluded.stars_gained`,
    )
    .bind(repoId, day, starsGained)
    .run();
}

async function count(table: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM daily_star_gains"),
    db.prepare("DELETE FROM chat_repositories"),
    db.prepare("DELETE FROM repositories"),
    db.prepare("DELETE FROM chats"),
  ]);
});

describe("schema", () => {
  it("has exactly the expected tables and indexes, automatic indexes included", async () => {
    // Only D1's own tables, and their indexes, are left out (sqlite_sequence
    // belongs to d1_migrations). SQLite's automatic indexes on our tables
    // (from UNIQUE constraints) stay in, because they cost writes too.
    const { results } = await db
      .prepare(
        `SELECT type, name FROM sqlite_master
         WHERE type IN ('table', 'index')
           AND tbl_name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
           AND tbl_name NOT IN ('d1_migrations', 'sqlite_sequence')
         ORDER BY type, name`,
      )
      .all<{ type: string; name: string }>();

    // Each index costs a written row on every write to its columns. Adding one
    // should be a deliberate change to this list.
    expect(results).toEqual([
      { type: "index", name: "idx_chat_repositories_repository_id" },
      { type: "table", name: "chat_repositories" },
      { type: "table", name: "chats" },
      { type: "table", name: "daily_star_gains" },
      { type: "table", name: "repositories" },
      { type: "table", name: "star_check_runs" },
      { type: "table", name: "star_check_state" },
    ]);
  });
});

describe("chats", () => {
  it("defaults to active, with ISO UTC timestamps", async () => {
    await addChat(-1001234567890);

    const chat = await db
      .prepare("SELECT * FROM chats WHERE id = ?")
      .bind(-1001234567890)
      .first<{ is_active: number; created_at: string; updated_at: string }>();

    expect(chat?.is_active).toBe(1);
    expect(chat?.created_at).toMatch(ISO_UTC);
    expect(chat?.updated_at).toMatch(ISO_UTC);
  });

  it("rejects is_active values other than 0 and 1", async () => {
    await expect(
      db.prepare("INSERT INTO chats (id, is_active) VALUES (1, 2)").run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});

describe("repositories", () => {
  it("rejects a negative star count", async () => {
    await expect(addRepo(1, -1)).rejects.toThrow(/CHECK constraint failed/);
  });

  it("compares names case-insensitively, like GitHub", async () => {
    await addRepo(10);

    const repo = await db
      .prepare("SELECT id FROM repositories WHERE full_name = ?")
      .bind("OWNER/Repo-10")
      .first<{ id: number }>();

    expect(repo?.id).toBe(10);
  });
});

describe("chat_repositories", () => {
  it("rejects subscriptions to a chat or repository that doesn't exist", async () => {
    await addChat(1);
    await addRepo(10);

    await expect(subscribe(2, 10)).rejects.toThrow(/FOREIGN KEY constraint failed/);
    await expect(subscribe(1, 99)).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it("rejects a second subscription to the same repository", async () => {
    await addChat(1);
    await addRepo(10);
    await subscribe(1, 10);

    await expect(subscribe(1, 10)).rejects.toThrow(/UNIQUE constraint failed|PRIMARY KEY/);
  });

  it("removes subscriptions when their chat is deleted", async () => {
    await addChat(1);
    await addChat(2);
    await addRepo(10);
    await subscribe(1, 10);
    await subscribe(2, 10);

    await db.prepare("DELETE FROM chats WHERE id = 1").run();

    expect(await count("chat_repositories")).toBe(1);
  });
});

describe("daily_star_gains", () => {
  it("adds gains found on the same day to one row", async () => {
    await addRepo(10);

    await recordGain(10, "2026-11-07", 5);
    await recordGain(10, "2026-11-07", 3);
    await recordGain(10, "2026-11-08", 2);

    const { results } = await db
      .prepare("SELECT day, stars_gained FROM daily_star_gains ORDER BY day")
      .all<{ day: string; stars_gained: number }>();
    expect(results).toEqual([
      { day: "2026-11-07", stars_gained: 8 },
      { day: "2026-11-08", stars_gained: 2 },
    ]);
  });

  it("only accepts positive gains and YYYY-MM-DD days", async () => {
    await addRepo(10);

    await expect(recordGain(10, "2026-11-07", 0)).rejects.toThrow(/CHECK constraint failed/);
    await expect(recordGain(10, "2026-11-07", -2)).rejects.toThrow(/CHECK constraint failed/);
    await expect(recordGain(10, "7 Nov 2026", 1)).rejects.toThrow(/CHECK constraint failed/);
  });

  it("is removed with its repository, without scanning other repositories' rows", async () => {
    await addChat(1);
    await addRepo(10);
    await addRepo(20);
    await subscribe(1, 10);
    await recordGain(10, "2026-11-07", 5);
    await recordGain(10, "2026-11-08", 5);
    // Plenty of unrelated rows that a scan would have to read.
    await db.batch(
      Array.from({ length: 90 }, (_, i) =>
        db
          .prepare("INSERT INTO daily_star_gains (repository_id, day, stars_gained) VALUES (20, ?, 1)")
          .bind(new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10)),
      ),
    );

    const deleted = await db.prepare("DELETE FROM repositories WHERE id = 10").run();

    expect(await count("chat_repositories")).toBe(0);
    expect(await count("daily_star_gains")).toBe(90);
    expect(deleted.meta.rows_read).toBeLessThan(20);
  });
});

describe("write budget", () => {
  // D1 bills rows written, index entries included. These writes repeat on
  // every star check run (or on every new repository), so each must stay at
  // one written row.
  it("costs one written row per repeated write", async () => {
    await addChat(1);
    const repoInsert = await addRepo(10);
    await subscribe(1, 10);

    const starUpdate = await db
      .prepare(
        `UPDATE repositories
         SET stars_count = 105, full_name = 'owner/renamed', github_node_id = 'R_new',
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = 10`,
      )
      .run();
    const firstGainToday = await recordGain(10, "2026-11-07", 5);
    const laterGainToday = await recordGain(10, "2026-11-07", 3);
    const notified = await db
      .prepare(
        "UPDATE chat_repositories SET last_notified_stars = 105 WHERE chat_id = 1 AND repository_id = 10",
      )
      .run();

    expect(repoInsert.meta.rows_written).toBe(1);
    expect(starUpdate.meta.rows_written).toBe(1);
    expect(firstGainToday.meta.rows_written).toBe(1);
    expect(laterGainToday.meta.rows_written).toBe(1);
    expect(notified.meta.rows_written).toBe(1);
  });
});
