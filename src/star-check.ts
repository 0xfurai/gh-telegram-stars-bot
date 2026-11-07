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
//
// Notifications are sent, logged or held according to NOTIFICATIONS. A run
// lock keeps two runs from overlapping and sending the same notification.
import { Api } from "grammy";
import { chunk } from "./chunk";
import type { AppConfig, NotificationMode } from "./config";
import {
  acquireStarCheckLock,
  listDueNotifications,
  loadStarCheck,
  markNotifiedMany,
  pruneStarGains,
  recordStarCheck,
  deactivateChat,
  migrateChat,
  releaseStarCheckLock,
  utcDay,
  type DueNotification,
} from "./db";
import { checkStars, starCheckUpdates, type GitHubError } from "./github";
import { MAX_UPDATES_PER_MESSAGE, starNotifications } from "./messages";
import { assertNever } from "./result";
import { send, type SendError } from "./telegram";
import { errorMessage } from "./errors";

/**
 * Subrequests a run may use. The free plan allows about 50 per invocation,
 * fetch calls and D1 queries alike; 5 stay in reserve for monitoring.
 */
export const SUBREQUEST_BUDGET = 45;

/**
 * D1 calls every run makes besides sending: take the lock, load, save, list
 * the due notifications, prune (first run of the day), release the lock.
 */
const FIXED_D1_CALLS = 6;

/** Each message costs the send plus one D1 call (marking it, or the chat). */
const SUBREQUESTS_PER_MESSAGE = 2;

export const DEFAULT_LIMITS = {
  /** 10 requests = up to 1,000 repositories per run. */
  githubRequests: 10,
  /** At most this many messages, and fewer when the subrequest budget is tighter. */
  messages: 20,
  /** Due notification rows read per run. */
  dueRows: 500,
};

export type StarCheckLimits = typeof DEFAULT_LIMITS;

const RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
// The cron runs every 5 minutes; the first run after midnight UTC prunes.
const PRUNE_WINDOW_MS = 5 * 60 * 1000;
// A run takes at most about 5 minutes (10 GitHub requests and 20 sends, each
// with a 10 s timeout); a crashed run's lock expires after 10.
const LOCK_TTL_MS = 10 * 60 * 1000;
const TELEGRAM_TIMEOUT_SECONDS = 10;
// D1 statements per batch when marking skipped notifications.
const MARK_BATCH_SIZE = 100;

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
  messagesSent: number;
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
  prunedStarGains: number | null;
  /** Subrequests this run used, out of SUBREQUEST_BUDGET. */
  subrequests: number;
}

/** One message to send: a chat and up to MAX_UPDATES_PER_MESSAGE repositories. */
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

function countItems(deliveries: readonly Delivery[]): number {
  return deliveries.reduce((sum, delivery) => sum + delivery.items.length, 0);
}

/** What the send loop does after one delivery. */
type Next = "next-delivery" | "stop-sending";

/** What happens to the chat after a failed send. */
export type ChatEffect =
  | { kind: "keep" }
  /** The bot can't reach the chat: mark it inactive until it's reachable again. */
  | { kind: "deactivate" }
  /** The group became a supergroup: move its subscriptions to the new ID. */
  | { kind: "migrate"; newChatId: number };

export interface FailurePolicy {
  chat: ChatEffect;
  /** retry: stays due (next run, or once the chat is reachable). drop: marked sent. */
  notification: "retry" | "drop";
  sending: Next;
}

/**
 * Every send failure's handling, in one exhaustive place.
 *
 * - A rate limit or an unavailable Telegram stops this run's sending; the
 *   rest go out next run.
 * - A blocked or missing chat is deactivated. Its notifications stay due for
 *   when the chat is reachable again: the user unblocks the bot, the bot is
 *   added back to the group (my_chat_member), or the chat sends a command.
 * - A group that became a supergroup moves to its new ID; next run sends there.
 * - A message Telegram rejects (likely our bug, e.g. bad HTML) is dropped, so
 *   it can't take a message slot every run; newer stars produce a new message.
 */
export function failurePolicy(error: SendError): FailurePolicy {
  switch (error.kind) {
    case "rate-limited":
    case "unavailable":
      return { chat: { kind: "keep" }, notification: "retry", sending: "stop-sending" };
    case "blocked":
    case "chat-not-found":
      return { chat: { kind: "deactivate" }, notification: "retry", sending: "next-delivery" };
    case "chat-migrated":
      return { chat: { kind: "migrate", newChatId: error.newChatId }, notification: "retry", sending: "next-delivery" };
    case "rejected":
      return { chat: { kind: "keep" }, notification: "drop", sending: "next-delivery" };
    default:
      return assertNever(error);
  }
}

