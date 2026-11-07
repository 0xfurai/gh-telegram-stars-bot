// Star check monitoring: the run log, freshness for /health/star-check, and
// the admin alert on failed runs.
import { Api } from "grammy";
import type { AppConfig } from "./config";
import { html } from "./messages";
import { assertNever, type Result } from "./result";
import { send } from "./telegram";

/** Three missed 5-minute runs. */
export const STALE_AFTER_MS = 15 * 60 * 1000;
const RUN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const ALERT_INTERVAL_MS = 60 * 60 * 1000;

export interface RunFailure {
  reason: string;
  /** The run summary, if the run got far enough to produce one. */
  summary: object | null;
}

/** A finished run: its summary, or why it failed. */
export type RunOutcome = Result<object, RunFailure>;

/** Saves one run. One written row. */
export async function recordRun(db: D1Database, scheduledTime: number, outcome: RunOutcome): Promise<void> {
  const details = outcome.ok ? outcome.value : outcome.error;
  await db
    .prepare("INSERT INTO star_check_runs (scheduled_at, ok, summary) VALUES (?, ?, ?)")
    .bind(new Date(scheduledTime).toISOString(), outcome.ok ? 1 : 0, JSON.stringify(details))
    .run();
}

/** Deletes runs older than 7 days. Returns rows deleted. */
export async function pruneRuns(db: D1Database, now: number): Promise<number> {
  const result = await db
    .prepare("DELETE FROM star_check_runs WHERE scheduled_at < ?")
    .bind(new Date(now - RUN_RETENTION_MS).toISOString())
    .run();
  return result.meta.changes;
}

export type StarCheckHealth =
  | { status: "ok"; lastSuccessAt: string; lastRunOk: boolean }
  | { status: "stale"; lastSuccessAt: string; lastRunOk: boolean }
  | { status: "no-successful-run"; lastSuccessAt: null; lastRunOk: boolean | null };

/**
 * Whether star checks are running: the last successful run must be within
 * STALE_AFTER_MS. Reads the newest rows by rowid, no scan.
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

/**
 * Takes the hourly alert slot atomically: true if no alert went out in the
 * last hour, and records this one. Two failing runs can't both alert.
 */
async function claimAlertSlot(db: D1Database, now: number): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE star_check_state SET last_alert_at = ?1
       WHERE id = 1 AND (last_alert_at IS NULL OR last_alert_at < ?2)`,
    )
    .bind(new Date(now).toISOString(), new Date(now - ALERT_INTERVAL_MS).toISOString())
    .run();
  return result.meta.changes === 1;
}

/** Messages ADMIN_CHAT_ID about a failed run, at most once an hour. */
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
  if (!(await claimAlertSlot(deps.db, now))) {
    return "throttled";
  }
  const api = new Api(config.telegramBotToken, deps.telegramFetch ? { fetch: deps.telegramFetch } : {});
  const sent = await send(() =>
    api.sendMessage(
      adminChatId,
      `⚠️ <b>Star check failed</b>\n\n${html(reason)}\n\nFurther failures in the next hour won't be reported.`,
      { parse_mode: "HTML" },
    ),
  );
  if (!sent.ok) {
    console.error(JSON.stringify({ message: "Admin alert not delivered", error: sent.error }));
    return "not-delivered";
  }
  return "sent";
}
