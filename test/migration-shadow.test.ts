import { describe, expect, it } from "vitest";
import { compareShadowRun, failedCriteria, runStats, type ShadowInput } from "../scripts/migration/shadow";
import { addDays, isUtcDay } from "../scripts/migration/to-d1";

// One whole day: 288 scheduled runs.
const WINDOW = { since: "2026-11-08", until: "2026-11-08", end: "2026-11-09T00:00:00.000Z" };
const GAIN_AT = "2026-11-08T12:00:00+00:00";
const BEFORE = "2026-11-01T00:00:00.000Z";

function summary(subrequests: number): string {
  return JSON.stringify({ subrequests });
}

/** A full day of successful runs, every 5 minutes. */
function fullDayOfRuns(subrequests = 7): ShadowInput["runs"] {
  return Array.from({ length: 288 }, (_, i) => ({
    scheduled_at: new Date(Date.parse("2026-11-08T00:00:00Z") + i * 300_000).toISOString(),
    ok: 1,
    summary: summary(subrequests),
  }));
}

type Subscription = ShadowInput["workerSubscriptions"][number];

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return { chat_id: 7, repository_id: 100, is_active: 1, created_at: BEFORE, last_notified_at: "2026-11-08T12:05:00.000Z", ...overrides };
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
      { repository_id: 1, stars_count: 12, previous_stars_count: 10, created_at: "2026-11-08T08:00:00+00:00" },
      { repository_id: 1, stars_count: 13, previous_stars_count: 12, created_at: GAIN_AT },
    ],
    workerGains: [
      { repository_id: 100, stars_gained: 1 },
      { repository_id: 100, stars_gained: 2 },
    ],
    workerSubscriptions: [subscription()],
    runs: fullDayOfRuns(),
    rowsWrittenPerDay: [{ date: "2026-11-08", rowsWritten: 3_000 }],
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
        oldStarEvents: [{ repository_id: 2, stars_count: 6, previous_stars_count: 5, created_at: GAIN_AT }],
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
  function check(...subscriptions: Subscription[]) {
    return compareShadowRun(input({ workerSubscriptions: subscriptions }));
  }

  it("needs a notification after the old app's latest gain, not just any in the window", () => {
    const report = check(
      subscription({ chat_id: 1, last_notified_at: null }),
      // Notified for the 08:00 gain, then missed the 12:00 one.
      subscription({ chat_id: 2, last_notified_at: "2026-11-08T08:05:00.000Z" }),
      // Up to an hour early is fine: the Worker checks more often than the old app.
      subscription({ chat_id: 3, last_notified_at: "2026-11-08T11:30:00.000Z" }),
    );

    expect(report.missedNotifications).toEqual([
      { chatId: 1, githubId: 100 },
      { chatId: 2, githubId: 100 },
    ]);
    expect(failedCriteria(report)).toEqual(["2 subscriptions the Worker never notified"]);
  });

  it("doesn't expect a notification for a subscription added after the last gain", () => {
    const report = check(subscription({ created_at: "2026-11-08T13:00:00.000Z", last_notified_at: null }));

    expect(report.missedNotifications).toEqual([]);
  });

  it("counts inactive chats and notifications after the window apart", () => {
    const report = check(
      subscription({ chat_id: 1, is_active: 0, last_notified_at: null }),
      subscription({ chat_id: 2, last_notified_at: "2026-11-09T06:00:00.000Z" }),
    );

    expect(report.missedNotifications).toEqual([]);
    expect(report.inactiveChats).toBe(1);
    expect(report.notifiedAfterWindow).toBe(1);
  });

  it("ignores subscriptions to repositories without gains", () => {
    const report = check(subscription({ repository_id: 200, last_notified_at: null }));

    expect(report.missedNotifications).toEqual([]);
  });
});

describe("runStats and failedCriteria", () => {
  it("counts failed runs, and reads subrequests from failed runs' nested summary", () => {
    const stats = runStats(
      [
        { scheduled_at: "2026-11-08T00:00:00.000Z", ok: 1, summary: summary(10) },
        { scheduled_at: "2026-11-08T00:05:00.000Z", ok: 0, summary: JSON.stringify({ reason: "GitHub failed", summary: { subrequests: 48 } }) },
      ],
      WINDOW,
    );

    expect(stats).toEqual({ total: 2, expected: 288, failed: ["2026-11-08T00:05:00.000Z"], maxSubrequests: 48 });
  });

  it("fails when scheduled runs are missing, such as a stopped Cron Trigger", () => {
    const report = compareShadowRun(input({ runs: fullDayOfRuns().slice(0, 200) }));

    expect(failedCriteria(report)).toEqual(["200 of 288 scheduled runs on record"]);
  });

  it("fails over 70% of a plan limit, using D1's real rows written", () => {
    const report = compareShadowRun(
      input({ runs: fullDayOfRuns(36), rowsWrittenPerDay: [{ date: "2026-11-08", rowsWritten: 70_001 }] }),
    );

    expect(failedCriteria(report)).toEqual(["a run used 36 subrequests", "a day had 70001 rows written"]);
  });
});

describe("isUtcDay and addDays", () => {
  it("refuses impossible days instead of rolling them over", () => {
    expect(isUtcDay("2026-02-28")).toBe(true);
    expect(isUtcDay("2026-02-31")).toBe(false);
    expect(isUtcDay("2026-2-3")).toBe(false);
  });

  it("adds days across month ends", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2026-11-08", -6)).toBe("2026-11-02");
  });
});
