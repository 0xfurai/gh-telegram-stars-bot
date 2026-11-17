// Weekly, monthly and yearly star summaries (GSB-23), sent by the star check
// after the star notifications, with the message slots those leave.
//
// A summary covers the last complete period (see periods.ts): each
// repository's net change between the snapshots at the period's start and
// end. It goes out at the chat's send time; one with no changes isn't sent,
// only marked, so the chat isn't asked again.
import {
  listSummaryCandidates,
  listSummaryChanges,
  markSummariesSent,
  summarySentStatement,
  type SummaryCandidate,
  type SummaryChange,
} from "./db";
import type { Outgoing } from "./delivery";
import { starSummary } from "./messages";
import { lastCompletePeriods, sendTime, type Period, type SummaryKind } from "./periods";

export interface SummaryLimits {
  /** Chats with a due summary read per run. */
  summaryCandidates: number;
  /** Summaries whose changes are read per run (one D1 batch). */
  summaryReads: number;
}

/** One chat's summary for one period, ready to send. */
export interface DueSummary {
  chatId: number;
  period: Period;
}

/** The candidates' summaries whose send time has come, in chat order. */
export function dueSummaries(
  candidates: readonly SummaryCandidate[],
  periods: Readonly<Record<SummaryKind, Period>>,
  now: number,
): DueSummary[] {
  return candidates.flatMap((candidate) =>
    candidate.due
      .filter((kind) => now >= sendTime(periods[kind].end, candidate.timeZone))
      .map((kind) => ({ chatId: candidate.chatId, period: periods[kind] })),
  );
}

export function summaryOutgoing(due: DueSummary, changes: readonly SummaryChange[]): Outgoing {
  return {
    kind: "summary",
    chatId: due.chatId,
    text: starSummary(due.period, changes),
    items: 1,
    marks: (db) => [summarySentStatement(db, due.chatId, due.period)],
  };
}

export interface PreparedSummaries {
  /** Summaries with changes, to send. */
  messages: Outgoing[];
  /** Summaries due but not read this run (over summaryReads); the next run reads them. */
  notRead: number;
  /** Summaries with no changes, marked without a message. */
  empty: number;
  /** D1 calls made. */
  calls: number;
}

/**
 * Reads the summaries due at `now` and their changes, and marks the empty
 * ones. One D1 call to find them, and up to two more when any are due.
 */
export async function prepareSummaries(db: D1Database, now: number, limits: SummaryLimits): Promise<PreparedSummaries> {
  const periods = lastCompletePeriods(now);
  const candidates = await listSummaryCandidates(db, periods, limits.summaryCandidates);
  const due = dueSummaries(candidates, periods, now);
  const read = due.slice(0, limits.summaryReads);
  if (read.length === 0) {
    return { messages: [], notRead: 0, empty: 0, calls: 1 };
  }
  const changes = await listSummaryChanges(db, read);
  const withChanges = read.flatMap((item, index) => {
    const found = changes[index] ?? [];
    return found.length > 0 ? [summaryOutgoing(item, found)] : [];
  });
  const empty = read.filter((_, index) => (changes[index] ?? []).length === 0);
  await markSummariesSent(db, empty);
  return {
    messages: withChanges,
    notRead: due.length - read.length,
    empty: empty.length,
    calls: 2 + (empty.length > 0 ? 1 : 0),
  };
}
