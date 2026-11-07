// GitHub GraphQL client for the star check and /add.
//
// The star check asks for up to 100 repositories per request by node ID, so
// 200 repositories cost 2 requests (and 2 rate-limit points). Expected
// failures are Results with a tagged error; callers switch over `kind`.
import * as z from "zod/mini";
import type { RepositoryInfo, RepositoryToCheck, StarCheckUpdate } from "./db";
import { err, ok, type Result } from "./result";

const GRAPHQL_URL = "https://api.github.com/graphql";
// GitHub requires a User-Agent. A generic name, no personal contact details.
const USER_AGENT = "gh-telegram-stars-bot";
export const MAX_NODES_PER_REQUEST = 100;

export interface GitHubClient {
  token: string;
  /** Replaces fetch (tests). */
  fetch?: typeof fetch;
}

export type GitHubError =
  | { kind: "rate-limited"; resetAt: string | null }
  | { kind: "unauthorized" }
  | { kind: "http"; status: number }
  | { kind: "graphql"; message: string }
  | { kind: "network"; message: string }
  | { kind: "bad-response" };

export interface RateLimit {
  remaining: number;
  resetAt: string;
  cost: number;
}

/** A repository as GitHub returns it. */
export interface RepositorySnapshot {
  id: number;
  nodeId: string;
  fullName: string;
  description: string | null;
  starsCount: number;
  isArchived: boolean;
}

export interface RepositoryPage {
  repositories: RepositorySnapshot[];
  /** Node IDs GitHub didn't return: deleted, private, or not a repository. */
  missingNodeIds: string[];
  rateLimit: RateLimit;
}

// --- Response validation ----------------------------------------------------

const repositorySchema = z.object({
  id: z.string(),
  databaseId: z.number().check(z.int()),
  nameWithOwner: z.string(),
  description: z.nullable(z.string()),
  stargazerCount: z.number().check(z.int(), z.nonnegative()),
  isArchived: z.boolean(),
  isPrivate: z.boolean(),
});

const rateLimitSchema = z.object({
  remaining: z.number(),
  resetAt: z.string(),
  cost: z.number(),
});

const graphqlErrorSchema = z.object({
  type: z.optional(z.string()),
  message: z.string(),
});

const nodesResponseSchema = z.object({
  data: z.nullable(
    z.optional(
      z.object({
        rateLimit: rateLimitSchema,
        // Nodes that aren't repositories come back as {} (the fragment doesn't match).
        nodes: z.array(z.nullable(z.union([repositorySchema, z.object({})]))),
      }),
    ),
  ),
  errors: z.optional(z.array(graphqlErrorSchema)),
});

const repositoryResponseSchema = z.object({
  data: z.nullable(z.optional(z.object({ repository: z.nullable(repositorySchema) }))),
  errors: z.optional(z.array(graphqlErrorSchema)),
});

type RepositoryNode = z.output<typeof repositorySchema>;

// --- Transport ----------------------------------------------------------------

const REPOSITORY_FIELDS = "id databaseId nameWithOwner description stargazerCount isArchived isPrivate";

const NODES_QUERY = `query StarCheck($ids: [ID!]!) {
  rateLimit { remaining resetAt cost }
  nodes(ids: $ids) { ... on Repository { ${REPOSITORY_FIELDS} } }
}`;

const REPOSITORY_QUERY = `query Repository($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { ${REPOSITORY_FIELDS} }
}`;

function rateLimitReset(response: Response): string | null {
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  return Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null;
}

function httpError(response: Response): GitHubError {
  if (response.status === 401) {
    return { kind: "unauthorized" };
  }
  // GitHub answers 403 or 429 when the primary or secondary rate limit is hit.
  if (response.status === 403 || response.status === 429) {
    return { kind: "rate-limited", resetAt: rateLimitReset(response) };
  }
  return { kind: "http", status: response.status };
}

