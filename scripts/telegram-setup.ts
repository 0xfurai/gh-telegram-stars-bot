// Points a Telegram bot at a deployed Worker and registers its command menu.
//
//   TELEGRAM_BOT_TOKEN=... WEBHOOK_SECRET=... WORKER_URL=https://<worker-host> \
//     bun run telegram:setup
//
// Use the same TELEGRAM_BOT_TOKEN and WEBHOOK_SECRET as the Worker's secrets.
//
// Order matters, so a failed step never leaves Telegram pointing at a broken
// Worker:
//   1. getMe: checks the token and prints BOT_INFO for the Worker.
//   2. GET <WORKER_URL>/health must answer 200. A 503 means the Worker's
//      settings are incomplete (often BOT_INFO not stored yet): store them
//      and run this again.
//   3. setWebhook (pending updates are kept, so messages sent while
//      switching reach the Worker), then setMyCommands.
//
// Runs on Node 24 (type stripping); never prints the token.
import { COMMANDS } from "../src/command-list.ts";

interface ApiResponse {
  ok: boolean;
  description?: string;
  result?: unknown;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Set ${name}`);
  }
  return value;
}

async function callApi(token: string, method: string, body: object = {}): Promise<unknown> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: ApiResponse;
  try {
    data = (await response.json()) as ApiResponse;
  } catch {
    throw new Error(`${method} failed: HTTP ${response.status}, response isn't JSON`);
  }
  if (!data.ok) {
    throw new Error(`${method} failed: HTTP ${response.status}, ${data.description ?? "no description"}`);
  }
  return data.result;
}

async function checkWorkerHealth(workerUrl: URL): Promise<void> {
  const healthUrl = new URL("/health", workerUrl);
  const response = await fetch(healthUrl);
  if (response.status === 503) {
    throw new Error(
      `${healthUrl.toString()} answered 503: the Worker's settings are incomplete or invalid. ` +
        "Check its logs, store the missing secrets (BOT_INFO is printed above), then run this again.",
    );
  }
  if (response.status !== 200) {
    throw new Error(`${healthUrl.toString()} answered ${response.status}, expected 200`);
  }
}

async function main(): Promise<void> {
  const token = required("TELEGRAM_BOT_TOKEN");
  const secret = required("WEBHOOK_SECRET");
  const workerUrl = new URL(required("WORKER_URL"));
  if (workerUrl.protocol !== "https:") {
    throw new Error("WORKER_URL must be https");
  }

  const me = await callApi(token, "getMe");
  console.log(`BOT_INFO for the Worker (wrangler secret put BOT_INFO):\n${JSON.stringify(me)}\n`);

  await checkWorkerHealth(workerUrl);

  await callApi(token, "setWebhook", {
    url: new URL("/webhook", workerUrl).toString(),
    secret_token: secret,
    // my_chat_member: the bot is blocked or unblocked, or added to or removed from a group.
    allowed_updates: ["message", "my_chat_member"],
    drop_pending_updates: false,
  });
  await callApi(token, "setMyCommands", { commands: COMMANDS });

  const info = (await callApi(token, "getWebhookInfo")) as {
    url: string;
    pending_update_count: number;
    last_error_message?: string;
  };
  console.log(`Webhook:          ${info.url}`);
  console.log(`Pending updates:  ${info.pending_update_count}`);
  console.log(`Last error:       ${info.last_error_message ?? "none"}`);
  console.log(`Commands:         ${COMMANDS.map((c) => `/${c.command}`).join(" ")}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
