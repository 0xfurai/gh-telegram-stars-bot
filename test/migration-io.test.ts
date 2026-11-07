import { describe, expect, it } from "vitest";
import {
  deleteSubscriptions,
  exportSupabase,
  lookUpNodeIds,
  readD1Snapshot,
  selectAll,
  wranglerTargetArgs,
  upsert,
  type RunCommand,
} from "../scripts/migration/io";
import { SNAPSHOT_QUERIES } from "../scripts/migration/types";

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function recordingFetch(answer: (url: string, init: RequestInit | undefined) => Response) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    return Promise.resolve(answer(url, init));
  };
  return { fetch, calls };
}

describe("Supabase", () => {
  it("reads a table a page at a time with the service-role key", async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({ id: i }));
    const { fetch, calls } = recordingFetch((_url, init) => {
      const range = new Headers(init?.headers).get("range") ?? "0-0";
      const [from = 0, to = 0] = range.split("-").map(Number);
      return Response.json(rows.slice(from, to + 1));
    });

    const result = await selectAll<{ id: number }>({ url: "https://sb.test", serviceRoleKey: "key", fetch }, "chats", {
      columns: "id,is_active",
      order: "id",
    });

    expect(result).toHaveLength(1500);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://sb.test/rest/v1/chats?select=id,is_active&order=id");
    expect(new Headers(calls[1]?.init?.headers).get("range")).toBe("1000-1999");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer key");
  });

  it("fails loudly on an error response", async () => {
    const { fetch } = recordingFetch(() => new Response("permission denied", { status: 401 }));

    await expect(selectAll({ url: "https://sb.test", serviceRoleKey: "anon", fetch }, "chats", { columns: "id", order: "id" })).rejects.toThrow(
      "Reading chats failed: HTTP 401 permission denied",
    );
  });

  it("exports star events from the given time on, ordered by unique keys, with nulls set to the old defaults", async () => {
    const { fetch, calls } = recordingFetch((url) => {
      const table = new URL(url).pathname.split("/").at(-1);
      const rows: Record<string, object[]> = {
        chats: [{ id: 1, is_active: null, created_at: null, updated_at: null }],
        repositories: [],
        chat_repositories: [
          { chat_id: 1, repository_id: 2, created_at: null },
          { chat_id: null, repository_id: 2, created_at: null },
        ],
        star_events: [{ repository_id: null, stars_count: 2, previous_stars_count: 1, created_at: null }],
      };
      return Response.json(rows[table ?? ""] ?? []);
    });
    const now = "2026-11-07T10:00:00.000Z";

    const data = await exportSupabase({ url: "https://sb.test", serviceRoleKey: "key", fetch }, { starEventsSince: "2026-08-10T00:00:00Z", now });

    expect(calls.map((c) => decodeURIComponent(c.url.slice("https://sb.test/rest/v1/".length)))).toEqual([
      "chats?select=id,is_active,created_at,updated_at&order=id",
      "repositories?select=id,github_id,full_name,description,html_url,stars_count,is_archived,created_at,updated_at&order=id",
      "chat_repositories?select=chat_id,repository_id,created_at&order=chat_id,repository_id",
      "star_events?select=repository_id,stars_count,previous_stars_count,created_at&order=id&created_at=gte.2026-08-10T00:00:00Z",
    ]);
    expect(data.chats).toEqual([{ id: 1, is_active: true, created_at: now, updated_at: now }]);
    expect(data.subscriptions).toEqual([{ chat_id: 1, repository_id: 2, created_at: now }]);
    expect(data.starEvents).toEqual([]);
  });

  it("skips star events when they aren't needed", async () => {
    const { fetch, calls } = recordingFetch(() => Response.json([]));

    await exportSupabase({ url: "https://sb.test", serviceRoleKey: "key", fetch }, { starEventsSince: null, now: "x" });

    expect(calls.map((c) => c.url).filter((url) => url.includes("star_events"))).toEqual([]);
  });

  it("deletes subscriptions 50 pairs per request", async () => {
    const { fetch, calls } = recordingFetch(() => new Response(null, { status: 204 }));
    const subs = Array.from({ length: 120 }, (_, i) => ({ chat_id: -100 - i, repository_id: i }));

    await deleteSubscriptions({ url: "https://sb.test", serviceRoleKey: "key", fetch }, subs);

    expect(calls.map((c) => c.init?.method)).toEqual(["DELETE", "DELETE", "DELETE"]);
    expect(decodeURIComponent(calls[0]?.url ?? "")).toMatch(
      /^https:\/\/sb\.test\/rest\/v1\/chat_repositories\?or=\(and\(chat_id\.eq\.-100,repository_id\.eq\.0\),and\(chat_id\.eq\.-101,repository_id\.eq\.1\),/,
    );
    expect(decodeURIComponent(calls[2]?.url ?? "").match(/and\(/g)).toHaveLength(20);
  });

  it("upserts in batches, merging on the given key", async () => {
    const { fetch, calls } = recordingFetch(() => new Response(null, { status: 201 }));

    await upsert({ url: "https://sb.test", serviceRoleKey: "key", fetch }, "repositories", "github_id", Array.from({ length: 1200 }, (_, i) => ({ github_id: i })));

    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toBe("https://sb.test/rest/v1/repositories?on_conflict=github_id");
    expect(new Headers(calls[0]?.init?.headers).get("prefer")).toBe("resolution=merge-duplicates,return=minimal");
  });
});

