import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getStarCheckCursor, setStarCheckCursor, type RepositoryToCheck } from "../src/db";
import {
  checkStars,
  fetchRepositoryPage,
  getRepository,
  rotate,
  starCheckUpdates,
  type GitHubClient,
} from "../src/github";
import { err } from "../src/result";

interface FakeRepo {
  id: string;
  databaseId: number;
  nameWithOwner: string;
  description: string | null;
  stargazerCount: number;
  isArchived: boolean;
  isPrivate: boolean;
}

function fakeRepo(databaseId: number, overrides: Partial<FakeRepo> = {}): FakeRepo {
  return {
    id: `R_${databaseId}`,
    databaseId,
    nameWithOwner: `owner/repo-${databaseId}`,
    description: null,
    stargazerCount: 100 + databaseId,
    isArchived: false,
    isPrivate: false,
    ...overrides,
  };
}

function stored(id: number, starsCount = 100 + id): RepositoryToCheck {
  return { id, nodeId: `R_${id}`, fullName: `owner/repo-${id}`, starsCount, isArchived: false };
}

const RATE_LIMIT = { remaining: 4999, resetAt: "2026-11-07T05:00:00Z", cost: 1 };

interface Call {
  headers: Headers;
  variables: Record<string, unknown>;
}

/** A fake GitHub GraphQL endpoint. `answer` builds each response. */
function fakeGitHub(answer: (variables: Record<string, unknown>, call: number) => Response) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = (_input, init) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      variables: Record<string, unknown>;
    };
    calls.push({ headers: new Headers(init?.headers), variables: body.variables });
    return Promise.resolve(answer(body.variables, calls.length));
  };
  const client: GitHubClient = { token: "ghp_test", fetch };
  return { client, calls };
}

/** Answers node queries from a set of repos; unknown IDs come back null + NOT_FOUND. */
function nodesFrom(repos: FakeRepo[], rateLimit = RATE_LIMIT) {
  const byNodeId = new Map(repos.map((repo) => [repo.id, repo]));
  return (variables: Record<string, unknown>) => {
    const ids = variables.ids as string[];
    const nodes = ids.map((id) => byNodeId.get(id) ?? null);
    const errors = ids.flatMap((id, index) =>
      byNodeId.has(id) ? [] : [{ type: "NOT_FOUND", path: ["nodes", index], message: `Could not resolve ${id}` }],
    );
    return Response.json({ data: { rateLimit, nodes }, ...(errors.length > 0 ? { errors } : {}) });
  };
}

