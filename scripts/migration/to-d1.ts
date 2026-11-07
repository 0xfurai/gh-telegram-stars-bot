// Builds the SQL that copies Supabase's data into D1. Pure: no I/O.
import { chunk } from "../../src/chunk.ts";
import { assertNever, err, ok, type Result } from "../../src/result.ts";
import type { D1Snapshot, NodeIds, SupabaseExport, SupabaseRepository, SupabaseStarEvent } from "./types.ts";

/**
 * full: the final copy at the switch (`today` sets the 90-day gains window).
 * shadow: the daily copy during the shadow run; needs D1's current
 * subscriptions, so only the pairs that differ are deleted or added.
 */
export type CopyOptions =
  | { mode: "full"; today: string }
  | { mode: "shadow"; current: D1Snapshot["subscriptions"] };

/** Problems in the export that would break or corrupt the copy. */
export type CopyProblem =
  | { kind: "duplicate-github-id"; githubId: number }
  | { kind: "unknown-repository"; chatId: number; repositoryId: number }
  | { kind: "unknown-chat"; chatId: number }
  | { kind: "missing-node-id"; githubId: number; fullName: string };

const RETENTION_DAYS = 90;
export const DAY_MS = 24 * 60 * 60 * 1000;
const ROWS_PER_INSERT = 100;

function sqlString(value: string | null): string {
  return value === null ? "NULL" : `'${value.replaceAll("'", "''")}'`;
}

