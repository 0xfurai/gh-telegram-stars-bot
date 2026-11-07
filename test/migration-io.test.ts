import { describe, expect, it } from "vitest";
import { lookUpNodeIds, readD1Snapshot, selectAll, upsert, type RunCommand } from "../scripts/migration/io";
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

    const result = await selectAll<{ id: number }>({ url: "https://sb.test", serviceRoleKey: "key", fetch }, "chats", "id,is_active");

    expect(result).toHaveLength(1500);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://sb.test/rest/v1/chats?select=id,is_active&order=id");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer key");
  });

  it("fails loudly on an error response", async () => {
    const { fetch } = recordingFetch(() => new Response("permission denied", { status: 401 }));

    await expect(selectAll({ url: "https://sb.test", serviceRoleKey: "anon", fetch }, "chats", "id")).rejects.toThrow(
      "Reading chats failed: HTTP 401 permission denied",
    );
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
  it("looks repositories up by ID, and treats gone and private ones as null", async () => {
    const { fetch } = recordingFetch((url) => {
      const id = Number(url.split("/").at(-1));
      if (id === 2) {
        return new Response("", { status: 404 });
      }
      return Response.json({ node_id: `R_${id}`, private: id === 3 });
    });

    const nodeIds = await lookUpNodeIds({ token: "t", fetch }, [1, 2, 3]);

    expect([...nodeIds]).toEqual([
      [1, "R_1"],
      [2, null],
      [3, null],
    ]);
  });

  it("fails loudly on other errors, such as a rate limit", async () => {
    const { fetch } = recordingFetch(() => new Response("rate limited", { status: 403 }));

    await expect(lookUpNodeIds({ token: "t", fetch }, [1])).rejects.toThrow("Looking up repository 1 failed: HTTP 403");
  });
});

describe("readD1Snapshot", () => {
  it("runs each snapshot query through wrangler and reads its JSON", async () => {
    const commands: string[][] = [];
    const run: RunCommand = (command, args) => {
      commands.push([command, ...args]);
      const sql = args.at(-1);
      const results = sql === SNAPSHOT_QUERIES.chats ? [{ id: 1, is_active: 1 }] : [];
      return Promise.resolve(JSON.stringify([{ results, success: true }]));
    };

    const snapshot = await readD1Snapshot(run, "--local");

    expect(snapshot.chats).toEqual([{ id: 1, is_active: 1 }]);
    expect(commands).toHaveLength(4);
    expect(commands[0]?.slice(0, 7)).toEqual(["bunx", "wrangler", "d1", "execute", "DB", "--local", "--json"]);
  });
});
