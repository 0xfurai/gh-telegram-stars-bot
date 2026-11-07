// Data access for D1. Plain functions taking the database, so tests can pass
// a local binding. Every operation is one statement or one batch (a batch runs
// in a single transaction), so there's no read-then-write race.
//
// D1 errors are thrown: they're infrastructure failures, not outcomes a
// caller handles. Expected outcomes are part of the return type.
//
// Cost: D1 bills rows read and written. Comments note what each repeated
// operation costs; test/db.test.ts checks the ones the star check repeats.
import { err, ok, type Result } from "./result";

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** A repository as stored. The URL is https://github.com/<fullName>. */
export interface Repository {
  id: number;
  nodeId: string | null;
  fullName: string;
  description: string | null;
  starsCount: number;
  isArchived: boolean;
}

/** What GitHub says about a repository, for /add. */
export interface RepositoryInfo {
  id: number;
  nodeId: string;
  fullName: string;
  description: string | null;
  starsCount: number;
  isArchived: boolean;
}

/** Every outcome of subscribe(); callers switch over it exhaustively. */
export type SubscribeOutcome =
  | "subscribed"
  | "already-subscribed"
  | "limit-reached"
  | "unknown-repository";

export interface RepositoryToCheck {
  id: number;
  nodeId: string;
  fullName: string;
  description: string | null;
  starsCount: number;
  isArchived: boolean;
}

/** What one star check found for a repository whose data changed. */
export interface StarCheckUpdate {
  id: number;
  fullName: string;
  description: string | null;
  starsCount: number;
  isArchived: boolean;
}

export interface DueNotification {
  chatId: number;
  repositoryId: number;
  fullName: string;
  /** The count to report; also what last_notified_stars becomes once sent. */
  starsCount: number;
  lastNotifiedStars: number;
}

export interface Stats {
  repositories: number;
  activeChats: number;
  subscriptions: number;
  starsGained: number;
}

interface RepositoryRow {
  id: number;
  github_node_id: string | null;
  full_name: string;
  description: string | null;
  stars_count: number;
  is_archived: number;
}

function toRepository(row: RepositoryRow): Repository {
  return {
    id: row.id,
    nodeId: row.github_node_id,
    fullName: row.full_name,
    description: row.description,
    starsCount: row.stars_count,
    isArchived: row.is_archived === 1,
  };
}

export function repositoryUrl(fullName: string): string {
  return `https://github.com/${fullName}`;
}

/** UTC day (YYYY-MM-DD) for daily_star_gains. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Chats

function ensureChatStatement(db: D1Database, chatId: number): D1PreparedStatement {
  // A message from a chat means the bot can reach it again, so this also
  // reactivates a chat marked inactive. No written rows when already active.
  return db
    .prepare(
      `INSERT INTO chats (id) VALUES (?1)
       ON CONFLICT (id) DO UPDATE SET is_active = 1, updated_at = ${NOW} WHERE is_active = 0`,
    )
    .bind(chatId);
}

/**
 * Creates the chat, or reactivates it. Returns true if anything changed.
 * Call it for every message from a chat.
 */
export async function ensureChat(db: D1Database, chatId: number): Promise<boolean> {
  const result = await ensureChatStatement(db, chatId).run();
  return result.meta.changes > 0;
}

/**
 * Marks a chat reachable after Telegram said so (the user unblocked the bot,
 * or it was added back to the group). Always touches updated_at, so a
 * deactivation based on an older failed send can't undo it.
 */
export async function markChatReachable(db: D1Database, chatId: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO chats (id) VALUES (?1)
       ON CONFLICT (id) DO UPDATE SET is_active = 1, updated_at = ${NOW}`,
    )
    .bind(chatId)
    .run();
}

/**
 * Marks a chat inactive after a send that started at `sendStartedAt` failed
 * because the chat can't be reached, unless the chat was reactivated since.
 * Returns true if it was deactivated.
 */
export async function deactivateChat(db: D1Database, chatId: number, sendStartedAt: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE chats SET is_active = 0, updated_at = ${NOW}
       WHERE id = ?1 AND is_active = 1 AND updated_at <= ?2`,
    )
    .bind(chatId, sendStartedAt)
    .run();
  return result.meta.changes > 0;
}

