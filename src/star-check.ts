// The scheduled star check (Cron Trigger).
//
// 1. Check the subscribed repositories on GitHub, continuing from the cursor.
// 2. Save what changed (stars, names, descriptions) and today's gains.
// 3. Send due notifications: subscriptions whose repository has more stars
//    than the chat was last told about. A chat with several such repositories
//    gets one message. last_notified_stars is raised only after a successful
//    send, so a failed send is retried next run, with any newer stars.
//
// Notifications are sent, logged or held according to NOTIFICATIONS.
import { Api } from "grammy";
import type { AppConfig, NotificationMode } from "./config";
import {
  getStarCheckCursor,
  listDueNotifications,
  listRepositoriesToCheck,
  markNotifiedMany,
  pruneStarGains,
  recordStarCheck,
  setStarCheckCursor,
  utcDay,
  type DueNotification,
} from "./db";
import { checkStars, starCheckUpdates, type GitHubError } from "./github";
import { MAX_UPDATES_PER_MESSAGE, starNotifications } from "./messages";
import { assertNever } from "./result";
import { send, type SendError } from "./telegram";

/**
 * Per-run budgets. A Worker on the free plan may make about 50 subrequests
 * per invocation, and fetch calls and D1 queries both count. A run makes:
 *   GitHub requests (1 per 100 repositories, at most `githubRequests`)
 *   + 2 per message (the send, then one D1 batch marking it sent)
 *   + about 5 other D1 queries.
 * For 200 repositories: 2 + 2 x 20 + 5 = 47.
 */
export const DEFAULT_LIMITS = {
  /** 10 requests = up to 1,000 repositories per run. */
  githubRequests: 10,
  /** Telegram messages per run; the rest go out next run. */
  messages: 20,
  /** Due notification rows read per run. */
  dueRows: 500,
};

export type StarCheckLimits = typeof DEFAULT_LIMITS;

const RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
// The cron runs every 5 minutes; the first run after midnight UTC prunes.
const PRUNE_WINDOW_MS = 5 * 60 * 1000;

export interface StarCheckDeps {
  db: D1Database;
  githubFetch?: typeof fetch;
  telegramFetch?: typeof fetch;
  limits?: Partial<StarCheckLimits>;
}

export interface RunSummary {
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
  /** Subscriptions marked notified without sending (dry-run or not allowed). */
  notificationsSkipped: number;
  /** Due notifications this run didn't get to; the next run sends them. */
  notificationsLeft: number;
  sendErrors: SendError["kind"][];
  prunedStarGains: number | null;
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
    byChat.set(item.chatId, [...(byChat.get(item.chatId) ?? []), item]);
  }
  return [...byChat].flatMap(([chatId, items]) => {
    const deliveries: Delivery[] = [];
    for (let i = 0; i < items.length; i += MAX_UPDATES_PER_MESSAGE) {
      deliveries.push({ chatId, items: items.slice(i, i + MAX_UPDATES_PER_MESSAGE) });
    }
    return deliveries;
  });
}

function messageFor(delivery: Delivery): string {
  return starNotifications(
    delivery.items.map((item) => ({
      fullName: item.fullName,
      gained: item.starsCount - item.lastNotifiedStars,
      total: item.starsCount,
    })),
  );
}

/** One D1 call per message, so the run stays inside its subrequest budget. */
async function markDelivered(db: D1Database, delivery: Delivery): Promise<void> {
  await markNotifiedMany(db, delivery.items);
}

/** What to do after a failed send. */
type AfterFailure = "next-delivery" | "stop-sending";

/**
 * A rate limit or an unavailable Telegram stops this run's sending: the rest
 * go out next run. Other refusals only affect this chat, which stays due.
 * (GSB-10 deactivates blocked and missing chats.)
 */
export function afterSendFailure(error: SendError): AfterFailure {
  switch (error.kind) {
    case "rate-limited":
    case "unavailable":
      return "stop-sending";
    case "blocked":
    case "chat-not-found":
    case "rejected":
      return "next-delivery";
    default:
      return assertNever(error);
  }
}

interface SendContext {
  config: AppConfig;
  deps: StarCheckDeps;
  api: Api;
  summary: RunSummary;
}

