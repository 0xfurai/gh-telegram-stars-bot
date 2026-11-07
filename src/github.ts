// GitHub GraphQL client for the star check and /add.
//
// The star check asks for up to 100 repositories per request by node ID, so
// 200 repositories cost 2 requests (and 2 rate-limit points). Expected
// failures are Results with a tagged error; callers switch over `kind`.
import * as z from "zod/mini";
import type { RepositoryInfo, RepositoryToCheck, StarCheckUpdate } from "./db";
import { assertNever, err, ok, type Result } from "./result";

const GRAPHQL_URL = "https://api.github.com/graphql";
// GitHub requires a User-Agent. A generic name, no personal contact details.
const USER_AGENT = "gh-telegram-stars-bot";
export const MAX_NODES_PER_REQUEST = 100;
// A hung request must not use up the whole scheduled run.
const REQUEST_TIMEOUT_MS = 10_000;

export interface GitHubClient {
  token: string;
  /** Replaces fetch (tests). */
  fetch?: typeof fetch;
}

export type GitHubError =
  /** Primary or secondary rate limit; `resetAt` is when to try again, if GitHub said. */
  | { kind: "rate-limited"; resetAt: string | null }
  /** 401: the token is wrong or expired. */
  | { kind: "unauthorized" }
  /** 403 that isn't a rate limit: the token lacks access, or an SSO or abuse block. */
  | { kind: "forbidden" }
  | { kind: "http"; status: number }
  | { kind: "graphql"; message: string }
  | { kind: "network"; message: string }
  | { kind: "timeout" }
  /** The response wasn't what the API documents. */
  | { kind: "bad-response" };

export interface RateLimit {
  remaining: number;
  resetAt: string;
  cost: number;
}

/** A repository as GitHub returns it. */
export type RepositorySnapshot = RepositoryInfo;

export interface RepositoryPage {
  repositories: RepositorySnapshot[];
  /** Deleted, private, inaccessible (e.g. org IP allow list) or not a repository. */
  missingNodeIds: string[];
  /** Repositories GitHub returned in a shape we don't understand. */
  invalidNodeIds: string[];
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

const rateLimitSchema = z.object({ remaining: z.number(), resetAt: z.string(), cost: z.number() });

const graphqlErrorSchema = z.object({
  type: z.optional(z.string()),
  message: z.string(),
  path: z.optional(z.array(z.union([z.string(), z.number()]))),
});

type GraphqlError = z.output<typeof graphqlErrorSchema>;

const nodesResponseSchema = z.object({
  data: z.nullable(z.optional(z.object({ rateLimit: rateLimitSchema, nodes: z.array(z.unknown()) }))),
  errors: z.optional(z.array(graphqlErrorSchema)),
});

const repositoryResponseSchema = z.object({
  data: z.nullable(z.optional(z.object({ repository: z.nullable(z.unknown()) }))),
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

interface GraphqlReply {
  body: unknown;
  headers: Headers;
}

/** When to retry, from x-ratelimit-reset (epoch seconds) or Retry-After (seconds). */
function retryTime(headers: Headers): string | null {
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    return new Date(reset * 1000).toISOString();
  }
  const retryAfter = Number(headers.get("retry-after"));
  return Number.isFinite(retryAfter) && retryAfter > 0 ? new Date(Date.now() + retryAfter * 1000).toISOString() : null;
}

function isRateLimited(headers: Headers): boolean {
  return headers.get("x-ratelimit-remaining") === "0" || headers.has("retry-after");
}

function httpError(response: Response): GitHubError {
  switch (response.status) {
    case 401:
      return { kind: "unauthorized" };
    case 403:
      // GitHub also uses 403 for rate limits; its headers tell them apart.
      return isRateLimited(response.headers)
        ? { kind: "rate-limited", resetAt: retryTime(response.headers) }
        : { kind: "forbidden" };
    case 429:
      return { kind: "rate-limited", resetAt: retryTime(response.headers) };
    default:
      return { kind: "http", status: response.status };
  }
}

function fetchFailure(error: unknown): GitHubError {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return { kind: "timeout" };
  }
  return { kind: "network", message: error instanceof Error ? error.message : String(error) };
}

async function postGraphql(
  client: GitHubClient,
  query: string,
  variables: Record<string, unknown>,
): Promise<Result<GraphqlReply, GitHubError>> {
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
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return err(fetchFailure(error));
  }

  if (!response.ok) {
    return err(httpError(response));
  }
  try {
    return ok({ body: await response.json(), headers: response.headers });
  } catch {
    return err({ kind: "bad-response" });
  }
}

/** Index of the node an error is about, if it's about one node (path ["nodes", i]). */
function nodeIndex(error: GraphqlError): number | null {
  const [field, index] = error.path ?? [];
  return field === "nodes" && typeof index === "number" ? index : null;
}

/**
 * An error about one node only affects that node. Any other error fails the
 * whole request.
 */
