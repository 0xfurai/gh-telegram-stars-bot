// Data access for D1. Plain functions taking the database, so tests can pass
// a local binding. Every operation is one statement or one batch (a batch runs
// in a single transaction), so there's no read-then-insert race.
//
// Cost: D1 bills rows read and written. Comments note what each repeated
// operation costs; test/db.test.ts checks the ones the star check repeats.

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

/** What GitHub says about a repository, for /add and the star check. */
export interface RepositoryInfo {
  id: number;
  nodeId: string;
  fullName: string;
  description: string | null;
  starsCount: number;
  isArchived: boolean;
}

export type SubscribeResult =
  | "subscribed"
  | "already-subscribed"
  | "limit-reached"
  | "unknown-repository";

export interface RepositoryToCheck {
  id: number;
  nodeId: string;
  fullName: string;
  starsCount: number;
}

/** One star check result for a repository. */
export interface StarCheckUpdate {
  id: number;
  fullName: string;
  starsCount: number;
  isArchived: boolean;
  /** The star count stored before this check. */
  previousStarsCount: number;
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
  starsGainedLast90Days: number;
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

/** Creates the chat if it's new. Costs no written rows when it exists. */
export async function ensureChat(db: D1Database, chatId: number): Promise<void> {
  await db.prepare("INSERT INTO chats (id) VALUES (?) ON CONFLICT (id) DO NOTHING").bind(chatId).run();
}

/** Marks a chat active or inactive (for example after the bot was blocked). */
export async function setChatActive(db: D1Database, chatId: number, active: boolean): Promise<void> {
  const isActive = active ? 1 : 0;
  await db
    .prepare(
      `INSERT INTO chats (id, is_active) VALUES (?1, ?2)
       ON CONFLICT (id) DO UPDATE SET is_active = ?2, updated_at = ${NOW}
       WHERE is_active <> ?2`,
    )
    .bind(chatId, isActive)
    .run();
}

// ---------------------------------------------------------------------------
// Repositories

/** Creates or refreshes a repository from GitHub's data. */
export async function upsertRepository(db: D1Database, repo: RepositoryInfo): Promise<void> {
  await db
    .prepare(
      `INSERT INTO repositories (id, github_node_id, full_name, description, stars_count, is_archived)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (id) DO UPDATE SET
         github_node_id = ?2, full_name = ?3, description = ?4, stars_count = ?5,
         is_archived = ?6, updated_at = ${NOW}`,
    )
    .bind(repo.id, repo.nodeId, repo.fullName, repo.description, repo.starsCount, repo.isArchived ? 1 : 0)
    .run();
}

/**
 * Repositories the star check should look at: not archived, with a node ID,
 * and with at least one subscriber.
 */
export async function listRepositoriesToCheck(db: D1Database): Promise<RepositoryToCheck[]> {
  const { results } = await db
    .prepare(
      `SELECT id, github_node_id, full_name, stars_count FROM repositories r
       WHERE is_archived = 0 AND github_node_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM chat_repositories cr WHERE cr.repository_id = r.id)
       ORDER BY id`,
    )
    .all<{ id: number; github_node_id: string; full_name: string; stars_count: number }>();

  return results.map((row) => ({
    id: row.id,
    nodeId: row.github_node_id,
    fullName: row.full_name,
    starsCount: row.stars_count,
  }));
}

/** Marks a repository that's gone from GitHub (deleted or private) as archived. */
export async function markRepositoryGone(db: D1Database, repositoryId: number): Promise<void> {
  await db
    .prepare(`UPDATE repositories SET is_archived = 1, updated_at = ${NOW} WHERE id = ? AND is_archived = 0`)
    .bind(repositoryId)
    .run();
}

// ---------------------------------------------------------------------------
// Subscriptions

/**
 * Subscribes a chat to a stored repository, at most `maxRepos` per chat.
 * The limit is checked in the same statement as the insert. New subscriptions
 * start at the current star count, so old stars aren't announced.
 */
export async function subscribe(
  db: D1Database,
  chatId: number,
  repositoryId: number,
  maxRepos: number,
): Promise<SubscribeResult> {
  const [insert, state] = await db.batch<{ subscribed: number; repository_exists: number }>([
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

  return subscribeResult(insert?.meta.changes === 1, state?.results[0]);
}

function subscribeResult(
  inserted: boolean,
  state: { subscribed: number; repository_exists: number } | undefined,
): SubscribeResult {
  if (inserted) {
    return "subscribed";
  }
  if (!state?.repository_exists) {
    return "unknown-repository";
  }
  return state.subscribed ? "already-subscribed" : "limit-reached";
}

/**
 * Unsubscribes a chat by repository name (case-insensitive). Returns the
 * stored name, or null if the chat wasn't subscribed.
 */
export async function unsubscribe(
  db: D1Database,
  chatId: number,
  fullName: string,
): Promise<string | null> {
  const repo = await db
    .prepare(
      `SELECT r.id, r.full_name FROM chat_repositories cr
       JOIN repositories r ON r.id = cr.repository_id
       WHERE cr.chat_id = ? AND r.full_name = ?`,
    )
    .bind(chatId, fullName)
    .first<{ id: number; full_name: string }>();

  if (!repo) {
    return null;
  }

  await db
    .prepare("DELETE FROM chat_repositories WHERE chat_id = ? AND repository_id = ?")
    .bind(chatId, repo.id)
    .run();
  return repo.full_name;
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
 * Saves one run's star check results in one batch. Per changed repository:
 * one written row for the update, plus one for today's gain when stars went
 * up. Unchanged repositories cost nothing; pass only the ones that changed.
 */
export async function recordStarCheck(
  db: D1Database,
  updates: readonly StarCheckUpdate[],
  day: string,
): Promise<{ rowsWritten: number }> {
  const statements = updates.flatMap((update) => starCheckStatements(db, update, day));
  if (statements.length === 0) {
    return { rowsWritten: 0 };
  }
  const results = await db.batch(statements);
  return { rowsWritten: results.reduce((sum, result) => sum + result.meta.rows_written, 0) };
}

function starCheckStatements(db: D1Database, update: StarCheckUpdate, day: string): D1PreparedStatement[] {
  const statements = [
    db
      .prepare(
        `UPDATE repositories SET stars_count = ?2, full_name = ?3, is_archived = ?4, updated_at = ${NOW}
         WHERE id = ?1`,
      )
      .bind(update.id, update.starsCount, update.fullName, update.isArchived ? 1 : 0),
  ];

  const gained = update.starsCount - update.previousStarsCount;
  if (gained > 0) {
    statements.push(
      db
        .prepare(
          `INSERT INTO daily_star_gains (repository_id, day, stars_gained) VALUES (?, ?, ?)
           ON CONFLICT (repository_id, day) DO UPDATE SET stars_gained = stars_gained + excluded.stars_gained`,
        )
        .bind(update.id, day, gained),
    );
  }
  return statements;
}

/**
 * Notifications that are due: active chats whose repository has more stars
 * than they were last told about. Reads every subscription once per run.
 */
export async function listDueNotifications(db: D1Database, limit: number): Promise<DueNotification[]> {
  const { results } = await db
    .prepare(
      `SELECT cr.chat_id, r.id AS repository_id, r.full_name, r.stars_count, cr.last_notified_stars
       FROM chat_repositories cr
       JOIN repositories r ON r.id = cr.repository_id
       JOIN chats c ON c.id = cr.chat_id
       WHERE c.is_active = 1 AND r.stars_count > cr.last_notified_stars
       ORDER BY r.id, cr.chat_id
       LIMIT ?`,
    )
    .bind(limit)
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
 * Records that a chat was told about `starsCount`. Never lowers the value, so
 * an overlapping run can't resend. One written row.
 */
export async function markNotified(
  db: D1Database,
  chatId: number,
  repositoryId: number,
  starsCount: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE chat_repositories SET last_notified_stars = ?3
       WHERE chat_id = ?1 AND repository_id = ?2 AND last_notified_stars < ?3`,
    )
    .bind(chatId, repositoryId, starsCount)
    .run();
}

/** Deletes star gains older than `beforeDay` (YYYY-MM-DD). */
export async function pruneStarGains(db: D1Database, beforeDay: string): Promise<number> {
  const result = await db.prepare("DELETE FROM daily_star_gains WHERE day < ?").bind(beforeDay).run();
  return result.meta.changes;
}

// ---------------------------------------------------------------------------
// Stats

export async function getStats(db: D1Database): Promise<Stats> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM repositories) AS repositories,
         (SELECT COUNT(*) FROM chats WHERE is_active = 1) AS active_chats,
         (SELECT COUNT(*) FROM chat_repositories) AS subscriptions,
         (SELECT COALESCE(SUM(stars_gained), 0) FROM daily_star_gains) AS stars_gained`,
    )
    .first<{ repositories: number; active_chats: number; subscriptions: number; stars_gained: number }>();

  return {
    repositories: row?.repositories ?? 0,
    activeChats: row?.active_chats ?? 0,
    subscriptions: row?.subscriptions ?? 0,
    starsGainedLast90Days: row?.stars_gained ?? 0,
  };
}
