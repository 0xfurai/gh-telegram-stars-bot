// The scheduled star check (Cron Trigger).
//
// 1. Check the subscribed repositories on GitHub, continuing from the cursor.
// 2. Save what changed (stars, names, descriptions) and today's gains.
// 3. Send due notifications: subscriptions whose repository's star count
//    differs from what the chat was last told. Gains go at once; losses wait
//    until the subscription hasn't been notified for LOSS_COOLDOWN_MS, so a
//    flapping count can't send a message every run. A chat with several due
//    repositories gets one message. last_notified_stars is set only after a
//    successful send, so a failed send is retried next run, with the newer
//    count.
// 4. Send due weekly, monthly and yearly summaries (summaries.ts), with the
//    message slots notifications left. On the first day of a period, step 2
//    also stores the star counts the summaries compare.
//
// Notifications and summaries are sent, logged or held according to NOTIFICATIONS. A run
// lock keeps two runs from overlapping and sending the same notification.
import { Api } from "grammy";
import { chunk } from "./chunk";
import type { AppConfig, NotificationMode } from "./config";
import {
  acquireStarCheckLock,
  listDueNotifications,
  loadStarCheck,
  notifiedStatements,
  pruneOldData,
  recordStarCheck,
  releaseStarCheckLock,
  utcDay,
  type DueNotification,
} from "./db";
import {
  attempts,
  sendAll,
  skipAll,
  splitAllowed,
  SUBREQUESTS_PER_MESSAGE,
  tally,
  type Outgoing,
  type SendContext,
} from "./delivery";
import { errorMessage } from "./errors";
import { checkStars, starCheckUpdates, type GitHubError } from "./github";
import { MAX_UPDATES_PER_MESSAGE, starNotifications } from "./messages";
import { isSnapshotDay } from "./periods";
import { assertNever } from "./result";
import { prepareSummaries } from "./summaries";
import type { SendError } from "./telegram";

/**
 * Subrequests a run may use. The free plan allows about 50 per invocation,
 * fetch calls and D1 queries alike; 5 stay in reserve for monitoring.
 */
export const SUBREQUEST_BUDGET = 45;

/**
 * D1 calls every run makes besides sending: take the lock, load, save, list
 * the due notifications, list the due summaries, prune (first run of the
 * day), release the lock.
 */
const FIXED_D1_CALLS = 7;

export const DEFAULT_LIMITS = {
  /** 10 requests = up to 1,000 repositories per run. */
  githubRequests: 10,
  /** At most this many messages, and fewer when the subrequest budget is tighter. */
  messages: 20,
  /** Due notification rows read per run. */
  dueRows: 500,
  /** Chats with a due summary read per run. */
  summaryCandidates: 500,
  /** Summaries whose changes are read per run, in one D1 batch. */
  summaryReads: 50,
};

export type StarCheckLimits = typeof DEFAULT_LIMITS;

const RETENTION_DAYS = 90;
// Snapshots are kept long enough for the yearly summary's start of the year.
const SNAPSHOT_RETENTION_DAYS = 400;
const DAY_MS = 24 * 60 * 60 * 1000;
// The cron runs every 5 minutes; the first run after midnight UTC prunes.
const PRUNE_WINDOW_MS = 5 * 60 * 1000;
// A run takes at most about 5 minutes (10 GitHub requests and 20 sends, each
// with a 10 s timeout); a crashed run's lock expires after 10.
const LOCK_TTL_MS = 10 * 60 * 1000;
const TELEGRAM_TIMEOUT_SECONDS = 10;

export interface StarCheckDeps {
  db: D1Database;
  githubFetch?: typeof fetch;
  telegramFetch?: typeof fetch;
  limits?: Partial<StarCheckLimits>;
}

