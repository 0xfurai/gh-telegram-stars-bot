import { webhookCallback } from "grammy";
import { createBot, type BotOptions } from "./bot";
import type { AppConfig } from "./config";

export interface RequestContext extends BotOptions {
  config: AppConfig;
}

type Handler = (request: Request, context: RequestContext) => Response | Promise<Response>;
type Methods = Partial<Record<string, Handler>>;

type WebhookHandler = (request: Request) => Promise<Response>;

// One bot per isolate: settings don't change while it lives.
const webhooks = new WeakMap<AppConfig, WebhookHandler>();

function buildWebhook(context: RequestContext): WebhookHandler {
  return webhookCallback(createBot(context.config, context), "cloudflare-mod", {
    // Requests without Telegram's X-Telegram-Bot-Api-Secret-Token get 401.
    secretToken: context.config.webhookSecret,
  });
}

function webhookFor(context: RequestContext): WebhookHandler {
  // A custom fetch (tests) gets its own bot instead of the cached one.
  if (context.telegramFetch) {
    return buildWebhook(context);
  }
  let handler = webhooks.get(context.config);
  if (!handler) {
    handler = buildWebhook(context);
    webhooks.set(context.config, handler);
  }
  return handler;
}

const ROUTES: Partial<Record<string, Methods>> = {
  "/health": { GET: () => Response.json({ status: "ok" }) },
  "/webhook": { POST: (request, context) => webhookFor(context)(request) },
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