interface SendContext {
  config: AppConfig;
  deps: StarCheckDeps;
  api: Api;
  summary: RunSummary;
  /** Chats deactivated or migrated during this run: their remaining messages are skipped. */
  unreachable: Set<number>;
  /** The run's time (its scheduled time), recorded as when chats were notified. */
  now: number;
}

/**
 * Marks a delivery sent. If that fails after Telegram accepted the message,
 * the chat may get it again next run: log that, and stop sending, because D1
 * is likely down.
 */
async function markSent(context: SendContext, delivery: Delivery): Promise<Next> {
  try {
    await markNotifiedMany(context.deps.db, delivery.items, new Date(context.now).toISOString());
    return "next-delivery";
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "Notification sent but not marked; it may be sent again",
        chatId: delivery.chatId,
        error: errorMessage(error),
      }),
    );
    return "stop-sending";
  }
}

/** Applies a chat effect. This is the D1 call the message's mark would have used. */
async function applyChatEffect(context: SendContext, chatId: number, effect: ChatEffect, sendStartedAt: string) {
  switch (effect.kind) {
    case "keep":
      return;
    case "deactivate":
      // Skipped if the chat was reactivated after this send started.
      if (await deactivateChat(context.deps.db, chatId, sendStartedAt)) {
        context.summary.chatsDeactivated += 1;
      }
      context.unreachable.add(chatId);
      return;
    case "migrate":
      await migrateChat(context.deps.db, chatId, effect.newChatId);
      context.summary.chatsMigrated += 1;
      context.unreachable.add(chatId);
      return;
    default:
      assertNever(effect);
  }
}

async function onSendFailure(
  context: SendContext,
  delivery: Delivery,
  error: SendError,
  sendStartedAt: string,
): Promise<Next> {
  context.summary.sendErrors.push(error.kind);
  console.warn(JSON.stringify({ message: "Notification not sent", chatId: delivery.chatId, error }));
  const policy = failurePolicy(error);
  try {
    await applyChatEffect(context, delivery.chatId, policy.chat, sendStartedAt);
  } catch (effectError) {
    console.error(
      JSON.stringify({ message: "Chat not updated after a failed send", chatId: delivery.chatId, error: errorMessage(effectError) }),
    );
    return "stop-sending";
  }
  switch (policy.notification) {
    case "retry":
      return policy.sending;
    case "drop":
      context.summary.notificationsSkipped += delivery.items.length;
      return worstOf(await markSent(context, delivery), policy.sending);
    default:
      return assertNever(policy.notification);
  }
}

/** Stop wins: if either step says stop, the run stops sending. */
function worstOf(a: Next, b: Next): Next {
  return a === "stop-sending" || b === "stop-sending" ? "stop-sending" : "next-delivery";
}

async function deliver(context: SendContext, delivery: Delivery): Promise<Next> {
  const sendStartedAt = new Date().toISOString();
  const sent = await send(() =>
    context.api.sendMessage(delivery.chatId, messageFor(delivery), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    }),
  );
  if (!sent.ok) {
    return onSendFailure(context, delivery, sent.error, sendStartedAt);
  }
  context.summary.messagesSent += 1;
  return markSent(context, delivery);
}

function attempts(summary: RunSummary): number {
  return summary.messagesSent + summary.sendErrors.length;
}

async function sendAll(context: SendContext, deliveries: readonly Delivery[], maxMessages: number): Promise<void> {
  for (const [index, delivery] of deliveries.entries()) {
    if (context.unreachable.has(delivery.chatId)) {
      context.summary.notificationsForUnreachableChats += delivery.items.length;
      continue;
    }
    if (attempts(context.summary) >= maxMessages) {
      context.summary.notificationsLeft += countItems(deliveries.slice(index));
      return;
    }
    const next = await deliver(context, delivery);
    switch (next) {
      case "next-delivery":
        break;
      case "stop-sending":
        context.summary.notificationsLeft += countItems(deliveries.slice(index + 1));
        return;
      default:
        assertNever(next);
    }
  }
}

