// Summary periods and when their summaries go out. Pure functions on UTC
// days (YYYY-MM-DD); no imports from the data layer.
//
// Periods are in UTC for everyone: weeks start on Monday, months on the 1st,
// years on 1 January. Only the send time depends on the chat's time zone.
import { assertNever } from "./result";
import { zonedTime } from "./time-zone";

export const SUMMARY_KINDS = ["weekly", "monthly", "yearly"] as const;
export type SummaryKind = (typeof SUMMARY_KINDS)[number];

/** A complete period: from `start` (included) to `end` (excluded), both UTC days. */
export interface Period {
  kind: SummaryKind;
  start: string;
  end: string;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Without a time zone, summaries go out at this hour UTC: afternoon in Europe, morning in the Americas. */
export const DEFAULT_SEND_HOUR_UTC = 15;
/** With a time zone, at this local hour. */
export const LOCAL_SEND_HOUR = 10;

function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function startOfDay(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

/** The first day of the period of `kind` that contains `day`. */
export function periodStart(kind: SummaryKind, day: string): string {
  switch (kind) {
    case "weekly": {
      const ms = startOfDay(day);
      const daysSinceMonday = (new Date(ms).getUTCDay() + 6) % 7;
      return dayOf(ms - daysSinceMonday * DAY_MS);
    }
    case "monthly":
      return `${day.slice(0, 7)}-01`;
    case "yearly":
      return `${day.slice(0, 4)}-01-01`;
    default:
      return assertNever(kind);
  }
}

/** The last period of `kind` that ended at or before `now`. */
export function lastCompletePeriod(kind: SummaryKind, now: number): Period {
  const end = periodStart(kind, dayOf(now));
  return { kind, start: periodStart(kind, dayOf(startOfDay(end) - DAY_MS)), end };
}

export function lastCompletePeriods(now: number): Record<SummaryKind, Period> {
  return {
    weekly: lastCompletePeriod("weekly", now),
    monthly: lastCompletePeriod("monthly", now),
    yearly: lastCompletePeriod("yearly", now),
  };
}

/** Days that start a period (Mondays and 1sts): the star check stores snapshots then. */
export function isSnapshotDay(day: string): boolean {
  return periodStart("weekly", day) === day || periodStart("monthly", day) === day;
}

/**
 * When a summary for a period ending on `endDay` may go out: 10:00 in the
 * chat's time zone on that day, or 15:00 UTC without one (or with one the
 * runtime doesn't know). Never before the period has ended (time zones far
 * ahead of UTC).
 */
export function sendTime(endDay: string, timeZone: string | null): number {
  const end = startOfDay(endDay);
  const fallback = end + DEFAULT_SEND_HOUR_UTC * HOUR_MS;
  if (timeZone === null) {
    return fallback;
  }
  try {
    return Math.max(end, zonedTime(endDay, LOCAL_SEND_HOUR, timeZone));
  } catch {
    // A stored name the runtime no longer knows: use the default hour.
    return fallback;
  }
}