function sqlInteger(value: number): string {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Not a safe integer: ${value}`);
  }
  return String(value);
}

function sqlTimestamp(value: string): string {
  return sqlString(new Date(value).toISOString());
}

function insertRows(prefix: string, rows: readonly string[], suffix = ""): string[] {
  return chunk(rows, ROWS_PER_INSERT).map((part) => `${prefix} VALUES\n  ${part.join(",\n  ")}${suffix};`);
}

export function utcDay(value: string | number): string {
  return new Date(value).toISOString().slice(0, 10);
}

/** A real YYYY-MM-DD day: "2026-02-31" is refused, not rolled over to March. */
export function isUtcDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && utcDay(value) === value;
}

/** The UTC day `days` after `day` (before it when negative). */
export function addDays(day: string, days: number): string {
  return utcDay(Date.parse(day) + days * DAY_MS);
}

/** The first day of the 90-day gains window that ends on `today` (a UTC day). */
export function gainsWindowStart(today: string): string {
  return utcDay(Date.parse(today) - (RETENTION_DAYS - 1) * DAY_MS);
}

/** Star events summed per GitHub repository and UTC day, positive gains only, last 90 days. */
export function dailyGains(
  events: readonly SupabaseStarEvent[],
  githubIdOf: ReadonlyMap<number, number>,
  today: string,
): { githubId: number; day: string; starsGained: number }[] {
  const since = gainsWindowStart(today);
  const totals = new Map<string, number>();
  for (const event of events) {
    const githubId = githubIdOf.get(event.repository_id);
    const gained = event.stars_count - event.previous_stars_count;
    const day = utcDay(event.created_at);
    if (githubId !== undefined && gained > 0 && day >= since) {
      const key = `${githubId}|${day}`;
      totals.set(key, (totals.get(key) ?? 0) + gained);
    }
  }
  return [...totals].map(([key, starsGained]) => {
    const [githubId = "0", day = ""] = key.split("|");
    return { githubId: Number(githubId), day, starsGained };
  });
}

function findProblems(data: SupabaseExport, nodeIds: NodeIds): CopyProblem[] {
  const problems: CopyProblem[] = [];
  const seen = new Set<number>();
  for (const repo of data.repositories) {
    if (seen.has(repo.github_id)) {
      problems.push({ kind: "duplicate-github-id", githubId: repo.github_id });
    }
    seen.add(repo.github_id);
    if (!nodeIds.has(repo.github_id)) {
      problems.push({ kind: "missing-node-id", githubId: repo.github_id, fullName: repo.full_name });
    }
  }
  const repoIds = new Set(data.repositories.map((repo) => repo.id));
  const chatIds = new Set(data.chats.map((chat) => chat.id));
  for (const sub of data.subscriptions) {
    if (!repoIds.has(sub.repository_id)) {
      problems.push({ kind: "unknown-repository", chatId: sub.chat_id, repositoryId: sub.repository_id });
    }
    if (!chatIds.has(sub.chat_id)) {
      problems.push({ kind: "unknown-chat", chatId: sub.chat_id });
    }
  }
  return problems;
}

function chatRows(data: SupabaseExport): string[] {
  return data.chats.map(
    (chat) =>
      `(${sqlInteger(chat.id)}, ${chat.is_active ? 1 : 0}, ${sqlTimestamp(chat.created_at)}, ${sqlTimestamp(chat.updated_at)})`,
  );
}

function repositoryRow(repo: SupabaseRepository, nodeIds: NodeIds): string {
  const nodeId = nodeIds.get(repo.github_id) ?? null;
  // Gone from GitHub (or private): stored without a node ID, archived.
  const archived = repo.is_archived || nodeId === null ? 1 : 0;
  return [
    sqlInteger(repo.github_id),
    sqlString(nodeId),
    sqlString(repo.full_name),
    sqlString(repo.description),
    sqlInteger(repo.stars_count),
    String(archived),
    sqlTimestamp(repo.created_at),
    sqlTimestamp(repo.updated_at),
  ].join(", ");
}

function subscriptionPairs(data: SupabaseExport): { chatId: number; githubId: number; createdAt: string }[] {
  const githubIdOf = new Map(data.repositories.map((repo) => [repo.id, repo.github_id]));
  return data.subscriptions.flatMap((sub) => {
    const githubId = githubIdOf.get(sub.repository_id);
    return githubId === undefined ? [] : [{ chatId: sub.chat_id, githubId, createdAt: sub.created_at }];
  });
}

const REPOSITORY_COLUMNS =
  "INSERT INTO repositories (id, github_node_id, full_name, description, stars_count, is_archived, created_at, updated_at)";

/** Full copy: D1 becomes an exact copy of Supabase. */
function fullCopy(data: SupabaseExport, nodeIds: NodeIds, today: string): string[] {
  const starsOf = new Map(data.repositories.map((repo) => [repo.github_id, repo.stars_count]));
  const subscriptions = subscriptionPairs(data).map(
    (s) => `(${sqlInteger(s.chatId)}, ${sqlInteger(s.githubId)}, ${sqlInteger(starsOf.get(s.githubId) ?? 0)}, ${sqlTimestamp(s.createdAt)})`,
  );
  const githubIdOf = new Map(data.repositories.map((repo) => [repo.id, repo.github_id]));
  const gains = dailyGains(data.starEvents, githubIdOf, today).map(
    (g) => `(${sqlInteger(g.githubId)}, ${sqlString(g.day)}, ${sqlInteger(g.starsGained)})`,
  );
  return [
    "DELETE FROM daily_star_gains;",
    "DELETE FROM chat_repositories;",
    "DELETE FROM repositories;",
    "DELETE FROM chats;",
    "UPDATE star_check_state SET cursor = 0;",
    ...insertRows("INSERT INTO chats (id, is_active, created_at, updated_at)", chatRows(data)),
    ...insertRows(REPOSITORY_COLUMNS, data.repositories.map((repo) => `(${repositoryRow(repo, nodeIds)})`)),
    ...insertRows("INSERT INTO chat_repositories (chat_id, repository_id, last_notified_stars, created_at)", subscriptions),
    ...insertRows("INSERT INTO daily_star_gains (repository_id, day, stars_gained)", gains),
  ];
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

function pairKey(chatId: number, repositoryId: number): string {
  return `${chatId}|${repositoryId}`;
}

/** Deletes exactly the subscriptions D1 has and Supabase doesn't, 100 pairs per statement. */
function removedSubscriptions(pairs: readonly { chatId: number; githubId: number }[], current: D1Snapshot["subscriptions"]): string[] {
  const wanted = new Set(pairs.map((p) => pairKey(p.chatId, p.githubId)));
  const removed = current
    .filter((sub) => !wanted.has(pairKey(sub.chat_id, sub.repository_id)))
    .map((sub) => `(${sqlInteger(sub.chat_id)}, ${sqlInteger(sub.repository_id)})`);
  return chunk(removed, ROWS_PER_INSERT).map(
    (part) => `DELETE FROM chat_repositories WHERE (chat_id, repository_id) IN (VALUES ${part.join(", ")});`,
  );
}

/** Adds the subscriptions Supabase has and D1 doesn't, at D1's current star count. */
function addedSubscriptions(pairs: readonly { chatId: number; githubId: number; createdAt: string }[], current: D1Snapshot["subscriptions"]): string[] {
  const existing = new Set(current.map((sub) => pairKey(sub.chat_id, sub.repository_id)));
  return pairs
    .filter((p) => !existing.has(pairKey(p.chatId, p.githubId)))
    .map(
      (p) =>
        `INSERT INTO chat_repositories (chat_id, repository_id, last_notified_stars, created_at) ` +
        `SELECT ${sqlInteger(p.chatId)}, id, stars_count, ${sqlTimestamp(p.createdAt)} FROM repositories WHERE id = ${sqlInteger(p.githubId)} ` +
        `ON CONFLICT (chat_id, repository_id) DO NOTHING;`,
    );
}

/**
 * Shadow copy: mirror chats and subscriptions, keep the star counts and
 * gains the Worker tracks. Rows (and updated_at) change only when a value
 * does, which also saves D1 writes.
 */
function shadowCopy(data: SupabaseExport, nodeIds: NodeIds, current: D1Snapshot["subscriptions"]): string[] {
  const pairs = subscriptionPairs(data);
  return [
    ...insertRows(
      "INSERT INTO chats (id, is_active, created_at, updated_at)",
      chatRows(data),
      `\nON CONFLICT (id) DO UPDATE SET is_active = excluded.is_active, updated_at = ${NOW} ` +
        "WHERE chats.is_active <> excluded.is_active",
    ),
    ...insertRows(
      REPOSITORY_COLUMNS,
      data.repositories.map((repo) => `(${repositoryRow(repo, nodeIds)})`),
      "\nON CONFLICT (id) DO UPDATE SET github_node_id = excluded.github_node_id, full_name = excluded.full_name, " +
        `description = excluded.description, is_archived = excluded.is_archived, updated_at = ${NOW} ` +
        "WHERE repositories.github_node_id IS NOT excluded.github_node_id " +
        "OR repositories.full_name IS NOT excluded.full_name COLLATE BINARY " +
        "OR repositories.description IS NOT excluded.description " +
        "OR repositories.is_archived <> excluded.is_archived",
    ),
    ...removedSubscriptions(pairs, current),
    ...addedSubscriptions(pairs, current),
  ];
}

/**
 * The statements that copy the export into D1. Safe to run more than once.
 * Fails without statements if the export has problems.
 */
export function buildD1Statements(
  data: SupabaseExport,
  nodeIds: NodeIds,
  options: CopyOptions,
): Result<string[], CopyProblem[]> {
  const problems = findProblems(data, nodeIds);
  return problems.length > 0 ? err(problems) : ok(statementsFor(data, nodeIds, options));
}

/** buildD1Statements as one SQL file, for `wrangler d1 execute --file`. */
export function buildD1Sql(
  data: SupabaseExport,
  nodeIds: NodeIds,
  options: CopyOptions,
): Result<string, CopyProblem[]> {
  const statements = buildD1Statements(data, nodeIds, options);
  return statements.ok
    ? ok(`-- Generated by scripts/copy-to-d1.ts (${options.mode} copy).\n${statements.value.join("\n")}\n`)
    : statements;
}

function statementsFor(data: SupabaseExport, nodeIds: NodeIds, options: CopyOptions): string[] {
  switch (options.mode) {
    case "full":
      return fullCopy(data, nodeIds, options.today);
    case "shadow":
      return shadowCopy(data, nodeIds, options.current);
    default:
      return assertNever(options);
  }
}
