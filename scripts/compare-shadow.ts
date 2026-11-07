// Compares the shadow run with the old app, for the GSB-15 report.
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     bun run shadow:compare -- --env=production --since=YYYY-MM-DD [--until=YYYY-MM-DD]
//
// --since  the first UTC day of the shadow run. star_check_runs keeps 7 days,
//          so the window must start within the last 6.
// --until  the last day, included (default: today, so the window ends now).
//          Run it soon after the window: a subscription notified again later
//          can no longer be checked, and is counted apart.
// --env    required: the D1 database to compare (production for the shadow run).
//
// Cloudflare's analytics give D1's real rows written per day. The API token is
// CLOUDFLARE_API_TOKEN when set, otherwise wrangler's login.
//
// Prints a Markdown report: stars gained per repository in each app, the
// subscriptions the Worker didn't handle, runs against the schedule, and the
// largest use of the plan limits. Exits 1 when a criterion it can check
// fails; gain differences are listed for a human to explain. Read-only.
import { readFile } from "node:fs/promises";
import { dayOption, d1Target, requiredEnv, runCommand, runMain } from "./migration/cli.ts";
import { d1DatabaseId, d1RowsWrittenPerDay, readD1Queries, selectAll } from "./migration/io.ts";
import {
  compareShadowRun,
  failedCriteria,
  LIMIT_SHARE,
  PLAN_LIMITS,
  type ShadowInput,
  type ShadowReport,
  type ShadowWindow,
} from "./migration/shadow.ts";
import type { D1Target } from "./migration/target.ts";
import { addDays, utcDay } from "./migration/to-d1.ts";

const SHOWN = 30;
/** star_check_runs keeps 7 days; older runs are gone. */
const RUN_HISTORY_DAYS = 6;

function shadowWindow(): ShadowWindow {
  const now = Date.now();
  const today = utcDay(now);
  const since = dayOption("since", null);
  const until = dayOption("until", today);
  if (until < since || until > today) {
    throw new Error("--until must be between --since and today");
  }
  if (since < addDays(today, -RUN_HISTORY_DAYS)) {
    throw new Error(`--since must be within the last ${RUN_HISTORY_DAYS} days: older star check runs are deleted`);
  }
  const endOfUntil = Date.parse(`${addDays(until, 1)}T00:00:00.000Z`);
  return { since, until, end: new Date(Math.min(endOfUntil, now)).toISOString() };
}

async function readD1(target: D1Target, window: ShadowWindow) {
  const [workerGains, workerSubscriptions, runs] = await readD1Queries(runCommand, target, [
    `SELECT repository_id, stars_gained FROM daily_star_gains WHERE day BETWEEN '${window.since}' AND '${window.until}'`,
    "SELECT cr.chat_id, cr.repository_id, c.is_active, cr.created_at, cr.last_notified_at " +
      "FROM chat_repositories cr JOIN chats c ON c.id = cr.chat_id",
    `SELECT scheduled_at, ok, summary FROM star_check_runs WHERE scheduled_at >= '${window.since}T00:00:00.000Z' AND scheduled_at < '${window.end}'`,
  ]);
  return {
    workerGains: workerGains as ShadowInput["workerGains"],
    workerSubscriptions: workerSubscriptions as ShadowInput["workerSubscriptions"],
    runs: runs as ShadowInput["runs"],
  };
}

async function readSupabase(window: ShadowWindow) {
  const supabase = { url: requiredEnv("SUPABASE_URL"), serviceRoleKey: requiredEnv("SUPABASE_SERVICE_ROLE_KEY") };
  const [oldRepositories, oldStarEvents] = await Promise.all([
    selectAll<ShadowInput["oldRepositories"][number]>(supabase, "repositories", { columns: "id,github_id,full_name", order: "id" }),
    selectAll<ShadowInput["oldStarEvents"][number]>(supabase, "star_events", {
      columns: "repository_id,stars_count,previous_stars_count,created_at",
      order: "id",
      filter: `created_at=gte.${window.since}T00:00:00Z&created_at=lt.${window.end}`,
    }),
  ]);
  return { oldRepositories, oldStarEvents };
}

