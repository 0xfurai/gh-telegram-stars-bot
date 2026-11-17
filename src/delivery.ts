// Sending the star check's messages: star notifications and summaries share
// one send loop, one failure policy and one subrequest count.
//
// A message is marked sent only after Telegram accepts it, so a failed send
// is retried by a later run.
import type { Api } from "grammy";
import { chunk } from "./chunk";
import type { AppConfig } from "./config";
import { deactivateChat, migrateChat } from "./db";
import { errorMessage } from "./errors";
import { assertNever } from "./result";
import type { RunSummary } from "./star-check";
import { send, type SendError } from "./telegram";

/** Each message costs the send plus one D1 call (marking it, or the chat). */
export const SUBREQUESTS_PER_MESSAGE = 2;

// D1 statements per batch when marking skipped messages.
const MARK_BATCH_SIZE = 100;

export type OutgoingKind = "notification" | "summary";

/** One message to send. */
export interface Outgoing {
  kind: OutgoingKind;
  chatId: number;
  text: string;
  /** Notifications (or summaries) it covers, for the run summary. */
  items: number;
  /** The statements that record it as sent; run in one D1 batch. */
  marks: (db: D1Database, at: string) => D1PreparedStatement[];
}

type Counter = "sent" | "skipped" | "left" | "unreachable";
type CountField = { [K in keyof RunSummary]: RunSummary[K] extends number ? K : never }[keyof RunSummary];

const COUNTERS: Record<OutgoingKind, Record<Counter, CountField>> = {
  notification: {
    sent: "notificationsSent",
    skipped: "notificationsSkipped",
    left: "notificationsLeft",
    unreachable: "notificationsForUnreachableChats",
  },
  summary: {
    sent: "summariesSent",
    skipped: "summariesSkipped",
    left: "summariesLeft",
    unreachable: "summariesForUnreachableChats",
  },
};

/** Adds the items of `messages` to the run summary's `counter`. */
export function tally(summary: RunSummary, messages: readonly Outgoing[], counter: Counter): void {
  for (const message of messages) {
    summary[COUNTERS[message.kind][counter]] += message.items;
  }
}

/** What the send loop does after one message. */
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
 * - A blocked or missing chat is deactivated. Its messages stay due for
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

export interface SendContext {
  config: AppConfig;
  db: D1Database;
  api: Api;
  summary: RunSummary;
  /** Chats deactivated or migrated during this run: their remaining messages are skipped. */
  unreachable: Set<number>;
  /** The run's time (its scheduled time), recorded as when chats were notified. */
  now: number;
}

function at(context: SendContext): string {
  return new Date(context.now).toISOString();
}

/**
 * Marks a message sent. If that fails after Telegram accepted it, the chat
 * may get it again next run: log that, and stop sending, because D1 is
 * likely down.
 */
async function markSent(context: SendContext, message: Outgoing): Promise<Next> {
  try {
    await context.db.batch(message.marks(context.db, at(context)));
    return "next-delivery";
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "Message sent but not marked; it may be sent again",
        kind: message.kind,
        chatId: message.chatId,
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
      if (await deactivateChat(context.db, chatId, sendStartedAt)) {
        context.summary.chatsDeactivated += 1;
      }
      context.unreachable.add(chatId);
      return;
    case "migrate":
      await migrateChat(context.db, chatId, effect.newChatId);
      context.summary.chatsMigrated += 1;
      context.unreachable.add(chatId);
      return;
    default:
      assertNever(effect);
  }
}

/** Stop wins: if either step says stop, the run stops sending. */
function worstOf(a: Next, b: Next): Next {
  return a === "stop-sending" || b === "stop-sending" ? "stop-sending" : "next-delivery";
}

async function onSendFailure(
  context: SendContext,
  message: Outgoing,
  error: SendError,
  sendStartedAt: string,
): Promise<Next> {
  context.summary.sendErrors.push(error.kind);
  console.warn(JSON.stringify({ message: "Message not sent", kind: message.kind, chatId: message.chatId, error }));
  const policy = failurePolicy(error);
  try {
    await applyChatEffect(context, message.chatId, policy.chat, sendStartedAt);
  } catch (effectError) {
    console.error(
      JSON.stringify({ message: "Chat not updated after a failed send", chatId: message.chatId, error: errorMessage(effectError) }),
    );
    return "stop-sending";
  }
  switch (policy.notification) {
    case "retry":
      return policy.sending;
    case "drop":
      tally(context.summary, [message], "skipped");
      return worstOf(await markSent(context, message), policy.sending);
    default:
      return assertNever(policy.notification);
  }
}

async function deliver(context: SendContext, message: Outgoing): Promise<Next> {
  const sendStartedAt = new Date().toISOString();
  const sent = await send(() =>
    context.api.sendMessage(message.chatId, message.text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    }),
  );
  if (!sent.ok) {
    return onSendFailure(context, message, sent.error, sendStartedAt);
  }
  context.summary.messagesSent += 1;
  tally(context.summary, [message], "sent");
  return markSent(context, message);
}

/** Messages this run tried to send, notifications and summaries alike. */
export function attempts(summary: RunSummary): number {
  return summary.messagesSent + summary.sendErrors.length;
}

/** Sends `messages` until this run has tried `maxAttempts` in all; the rest stay due. */
export async function sendAll(context: SendContext, messages: readonly Outgoing[], maxAttempts: number): Promise<void> {
  for (const [index, message] of messages.entries()) {
    if (context.unreachable.has(message.chatId)) {
      tally(context.summary, [message], "unreachable");
      continue;
    }
    if (attempts(context.summary) >= maxAttempts) {
      tally(context.summary, messages.slice(index), "left");
      return;
    }
    const next = await deliver(context, message);
    switch (next) {
      case "next-delivery":
        break;
      case "stop-sending":
        tally(context.summary, messages.slice(index + 1), "left");
        return;
      default:
        assertNever(next);
    }
  }
}

/**
 * Logs messages and marks them sent without sending (dry-run, or a chat
 * outside ALLOWED_CHAT_IDS), in batches. Returns the D1 calls it made.
 */
export async function skipAll(context: SendContext, messages: readonly Outgoing[], reason: string): Promise<number> {
  for (const message of messages) {
    console.log(
      JSON.stringify({ message: "Notification skipped", kind: message.kind, reason, chatId: message.chatId, text: message.text }),
    );
  }
  const batches = chunk(
    messages.flatMap((message) => message.marks(context.db, at(context))),
    MARK_BATCH_SIZE,
  );
  for (const batch of batches) {
    await context.db.batch(batch);
  }
  tally(context.summary, messages, "skipped");
  return batches.length;
}

/** In staging, messages only go to ALLOWED_CHAT_IDS; the rest are skipped. */
export function splitAllowed(messages: readonly Outgoing[], allowed: ReadonlySet<number> | null) {
  if (allowed === null) {
    return { allowed: [...messages], notAllowed: [] };
  }
  return {
    allowed: messages.filter((m) => allowed.has(m.chatId)),
    notAllowed: messages.filter((m) => !allowed.has(m.chatId)),
  };
}