function requestError(errors: readonly GraphqlError[] | undefined, headers: Headers): GitHubError | null {
  const fatal = (errors ?? []).find((error) => error.type !== "NOT_FOUND" && nodeIndex(error) === null);
  if (!fatal) {
    return null;
  }
  return fatal.type === "RATE_LIMITED"
    ? { kind: "rate-limited", resetAt: retryTime(headers) }
    : { kind: "graphql", message: fatal.message };
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

type NodeOutcome =
  | { kind: "repository"; repository: RepositorySnapshot }
  | { kind: "missing" }
  | { kind: "invalid" };

/**
 * null: deleted or inaccessible. An object without repository fields: not a
 * repository (the fragment didn't match). Private repositories count as
 * missing: the bot never reports on them, even if the token can see them.
 */
function classifyNode(node: unknown): NodeOutcome {
  if (node === null || typeof node !== "object" || Object.keys(node).length === 0) {
    return { kind: "missing" };
  }
  const parsed = z.safeParse(repositorySchema, node);
  if (!parsed.success) {
    return { kind: "invalid" };
  }
  return parsed.data.isPrivate ? { kind: "missing" } : { kind: "repository", repository: toSnapshot(parsed.data) };
}

function pageFromNodes(nodeIds: readonly string[], nodes: readonly unknown[], rateLimit: RateLimit): RepositoryPage {
  const page: RepositoryPage = { repositories: [], missingNodeIds: [], invalidNodeIds: [], rateLimit };
  nodes.forEach((node, index) => {
    const nodeId = nodeIds[index] ?? "";
    const outcome = classifyNode(node);
    switch (outcome.kind) {
      case "repository":
        page.repositories.push(outcome.repository);
        break;
      case "missing":
        page.missingNodeIds.push(nodeId);
        break;
      case "invalid":
        page.invalidNodeIds.push(nodeId);
        break;
      default:
        assertNever(outcome);
    }
  });
  return page;
}

// --- Star check -----------------------------------------------------------------

/** Fetches up to 100 repositories by node ID in one request. */
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
  const parsed = z.safeParse(nodesResponseSchema, posted.value.body);
  if (!parsed.success) {
    return err({ kind: "bad-response" });
  }

  const { data, errors } = parsed.data;
  const fatal = requestError(errors, posted.value.headers);
  if (fatal) {
    return err(fatal);
  }
  // GitHub returns exactly one node (or null) per requested ID, in order.
  if (!data || data.nodes.length !== nodeIds.length) {
    return err({ kind: "bad-response" });
  }
  return ok(pageFromNodes(nodeIds, data.nodes, data.rateLimit));
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
  invalidNodeIds: string[];
  /** Where the next run should start: the last ID handled, or 0 after a full pass. */
  nextCursor: number;
  requests: number;
  rateLimit: RateLimit | null;
  /** Set when the run stopped early because of an error. */
  error: GitHubError | null;
}

/** Repositories starting after `cursor`, wrapping around, so every one gets its turn. */
export function rotate(repositories: readonly RepositoryToCheck[], cursor: number): RepositoryToCheck[] {
  // Sorted here too: the cursor logic depends on the order, and it's cheap.
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

/**
 * Whether a failed page should be tried again next run (temporary failure) or
 * skipped (it would fail the same way again and block every page after it).
 */
export function retryPage(error: GitHubError): boolean {
  switch (error.kind) {
    case "rate-limited":
    case "unauthorized":
    case "forbidden":
    case "network":
    case "timeout":
      return true;
    case "http":
      return error.status >= 500;
    case "graphql":
    case "bad-response":
      return false;
    default:
      return assertNever(error);
  }
}

function budgetSpent(result: StarCheckResult, maxRequests: number): boolean {
  return result.requests >= maxRequests || result.rateLimit?.remaining === 0;
}

function addPage(result: StarCheckResult, page: RepositoryPage): void {
  result.snapshots.push(...page.repositories);
  result.missingNodeIds.push(...page.missingNodeIds);
  result.invalidNodeIds.push(...page.invalidNodeIds);
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
    invalidNodeIds: [],
    nextCursor: 0,
    requests: 0,
    rateLimit: null,
    error: null,
  };
  let lastHandled = options.cursor;

  for (const page of chunk(rotate(repositories, options.cursor), MAX_NODES_PER_REQUEST)) {
    if (budgetSpent(result, options.maxRequests)) {
      return { ...result, nextCursor: lastHandled };
    }
    const fetched = await fetchRepositoryPage(client, page.map((repo) => repo.nodeId));
    result.requests += 1;
    const pageEnd = page.at(-1)?.id ?? lastHandled;
    if (!fetched.ok) {
      return { ...result, error: fetched.error, nextCursor: retryPage(fetched.error) ? lastHandled : pageEnd };
    }
    addPage(result, fetched.value);
    lastHandled = pageEnd;
  }
  // A full pass: the next run starts from the beginning.
  return result;
}

/**
 * The repositories whose stored data differs from what GitHub returned:
 * stars, name (renamed or transferred), description or archived flag.
 * Unchanged repositories cost no writes.
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
        before.description !== snapshot.description ||
        before.isArchived !== snapshot.isArchived);
    return changed
      ? [
          {
            id: snapshot.id,
            fullName: snapshot.fullName,
            description: snapshot.description,
            starsCount: snapshot.starsCount,
            isArchived: snapshot.isArchived,
          },
        ]
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
  const parsed = z.safeParse(repositoryResponseSchema, posted.value.body);
  if (!parsed.success) {
    return err({ kind: "bad-response" });
  }

  // A missing repository comes back as NOT_FOUND with path ["repository"].
  const fatal = requestError(parsed.data.errors, posted.value.headers);
  if (fatal) {
    return err(fatal);
  }
  const outcome = classifyNode(parsed.data.data?.repository ?? null);
  switch (outcome.kind) {
    case "repository":
      return ok(outcome.repository);
    case "missing":
      return err({ kind: "not-found" });
    case "invalid":
      return err({ kind: "bad-response" });
    default:
      return assertNever(outcome);
  }
}