describe("fetchRepositoryPage", () => {
  it("returns repositories, and lists deleted, private and non-repository nodes as missing", async () => {
    const { client } = fakeGitHub((variables) => {
      const response = nodesFrom([fakeRepo(1, { description: "One" }), fakeRepo(3, { isPrivate: true })])(variables);
      return response;
    });

    const page = await fetchRepositoryPage(client, ["R_1", "R_2", "R_3"]);

    expect(page).toEqual({
      ok: true,
      value: {
        repositories: [
          { id: 1, nodeId: "R_1", fullName: "owner/repo-1", description: "One", starsCount: 101, isArchived: false },
        ],
        missingNodeIds: ["R_2", "R_3"],
        rateLimit: RATE_LIMIT,
      },
    });
  });

  it("treats a node that isn't a repository as missing", async () => {
    const { client } = fakeGitHub(() => Response.json({ data: { rateLimit: RATE_LIMIT, nodes: [{}] } }));

    const page = await fetchRepositoryPage(client, ["U_user"]);

    expect(page.ok && page.value.missingNodeIds).toEqual(["U_user"]);
  });

  it("authenticates and sends a generic User-Agent", async () => {
    const { client, calls } = fakeGitHub(nodesFrom([fakeRepo(1)]));

    await fetchRepositoryPage(client, ["R_1"]);

    expect(calls[0]?.headers.get("authorization")).toBe("bearer ghp_test");
    expect(calls[0]?.headers.get("user-agent")).toBe("gh-telegram-stars-bot");
  });

  it.each([
    [401, {}, { kind: "unauthorized" }],
    [403, { "x-ratelimit-reset": "1793336400" }, { kind: "rate-limited", resetAt: new Date(1793336400 * 1000).toISOString() }],
    [429, {}, { kind: "rate-limited", resetAt: null }],
    [502, {}, { kind: "http", status: 502 }],
  ])("maps HTTP %i to a typed error", async (status, headers, expected) => {
    const { client } = fakeGitHub(() => new Response("nope", { status, headers }));

    expect(await fetchRepositoryPage(client, ["R_1"])).toEqual(err(expected));
  });

  it("maps a network failure, a non-JSON body and an unexpected shape", async () => {
    const network: GitHubClient = { token: "t", fetch: () => Promise.reject(new Error("connection reset")) };
    const html = fakeGitHub(() => new Response("<html>", { status: 200 }));
    const shape = fakeGitHub(() => Response.json({ data: { nodes: "nope" } }));

    expect(await fetchRepositoryPage(network, ["R_1"])).toEqual(err({ kind: "network", message: "connection reset" }));
    expect(await fetchRepositoryPage(html.client, ["R_1"])).toEqual(err({ kind: "bad-response" }));
    expect(await fetchRepositoryPage(shape.client, ["R_1"])).toEqual(err({ kind: "bad-response" }));
  });

  it("fails the request on GraphQL errors other than a missing node", async () => {
    const limited = fakeGitHub(() => Response.json({ data: null, errors: [{ type: "RATE_LIMITED", message: "slow down" }] }));
    const broken = fakeGitHub(() => Response.json({ data: null, errors: [{ message: "Something went wrong" }] }));

    expect(await fetchRepositoryPage(limited.client, ["R_1"])).toEqual(err({ kind: "rate-limited", resetAt: null }));
    expect(await fetchRepositoryPage(broken.client, ["R_1"])).toEqual(
      err({ kind: "graphql", message: "Something went wrong" }),
    );
  });

  it("refuses an empty page or more than 100 node IDs", async () => {
    const { client } = fakeGitHub(nodesFrom([]));

    await expect(fetchRepositoryPage(client, [])).rejects.toThrow();
    await expect(fetchRepositoryPage(client, Array.from({ length: 101 }, (_, i) => `R_${i}`))).rejects.toThrow();
  });
});

describe("checkStars", () => {
  const repos = (count: number) => Array.from({ length: count }, (_, i) => stored(i + 1));
  const github = (count: number) => Array.from({ length: count }, (_, i) => fakeRepo(i + 1));

  it("checks 200 repositories with 2 requests", async () => {
    const { client, calls } = fakeGitHub(nodesFrom(github(200)));

    const result = await checkStars(client, repos(200), { cursor: 0, maxRequests: 10 });

    expect(calls).toHaveLength(2);
    expect(result.requests).toBe(2);
    expect(result.snapshots).toHaveLength(200);
    expect(result.nextCursor).toBe(0);
    expect(result.error).toBeNull();
  });

  it("stops at the request budget and continues from the cursor next run", async () => {
    const { client } = fakeGitHub(nodesFrom(github(250)));

    const first = await checkStars(client, repos(250), { cursor: 0, maxRequests: 2 });
    const second = await checkStars(client, repos(250), { cursor: first.nextCursor, maxRequests: 2 });

    expect(first.snapshots.map((s) => s.id)).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    expect(first.nextCursor).toBe(200);
    // The second run starts with 201-250, then wraps around: 1-150.
    expect(second.snapshots.slice(0, 50).map((s) => s.id)).toEqual(Array.from({ length: 50 }, (_, i) => i + 201));
    expect(second.snapshots.slice(50, 200).map((s) => s.id)).toEqual(Array.from({ length: 150 }, (_, i) => i + 1));
    expect(second.nextCursor).toBe(150);
  });

  it("stops when the rate limit has no points left", async () => {
    const { client, calls } = fakeGitHub(nodesFrom(github(150), { ...RATE_LIMIT, remaining: 0 }));

    const result = await checkStars(client, repos(150), { cursor: 0, maxRequests: 10 });

    expect(calls).toHaveLength(1);
    expect(result.snapshots).toHaveLength(100);
    expect(result.nextCursor).toBe(100);
    expect(result.rateLimit?.remaining).toBe(0);
  });

  it("keeps the pages it fetched when a later request fails", async () => {
    const pages = nodesFrom(github(150));
    const { client } = fakeGitHub((variables, call) => (call === 1 ? pages(variables) : new Response("", { status: 502 })));

    const result = await checkStars(client, repos(150), { cursor: 0, maxRequests: 10 });

    expect(result.snapshots).toHaveLength(100);
    expect(result.error).toEqual({ kind: "http", status: 502 });
    expect(result.nextCursor).toBe(100);
  });

  it("reports deleted repositories as missing without failing the run", async () => {
    const { client } = fakeGitHub(nodesFrom([fakeRepo(1)]));

    const result = await checkStars(client, [stored(1), stored(2)], { cursor: 0, maxRequests: 10 });

    expect(result.snapshots.map((s) => s.id)).toEqual([1]);
    expect(result.missingNodeIds).toEqual(["R_2"]);
    expect(result.error).toBeNull();
  });

  it("makes no request when there's nothing to check", async () => {
    const { client, calls } = fakeGitHub(nodesFrom([]));

    const result = await checkStars(client, [], { cursor: 0, maxRequests: 10 });

    expect(calls).toEqual([]);
    expect(result.snapshots).toEqual([]);
  });
});