describe("GitHub node IDs", () => {
  it("looks repositories up by ID, and treats gone, blocked and private ones as null", async () => {
    const statuses: Record<number, number> = { 2: 404, 4: 410, 5: 451, 6: 403 };
    const { fetch } = recordingFetch((url) => {
      const id = Number(url.split("/").at(-1));
      const status = statuses[id];
      return status ? new Response("", { status }) : Response.json({ node_id: `R_${id}`, private: id === 3 });
    });

    const nodeIds = await lookUpNodeIds({ token: "t", fetch }, [1, 2, 3, 4, 5, 6]);

    expect([...nodeIds]).toEqual([
      [1, "R_1"],
      [2, null],
      [3, null],
      [4, null],
      [5, null],
      [6, null],
    ]);
  });

  it.each([
    ["429", new Response("", { status: 429 })],
    ["403 with no requests left", new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } })],
    ["403 with retry-after", new Response("", { status: 403, headers: { "retry-after": "60" } })],
  ])("fails the whole lookup on a rate limit (%s), so live repositories aren't stored as gone", async (_name, response) => {
    const { fetch } = recordingFetch(() => response.clone());

    await expect(lookUpNodeIds({ token: "t", fetch }, [1])).rejects.toThrow("GitHub rate limit reached");
  });

  it("fails loudly on other errors", async () => {
    const { fetch } = recordingFetch(() => new Response("oops", { status: 502 }));

    await expect(lookUpNodeIds({ token: "t", fetch }, [1])).rejects.toThrow("Looking up repository 1 failed: HTTP 502 oops");
  });
});

describe("readD1Snapshot", () => {
  it("runs the four snapshot queries in one wrangler call and reads each result", async () => {
    const commands: string[][] = [];
    const run: RunCommand = (command, args) => {
      commands.push([command, ...args]);
      const answer = [[{ id: 1, is_active: 1 }], [], [{ chat_id: 1, repository_id: 10, last_notified_stars: 5 }], []];
      return Promise.resolve(JSON.stringify(answer.map((results) => ({ results, success: true }))));
    };

    const snapshot = await readD1Snapshot(run, { environment: "staging", location: "remote" });

    expect(snapshot.chats).toEqual([{ id: 1, is_active: 1 }]);
    expect(snapshot.subscriptions).toEqual([{ chat_id: 1, repository_id: 10, last_notified_stars: 5 }]);
    expect(commands).toEqual([
      [
        "bunx",
        "wrangler",
        "d1",
        "execute",
        "DB",
        "--remote",
        "--env",
        "staging",
        "--json",
        "--command",
        Object.values(SNAPSHOT_QUERIES).join("; "),
      ],
    ]);
  });

  it("fails when wrangler returns fewer results than queries", async () => {
    const run: RunCommand = () => Promise.resolve(JSON.stringify([{ results: [], success: true }]));

    await expect(readD1Snapshot(run, { environment: "production", location: "remote" })).rejects.toThrow(
      "Reading D1 returned 1 results for 4 queries",
    );
  });

  it("targets production as wrangler.jsonc's top level, and staging with --env", () => {
    expect(wranglerTargetArgs({ environment: "production", location: "remote" })).toEqual(["--remote"]);
    expect(wranglerTargetArgs({ environment: "production", location: "local" })).toEqual(["--local"]);
    expect(wranglerTargetArgs({ environment: "staging", location: "remote" })).toEqual(["--remote", "--env", "staging"]);
  });
});