export interface RunSummary {
  /** Set when the run didn't happen. */
  skipped: "another-run-in-progress" | null;
  notifications: NotificationMode;
  repositoriesChecked: number;
  repositoriesChanged: number;
  missingRepositories: number;
  invalidRepositories: number;
  githubRequests: number;
  githubError: GitHubError | null;
  rateLimitRemaining: number | null;
  rowsWritten: number;
  /** Messages Telegram accepted: notifications and summaries. */
  messagesSent: number;
  /** Subscriptions notified (a message can cover several). */
  notificationsSent: number;
  /** Subscriptions marked notified without sending (dry-run, not allowed, or rejected). */
  notificationsSkipped: number;
  /** Due notifications this run didn't get to; the next run sends them. */
  notificationsLeft: number;
  sendErrors: SendError["kind"][];
  /** Chats marked inactive because Telegram said they blocked the bot or are gone. */
  chatsDeactivated: number;
  /** Groups that became supergroups; their subscriptions moved to the new ID. */
  chatsMigrated: number;
  /**
   * Notifications not tried because their chat became unreachable earlier in
   * this run. They stay due for when the chat is reachable again.
   */
  notificationsForUnreachableChats: number;
  summariesSent: number;
  /** Summaries marked sent without sending (dry-run, not allowed, or rejected). */
  summariesSkipped: number;
  /** Due summaries with no changes: marked sent, no message. */
  summariesEmpty: number;
  /** Due summaries this run didn't get to; a later run sends them. */
  summariesLeft: number;
  /** Summaries not tried because their chat became unreachable earlier in this run. */
  summariesForUnreachableChats: number;
  prunedStarGains: number | null;
  prunedSnapshots: number | null;
  /** Subrequests this run used, out of SUBREQUEST_BUDGET. */
  subrequests: number;
}

/** One notification message: a chat and up to MAX_UPDATES_PER_MESSAGE repositories. */
interface Delivery {
  chatId: number;
  items: DueNotification[];
}

/** Groups due notifications into messages, one per chat (split if long). */
export function groupDeliveries(due: readonly DueNotification[]): Delivery[] {
  const byChat = new Map<number, DueNotification[]>();
  for (const item of due) {
    const items = byChat.get(item.chatId);
    if (items) {
      items.push(item);
    } else {
      byChat.set(item.chatId, [item]);
    }
  }
  return [...byChat].flatMap(([chatId, items]) =>
    chunk(items, MAX_UPDATES_PER_MESSAGE).map((part) => ({ chatId, items: part })),
  );
}

function messageFor(delivery: Delivery): string {
  return starNotifications(
    delivery.items.map((item) => ({
      fullName: item.fullName,
      change: item.starsCount - item.lastNotifiedStars,
      total: item.starsCount,
    })),
  );
}

function notificationOutgoing(delivery: Delivery): Outgoing {
  return {
    kind: "notification",
    chatId: delivery.chatId,
    text: messageFor(delivery),
    items: delivery.items.length,
    marks: (db, at) => notifiedStatements(db, delivery.items, at),
  };
}

/** Messages this run can still afford, within the limit and the subrequest budget. */
function messageBudget(summary: RunSummary, limits: StarCheckLimits, extraCalls: number): number {
  const spare = SUBREQUEST_BUDGET - FIXED_D1_CALLS - summary.githubRequests - extraCalls;
  return Math.max(0, Math.min(limits.messages, Math.floor(spare / SUBREQUESTS_PER_MESSAGE)));
}

/** A flapping count sends at most one gain and one loss per subscription in this time. */
export const LOSS_COOLDOWN_MS = 60 * 60 * 1000;

async function listDue(context: SendContext, limits: StarCheckLimits): Promise<Outgoing[]> {
  const lossesAfter = new Date(context.now - LOSS_COOLDOWN_MS).toISOString();
  const due = await listDueNotifications(context.db, limits.dueRows, lossesAfter);
  return groupDeliveries(due).map(notificationOutgoing);
}