async function postGraphql(
  client: GitHubClient,
  query: string,
  variables: Record<string, unknown>,
): Promise<Result<unknown, GitHubError>> {
  const fetchImpl = client.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(GRAPHQL_URL, {
      method: "POST",
      headers: {
        authorization: `bearer ${client.token}`,
        "content-type": "application/json",
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (error) {
    return err({ kind: "network", message: error instanceof Error ? error.message : String(error) });
  }

  if (!response.ok) {
    return err(httpError(response));
  }
  try {
    return ok(await response.json());
  } catch {
    return err({ kind: "bad-response" });
  }
}

/** A GraphQL error that isn't about one missing node fails the whole request. */
function requestError(errors: readonly { type?: string; message: string }[] | undefined): GitHubError | null {
  const fatal = (errors ?? []).find((error) => error.type !== "NOT_FOUND");
  if (!fatal) {
    return null;
  }
  return fatal.type === "RATE_LIMITED"
    ? { kind: "rate-limited", resetAt: null }
    : { kind: "graphql", message: fatal.message };
}

function isRepository(node: unknown): node is RepositoryNode {
  return node !== null && typeof node === "object" && "databaseId" in node;
}

function toSnapshot(node: RepositoryNode): RepositorySnapshot {
  return {
    id: node.databaseId,
    nodeId: node.id,
    fullName: node.nameWithOwner,
    description: node.description,
    starsCount: node.stargazerCount,
    isArchived: node.isArchived,
  };
}

// --- Star check -----------------------------------------------------------------

/**
 * Fetches up to 100 repositories by node ID in one request. Repositories that
 * are deleted or private (the bot never reports on private repositories, even
 * if the token can see them) are listed in `missingNodeIds`.
 */
export async function fetchRepositoryPage(
  client: GitHubClient,
  nodeIds: readonly string[],
): Promise<Result<RepositoryPage, GitHubError>> {
  if (nodeIds.length === 0 || nodeIds.length > MAX_NODES_PER_REQUEST) {
    throw new Error(`fetchRepositoryPage takes 1-${MAX_NODES_PER_REQUEST} node IDs, got ${nodeIds.length}`);
  }

  const posted = await postGraphql(client, NODES_QUERY, { ids: nodeIds });
  if (!posted.ok) {
    return posted;
  }
  const parsed = z.safeParse(nodesResponseSchema, posted.value);
  if (!parsed.success) {
    return err({ kind: "bad-response" });
  }

  const { data, errors } = parsed.data;
  const fatal = requestError(errors);
  if (fatal || !data) {
    return err(fatal ?? { kind: "bad-response" });
  }

  const repositories: RepositorySnapshot[] = [];
  const missingNodeIds: string[] = [];
  data.nodes.forEach((node, index) => {
    if (isRepository(node) && !node.isPrivate) {
      repositories.push(toSnapshot(node));
    } else {
      missingNodeIds.push(nodeIds[index] ?? "");
    }
  });
  return ok({ repositories, missingNodeIds, rateLimit: data.rateLimit });
}

export interface StarCheckOptions {
  /** Repositories with an ID above this are checked first, then the rest. */
  cursor: number;
  /** Most GitHub requests this run may make (the Worker's subrequest budget). */
  maxRequests: number;
}

export interface StarCheckResult {
  snapshots: RepositorySnapshot[];
  missingNodeIds: string[];
  /** Where the next run should start: the last ID checked, or 0 after a full pass. */
  nextCursor: number;
  requests: number;
  rateLimit: RateLimit | null;
  /** Set when the run stopped early because of an error. */
  error: GitHubError | null;
}

/** Repositories starting after `cursor`, wrapping around, so every one gets its turn. */
export function rotate(repositories: readonly RepositoryToCheck[], cursor: number): RepositoryToCheck[] {
  const sorted = [...repositories].sort((a, b) => a.id - b.id);
  const start = sorted.findIndex((repo) => repo.id > cursor);
  return start <= 0 ? sorted : [...sorted.slice(start), ...sorted.slice(0, start)];
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function budgetSpent(result: StarCheckResult, maxRequests: number): boolean {
  return result.requests >= maxRequests || result.rateLimit?.remaining === 0;
}

function addPage(result: StarCheckResult, page: RepositoryPage): void {
  result.snapshots.push(...page.repositories);
  result.missingNodeIds.push(...page.missingNodeIds);
  result.rateLimit = page.rateLimit;
}

/**
 * Checks as many repositories as the budget allows, 100 per request. Stops
 * early on an error or when the rate limit has no points left, keeping what
 * it already fetched; the cursor makes the next run continue from there.
 */
export async function checkStars(
  client: GitHubClient,
  repositories: readonly RepositoryToCheck[],
  options: StarCheckOptions,
): Promise<StarCheckResult> {
  const result: StarCheckResult = {
    snapshots: [],
    missingNodeIds: [],
    nextCursor: 0,
    requests: 0,
    rateLimit: null,
    error: null,
  };
  let lastChecked = options.cursor;

  for (const page of chunk(rotate(repositories, options.cursor), MAX_NODES_PER_REQUEST)) {
    if (budgetSpent(result, options.maxRequests)) {
      return { ...result, nextCursor: lastChecked };
    }
    const fetched = await fetchRepositoryPage(client, page.map((repo) => repo.nodeId));
    result.requests += 1;
    if (!fetched.ok) {
      return { ...result, error: fetched.error, nextCursor: lastChecked };
    }
    addPage(result, fetched.value);
    lastChecked = page.at(-1)?.id ?? lastChecked;
  }
  // A full pass: the next run starts from the beginning.
  return result;
}

/**
 * The repositories whose stored data differs from what GitHub returned:
 * star count, name (renamed or transferred) or archived flag. Unchanged
 * repositories cost no writes.
 */
export function starCheckUpdates(
  stored: readonly RepositoryToCheck[],
  snapshots: readonly RepositorySnapshot[],
): StarCheckUpdate[] {
  const byId = new Map(stored.map((repo) => [repo.id, repo]));
  return snapshots.flatMap((snapshot) => {
    const before = byId.get(snapshot.id);
    const changed =
      before !== undefined &&
      (before.starsCount !== snapshot.starsCount ||
        before.fullName !== snapshot.fullName ||
        before.isArchived !== snapshot.isArchived);
    return changed
      ? [{ id: snapshot.id, fullName: snapshot.fullName, starsCount: snapshot.starsCount, isArchived: snapshot.isArchived }]
      : [];
  });
}

// --- /add -------------------------------------------------------------------------

export type RepositoryLookupError = GitHubError | { kind: "not-found" };

/**
 * Looks up one repository by owner and name, for /add. Private repositories
 * count as not found, even if the token can see them.
 */
export async function getRepository(
  client: GitHubClient,
  owner: string,
  name: string,
): Promise<Result<RepositoryInfo, RepositoryLookupError>> {
  const posted = await postGraphql(client, REPOSITORY_QUERY, { owner, name });
  if (!posted.ok) {
    return posted;
  }
  const parsed = z.safeParse(repositoryResponseSchema, posted.value);
  if (!parsed.success) {
    return err({ kind: "bad-response" });
  }

  const fatal = requestError(parsed.data.errors);
  if (fatal) {
    return err(fatal);
  }
  const node = parsed.data.data?.repository;
  return node && !node.isPrivate ? ok(toSnapshot(node)) : err({ kind: "not-found" });
}
