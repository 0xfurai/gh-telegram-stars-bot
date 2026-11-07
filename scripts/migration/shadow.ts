// Compares the shadow run with the old app (GSB-15). Pure: no I/O.
//
// The window is whole UTC days, both ends included. The old app records a
// star event whenever a check sees more stars than the last one; the Worker
// adds its gains to daily_star_gains. The two check at different times, so
// totals per repository are compared, not single events.

/** Workers Free: subrequests per invocation and D1 rows written per day. */
export const PLAN_LIMITS = { subrequestsPerRun: 50, rowsWrittenPerDay: 100_000 } as const;
/** Pass mark: stay under this share of each plan limit. */
export const LIMIT_SHARE = 0.7;

export interface ShadowWindow {
  /** First day, YYYY-MM-DD. */
  since: string;
  /** Last day, YYYY-MM-DD, included. */
  until: string;
}

export interface ShadowInput {
  window: ShadowWindow;
  /** Supabase repositories: its serial ID and the GitHub ID. */
  oldRepositories: readonly { id: number; github_id: number; full_name: string }[];
  /** Supabase star events inside the window. */
  oldStarEvents: readonly { repository_id: number; stars_count: number; previous_stars_count: number }[];
  /** D1 daily gains inside the window; repository_id is the GitHub ID. */
  workerGains: readonly { repository_id: number; stars_gained: number }[];
  /** D1 subscriptions, with the chat's state and when the Worker last handled them. */
  workerSubscriptions: readonly { chat_id: number; repository_id: number; is_active: number; last_notified_at: string | null }[];
  /** star_check_runs rows inside the window. */
  runs: readonly { scheduled_at: string; ok: number; summary: string }[];
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
  failed: string[];
  maxSubrequests: number;
  maxRowsWrittenPerDay: number;
}

export interface ShadowReport {
  gains: GainComparison[];
  /** Subscriptions to repositories that gained stars in the old app, never handled by the Worker in the window. */
  missedNotifications: { chatId: number; githubId: number }[];
  /** Same, but the chat is inactive: the Worker doesn't notify those on purpose. */
  inactiveChats: number;
  runs: RunStats;
}

function addTo(totals: Map<number, number>, key: number, amount: number): void {
  totals.set(key, (totals.get(key) ?? 0) + amount);
}

function oldGainsByGithubId(input: ShadowInput): Map<number, number> {
  const githubIds = new Map(input.oldRepositories.map((repo) => [repo.id, repo.github_id]));
  const totals = new Map<number, number>();
  for (const event of input.oldStarEvents) {
    const githubId = githubIds.get(event.repository_id);
    if (githubId !== undefined) {
      addTo(totals, githubId, event.stars_count - event.previous_stars_count);
    }
  }
  return totals;
}

/** Stars gained per repository by each app, largest difference first. */
export function compareGains(input: ShadowInput): GainComparison[] {
  const oldApp = oldGainsByGithubId(input);
  const worker = new Map<number, number>();
  for (const gain of input.workerGains) {
    addTo(worker, gain.repository_id, gain.stars_gained);
  }
  const names = new Map(input.oldRepositories.map((repo) => [repo.github_id, repo.full_name]));
  const githubIds = new Set([...oldApp.keys(), ...worker.keys()]);
  return [...githubIds]
    .map((githubId) => {
      const old = oldApp.get(githubId) ?? 0;
      const ours = worker.get(githubId) ?? 0;
      return { githubId, fullName: names.get(githubId) ?? `#${githubId}`, oldApp: old, worker: ours, difference: ours - old };
    })
    .sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference) || a.fullName.localeCompare(b.fullName));
}

function missedNotifications(input: ShadowInput): Pick<ShadowReport, "missedNotifications" | "inactiveChats"> {
  const gained = new Set([...oldGainsByGithubId(input)].filter(([, stars]) => stars > 0).map(([githubId]) => githubId));
  const start = `${input.window.since}T00:00:00.000Z`;
  const missed: ShadowReport["missedNotifications"] = [];
  let inactiveChats = 0;
  for (const subscription of input.workerSubscriptions) {
    const handled = subscription.last_notified_at !== null && subscription.last_notified_at >= start;
    if (!gained.has(subscription.repository_id) || handled) {
      continue;
    }
    if (subscription.is_active === 1) {
      missed.push({ chatId: subscription.chat_id, githubId: subscription.repository_id });
    } else {
      inactiveChats += 1;
    }
  }
  return { missedNotifications: missed, inactiveChats };
}

interface SummaryNumbers {
  subrequests?: number;
  rowsWritten?: number;
}

/** Run counts, failures and the largest use of each plan limit. */
export function runStats(runs: ShadowInput["runs"]): RunStats {
  const rowsPerDay = new Map<string, number>();
  let maxSubrequests = 0;
  for (const run of runs) {
    const summary = JSON.parse(run.summary) as SummaryNumbers;
    maxSubrequests = Math.max(maxSubrequests, summary.subrequests ?? 0);
    const day = run.scheduled_at.slice(0, 10);
    rowsPerDay.set(day, (rowsPerDay.get(day) ?? 0) + (summary.rowsWritten ?? 0));
  }
  return {
    total: runs.length,
    failed: runs.filter((run) => run.ok !== 1).map((run) => run.scheduled_at),
    maxSubrequests,
    maxRowsWrittenPerDay: Math.max(0, ...rowsPerDay.values()),
  };
}

export function compareShadowRun(input: ShadowInput): ShadowReport {
  return { gains: compareGains(input), ...missedNotifications(input), runs: runStats(input.runs) };
}

/** The criteria the script can check by itself; gain differences need a human explanation. */
export function failedCriteria(report: ShadowReport): string[] {
  const failed: string[] = [];
  if (report.runs.total === 0) {
    failed.push("no star check runs in the window");
  }
  if (report.runs.failed.length > 0) {
    failed.push(`${report.runs.failed.length} failed runs`);
  }
  if (report.missedNotifications.length > 0) {
    failed.push(`${report.missedNotifications.length} subscriptions the Worker never notified`);
  }
  if (report.runs.maxSubrequests > PLAN_LIMITS.subrequestsPerRun * LIMIT_SHARE) {
    failed.push(`a run used ${report.runs.maxSubrequests} subrequests`);
  }
  if (report.runs.maxRowsWrittenPerDay > PLAN_LIMITS.rowsWrittenPerDay * LIMIT_SHARE) {
    failed.push(`a day had ${report.runs.maxRowsWrittenPerDay} rows written`);
  }
  return failed;
}