describe("rotate", () => {
  it("starts after the cursor and wraps around", () => {
    const ids = (cursor: number) => rotate([stored(5), stored(1), stored(3)], cursor).map((r) => r.id);

    expect(ids(0)).toEqual([1, 3, 5]);
    expect(ids(1)).toEqual([3, 5, 1]);
    expect(ids(3)).toEqual([5, 1, 3]);
    expect(ids(5)).toEqual([1, 3, 5]);
    expect(ids(99)).toEqual([1, 3, 5]);
  });
});

describe("starCheckUpdates", () => {
  it("returns only repositories whose stars, name or archived flag changed", () => {
    const snapshot = (id: number, overrides = {}) => ({
      id,
      nodeId: `R_${id}`,
      fullName: `owner/repo-${id}`,
      description: null,
      starsCount: 100 + id,
      isArchived: false,
      ...overrides,
    });

    const updates = starCheckUpdates(
      [stored(1), stored(2), stored(3), stored(4)],
      [
        snapshot(1),
        snapshot(2, { starsCount: 150 }),
        snapshot(3, { fullName: "new-owner/renamed" }),
        snapshot(4, { isArchived: true }),
        snapshot(9, { starsCount: 999 }),
      ],
    );

    expect(updates).toEqual([
      { id: 2, fullName: "owner/repo-2", starsCount: 150, isArchived: false },
      { id: 3, fullName: "new-owner/renamed", starsCount: 103, isArchived: false },
      { id: 4, fullName: "owner/repo-4", starsCount: 104, isArchived: true },
    ]);
  });
});

describe("getRepository", () => {
  it("returns a public repository", async () => {
    const { client, calls } = fakeGitHub(() =>
      Response.json({ data: { repository: fakeRepo(7, { nameWithOwner: "facebook/react", description: "UI" }) } }),
    );

    const result = await getRepository(client, "Facebook", "React");

    expect(result).toEqual({
      ok: true,
      value: { id: 7, nodeId: "R_7", fullName: "facebook/react", description: "UI", starsCount: 107, isArchived: false },
    });
    expect(calls[0]?.variables).toEqual({ owner: "Facebook", name: "React" });
  });

  it("treats missing and private repositories as not found", async () => {
    const missing = fakeGitHub(() =>
      Response.json({ data: { repository: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve" }] }),
    );
    const secret = fakeGitHub(() => Response.json({ data: { repository: fakeRepo(7, { isPrivate: true }) } }));

    expect(await getRepository(missing.client, "a", "b")).toEqual(err({ kind: "not-found" }));
    expect(await getRepository(secret.client, "a", "b")).toEqual(err({ kind: "not-found" }));
  });

  it("passes through request errors", async () => {
    const { client } = fakeGitHub(() => new Response("", { status: 401 }));

    expect(await getRepository(client, "a", "b")).toEqual(err({ kind: "unauthorized" }));
  });
});

describe("star check cursor", () => {
  it("starts at 0, and saves a new value", async () => {
    await setStarCheckCursor(env.DB, 0);
    expect(await getStarCheckCursor(env.DB)).toBe(0);

    await setStarCheckCursor(env.DB, 200);
    expect(await getStarCheckCursor(env.DB)).toBe(200);
  });

  it("writes nothing when the cursor is unchanged", async () => {
    await setStarCheckCursor(env.DB, 0);

    const result = await env.DB.prepare("UPDATE star_check_state SET cursor = ?1 WHERE id = 1 AND cursor <> ?1")
      .bind(0)
      .run();

    expect(result.meta.rows_written).toBe(0);
  });
});