/**
 * A group became a supergroup with a new ID: move its subscriptions to the new
 * chat (keeping what it was last told), and deactivate the old one. One batch.
 */
export async function migrateChat(db: D1Database, oldChatId: number, newChatId: number): Promise<void> {
  await db.batch([
    db
      .prepare(`INSERT INTO chats (id) VALUES (?1) ON CONFLICT (id) DO UPDATE SET is_active = 1, updated_at = ${NOW}`)
      .bind(newChatId),
    db
      .prepare(
        `INSERT INTO chat_repositories (chat_id, repository_id, last_notified_stars, created_at)
         SELECT ?2, repository_id, last_notified_stars, created_at FROM chat_repositories WHERE chat_id = ?1
         ON CONFLICT (chat_id, repository_id) DO NOTHING`,
      )
      .bind(oldChatId, newChatId),
    db.prepare("DELETE FROM chat_repositories WHERE chat_id = ?").bind(oldChatId),
    db.prepare(`UPDATE chats SET is_active = 0, updated_at = ${NOW} WHERE id = ?`).bind(oldChatId),
  ]);
}

/** Marks a chat inactive (for example after the bot was blocked) or active. */
export async function setChatActive(db: D1Database, chatId: number, active: boolean): Promise<void> {
  await db
    .prepare(
      `INSERT INTO chats (id, is_active) VALUES (?1, ?2)
       ON CONFLICT (id) DO UPDATE SET is_active = ?2, updated_at = ${NOW} WHERE is_active <> ?2`,
    )
    .bind(chatId, active ? 1 : 0)
    .run();
}

// ---------------------------------------------------------------------------
// Repositories

/**
 * Adds the gain between the stored star count and `starsCount` to today's
 * row, computed in SQL from the stored count. Run it before the statement
 * that stores the new count. Two overlapping runs that see the same new
 * count record the gain once. One written row when stars went up, none
 * otherwise.
 */
function recordGainStatement(db: D1Database, repositoryId: number, starsCount: number, day: string) {
  return db
    .prepare(
      `INSERT INTO daily_star_gains (repository_id, day, stars_gained)
       SELECT id, ?2, ?3 - stars_count FROM repositories WHERE id = ?1 AND ?3 > stars_count
       ON CONFLICT (repository_id, day) DO UPDATE SET stars_gained = stars_gained + excluded.stars_gained`,
    )
    .bind(repositoryId, day, starsCount);
}

/**
 * Creates or refreshes a repository from GitHub's data (/add). Stars gained
 * since the last check are recorded first, so they aren't lost.
 */
export async function upsertRepository(db: D1Database, repo: RepositoryInfo, day: string): Promise<void> {
  await db.batch([
    recordGainStatement(db, repo.id, repo.starsCount, day),
    db
      .prepare(
        `INSERT INTO repositories (id, github_node_id, full_name, description, stars_count, is_archived)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (id) DO UPDATE SET
           github_node_id = ?2, full_name = ?3, description = ?4, stars_count = ?5,
           is_archived = ?6, updated_at = ${NOW}`,
      )
      .bind(repo.id, repo.nodeId, repo.fullName, repo.description, repo.starsCount, repo.isArchived ? 1 : 0),
  ]);
}

/**
 * Repositories the star check should look at: those with a node ID and at
 * least one active subscriber. Archived repositories are included (they can
 * still gain stars), and so are ones GitHub stopped returning: if they come
 * back, they're picked up again.
 */
interface RepositoryToCheckRow {
  id: number;
  github_node_id: string;
  full_name: string;
  description: string | null;
  stars_count: number;
  is_archived: number;
}

