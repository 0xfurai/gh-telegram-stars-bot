// I/O for the copy scripts: Supabase's REST API, GitHub's REST API, and D1
// through wrangler. `fetch` and the command runner can be replaced in tests.
import { chunk } from "../../src/chunk.ts";
import { assertNever } from "../../src/result.ts";
import { normalizeExport, type RawSupabaseExport } from "./normalize.ts";
import { SNAPSHOT_QUERIES, type D1Snapshot, type NodeIds, type SupabaseExport } from "./types.ts";

const PAGE_SIZE = 1000;
const GITHUB_CONCURRENCY = 5;
const DELETES_PER_REQUEST = 50;

export interface Supabase {
  url: string;
  serviceRoleKey: string;
  fetch?: typeof fetch;
}

function supabaseHeaders(supabase: Supabase, extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: supabase.serviceRoleKey,
    authorization: `Bearer ${supabase.serviceRoleKey}`,
    "content-type": "application/json",
    ...extra,
  };
}

async function checked(response: Response, what: string): Promise<Response> {
  if (!response.ok) {
    throw new Error(`${what} failed: HTTP ${response.status} ${await response.text()}`);
  }
  return response;
}

export interface SelectOptions {
  columns: string;
  /** A unique ordering, so pages never overlap or skip rows. */
  order: string;
  /** Extra PostgREST filters, e.g. "created_at=gte.2026-08-10". */
  filter?: string;
}

/** Every row of a table, a page at a time. */
export async function selectAll<T>(supabase: Supabase, table: string, options: SelectOptions): Promise<T[]> {
  const fetchImpl = supabase.fetch ?? fetch;
  const filter = options.filter ? `&${options.filter}` : "";
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const response = await fetchImpl(
      `${supabase.url}/rest/v1/${table}?select=${options.columns}&order=${options.order}${filter}`,
      { headers: supabaseHeaders(supabase, { "range-unit": "items", range: `${from}-${from + PAGE_SIZE - 1}` }) },
    );
    const page = (await (await checked(response, `Reading ${table}`)).json()) as T[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) {
      return rows;
    }
  }
}

export interface ExportOptions {
  /** Star events from this ISO time on, or null to skip them (the shadow copy doesn't use them). */
  starEventsSince: string | null;
  now: string;
}

type Raw<K extends keyof RawSupabaseExport> = RawSupabaseExport[K][number];

export async function exportSupabase(supabase: Supabase, options: ExportOptions): Promise<SupabaseExport> {
  const since = options.starEventsSince;
  const [chats, repositories, subscriptions, starEvents] = await Promise.all([
    selectAll<Raw<"chats">>(supabase, "chats", { columns: "id,is_active,created_at,updated_at", order: "id" }),
    selectAll<Raw<"repositories">>(supabase, "repositories", {
      columns: "id,github_id,full_name,description,html_url,stars_count,is_archived,created_at,updated_at",
      order: "id",
    }),
    selectAll<Raw<"subscriptions">>(supabase, "chat_repositories", {
      columns: "chat_id,repository_id,created_at",
      order: "chat_id,repository_id",
    }),
    since === null
      ? Promise.resolve([])
      : selectAll<Raw<"starEvents">>(supabase, "star_events", {
          columns: "repository_id,stars_count,previous_stars_count,created_at",
          order: "id",
          filter: `created_at=gte.${since}`,
        }),
  ]);
  return normalizeExport({ chats, repositories, subscriptions, starEvents }, options.now);
}

