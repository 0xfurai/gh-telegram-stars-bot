import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const db = env.DB;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function addChat(id: number) {
  return db.prepare("INSERT INTO chats (id) VALUES (?)").bind(id).run();
}

function addRepo(id: number, nodeId: string | null, stars = 100) {
  return db
    .prepare(
      `INSERT INTO repositories (id, github_node_id, full_name, html_url, stars_count)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(id, nodeId, `owner/repo-${id}`, `https://github.com/owner/repo-${id}`, stars)
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

async function count(table: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM star_events"),
    db.prepare("DELETE FROM chat_repositories"),
    db.prepare("DELETE FROM repositories"),
    db.prepare("DELETE FROM chats"),
  ]);
});

describe("schema", () => {
  it("has exactly the expected tables and indexes", async () => {
    const { results } = await db
      .prepare(
        `SELECT type, name FROM sqlite_master
         WHERE type IN ('table', 'index')
           AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'
         ORDER BY type, name`,
      )
      .all<{ type: string; name: string }>();

    // A new index costs a written row on every write to its columns; adding
    // one should be a deliberate change to this list.
    expect(results).toEqual([
      { type: "index", name: "idx_chat_repositories_repository_id" },
      { type: "table", name: "chat_repositories" },
      { type: "table", name: "chats" },
      { type: "table", name: "repositories" },
      { type: "table", name: "star_events" },
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
    await expect(addRepo(1, "R_1", -1)).rejects.toThrow(/CHECK constraint failed/);
  });

  it("requires unique node IDs but allows several repos without one", async () => {
    await addRepo(1, "R_1");
    await expect(addRepo(2, "R_1")).rejects.toThrow(/UNIQUE constraint failed/);

    await addRepo(3, null);
    await addRepo(4, null);
    expect(await count("repositories")).toBe(3);
  });
});

describe("chat_repositories", () => {
  it("rejects subscriptions to a chat or repository that doesn't exist", async () => {
    await addChat(1);
    await addRepo(10, "R_10");

    await expect(subscribe(2, 10)).rejects.toThrow(/FOREIGN KEY constraint failed/);
    await expect(subscribe(1, 99)).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it("rejects a second subscription to the same repository", async () => {
    await addChat(1);
    await addRepo(10, "R_10");
    await subscribe(1, 10);

    await expect(subscribe(1, 10)).rejects.toThrow(/UNIQUE constraint failed|PRIMARY KEY/);
  });

  it("removes subscriptions when their chat is deleted", async () => {
    await addChat(1);
    await addChat(2);
    await addRepo(10, "R_10");
    await subscribe(1, 10);
    await subscribe(2, 10);

    await db.prepare("DELETE FROM chats WHERE id = 1").run();

    expect(await count("chat_repositories")).toBe(1);
  });

  it("removes subscriptions and star events when their repository is deleted", async () => {
    await addChat(1);
    await addRepo(10, "R_10");
    await subscribe(1, 10);
    await db
      .prepare(
        "INSERT INTO star_events (repository_id, stars_count, previous_stars_count) VALUES (10, 105, 100)",
      )
      .run();

    await db.prepare("DELETE FROM repositories WHERE id = 10").run();

    expect(await count("chat_repositories")).toBe(0);
    expect(await count("star_events")).toBe(0);
  });
});

describe("star_events", () => {
  it("computes stars_gained from the two counts", async () => {
    await addRepo(10, "R_10");
    await db
      .prepare(
        "INSERT INTO star_events (repository_id, stars_count, previous_stars_count) VALUES (10, 105, 100)",
      )
      .run();

    const event = await db
      .prepare("SELECT stars_gained, created_at FROM star_events")
      .first<{ stars_gained: number; created_at: string }>();

    expect(event?.stars_gained).toBe(5);
    expect(event?.created_at).toMatch(ISO_UTC);
  });
});

describe("write budget", () => {
  // D1 bills rows written, including index entries. These are the writes the
  // star check repeats every run, so they must stay at one row each.
  it("costs one written row per star change and per star event", async () => {
    await addChat(1);
    await addRepo(10, "R_10");
    await subscribe(1, 10);

    const starUpdate = await db
      .prepare(
        "UPDATE repositories SET stars_count = 105, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 10",
      )
      .run();
    const event = await db
      .prepare(
        "INSERT INTO star_events (repository_id, stars_count, previous_stars_count) VALUES (10, 105, 100)",
      )
      .run();
    const notified = await db
      .prepare(
        "UPDATE chat_repositories SET last_notified_stars = 105 WHERE chat_id = 1 AND repository_id = 10",
      )
      .run();

    expect(starUpdate.meta.rows_written).toBe(1);
    expect(event.meta.rows_written).toBe(1);
    expect(notified.meta.rows_written).toBe(1);
  });
});