async function cloudflareToken(): Promise<string> {
  const fromEnv = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return (JSON.parse(await runCommand("bunx", ["wrangler", "auth", "token", "--json"])) as { token: string }).token;
}

async function accountId(): Promise<string> {
  const config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const match = /"account_id":\s*"([0-9a-f]{32})"/.exec(config);
  if (!match?.[1]) {
    throw new Error("No account_id in wrangler.jsonc");
  }
  return match[1];
}

async function readRowsWritten(target: D1Target, window: ShadowWindow) {
  const token = await cloudflareToken();
  const databaseId = await d1DatabaseId(runCommand, target);
  const rowsWrittenPerDay = await d1RowsWrittenPerDay({ token, accountId: await accountId() }, databaseId, window);
  return { rowsWrittenPerDay };
}

/** Up to SHOWN lines, then how many were left out. */
function shown(lines: readonly string[]): string[] {
  return [...lines.slice(0, SHOWN), ...(lines.length > SHOWN ? [`… and ${lines.length - SHOWN} more`] : [])];
}

function gainLines(report: ShadowReport): string[] {
  const differing = report.gains.filter((gain) => gain.difference !== 0);
  const total = (pick: "oldApp" | "worker") => report.gains.reduce((sum, gain) => sum + gain[pick], 0);
  return [
    "## Stars gained",
    "",
    `${report.gains.length} repositories gained stars: ${total("oldApp")} in the old app, ${total("worker")} in the Worker. ` +
      `${differing.length} differ.`,
    ...(differing.length > 0 ? ["", "| Repository | Old app | Worker | Difference |", "| -- | -- | -- | -- |"] : []),
    ...shown(differing.map((g) => `| ${g.fullName} | ${g.oldApp} | ${g.worker} | ${g.difference > 0 ? "+" : ""}${g.difference} |`)),
  ];
}

function notificationLines(report: ShadowReport): string[] {
  return [
    "## Notifications",
    "",
    `${report.missedNotifications.length} subscriptions weren't handled by the Worker after the old app's last gain for their repository.`,
    `Not counted: ${report.inactiveChats} in inactive chats (skipped on purpose), ` +
      `${report.notifiedAfterWindow} handled again after the window (can't be checked).`,
    ...shown(report.missedNotifications.map((m) => `* chat ${m.chatId}, repository #${m.githubId}`)),
  ];
}

function limitLines(report: ShadowReport): string[] {
  const { runs } = report;
  const failed = runs.failed.length > 0 ? `: ${shown(runs.failed).join(", ")}` : "";
  return [
    "## Runs and limits",
    "",
    `* ${runs.total} runs of ${runs.expected} scheduled, ${runs.failed.length} failed${failed}`,
    `* Most subrequests in a run: ${runs.maxSubrequests} (limit ${PLAN_LIMITS.subrequestsPerRun}, pass under ${PLAN_LIMITS.subrequestsPerRun * LIMIT_SHARE})`,
    `* Most D1 rows written in a day: ${report.maxRowsWrittenPerDay} (limit ${PLAN_LIMITS.rowsWrittenPerDay}, pass under ${PLAN_LIMITS.rowsWrittenPerDay * LIMIT_SHARE})`,
  ];
}

async function main(): Promise<void> {
  const target = d1Target();
  const window = shadowWindow();
  // One after the other: wrangler calls fail when they overlap.
  const d1 = await readD1(target, window);
  const rows = await readRowsWritten(target, window);
  const supabase = await readSupabase(window);
  const result = compareShadowRun({ window, ...supabase, ...d1, ...rows });
  console.log(
    [`# Shadow run ${window.since} to ${window.until}`, "", ...gainLines(result), "", ...notificationLines(result), "", ...limitLines(result)].join(
      "\n",
    ),
  );
  const failed = failedCriteria(result);
  if (failed.length > 0) {
    console.error(`\nFailed: ${failed.join("; ")}`);
    process.exitCode = 1;
  }
}

runMain(main);