function repositoriesToCheckStatement(db: D1Database): D1PreparedStatement {
  return db.prepare(
    `SELECT id, github_node_id, full_name, description, stars_count, is_archived FROM repositories r
     WHERE github_node_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM chat_repositories cr JOIN chats c ON c.id = cr.chat_id
         WHERE cr.repository_id = r.id AND c.is_active = 1
       )
     ORDER BY id`,
  );
}

function toRepositoryToCheck(row: RepositoryToCheckRow): RepositoryToCheck {
  return {
    id: row.id,
    nodeId: row.github_node_id,
    fullName: row.full_name,
    description: row.description,
    starsCount: row.stars_count,
    isArchived: row.is_archived === 1,
  };
}

export async function listRepositoriesToCheck(db: D1Database): Promise<RepositoryToCheck[]> {
  const { results } = await repositoriesToCheckStatement(db).all<RepositoryToCheckRow>();
  return results.map(toRepositoryToCheck);
}

// ---------------------------------------------------------------------------
// Subscriptions

/**
 * Subscribes a chat to a stored repository, at most `maxRepos` per chat.
 * Creates or reactivates the chat in the same batch, and checks the limit in
 * the insert statement itself. New subscriptions start at the current star
 * count, so old stars aren't announced.
 */
export async function subscribe(
  db: D1Database,
  chatId: number,
  repositoryId: number,
  maxRepos: number,
): Promise<SubscribeOutcome> {
  const [, insert, state] = await db.batch<{ subscribed: number; repository_exists: number }>([
    ensureChatStatement(db, chatId),
    db
      .prepare(
        `INSERT INTO chat_repositories (chat_id, repository_id, last_notified_stars)
         SELECT ?1, r.id, r.stars_count FROM repositories r
         WHERE r.id = ?2
           AND (SELECT COUNT(*) FROM chat_repositories WHERE chat_id = ?1) < ?3
         ON CONFLICT (chat_id, repository_id) DO NOTHING`,
      )
      .bind(chatId, repositoryId, maxRepos),
    db
      .prepare(
        `SELECT
           EXISTS (SELECT 1 FROM chat_repositories WHERE chat_id = ?1 AND repository_id = ?2) AS subscribed,
           EXISTS (SELECT 1 FROM repositories WHERE id = ?2) AS repository_exists`,
      )
      .bind(chatId, repositoryId),
  ]);

  return subscribeOutcome(insert?.meta.changes === 1, state?.results[0]);
}

function subscribeOutcome(
  inserted: boolean,
  state: { subscribed: number; repository_exists: number } | undefined,
): SubscribeOutcome {
  if (inserted) {
    return "subscribed";
  }
  if (!state?.repository_exists) {
    return "unknown-repository";
  }
  return state.subscribed ? "already-subscribed" : "limit-reached";
}

/**
 * Unsubscribes a chat by repository name (case-insensitive), in one batch.
 * Removes every subscription of that chat with that name, in case a stale row
 * shares it. Returns the stored name for the reply.
 */
export async function unsubscribe(
  db: D1Database,
  chatId: number,
  fullName: string,
): Promise<Result<string, "not-subscribed">> {
  const [match, deleted] = await db.batch<{ full_name: string }>([
    db
      .prepare(
        `SELECT r.full_name FROM chat_repositories cr JOIN repositories r ON r.id = cr.repository_id
         WHERE cr.chat_id = ?1 AND r.full_name = ?2
         ORDER BY r.updated_at DESC LIMIT 1`,
      )
      .bind(chatId, fullName),
    db
      .prepare(
        `DELETE FROM chat_repositories
         WHERE chat_id = ?1 AND repository_id IN (SELECT id FROM repositories WHERE full_name = ?2)`,
      )
      .bind(chatId, fullName),
  ]);

  const storedName = match?.results[0]?.full_name;
  return storedName !== undefined && (deleted?.meta.changes ?? 0) > 0 ? ok(storedName) : err("not-subscribed");
}

