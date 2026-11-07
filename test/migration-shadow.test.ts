import { describe, expect, it } from "vitest";
import { compareShadowRun, failedCriteria, runStats, type ShadowInput } from "../scripts/migration/shadow";

const WINDOW = { since: "2026-11-08", until: "2026-11-10" };
const DURING = "2026-11-09T12:00:00.000Z";

function summary(subrequests: number, rowsWritten: number): string {
  return JSON.stringify({ subrequests, rowsWritten });
}

function input(overrides: Partial<ShadowInput> = {}): ShadowInput {
  return {
    window: WINDOW,
    // Supabase serial IDs 1 and 2 are GitHub repositories 100 and 200.
    oldRepositories: [
      { id: 1, github_id: 100, full_name: "a/one" },
      { id: 2, github_id: 200, full_name: "b/two" },
    ],
    oldStarEvents: [
      { repository_id: 1, stars_count: 12, previous_stars_count: 10 },
      { repository_id: 1, stars_count: 13, previous_stars_count: 12 },
    ],
    workerGains: [
      { repository_id: 100, stars_gained: 1 },
      { repository_id: 100, stars_gained: 2 },
    ],
    workerSubscriptions: [{ chat_id: 7, repository_id: 100, is_active: 1, last_notified_at: DURING }],
    runs: [{ scheduled_at: DURING, ok: 1, summary: summary(7, 3) }],
    ...overrides,
  };
}

describe("compareShadowRun: gains", () => {
  it("matches the old app's events to the Worker's daily gains by GitHub ID", () => {
    const report = compareShadowRun(input());

    expect(report.gains).toEqual([{ githubId: 100, fullName: "a/one", oldApp: 3, worker: 3, difference: 0 }]);
    expect(failedCriteria(report)).toEqual([]);
  });

  it("lists repositories either app missed, largest difference first", () => {
    const report = compareShadowRun(
      input({
        oldStarEvents: [{ repository_id: 2, stars_count: 6, previous_stars_count: 5 }],
        workerGains: [{ repository_id: 100, stars_gained: 4 }],
        workerSubscriptions: [],
      }),
    );

    expect(report.gains).toEqual([
      { githubId: 100, fullName: "a/one", oldApp: 0, worker: 4, difference: 4 },
      { githubId: 200, fullName: "b/two", oldApp: 1, worker: 0, difference: -1 },
    ]);
  });

  it("names a repository Supabase doesn't have by its GitHub ID", () => {
    const report = compareShadowRun(input({ oldStarEvents: [], workerGains: [{ repository_id: 999, stars_gained: 1 }] }));

    expect(report.gains[0]?.fullName).toBe("#999");
  });
});

describe("compareShadowRun: notifications", () => {
  it("reports subscribers of a repository that gained stars but were never handled in the window", () => {
    const report = compareShadowRun(
      input({
        workerSubscriptions: [
          { chat_id: 7, repository_id: 100, is_active: 1, last_notified_at: null },
          { chat_id: 8, repository_id: 100, is_active: 1, last_notified_at: "2026-11-07T23:59:59.000Z" },
          { chat_id: 9, repository_id: 100, is_active: 1, last_notified_at: DURING },
        ],
      }),
    );

    expect(report.missedNotifications).toEqual([
      { chatId: 7, githubId: 100 },
      { chatId: 8, githubId: 100 },
    ]);
    expect(failedCriteria(report)).toEqual(["2 subscriptions the Worker never notified"]);
  });

  it("counts inactive chats apart: the Worker skips them on purpose", () => {
    const report = compareShadowRun(
      input({ workerSubscriptions: [{ chat_id: 7, repository_id: 100, is_active: 0, last_notified_at: null }] }),
    );

    expect(report.missedNotifications).toEqual([]);
    expect(report.inactiveChats).toBe(1);
  });

  it("ignores subscriptions to repositories without gains", () => {
    const report = compareShadowRun(
      input({ workerSubscriptions: [{ chat_id: 7, repository_id: 200, is_active: 1, last_notified_at: null }] }),
    );

    expect(report.missedNotifications).toEqual([]);
  });
});

describe("runStats and failedCriteria", () => {
  it("finds failed runs and the largest use of each limit, rows summed per day", () => {
    const stats = runStats([
      { scheduled_at: "2026-11-08T00:00:00.000Z", ok: 1, summary: summary(10, 40) },
      { scheduled_at: "2026-11-08T00:05:00.000Z", ok: 0, summary: summary(36, 30) },
      { scheduled_at: "2026-11-09T00:00:00.000Z", ok: 1, summary: summary(5, 50) },
    ]);

    expect(stats).toEqual({ total: 3, failed: ["2026-11-08T00:05:00.000Z"], maxSubrequests: 36, maxRowsWrittenPerDay: 70 });
  });

  it("fails without runs, and over 70% of a plan limit", () => {
    expect(failedCriteria(compareShadowRun(input({ runs: [] })))).toEqual(["no star check runs in the window"]);
    expect(
      failedCriteria(compareShadowRun(input({ runs: [{ scheduled_at: DURING, ok: 1, summary: summary(36, 70_001) }] }))),
    ).toEqual(["a run used 36 subrequests", "a day had 70001 rows written"]);
  });
});
