// The Worker's scheduled handler: runs the star check, records the run, and
// alerts the admin chat when it fails.
import type { AppConfig } from "./config";
import { alertAdmin, pruneRuns, recordRun, type RunFailure } from "./monitoring";
import { assertNever, err, ok, type Result } from "./result";
import { isPruneRun, runStarCheck, type RunSummary, type StarCheckDeps } from "./star-check";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Judgement =
  | { kind: "finished"; outcome: Result<RunSummary, RunFailure> }
  /** Another run held the lock; it records its own result. */
  | { kind: "skipped" };

/**
 * A run fails when it throws (for example D1 is down) or GitHub couldn't be
 * checked. Failed sends don't fail the run: they're retried next run.
 */
async function runAndJudge(
  controller: Pick<ScheduledController, "scheduledTime">,
  config: AppConfig,
  deps: StarCheckDeps,
): Promise<Judgement> {
  let summary: RunSummary;
  try {
    summary = await runStarCheck(controller, config, deps);
  } catch (error) {
    return { kind: "finished", outcome: err({ reason: `Star check crashed: ${errorMessage(error)}`, summary: null }) };
  }
  if (summary.skipped !== null) {
    return { kind: "skipped" };
  }
  return {
    kind: "finished",
    outcome: summary.githubError
      ? err({ reason: `GitHub check failed: ${summary.githubError.kind}`, summary })
      : ok(summary),
  };
}

/** Monitoring must never hide the run's own result, so its failures are only logged. */
async function bestEffort(label: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    console.error(JSON.stringify({ message: `${label} failed`, error: errorMessage(error) }));
  }
}

async function finish(
  controller: Pick<ScheduledController, "scheduledTime">,
  config: AppConfig,
  deps: StarCheckDeps & { now?: () => number },
  outcome: Result<RunSummary, RunFailure>,
): Promise<void> {
  const now = deps.now?.() ?? Date.now();
  await bestEffort("Recording the run", () => recordRun(deps.db, controller.scheduledTime, outcome));
  if (isPruneRun(controller.scheduledTime)) {
    await bestEffort("Pruning old runs", () => pruneRuns(deps.db, now));
  }
  if (!outcome.ok) {
    const { reason } = outcome.error;
    await bestEffort("Alerting the admin chat", async () => {
      const alert = await alertAdmin(config, deps, reason, now);
      console.log(JSON.stringify({ message: "Star check failed", reason, alert }));
    });
    // Fail the invocation too, so Cloudflare shows the run as failed.
    throw new Error(reason);
  }
}

export async function handleScheduled(
  controller: Pick<ScheduledController, "scheduledTime">,
  config: AppConfig,
  deps: StarCheckDeps & { now?: () => number },
): Promise<void> {
  const judgement = await runAndJudge(controller, config, deps);
  switch (judgement.kind) {
    case "skipped":
      return;
    case "finished":
      return finish(controller, config, deps, judgement.outcome);
    default:
      return assertNever(judgement);
  }
}