/** A chat's subscriptions, most-starred first. */
export async function listSubscriptions(db: D1Database, chatId: number): Promise<Repository[]> {
  const { results } = await db
    .prepare(
      `SELECT r.id, r.github_node_id, r.full_name, r.description, r.stars_count, r.is_archived
       FROM chat_repositories cr JOIN repositories r ON r.id = cr.repository_id
       WHERE cr.chat_id = ?
       ORDER BY r.stars_count DESC, r.full_name`,
    )
    .bind(chatId)
    .all<RepositoryRow>();
  return results.map(toRepository);
}

/** Active chats subscribed to a repository. */
export async function listSubscribers(db: D1Database, repositoryId: number): Promise<number[]> {
  const { results } = await db
    .prepare(
      `SELECT cr.chat_id FROM chat_repositories cr JOIN chats c ON c.id = cr.chat_id
       WHERE cr.repository_id = ? AND c.is_active = 1
       ORDER BY cr.chat_id`,
    )
    .bind(repositoryId)
    .all<{ chat_id: number }>();
  return results.map((row) => row.chat_id);
}

// ---------------------------------------------------------------------------
// Star check

/**
 * Saves one run's results in one batch. Pass only repositories whose data
 * changed. Per repository: one written row for the update, plus one for
 * today's gain when stars went up (computed from the stored count).
 * Returns the rows written, for the run summary.
 */
export async function recordStarCheck(
  db: D1Database,
  updates: readonly StarCheckUpdate[],
  day: string,
  nextCursor?: number,
): Promise<{ rowsWritten: number }> {
  const cursor = nextCursor === undefined ? [] : [setCursorStatement(db, nextCursor)];
  const statements = updates.flatMap((update) => [
    recordGainStatement(db, update.id, update.starsCount, day),
    db
      .prepare(
        `UPDATE repositories
         SET stars_count = ?2, full_name = ?3, description = ?4, is_archived = ?5, updated_at = ${NOW}
         WHERE id = ?1`,
      )
      .bind(update.id, update.starsCount, update.fullName, update.description, update.isArchived ? 1 : 0),
  ]);
  if (statements.length + cursor.length === 0) {
    return { rowsWritten: 0 };
  }
  const results = await db.batch([...statements, ...cursor]);
  return { rowsWritten: results.reduce((sum, result) => sum + result.meta.rows_written, 0) };
}

/**
 * Notifications that are due: active chats whose repository's star count
 * differs from what they were last told. A gain is due at once; a loss only
 * if the chat wasn't notified about that repository after `lossesAfter` (an
 * ISO time), so a flapping count can't send a message every run (see
 * migrations/0005). Random order, so rows whose sends keep failing can't
 * crowd out the rest. Reads every subscription once.
 */
export async function listDueNotifications(db: D1Database, limit: number, lossesAfter: string): Promise<DueNotification[]> {
  const { results } = await db
    .prepare(
      `SELECT cr.chat_id, r.id AS repository_id, r.full_name, r.stars_count, cr.last_notified_stars
       FROM chat_repositories cr
       JOIN repositories r ON r.id = cr.repository_id
       JOIN chats c ON c.id = cr.chat_id
       WHERE c.is_active = 1
         AND (r.stars_count > cr.last_notified_stars
              OR (r.stars_count < cr.last_notified_stars
                  AND (cr.last_notified_at IS NULL OR cr.last_notified_at <= ?2)))
       ORDER BY random()
       LIMIT ?1`,
    )
    .bind(limit, lossesAfter)
    .all<{
      chat_id: number;
      repository_id: number;
      full_name: string;
      stars_count: number;
      last_notified_stars: number;
    }>();

  return results.map((row) => ({
    chatId: row.chat_id,
    repositoryId: row.repository_id,
    fullName: row.full_name,
    starsCount: row.stars_count,
    lastNotifiedStars: row.last_notified_stars,
  }));
}

/**
 * Records that chats were told about `starsCount` at `at` (an ISO time), in
 * one batch (one D1 call), for a message that covered all of them. Lower
 * counts too: losses are reported. Rows already at the count aren't written.
 * Overlapping runs are prevented by the run lock, not by this.
 */
