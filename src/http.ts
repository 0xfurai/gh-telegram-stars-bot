import { webhookCallback } from "grammy";
import { createBot, type BotDeps } from "./bot";
import type { AppConfig } from "./config";
import { healthStatusCode, starCheckHealth } from "./monitoring";
import { errorMessage } from "./errors";

export interface RequestContext extends BotDeps {
  config: AppConfig;
}

type Handler = (request: Request, context: RequestContext) => Response | Promise<Response>;
type Methods = Partial<Record<string, Handler>>;

type WebhookHandler = (request: Request) => Promise<Response>;

// Answer Telegram before its own timeout. If an update takes longer, grammY
// answers 200 and the update isn't redelivered: an update cut short is better
// than one handled twice.
const WEBHOOK_TIMEOUT_MS = 20_000;

// One bot per isolate: settings and bindings don't change while it lives.
// The cache remembers which deps built each bot and rebuilds when any of them
// differs, so a reused bot never runs with another request's database, fetch
// or handlers. Tests go through this same path.
interface CachedWebhook {
  deps: readonly unknown[];
  handler: WebhookHandler;
}
const webhooks = new WeakMap<AppConfig, CachedWebhook>();

function depsOf(context: RequestContext): readonly unknown[] {
  return [context.db, context.telegramFetch, context.githubFetch, context.commandHandlers, context.now];
}

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((dep, index) => dep === b[index]);
}

function buildWebhook(context: RequestContext): WebhookHandler {
  return webhookCallback(createBot(context.config, context), "cloudflare-mod", {
    // Requests without Telegram's X-Telegram-Bot-Api-Secret-Token get 401.
    secretToken: context.config.webhookSecret,
    onTimeout: "return",
    timeoutMilliseconds: WEBHOOK_TIMEOUT_MS,
  });
}

export function webhookFor(context: RequestContext): WebhookHandler {
  const deps = depsOf(context);
  const cached = webhooks.get(context.config);
  if (cached && sameDeps(cached.deps, deps)) {
    return cached.handler;
  }
  const handler = buildWebhook(context);
  webhooks.set(context.config, { deps, handler });
  return handler;
}

/**
 * Handler errors are already caught by the bot's error boundary. This catches
 * what happens outside it (a body that isn't JSON) and still answers 200, so
 * Telegram doesn't redeliver a request that will never work.
 */
async function handleWebhook(request: Request, context: RequestContext): Promise<Response> {
  try {
    return await webhookFor(context)(request);
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "Webhook request failed",
        error: errorMessage(error),
      }),
    );
    return Response.json({ ok: false });
  }
}

/**
 * For an uptime monitor: 503 when the last successful star check is more
 * than 15 minutes old. Reads D1 only; never calls GitHub or Telegram.
 */
async function handleStarCheckHealth(_request: Request, context: RequestContext): Promise<Response> {
  const now = context.now?.().getTime() ?? Date.now();
  const health = await starCheckHealth(context.db, now);
  return Response.json(health, { status: healthStatusCode(health) });
}

const ROUTES: Partial<Record<string, Methods>> = {
  // Liveness: the Worker runs and its settings are valid (telegram:setup checks this).
  "/health": { GET: () => Response.json({ status: "ok" }) },
  "/health/star-check": { GET: handleStarCheckHealth },
  "/webhook": { POST: handleWebhook },
};

function allowHeader(methods: Methods): string {
  const names = Object.keys(methods);
  return (names.includes("GET") ? [...names, "HEAD"] : names).join(", ");
}

/** Every request gets this while the Worker's settings are invalid. */
export function misconfigured(): Response {
  return Response.json({ error: "Service misconfigured" }, { status: 503 });
}

export async function handleFetch(request: Request, context: RequestContext): Promise<Response> {
  const methods = ROUTES[new URL(request.url).pathname];
  if (!methods) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const isHead = request.method === "HEAD";
  const handler = methods[isHead ? "GET" : request.method];
  if (!handler) {
    return Response.json(
      { error: "Method not allowed" },
      { status: 405, headers: { Allow: allowHeader(methods) } },
    );
  }

  const response = await handler(request, context);
  return isHead ? new Response(null, { status: response.status, headers: response.headers }) : response;
}