/** Upserts rows (merging on `onConflict`), 500 per request. */
export async function upsert(supabase: Supabase, table: string, onConflict: string, rows: readonly object[]): Promise<void> {
  const fetchImpl = supabase.fetch ?? fetch;
  for (const part of chunk(rows, 500)) {
    const response = await fetchImpl(`${supabase.url}/rest/v1/${table}?on_conflict=${onConflict}`, {
      method: "POST",
      headers: supabaseHeaders(supabase, { prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify(part),
    });
    await checked(response, `Writing ${table}`);
  }
}

/** Deletes subscriptions, 50 per request. */
export async function deleteSubscriptions(
  supabase: Supabase,
  subscriptions: readonly { chat_id: number; repository_id: number }[],
): Promise<void> {
  const fetchImpl = supabase.fetch ?? fetch;
  for (const part of chunk(subscriptions, DELETES_PER_REQUEST)) {
    const pairs = part.map((s) => `and(chat_id.eq.${s.chat_id},repository_id.eq.${s.repository_id})`).join(",");
    const response = await fetchImpl(`${supabase.url}/rest/v1/chat_repositories?or=(${pairs})`, {
      method: "DELETE",
      headers: supabaseHeaders(supabase),
    });
    await checked(response, "Deleting subscriptions");
  }
}

export interface GitHub {
  token: string;
  fetch?: typeof fetch;
}

function isRateLimited(response: Response): boolean {
  return (
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")))
  );
}

/**
 * One repository's node ID by GitHub ID; null when it can't be reported on:
 * gone (404, 410), taken down (451), access blocked (403) or private. A rate
 * limit fails the whole lookup, so it's run again later instead of storing
 * live repositories as gone.
 */
async function nodeIdFor(github: GitHub, githubId: number): Promise<string | null> {
  const fetchImpl = github.fetch ?? fetch;
  const response = await fetchImpl(`https://api.github.com/repositories/${githubId}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${github.token}`,
      "user-agent": "gh-telegram-stars-bot",
    },
  });
  if (isRateLimited(response)) {
    throw new Error(`GitHub rate limit reached while looking up repository ${githubId}; run the copy again later`);
  }
  if ([403, 404, 410, 451].includes(response.status)) {
    return null;
  }
  const repo = (await (await checked(response, `Looking up repository ${githubId}`)).json()) as {
    node_id: string;
    private: boolean;
  };
  return repo.private ? null : repo.node_id;
}

/** Node IDs for every repository, by GitHub ID, a few at a time. Works for renamed repositories too. */
export async function lookUpNodeIds(github: GitHub, githubIds: readonly number[]): Promise<NodeIds> {
  const nodeIds = new Map<number, string | null>();
  for (const part of chunk(githubIds, GITHUB_CONCURRENCY)) {
    const found = await Promise.all(part.map(async (id) => [id, await nodeIdFor(github, id)] as const));
    for (const [id, nodeId] of found) {
      nodeIds.set(id, nodeId);
    }
  }
  return nodeIds;
}

/** Runs a command and returns its stdout. */
export type RunCommand = (command: string, args: readonly string[]) => Promise<string>;

/** Which D1 database: the wrangler environment, remote or local (a dry run). */
export interface D1Target {
  environment: "production" | "staging";
  location: "remote" | "local";
}

/** wrangler's flags for a target. Production is wrangler.jsonc's top level, so it has no --env. */
export function wranglerTargetArgs(target: D1Target): string[] {
  const location = `--${target.location}`;
  switch (target.environment) {
    case "production":
      return [location];
    case "staging":
      return [location, "--env", "staging"];
    default:
      return assertNever(target.environment);
  }
}

/**
 * Reads a D1Snapshot with one `wrangler d1 execute --json` call running all
 * four queries. One call, not four in parallel: local wrangler runs fail
 * when they overlap.
 */
export async function readD1Snapshot(run: RunCommand, target: D1Target): Promise<D1Snapshot> {
  const queries = [SNAPSHOT_QUERIES.chats, SNAPSHOT_QUERIES.repositories, SNAPSHOT_QUERIES.subscriptions, SNAPSHOT_QUERIES.gains];
  const output = await run("bunx", [
    "wrangler",
    "d1",
    "execute",
    "DB",
    ...wranglerTargetArgs(target),
    "--json",
    "--command",
    queries.join("; "),
  ]);
  const results = (JSON.parse(output) as { results: unknown[] }[]).map((result) => result.results);
  if (results.length !== queries.length) {
    throw new Error(`Reading D1 returned ${results.length} results for ${queries.length} queries`);
  }
  const [chats, repositories, subscriptions, gains] = results;
  return {
    chats: chats as D1Snapshot["chats"],
    repositories: repositories as D1Snapshot["repositories"],
    subscriptions: subscriptions as D1Snapshot["subscriptions"],
    gains: gains as D1Snapshot["gains"],
  };
}
