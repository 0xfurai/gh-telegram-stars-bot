// Compares the shadow run with the old app (GSB-15). Pure: no I/O.
//
// The old app records a star event whenever a check sees more stars than the
// last one; the Worker adds its gains to daily_star_gains. The two check at
// different times, so totals per repository are compared, not single events.
import { assertNever } from "../../src/result.ts";

/** Workers Free: subrequests per invocation and D1 rows written per day. */
export const PLAN_LIMITS = { subrequestsPerRun: 50, rowsWrittenPerDay: 100_000 } as const;
/** Pass mark: stay under this share of each plan limit. */
export const LIMIT_SHARE = 0.7;
/** The Cron Trigger's interval, and the share of scheduled runs that must be on record. */
const RUN_INTERVAL_MS = 5 * 60 * 1000;
const RUN_COVERAGE = 0.95;
/**
 * The Worker checks more often than the old app, so it can see (and notify)
 * stars some time before the old app records them.
 */
export const EARLY_NOTICE_MS = 60 * 60 * 1000;

export interface ShadowWindow {
  /** First day, YYYY-MM-DD. */
  since: string;
  /** Last day, YYYY-MM-DD, included. */
  until: string;
  /** Where the window ends, ISO: the end of `until`, or now when that's still to come. */
  end: string;
}

export interface ShadowInput {
  window: ShadowWindow;
  /** Supabase repositories: its serial ID and the GitHub ID. */
  oldRepositories: readonly { id: number; github_id: number; full_name: string }[];
  /** Supabase star events inside the window. */
  oldStarEvents: readonly { repository_id: number; stars_count: number; previous_stars_count: number; created_at: string }[];
  /** D1 daily gains inside the window; repository_id is the GitHub ID. */
  workerGains: readonly { repository_id: number; stars_gained: number }[];
  /** D1 subscriptions, with the chat's state and when the Worker last handled them. */
  workerSubscriptions: readonly {
    chat_id: number;
    repository_id: number;
    is_active: number;
    created_at: string;
    last_notified_at: string | null;
  }[];
  /** star_check_runs rows inside the window. */
  runs: readonly { scheduled_at: string; ok: number; summary: string }[];
  /** Rows D1 wrote per day, from Cloudflare's analytics. */
  rowsWrittenPerDay: readonly { date: string; rowsWritten: number }[];
}

export interface GainComparison {
  githubId: number;
  fullName: string;
  oldApp: number;
  worker: number;
  difference: number;
}

export interface RunStats {
  total: number;
  expected: number;
  failed: string[];
  maxSubrequests: number;
}

export interface ShadowReport {
  gains: GainComparison[];
  /** Subscriptions the Worker didn't handle after the old app's last gain for that repository. */
  missedNotifications: { chatId: number; githubId: number }[];
  /** Same, but the chat is inactive: the Worker doesn't notify those on purpose. */
  inactiveChats: number;
  /** Handled again after the window ended, which hides whether it was handled inside it. */
  notifiedAfterWindow: number;
  runs: RunStats;
  maxRowsWrittenPerDay: number;
}

interface OldGains {
  total: number;
  /** ms: when the old app last recorded a gain. */
  latestAt: number;
}

/** The old app's gains per GitHub ID, with the time of the latest one. */
function oldGainsByGithubId(input: ShadowInput): Map<number, OldGains> {
  const githubIds = new Map(input.oldRepositories.map((repo) => [repo.id, repo.github_id]));
  const gains = new Map<number, OldGains>();
  for (const event of input.oldStarEvents) {
    const githubId = githubIds.get(event.repository_id);
    if (githubId === undefined) {
      continue;
    }
    const previous = gains.get(githubId) ?? { total: 0, latestAt: 0 };
    gains.set(githubId, {
      total: previous.total + event.stars_count - event.previous_stars_count,
      latestAt: Math.max(previous.latestAt, Date.parse(event.created_at)),
    });
  }
  return gains;
}

/** Stars gained per repository by each app, largest difference first. */
function compareGains(input: ShadowInput, oldGains: ReadonlyMap<number, OldGains>): GainComparison[] {
  const worker = new Map<number, number>();
  for (const gain of input.workerGains) {
    worker.set(gain.repository_id, (worker.get(gain.repository_id) ?? 0) + gain.stars_gained);
  }
  const names = new Map(input.oldRepositories.map((repo) => [repo.github_id, repo.full_name]));
  return [...new Set([...oldGains.keys(), ...worker.keys()])]
    .map((githubId) => {
      const old = oldGains.get(githubId)?.total ?? 0;
      const ours = worker.get(githubId) ?? 0;
      return { githubId, fullName: names.get(githubId) ?? `#${githubId}`, oldApp: old, worker: ours, difference: ours - old };
    })
    .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference) || a.fullName.localeCompare(b.fullName));
}