async function notify(context: SendContext, limits: StarCheckLimits): Promise<number> {
  const mode = context.config.notifications;
  switch (mode) {
    case "off":
      // Emergency stop: nothing is sent or marked; everything stays due.
      return 0;
    case "dry-run":
      return skipWithinBudget(context, await listDue(context, limits), messageBudget(context.summary, limits, 0));
    case "on": {
      const messages = await listDue(context, limits);
      return sendOrSkip(context, messages, (skipCalls) => messageBudget(context.summary, limits, skipCalls));
    }
    default:
      return assertNever(mode);
  }
}

/**
 * dry-run: logs and marks at most `max` messages, the same budget as sending,
 * so the shadow run behaves like the real thing. Returns the D1 calls made.
 */
function skipWithinBudget(context: SendContext, messages: readonly Outgoing[], max: number): Promise<number> {
  tally(context.summary, messages.slice(max), "left");
  return skipAll(context, messages.slice(0, max), "dry-run");
}

/**
 * on: skips chats outside ALLOWED_CHAT_IDS, then sends to the rest until
 * this run has tried `maxAttempts(skipCalls)` messages in all. Returns the
 * subrequests used: skip batches, plus a send and a mark per attempt.
 */
async function sendOrSkip(
  context: SendContext,
  messages: readonly Outgoing[],
  maxAttempts: (skipCalls: number) => number,
): Promise<number> {
  const before = attempts(context.summary);
  const { allowed, notAllowed } = splitAllowed(messages, context.config.allowedChatIds);
  const skipCalls = await skipAll(context, notAllowed, "chat not in ALLOWED_CHAT_IDS");
  await sendAll(context, allowed, maxAttempts(skipCalls));
  return skipCalls + (attempts(context.summary) - before) * SUBREQUESTS_PER_MESSAGE;
}

/**
 * Summaries, with what notifications left of the budget (`callsSoFar` is
 * what notifications used). Returns the subrequests used, besides the fixed
 * query for due summaries.
 */
async function summarize(context: SendContext, limits: StarCheckLimits, callsSoFar: number): Promise<number> {
  const mode = context.config.notifications;
  if (mode === "off") {
    // Nothing is sent or marked; summaries stay due.
    return 0;
  }
  const prepared = await prepareSummaries(context.db, context.now, limits);
  Object.assign(context.summary, {
    summariesLeft: context.summary.summariesLeft + prepared.notRead,
    summariesEmpty: prepared.empty,
  });
  const extra = prepared.calls - 1;
  const budget = (skipCalls: number) =>
    Math.min(limits.messages - attempts(context.summary), messageBudget(context.summary, limits, callsSoFar + extra + skipCalls));
  switch (mode) {
    case "dry-run":
      return extra + (await skipWithinBudget(context, prepared.messages, budget(0)));
    case "on":
      return extra + (await sendOrSkip(context, prepared.messages, (skipCalls) => attempts(context.summary) + budget(skipCalls)));
    default:
      return assertNever(mode);
  }
}

/** True for the first run after midnight UTC. */
export function isPruneRun(scheduledTime: number): boolean {
  return scheduledTime % DAY_MS < PRUNE_WINDOW_MS;
}

async function pruneIfDue(db: D1Database, scheduledTime: number, summary: RunSummary): Promise<void> {
  if (!isPruneRun(scheduledTime)) {
    return;
  }
  const daysAgo = (days: number) => utcDay(new Date(scheduledTime - (days - 1) * DAY_MS));
  const pruned = await pruneOldData(db, daysAgo(RETENTION_DAYS), daysAgo(SNAPSHOT_RETENTION_DAYS));
  summary.prunedStarGains = pruned.starGains;
  summary.prunedSnapshots = pruned.snapshots;
}

function emptySummary(mode: NotificationMode): RunSummary {
  return {
    skipped: null,
    notifications: mode,
    repositoriesChecked: 0,
    repositoriesChanged: 0,
    missingRepositories: 0,
    invalidRepositories: 0,
    githubRequests: 0,
    githubError: null,
    rateLimitRemaining: null,
    rowsWritten: 0,
    messagesSent: 0,
    notificationsSent: 0,
    notificationsSkipped: 0,
    notificationsLeft: 0,
    sendErrors: [],
    chatsDeactivated: 0,
    chatsMigrated: 0,
    notificationsForUnreachableChats: 0,
    summariesSent: 0,
    summariesSkipped: 0,
    summariesEmpty: 0,
    summariesLeft: 0,
    summariesForUnreachableChats: 0,
    prunedStarGains: null,
    prunedSnapshots: null,
    subrequests: 0,
  };
}

