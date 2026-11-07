// Points a Telegram bot at a deployed Worker and registers its command menu.
//
//   TELEGRAM_BOT_TOKEN=... WEBHOOK_SECRET=... WORKER_URL=https://<worker-host> \
//     bun run telegram:setup
//
// Use the same TELEGRAM_BOT_TOKEN and WEBHOOK_SECRET as the Worker's secrets.
// Pending updates are kept (not dropped), so messages sent while switching
// are delivered to the Worker. Prints the BOT_INFO value for the Worker.
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
  const data = (await response.json()) as ApiResponse;
  if (!data.ok) {
    throw new Error(`${method} failed: ${data.description ?? response.status}`);
  }
  return data.result;
}

async function main(): Promise<void> {
  const token = required("TELEGRAM_BOT_TOKEN");
  const secret = required("WEBHOOK_SECRET");
  const workerUrl = new URL(required("WORKER_URL"));
  if (workerUrl.protocol !== "https:") {
    throw new Error("WORKER_URL must be https");
  }
  const webhookUrl = new URL("/webhook", workerUrl).toString();

  await callApi(token, "setWebhook", {
    url: webhookUrl,
    secret_token: secret,
    allowed_updates: ["message"],
    drop_pending_updates: false,
  });
  await callApi(token, "setMyCommands", { commands: COMMANDS });

  const info = (await callApi(token, "getWebhookInfo")) as {
    url: string;
    pending_update_count: number;
    last_error_message?: string;
  };
  const me = await callApi(token, "getMe");

  console.log(`Webhook:          ${info.url}`);
  console.log(`Pending updates:  ${info.pending_update_count}`);
  console.log(`Last error:       ${info.last_error_message ?? "none"}`);
  console.log(`Commands:         ${COMMANDS.map((c) => `/${c.command}`).join(" ")}`);
  console.log(`\nBOT_INFO for the Worker (wrangler secret put BOT_INFO):\n${JSON.stringify(me)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
