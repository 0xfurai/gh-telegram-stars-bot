// I/O for the copy scripts: Supabase's REST API, GitHub's REST API, and D1
// through wrangler. `fetch` and the command runner can be replaced in tests.
import { chunk } from "../../src/chunk.ts";
import { SNAPSHOT_QUERIES, type D1Snapshot, type NodeIds, type SupabaseExport } from "./types.ts";

const PAGE_SIZE = 1000;
const GITHUB_CONCURRENCY = 5;

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

/** Every row of a table, a page at a time. */
export async function selectAll<T>(supabase: Supabase, table: string, columns: string): Promise<T[]> {
  const fetchImpl = supabase.fetch ?? fetch;
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const response = await fetchImpl(`${supabase.url}/rest/v1/${table}?select=${columns}&order=${columns.split(",")[0]}`, {
      headers: supabaseHeaders(supabase, { "range-unit": "items", range: `${from}-${from + PAGE_SIZE - 1}` }),
    });
    const page = (await (await checked(response, `Reading ${table}`)).json()) as T[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) {
      return rows;
    }
  }
}

export async function exportSupabase(supabase: Supabase): Promise<SupabaseExport> {
  const [chats, repositories, subscriptions, starEvents] = await Promise.all([
    selectAll<SupabaseExport["chats"][number]>(supabase, "chats", "id,is_active,created_at,updated_at"),
    selectAll<SupabaseExport["repositories"][number]>(
      supabase,
      "repositories",
      "id,github_id,full_name,description,html_url,stars_count,is_archived,created_at,updated_at",
    ),
    selectAll<SupabaseExport["subscriptions"][number]>(supabase, "chat_repositories", "chat_id,repository_id,created_at"),
    selectAll<SupabaseExport["starEvents"][number]>(
      supabase,
      "star_events",
      "repository_id,stars_count,previous_stars_count,created_at",
    ),
  ]);
  return { chats, repositories, subscriptions, starEvents };
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

export async function deleteSubscription(supabase: Supabase, chatId: number, repositoryId: number): Promise<void> {
  const fetchImpl = supabase.fetch ?? fetch;
  const response = await fetchImpl(
    `${supabase.url}/rest/v1/chat_repositories?chat_id=eq.${chatId}&repository_id=eq.${repositoryId}`,
    { method: "DELETE", headers: supabaseHeaders(supabase) },
  );
  await checked(response, "Deleting a subscription");
}

export interface GitHub {
  token: string;
  fetch?: typeof fetch;
}

/** One repository's node ID by GitHub ID; null when it's gone or private. */
async function nodeIdFor(github: GitHub, githubId: number): Promise<string | null> {
  const fetchImpl = github.fetch ?? fetch;
  const response = await fetchImpl(`https://api.github.com/repositories/${githubId}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${github.token}`,
      "user-agent": "gh-telegram-stars-bot",
    },
  });
  if (response.status === 404) {
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

/** Reads a D1Snapshot through `wrangler d1 execute --json`. */
export async function readD1Snapshot(run: RunCommand, target: "--remote" | "--local"): Promise<D1Snapshot> {
  const query = async (sql: string) => {
    const output = await run("bunx", ["wrangler", "d1", "execute", "DB", target, "--json", "--command", sql]);
    const [result] = JSON.parse(output) as { results: unknown[] }[];
    return result?.results ?? [];
  };
  return {
    chats: (await query(SNAPSHOT_QUERIES.chats)) as D1Snapshot["chats"],
    repositories: (await query(SNAPSHOT_QUERIES.repositories)) as D1Snapshot["repositories"],
    subscriptions: (await query(SNAPSHOT_QUERIES.subscriptions)) as D1Snapshot["subscriptions"],
    gains: (await query(SNAPSHOT_QUERIES.gains)) as D1Snapshot["gains"],
  };
}