type SubscriptionCheck = "not-expected" | "handled" | "missed" | "inactive" | "notified-after-window";

/**
 * Whether the Worker handled a subscription after the old app's latest gain
 * for its repository. One notification after that gain is enough: the Worker
 * reports the net change since the chat was last told, so it includes every
 * earlier gain.
 */
function checkSubscription(
  subscription: ShadowInput["workerSubscriptions"][number],
  latestGainAt: number | undefined,
  windowEnd: number,
): SubscriptionCheck {
  if (latestGainAt === undefined || Date.parse(subscription.created_at) >= latestGainAt) {
    return "not-expected";
  }
  if (subscription.is_active !== 1) {
    return "inactive";
  }
  const notifiedAt = subscription.last_notified_at === null ? null : Date.parse(subscription.last_notified_at);
  if (notifiedAt === null) {
    return "missed";
  }
  if (notifiedAt >= windowEnd) {
    return "notified-after-window";
  }
  return notifiedAt >= latestGainAt - EARLY_NOTICE_MS ? "handled" : "missed";
}

function checkNotifications(input: ShadowInput, oldGains: ReadonlyMap<number, OldGains>) {
  const windowEnd = Date.parse(input.window.end);
  const result = { missedNotifications: [] as ShadowReport["missedNotifications"], inactiveChats: 0, notifiedAfterWindow: 0 };
  for (const subscription of input.workerSubscriptions) {
    const gains = oldGains.get(subscription.repository_id);
    const check = checkSubscription(subscription, gains && gains.total > 0 ? gains.latestAt : undefined, windowEnd);
    switch (check) {
      case "missed":
        result.missedNotifications.push({ chatId: subscription.chat_id, githubId: subscription.repository_id });
        break;
      case "inactive":
        result.inactiveChats += 1;
        break;
      case "notified-after-window":
        result.notifiedAfterWindow += 1;
        break;
      case "not-expected":
      case "handled":
        break;
      default:
        assertNever(check);
    }
  }
  return result;
}

/** A run's subrequests. Failed runs keep the summary under `summary`, next to the reason. */
function subrequestsOf(summaryJson: string): number {
  const details = JSON.parse(summaryJson) as { subrequests?: number; summary?: { subrequests?: number } };
  return details.subrequests ?? details.summary?.subrequests ?? 0;
}

/** Run counts against the schedule, failures, and the most subrequests in a run. */
export function runStats(runs: ShadowInput["runs"], window: ShadowWindow): RunStats {
  const start = Date.parse(`${window.since}T00:00:00.000Z`);
  return {
    total: runs.length,
    expected: Math.floor((Date.parse(window.end) - start) / RUN_INTERVAL_MS),
    failed: runs.filter((run) => run.ok !== 1).map((run) => run.scheduled_at),
    maxSubrequests: Math.max(0, ...runs.map((run) => subrequestsOf(run.summary))),
  };
}

export function compareShadowRun(input: ShadowInput): ShadowReport {
  const oldGains = oldGainsByGithubId(input);
  return {
    gains: compareGains(input, oldGains),
    ...checkNotifications(input, oldGains),
    runs: runStats(input.runs, input.window),
    maxRowsWrittenPerDay: Math.max(0, ...input.rowsWrittenPerDay.map((day) => day.rowsWritten)),
  };
}

/** The criteria the script can check by itself; gain differences need a human explanation. */
export function failedCriteria(report: ShadowReport): string[] {
  const { runs } = report;
  const checks: [boolean, string][] = [
    [runs.total < runs.expected * RUN_COVERAGE, `${runs.total} of ${runs.expected} scheduled runs on record`],
    [runs.failed.length > 0, `${runs.failed.length} failed runs`],
    [report.missedNotifications.length > 0, `${report.missedNotifications.length} subscriptions the Worker never notified`],
    [runs.maxSubrequests > PLAN_LIMITS.subrequestsPerRun * LIMIT_SHARE, `a run used ${runs.maxSubrequests} subrequests`],
    [
      report.maxRowsWrittenPerDay > PLAN_LIMITS.rowsWrittenPerDay * LIMIT_SHARE,
      `a day had ${report.maxRowsWrittenPerDay} rows written`,
    ],
  ];
  return checks.filter(([failed]) => failed).map(([, message]) => message);
}