async function checkAndSave(
  controller: Pick<ScheduledController, "scheduledTime">,
  config: AppConfig,
  deps: StarCheckDeps,
  limits: StarCheckLimits,
  summary: RunSummary,
): Promise<void> {
  const { repositories, cursor } = await loadStarCheck(deps.db);
  const checked = await checkStars({ token: config.githubToken, fetch: deps.githubFetch }, repositories, {
    cursor,
    maxRequests: limits.githubRequests,
  });
  const updates = starCheckUpdates(repositories, checked.snapshots);
  const day = utcDay(new Date(controller.scheduledTime));
  const { rowsWritten } = await recordStarCheck(deps.db, updates, day, checked.nextCursor, {
    snapshot: isSnapshotDay(day),
  });

  Object.assign(summary, {
    repositoriesChecked: checked.snapshots.length,
    repositoriesChanged: updates.length,
    missingRepositories: checked.missingNodeIds.length,
    invalidRepositories: checked.invalidNodeIds.length,
    githubRequests: checked.requests,
    githubError: checked.error,
    rateLimitRemaining: checked.rateLimit?.remaining ?? null,
    rowsWritten,
  });
}

/**
 * Releases the lock after a failed run, logging (not throwing) a failed
 * release, so the run's own error is the one reported. The lock then
 * expires by itself after LOCK_TTL_MS.
 */
async function releaseLockAfterFailure(db: D1Database): Promise<void> {
  try {
    await releaseStarCheckLock(db);
  } catch (error) {
    console.error(
      JSON.stringify({ message: "Star check lock not released; it expires by itself", error: errorMessage(error) }),
    );
  }
}

/** The run itself, while holding the lock. */
async function checkAndNotify(
  controller: Pick<ScheduledController, "scheduledTime">,
  config: AppConfig,
  deps: StarCheckDeps,
  limits: StarCheckLimits,
  summary: RunSummary,
): Promise<void> {
  await checkAndSave(controller, config, deps, limits, summary);
  const api = new Api(config.telegramBotToken, {
    timeoutSeconds: TELEGRAM_TIMEOUT_SECONDS,
    ...(deps.telegramFetch ? { fetch: deps.telegramFetch } : {}),
  });
  const context: SendContext = { config, db: deps.db, api, summary, unreachable: new Set(), now: controller.scheduledTime };
  const notifyCalls = await notify(context, limits);
  const summaryCalls = await summarize(context, limits, notifyCalls);
  await pruneIfDue(deps.db, controller.scheduledTime, summary);
  summary.subrequests = FIXED_D1_CALLS + summary.githubRequests + notifyCalls + summaryCalls;
}

/**
 * Runs one star check. Returns (and logs) the run summary. A failed lock
 * release after a successful run fails the run, so it's recorded and
 * alerted on: the next runs would skip until the lock expires.
 */
export async function runStarCheck(
  controller: Pick<ScheduledController, "scheduledTime">,
  config: AppConfig,
  deps: StarCheckDeps,
): Promise<RunSummary> {
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const summary = emptySummary(config.notifications);
  const now = Date.now();

  if (!(await acquireStarCheckLock(deps.db, now, now + LOCK_TTL_MS))) {
    summary.skipped = "another-run-in-progress";
    console.log(JSON.stringify({ message: "Star check skipped: another run is in progress" }));
    return summary;
  }
  try {
    await checkAndNotify(controller, config, deps, limits, summary);
  } catch (error) {
    await releaseLockAfterFailure(deps.db);
    throw error;
  }
  await releaseStarCheckLock(deps.db);

  console.log(JSON.stringify({ message: "Star check finished", ...summary }));
  return summary;
}
