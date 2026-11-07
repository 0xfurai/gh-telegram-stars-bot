// Compares the shadow run with the old app, for the GSB-15 report.
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     bun run shadow:compare -- --env=production --since=YYYY-MM-DD [--until=YYYY-MM-DD]
//
// --since  the first whole UTC day of the shadow run.
// --until  the last day, included (default: yesterday, the last whole day).
// --env    required: the D1 database to compare (production for the shadow run).
//
// Prints a Markdown report: stars gained per repository in each app, the
// subscriptions the Worker never handled, failed runs, and the largest use of
// the plan limits. Exits 1 when a criterion it can check fails; gain
// differences are listed for a human to explain. Read-only.
import { d1Target, option, requiredEnv, runCommand, runMain } from "./migration/cli.ts";
import { selectAll } from "./migration/io.ts";
import {
  compareShadowRun,
  failedCriteria,
  LIMIT_SHARE,
  PLAN_LIMITS,
  type ShadowInput,
  type ShadowReport,
  type ShadowWindow,
} from "./migration/shadow.ts";
import { wranglerTargetArgs, type D1Target } from "./migration/target.ts";

const SHOWN = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function day(name: string, fallback: string | null): string {
  const value = option(name) ?? fallback;
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`Pass --${name} as YYYY-MM-DD`);
  }
  return value;
}

function nextDay(value: string): string {
  return new Date(Date.parse(value) + DAY_MS).toISOString().slice(0, 10);
}

function shadowWindow(): ShadowWindow {
  const yesterday = new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);
  const window = { since: day("since", null), until: day("until", yesterday) };
  if (window.until < window.since) {
    throw new Error("--until is before --since");
  }
  return window;
}

async function readD1(target: D1Target, window: ShadowWindow) {
  const end = `${nextDay(window.until)}T00:00:00.000Z`;
  const queries = [
    `SELECT repository_id, stars_gained FROM daily_star_gains WHERE day BETWEEN '${window.since}' AND '${window.until}'`,
    "SELECT cr.chat_id, cr.repository_id, c.is_active, cr.last_notified_at FROM chat_repositories cr JOIN chats c ON c.id = cr.chat_id",
    `SELECT scheduled_at, ok, summary FROM star_check_runs WHERE scheduled_at >= '${window.since}T00:00:00.000Z' AND scheduled_at < '${end}'`,
  ];
  const output = await runCommand("bunx", ["wrangler", "d1", "execute", "DB", ...wranglerTargetArgs(target), "--json", "--command", queries.join("; ")]);
  const [gains, subscriptions, runs] = (JSON.parse(output) as { results: unknown[] }[]).map((result) => result.results);
  if (!gains || !subscriptions || !runs) {
    throw new Error("Reading D1 returned fewer results than queries");
  }
  return {
    workerGains: gains as ShadowInput["workerGains"],
    workerSubscriptions: subscriptions as ShadowInput["workerSubscriptions"],
    runs: runs as ShadowInput["runs"],
  };
}

async function readSupabase(window: ShadowWindow) {
  const supabase = { url: requiredEnv("SUPABASE_URL"), serviceRoleKey: requiredEnv("SUPABASE_SERVICE_ROLE_KEY") };
  const [oldRepositories, oldStarEvents] = await Promise.all([
    selectAll<ShadowInput["oldRepositories"][number]>(supabase, "repositories", { columns: "id,github_id,full_name", order: "id" }),
    selectAll<ShadowInput["oldStarEvents"][number]>(supabase, "star_events", {
      columns: "repository_id,stars_count,previous_stars_count",
      order: "id",
      filter: `created_at=gte.${window.since}T00:00:00Z&created_at=lt.${nextDay(window.until)}T00:00:00Z`,
    }),
  ]);
  return { oldRepositories, oldStarEvents };
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
    ...differing.slice(0, SHOWN).map((g) => `| ${g.fullName} | ${g.oldApp} | ${g.worker} | ${g.difference > 0 ? "+" : ""}${g.difference} |`),
    ...(differing.length > SHOWN ? [`\n… and ${differing.length - SHOWN} more`] : []),
  ];
}

function report(window: ShadowWindow, result: ShadowReport): string {
  const { runs } = result;
  return [
    `# Shadow run ${window.since} to ${window.until}`,
    "",
    ...gainLines(result),
    "",
    "## Notifications",
    "",
    `${result.missedNotifications.length} subscriptions to repositories that gained stars were never handled by the Worker` +
      ` (${result.inactiveChats} more belong to inactive chats, which the Worker skips on purpose).`,
    ...result.missedNotifications.slice(0, SHOWN).map((m) => `* chat ${m.chatId}, repository #${m.githubId}`),
    "",
    "## Runs and limits",
    "",
    `* ${runs.total} runs, ${runs.failed.length} failed${runs.failed.length > 0 ? `: ${runs.failed.slice(0, SHOWN).join(", ")}` : ""}`,
    `* Most subrequests in a run: ${runs.maxSubrequests} (limit ${PLAN_LIMITS.subrequestsPerRun}, pass under ${PLAN_LIMITS.subrequestsPerRun * LIMIT_SHARE})`,
    `* Most rows written by star checks in a day: ${runs.maxRowsWrittenPerDay} (limit ${PLAN_LIMITS.rowsWrittenPerDay}, pass under ${PLAN_LIMITS.rowsWrittenPerDay * LIMIT_SHARE})`,
  ].join("\n");
}

async function main(): Promise<void> {
  const target = d1Target();
  const window = shadowWindow();
  const [d1, supabase] = await Promise.all([readD1(target, window), readSupabase(window)]);
  const result = compareShadowRun({ window, ...supabase, ...d1 });
  console.log(report(window, result));
  const failed = failedCriteria(result);
  if (failed.length > 0) {
    console.error(`\nFailed: ${failed.join("; ")}`);
    process.exitCode = 1;
  }
}

runMain(main);
