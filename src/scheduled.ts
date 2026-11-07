// The Worker's scheduled handler: runs the star check, records the run, and
// alerts the admin chat when something needs attention.
//
// Alerting is about what needs a person, not about every blip:
// * A rejected GitHub token or a likely bug (a GraphQL or response-shape
//   error) alerts at once.
// * Temporary problems (rate limits, timeouts, GitHub or D1 outages) heal by
//   themselves; they only alert when star checks go stale (no successful run
//   in 15 minutes).
// A crash is an exception: it's caught only to record and alert, then the
// original is rethrown so Cloudflare shows the failed run with its stack.
import type { AppConfig } from "./config";
import { errorMessage } from "./errors";
import type { GitHubError } from "./github";
import { alertAdmin, readStarCheckHealth, recordRun, type StarCheckHealth } from "./monitoring";
import { assertNever } from "./result";
import { isPruneRun, runStarCheck, type RunSummary, type StarCheckDeps } from "./star-check";

type ScheduledDeps = StarCheckDeps & { now?: () => number };
type Controller = Pick<ScheduledController, "scheduledTime">;

/** What a GitHub error means for the people running the bot. */
export type GitHubSeverity =
  /** Heals by itself; the cursor retries next run. */
  | "transient"
  /** The token is wrong, expired or lacks access: someone has to fix it. */
  | "operator"
  /** GitHub answered something we don't understand: likely our bug. */
  | "bug";

export function githubSeverity(error: GitHubError): GitHubSeverity {
  switch (error.kind) {
    case "rate-limited":
    case "network":
    case "timeout":
      return "transient";
    case "http":
      return error.status >= 500 ? "transient" : "bug";
    case "unauthorized":
    case "forbidden":
      return "operator";
    case "graphql":
    case "bad-response":
      return "bug";
    default:
      return assertNever(error);
  }
}

type AlertWhen = "now" | "if-stale";

export type Judgement =
  | { kind: "succeeded"; summary: RunSummary }
  /** A temporary GitHub error after some progress: counts as a successful run. */
  | { kind: "degraded"; summary: RunSummary; error: GitHubError }
  | { kind: "failed"; summary: RunSummary; error: GitHubError; severity: GitHubSeverity; alert: AlertWhen }
  /** Another run held the lock; it records its own result. */
  | { kind: "skipped" };

export function judge(summary: RunSummary): Judgement {
  if (summary.skipped !== null) {
    return { kind: "skipped" };
  }
  const error = summary.githubError;
  if (error === null) {
    return { kind: "succeeded", summary };
  }
  const severity = githubSeverity(error);
  switch (severity) {
    case "transient":
      return summary.repositoriesChecked > 0
        ? { kind: "degraded", summary, error }
        : { kind: "failed", summary, error, severity, alert: "if-stale" };
    case "operator":
    case "bug":
      return { kind: "failed", summary, error, severity, alert: "now" };
    default:
      return assertNever(severity);
  }
}

function failureReason(severity: GitHubSeverity, error: GitHubError): string {
  switch (severity) {
    case "transient":
      return `GitHub is unavailable (${error.kind}); no repositories could be checked.`;
    case "operator":
      return `GitHub rejected the token (${error.kind}). Check GITHUB_TOKEN.`;
    case "bug":
      return `GitHub answered something unexpected (${error.kind}); likely a bug.`;
    default:
      return assertNever(severity);
  }
}

/** Monitoring must never hide the run's own result, so its failures are only logged. */
async function bestEffort(label: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    console.error(JSON.stringify({ message: `${label} failed`, error: errorMessage(error) }));
  }
}

async function record(controller: Controller, deps: ScheduledDeps, ok: boolean, details: object): Promise<void> {
  const now = deps.now?.() ?? Date.now();
  const prune = isPruneRun(controller.scheduledTime) ? { now } : null;
  await bestEffort("Recording the run", () => recordRun(deps.db, { scheduledTime: controller.scheduledTime, ok, details }, prune));
}

/** Whether to alert now: always, or only when star checks have gone stale. */
async function alertDue(db: D1Database, when: AlertWhen, now: number): Promise<boolean> {
  switch (when) {
    case "now":
      return true;
    case "if-stale":
      return healthNeedsAlert((await readStarCheckHealth(db, now)).status);
    default:
      return assertNever(when);
  }
}

function healthNeedsAlert(status: StarCheckHealth["status"]): boolean {
  switch (status) {
    case "ok":
      return false;
    // "unknown" means D1 is down: alert (fail open), as alertAdmin does when it can't throttle.
    case "stale":
    case "no-successful-run":
    case "unknown":
      return true;
    default:
      return assertNever(status);
  }
}

async function alert(config: AppConfig, deps: ScheduledDeps, when: AlertWhen, reason: string): Promise<void> {
  const now = deps.now?.() ?? Date.now();
  await bestEffort("Alerting the admin chat", async () => {
    const outcome = (await alertDue(deps.db, when, now)) ? await alertAdmin(config, deps, reason, now) : "not-needed";
    console.log(JSON.stringify({ message: "Star check problem", reason, when, alert: outcome }));
  });
}

async function onCrash(controller: Controller, config: AppConfig, deps: ScheduledDeps, error: unknown): Promise<void> {
  const message = errorMessage(error);
  await record(controller, deps, false, { crashed: message });
  await alert(config, deps, "if-stale", `The star check crashed: ${message}`);
}

/** A problem that needs a person also fails the invocation, so Cloudflare shows it. */
function failInvocationIfNeeded(when: AlertWhen, reason: string): void {
  switch (when) {
    case "now":
      throw new Error(reason);
    case "if-stale":
      return;
    default:
      assertNever(when);
  }
}

export async function handleScheduled(controller: Controller, config: AppConfig, deps: ScheduledDeps): Promise<void> {
  let summary: RunSummary;
  try {
    summary = await runStarCheck(controller, config, deps);
  } catch (error) {
    await onCrash(controller, config, deps, error);
    throw error;
  }

  const judgement = judge(summary);
  switch (judgement.kind) {
    case "skipped":
      return;
    case "succeeded":
    case "degraded":
      return record(controller, deps, true, judgement.summary);
    case "failed": {
      const reason = failureReason(judgement.severity, judgement.error);
      await record(controller, deps, false, { reason, summary: judgement.summary });
      await alert(config, deps, judgement.alert, reason);
      return failInvocationIfNeeded(judgement.alert, reason);
    }
    default:
      return assertNever(judgement);
  }
}
