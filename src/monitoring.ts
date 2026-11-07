// Star check monitoring: the run log, freshness for /health/star-check, and
// the admin alert.
import { Api } from "grammy";
import type { AppConfig } from "./config";
import { errorMessage } from "./errors";
import { html } from "./messages";
import { assertNever } from "./result";
import { send } from "./telegram";

/** Three missed 5-minute runs. */
export const STALE_AFTER_MS = 15 * 60 * 1000;
const RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const ALERT_INTERVAL_MS = 60 * 60 * 1000;
const TELEGRAM_TIMEOUT_SECONDS = 10;

export interface RunRecord {
  scheduledTime: number;
  /** A successful run: it counts toward /health/star-check freshness. */
  ok: boolean;
  details: object;
}

/**
 * Saves one run, and on the first run of the day deletes runs older than
 * 7 days, in one D1 call.
 */
export async function recordRun(db: D1Database, run: RunRecord, prune: { now: number } | null): Promise<void> {
  const insert = db
    .prepare("INSERT INTO star_check_runs (scheduled_at, ok, summary) VALUES (?, ?, ?)")
    .bind(new Date(run.scheduledTime).toISOString(), run.ok ? 1 : 0, JSON.stringify(run.details));
  const cleanup = prune
    ? [
        db
          .prepare("DELETE FROM star_check_runs WHERE scheduled_at < ?")
          .bind(new Date(prune.now - RUN_RETENTION_MS).toISOString()),
      ]
    : [];
  await db.batch([insert, ...cleanup]);
}

export type StarCheckHealth =
  | { status: "ok"; lastSuccessAt: string; lastRunOk: boolean }
  | { status: "stale"; lastSuccessAt: string; lastRunOk: boolean }
  | { status: "no-successful-run"; lastSuccessAt: null; lastRunOk: boolean | null };

/**
 * Whether star checks are running: the last successful run must be within
 * STALE_AFTER_MS. Both reads use the rowid or the partial index, no scan.
 */
export async function starCheckHealth(db: D1Database, now: number): Promise<StarCheckHealth> {
  const [lastRun, lastSuccess] = await db.batch<{ ok: number; scheduled_at: string }>([
    db.prepare("SELECT ok, scheduled_at FROM star_check_runs ORDER BY id DESC LIMIT 1"),
    db.prepare("SELECT ok, scheduled_at FROM star_check_runs WHERE ok = 1 ORDER BY id DESC LIMIT 1"),
  ]);
  const lastRunOk = lastRun?.results[0] ? lastRun.results[0].ok === 1 : null;
  const lastSuccessAt = lastSuccess?.results[0]?.scheduled_at;
  if (lastSuccessAt === undefined) {
    return { status: "no-successful-run", lastSuccessAt: null, lastRunOk };
  }
  const fresh = now - Date.parse(lastSuccessAt) <= STALE_AFTER_MS;
  return { status: fresh ? "ok" : "stale", lastSuccessAt, lastRunOk: lastRunOk ?? false };
}

/** HTTP status for /health/star-check. */
export function healthStatusCode(health: StarCheckHealth): number {
  switch (health.status) {
    case "ok":
      return 200;
    case "stale":
    case "no-successful-run":
      return 503;
    default:
      return assertNever(health);
  }
}

export type AlertOutcome = "sent" | "no-admin-chat" | "throttled" | "not-delivered";

type AlertSlot =
  | { kind: "claimed"; at: string }
  | { kind: "taken" }
  /** D1 couldn't be asked: send anyway (fail open). An outage is exactly when the alert matters. */
  | { kind: "unknown" };

/**
 * Takes the hourly alert slot atomically, so two failing runs can't both
 * alert.
 */
async function claimAlertSlot(db: D1Database, now: number): Promise<AlertSlot> {
  const at = new Date(now).toISOString();
  try {
    const result = await db
      .prepare(
        `UPDATE star_check_state SET last_alert_at = ?1
         WHERE id = 1 AND (last_alert_at IS NULL OR last_alert_at < ?2)`,
      )
      .bind(at, new Date(now - ALERT_INTERVAL_MS).toISOString())
      .run();
    return result.meta.changes === 1 ? { kind: "claimed", at } : { kind: "taken" };
  } catch (error) {
    console.error(JSON.stringify({ message: "Alert throttle unavailable; alerting anyway", error: errorMessage(error) }));
    return { kind: "unknown" };
  }
}

/** Gives the slot back after a failed send, so the next failing run can alert. */
async function releaseAlertSlot(db: D1Database, slot: AlertSlot): Promise<void> {
  switch (slot.kind) {
    case "claimed":
      await db
        .prepare("UPDATE star_check_state SET last_alert_at = NULL WHERE id = 1 AND last_alert_at = ?")
        .bind(slot.at)
        .run();
      return;
    case "taken":
    case "unknown":
      return;
    default:
      assertNever(slot);
  }
}

async function sendAlert(config: AppConfig, deps: { telegramFetch?: typeof fetch }, chatId: number, text: string) {
  const api = new Api(config.telegramBotToken, {
    timeoutSeconds: TELEGRAM_TIMEOUT_SECONDS,
    ...(deps.telegramFetch ? { fetch: deps.telegramFetch } : {}),
  });
  return send(() => api.sendMessage(chatId, text, { parse_mode: "HTML" }));
}

/** Messages ADMIN_CHAT_ID, at most once an hour. */
export async function alertAdmin(
  config: AppConfig,
  deps: { db: D1Database; telegramFetch?: typeof fetch },
  reason: string,
  now: number,
): Promise<AlertOutcome> {
  const adminChatId = config.adminChatId;
  if (adminChatId === null) {
    return "no-admin-chat";
  }
  const slot = await claimAlertSlot(deps.db, now);
  switch (slot.kind) {
    case "taken":
      return "throttled";
    case "claimed":
    case "unknown":
      break;
    default:
      return assertNever(slot);
  }
  const text = `⚠️ <b>Star check problem</b>\n\n${html(reason)}\n\nFurther alerts in the next hour are held back.`;
  const sent = await sendAlert(config, deps, adminChatId, text);
  if (!sent.ok) {
    console.error(JSON.stringify({ message: "Admin alert not delivered", error: sent.error }));
    await releaseAlertSlot(deps.db, slot);
    return "not-delivered";
  }
  return "sent";
}