async function deliver(context: SendContext, delivery: Delivery): Promise<AfterFailure | "sent"> {
  const sent = await send(() =>
    context.api.sendMessage(delivery.chatId, messageFor(delivery), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    }),
  );
  if (sent.ok) {
    await markDelivered(context.deps.db, delivery);
    context.summary.messagesSent += 1;
    return "sent";
  }
  context.summary.sendErrors.push(sent.error.kind);
  console.warn(JSON.stringify({ message: "Notification not sent", chatId: delivery.chatId, error: sent.error }));
  return afterSendFailure(sent.error);
}

async function sendAll(context: SendContext, deliveries: readonly Delivery[], maxMessages: number): Promise<void> {
  for (const [index, delivery] of deliveries.entries()) {
    if (context.summary.messagesSent + context.summary.sendErrors.length >= maxMessages) {
      context.summary.notificationsLeft += countItems(deliveries.slice(index));
      return;
    }
    const outcome = await deliver(context, delivery);
    if (outcome === "stop-sending") {
      context.summary.notificationsLeft += countItems(deliveries.slice(index + 1));
      return;
    }
  }
}

function countItems(deliveries: readonly Delivery[]): number {
  return deliveries.reduce((sum, delivery) => sum + delivery.items.length, 0);
}

// D1 statements per batch when marking skipped notifications.
const MARK_BATCH_SIZE = 100;

/**
 * Logs notifications and marks them sent without sending (dry-run, or a chat
 * outside ALLOWED_CHAT_IDS). Marks in batches, so this costs a few D1 calls
 * however many there are.
 */
async function skipAll(context: SendContext, deliveries: readonly Delivery[], reason: string): Promise<void> {
  for (const delivery of deliveries) {
    console.log(JSON.stringify({ message: "Notification skipped", reason, chatId: delivery.chatId, text: messageFor(delivery) }));
  }
  const items = deliveries.flatMap((delivery) => delivery.items);
  for (let i = 0; i < items.length; i += MARK_BATCH_SIZE) {
    await markNotifiedMany(context.deps.db, items.slice(i, i + MARK_BATCH_SIZE));
  }
  context.summary.notificationsSkipped += items.length;
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

async function notify(context: SendContext, limits: StarCheckLimits): Promise<void> {
  const mode = context.config.notifications;
  switch (mode) {
    case "off":
      // Emergency stop: nothing is sent or marked; everything stays due.
      return;
    case "dry-run": {
      // Same budget as sending, so the shadow run behaves like the real thing.
      const deliveries = groupDeliveries(await listDueNotifications(context.deps.db, limits.dueRows));
      context.summary.notificationsLeft += countItems(deliveries.slice(limits.messages));
      return skipAll(context, deliveries.slice(0, limits.messages), "dry-run");
    }
    case "on": {
      const due = await listDueNotifications(context.deps.db, limits.dueRows);
      const { allowed, notAllowed } = splitAllowed(groupDeliveries(due), context.config.allowedChatIds);
      await skipAll(context, notAllowed, "chat not in ALLOWED_CHAT_IDS");
      return sendAll(context, allowed, limits.messages);
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
    prunedStarGains: null,
  };
}

/** Runs one star check. Returns (and logs) the run summary. */
export async function runStarCheck(
  controller: Pick<ScheduledController, "scheduledTime">,
  config: AppConfig,
  deps: StarCheckDeps,
): Promise<RunSummary> {
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const summary = emptySummary(config.notifications);

  const repositories = await listRepositoriesToCheck(deps.db);
  const checked = await checkStars(
    { token: config.githubToken, fetch: deps.githubFetch },
    repositories,
    { cursor: await getStarCheckCursor(deps.db), maxRequests: limits.githubRequests },
  );
  const updates = starCheckUpdates(repositories, checked.snapshots);
  const { rowsWritten } = await recordStarCheck(deps.db, updates, utcDay(new Date(controller.scheduledTime)));
  await setStarCheckCursor(deps.db, checked.nextCursor);

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

  const api = new Api(config.telegramBotToken, deps.telegramFetch ? { fetch: deps.telegramFetch } : {});
  await notify({ config, deps, api, summary }, limits);
  summary.prunedStarGains = await pruneIfDue(deps.db, controller.scheduledTime);

  console.log(JSON.stringify({ message: "Star check finished", ...summary }));
  return summary;
}