/**
 * Logs notifications and marks them sent without sending (dry-run, or a chat
 * outside ALLOWED_CHAT_IDS), in batches. Returns the D1 calls it made.
 */
async function skipAll(context: SendContext, deliveries: readonly Delivery[], reason: string): Promise<number> {
  for (const delivery of deliveries) {
    console.log(JSON.stringify({ message: "Notification skipped", reason, chatId: delivery.chatId, text: messageFor(delivery) }));
  }
  const batches = chunk(deliveries.flatMap((delivery) => delivery.items), MARK_BATCH_SIZE);
  for (const batch of batches) {
    await markNotifiedMany(context.deps.db, batch, new Date(context.now).toISOString());
    context.summary.notificationsSkipped += batch.length;
  }
  return batches.length;
}

/** In staging, notifications only go to ALLOWED_CHAT_IDS; the rest are skipped. */
function splitAllowed(deliveries: readonly Delivery[], allowed: ReadonlySet<number> | null) {
  if (allowed === null) {
    return { allowed: [...deliveries], notAllowed: [] };
  }
  return {
    allowed: deliveries.filter((d) => allowed.has(d.chatId)),
    notAllowed: deliveries.filter((d) => !allowed.has(d.chatId)),
  };
}

/** Messages this run can still afford, within the limit and the subrequest budget. */
function messageBudget(summary: RunSummary, limits: StarCheckLimits, extraCalls: number): number {
  const spare = SUBREQUEST_BUDGET - FIXED_D1_CALLS - summary.githubRequests - extraCalls;
  return Math.max(0, Math.min(limits.messages, Math.floor(spare / SUBREQUESTS_PER_MESSAGE)));
}

/** A flapping count sends at most one gain and one loss per subscription in this time. */
export const LOSS_COOLDOWN_MS = 60 * 60 * 1000;

function listDue(context: SendContext, limits: StarCheckLimits): Promise<DueNotification[]> {
  const lossesAfter = new Date(context.now - LOSS_COOLDOWN_MS).toISOString();
  return listDueNotifications(context.deps.db, limits.dueRows, lossesAfter);
}

async function notify(context: SendContext, limits: StarCheckLimits): Promise<number> {
  const mode = context.config.notifications;
  switch (mode) {
    case "off":
      // Emergency stop: nothing is sent or marked; everything stays due.
      return 0;
    case "dry-run": {
      // Same budget as sending, so the shadow run behaves like the real thing.
      const deliveries = groupDeliveries(await listDue(context, limits));
      const max = messageBudget(context.summary, limits, 0);
      context.summary.notificationsLeft += countItems(deliveries.slice(max));
      return skipAll(context, deliveries.slice(0, max), "dry-run");
    }
    case "on": {
      const due = await listDue(context, limits);
      const { allowed, notAllowed } = splitAllowed(groupDeliveries(due), context.config.allowedChatIds);
      const skipCalls = await skipAll(context, notAllowed, "chat not in ALLOWED_CHAT_IDS");
      await sendAll(context, allowed, messageBudget(context.summary, limits, skipCalls));
      return skipCalls + attempts(context.summary) * SUBREQUESTS_PER_MESSAGE;
    }
    default:
      return assertNever(mode);
  }
}

/** True for the first run after midnight UTC. */
export function isPruneRun(scheduledTime: number): boolean {
  return scheduledTime % DAY_MS < PRUNE_WINDOW_MS;
}

async function pruneIfDue(db: D1Database, scheduledTime: number): Promise<number | null> {
  if (!isPruneRun(scheduledTime)) {
    return null;
  }
  return pruneStarGains(db, utcDay(new Date(scheduledTime - (RETENTION_DAYS - 1) * DAY_MS)));
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
    notificationsSkipped: 0,
    notificationsLeft: 0,
    sendErrors: [],
    chatsDeactivated: 0,
    chatsMigrated: 0,
    notificationsForUnreachableChats: 0,
    prunedStarGains: null,
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
  const { rowsWritten } = await recordStarCheck(deps.db, updates, day, checked.nextCursor);

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
  const sendCalls = await notify(
    { config, deps, api, summary, unreachable: new Set(), now: controller.scheduledTime },
    limits,
  );
  summary.prunedStarGains = await pruneIfDue(deps.db, controller.scheduledTime);
  summary.subrequests = FIXED_D1_CALLS + summary.githubRequests + sendCalls;
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