export async function markNotifiedMany(
  db: D1Database,
  items: readonly { chatId: number; repositoryId: number; starsCount: number }[],
  at: string,
): Promise<void> {
  if (items.length === 0) {
    return;
  }
  await db.batch(
    items.map((item) =>
      db
        .prepare(
          `UPDATE chat_repositories SET last_notified_stars = ?3, last_notified_at = ?4
           WHERE chat_id = ?1 AND repository_id = ?2 AND last_notified_stars <> ?3`,
        )
        .bind(item.chatId, item.repositoryId, item.starsCount, at),
    ),
  );
}

/** Deletes star gains older than `beforeDay` (YYYY-MM-DD). Returns rows deleted. */
export async function pruneStarGains(db: D1Database, beforeDay: string): Promise<number> {
  const result = await db.prepare("DELETE FROM daily_star_gains WHERE day < ?").bind(beforeDay).run();
  return result.meta.changes;
}

// ---------------------------------------------------------------------------
// Stats

/** Counts for /stats. `starsGained` sums days from `sinceDay` on, even if a cleanup was missed. */
export async function getStats(db: D1Database, sinceDay: string): Promise<Stats> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM repositories) AS repositories,
         (SELECT COUNT(*) FROM chats WHERE is_active = 1) AS active_chats,
         (SELECT COUNT(*) FROM chat_repositories) AS subscriptions,
         (SELECT COALESCE(SUM(stars_gained), 0) FROM daily_star_gains WHERE day >= ?) AS stars_gained`,
    )
    .bind(sinceDay)
    .first<{ repositories: number; active_chats: number; subscriptions: number; stars_gained: number }>();

  return {
    repositories: row?.repositories ?? 0,
    activeChats: row?.active_chats ?? 0,
    subscriptions: row?.subscriptions ?? 0,
    starsGained: row?.stars_gained ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Star check cursor

/** Where the next star check starts (0 = from the beginning). */
export async function getStarCheckCursor(db: D1Database): Promise<number> {
  const cursor = await db.prepare("SELECT cursor FROM star_check_state WHERE id = 1").first<number>("cursor");
  return cursor ?? 0;
}

function setCursorStatement(db: D1Database, cursor: number): D1PreparedStatement {
  return db.prepare("UPDATE star_check_state SET cursor = ?1 WHERE id = 1 AND cursor <> ?1").bind(cursor);
}

/** Saves the cursor. No written rows when it's unchanged. */
export async function setStarCheckCursor(db: D1Database, cursor: number): Promise<void> {
  await setCursorStatement(db, cursor).run();
}

/** The repositories to check and the cursor, in one D1 call. */
export async function loadStarCheck(db: D1Database): Promise<{ repositories: RepositoryToCheck[]; cursor: number }> {
  const [repositories, state] = await db.batch([
    repositoriesToCheckStatement(db),
    db.prepare("SELECT cursor FROM star_check_state WHERE id = 1"),
  ]);
  const rows = (repositories?.results ?? []) as RepositoryToCheckRow[];
  const cursorRow = state?.results[0] as { cursor: number } | undefined;
  return { repositories: rows.map(toRepositoryToCheck), cursor: cursorRow?.cursor ?? 0 };
}

/**
 * Takes the run lock until `until`, if it's free or expired. False when
 * another run holds it. One written row.
 */
export async function acquireStarCheckLock(db: D1Database, now: number, until: number): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE star_check_state SET locked_until = ?2
       WHERE id = 1 AND (locked_until IS NULL OR locked_until < ?1)`,
    )
    .bind(new Date(now).toISOString(), new Date(until).toISOString())
    .run();
  return result.meta.changes === 1;
}

export async function releaseStarCheckLock(db: D1Database): Promise<void> {
  await db.prepare("UPDATE star_check_state SET locked_until = NULL WHERE id = 1").run();
}
