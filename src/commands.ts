// The bot's commands. Every outcome (GitHub lookup errors, subscribe
// outcomes, unsubscribe results) is handled with an exhaustive switch.
import type { Context } from "grammy";
import type { CommandName } from "./command-list";
import type { AppConfig } from "./config";
import {
  getStats,
  listSubscriptions,
  subscribe,
  unsubscribe,
  upsertRepository,
  utcDay,
  type Repository,
  type SubscribeOutcome,
} from "./db";
import { getRepository, type GitHubClient, type RepositoryLookupError } from "./github";
import * as messages from "./messages";
import { parseRepositoryInput, type RepositoryName } from "./repo-input";
import { assertNever } from "./result";
import { replyHtml } from "./telegram";

/** A command handler. `args` is the text after the command, trimmed. */
export type CommandHandler = (ctx: Context, args: string) => Promise<void>;

export interface CommandDeps {
  config: AppConfig;
  db: D1Database;
  github: GitHubClient;
  /** The current time (tests). */
  now?: () => Date;
}

const STATS_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

function lookupFailure(error: RepositoryLookupError, input: RepositoryName): string {
  switch (error.kind) {
    case "not-found":
      return messages.repositoryNotFound(input.owner, input.name);
    case "rate-limited":
    case "http":
    case "network":
    case "timeout":
    case "graphql":
    case "bad-response":
      return messages.githubUnavailable();
    case "unauthorized":
    case "forbidden":
      // The GitHub token is wrong, expired or lacks access: an operator
      // problem, not the user's.
      console.error(JSON.stringify({ message: "GitHub token rejected", error }));
      return messages.somethingWentWrong();
    default:
      return assertNever(error);
  }
}

interface Reply {
  text: string;
  /** Show a link preview (only for a new subscription). */
  preview: boolean;
}

function subscribeReply(outcome: SubscribeOutcome, repo: Repository, maxReposPerChat: number): Reply {
  switch (outcome) {
    case "subscribed":
      return { text: messages.subscribed(repo), preview: true };
    case "already-subscribed":
      return { text: messages.alreadySubscribed(repo.fullName), preview: false };
    case "limit-reached":
      return { text: messages.limitReached(maxReposPerChat), preview: false };
    case "unknown-repository":
      // The repository was stored just before; this would be a bug.
      throw new Error(`Repository ${repo.id} missing right after it was stored`);
    default:
      return assertNever(outcome);
  }
}

/**
 * Answers /add from the chat's own subscriptions when that's enough, before
 * any GitHub call or write: already subscribed (by name), or at the limit.
 * Null when the repository needs looking up.
 */
function precheckReply(subscriptions: readonly Repository[], input: RepositoryName, max: number): string | null {
  const wanted = `${input.owner}/${input.name}`.toLowerCase();
  const existing = subscriptions.find((repo) => repo.fullName.toLowerCase() === wanted);
  if (existing) {
    return messages.alreadySubscribed(existing.fullName);
  }
  return subscriptions.length >= max ? messages.limitReached(max) : null;
}

function chatIdOf(ctx: Context): number {
  if (ctx.chat === undefined) {
    throw new Error("Command without a chat");
  }
  return ctx.chat.id;
}

export function createCommandHandlers(deps: CommandDeps): Record<CommandName, CommandHandler> {
  const now = deps.now ?? (() => new Date());
  const max = deps.config.maxReposPerChat;

  const add: CommandHandler = async (ctx, args) => {
    if (args === "") {
      return replyHtml(ctx, messages.addUsage());
    }
    const parsed = parseRepositoryInput(args);
    if (!parsed.ok) {
      return replyHtml(ctx, messages.invalidRepository(parsed.error));
    }
    const input = parsed.value;
    const early = precheckReply(await listSubscriptions(deps.db, chatIdOf(ctx)), input, max);
    if (early !== null) {
      return replyHtml(ctx, early);
    }
    const found = await getRepository(deps.github, input.owner, input.name);
    if (!found.ok) {
      return replyHtml(ctx, lookupFailure(found.error, input));
    }
    await upsertRepository(deps.db, found.value, utcDay(now()));
    const reply = subscribeReply(await subscribe(deps.db, chatIdOf(ctx), found.value.id, max), found.value, max);
    return replyHtml(ctx, reply.text, { preview: reply.preview });
  };

  const remove: CommandHandler = async (ctx, args) => {
    if (args === "") {
      return replyHtml(ctx, messages.removeUsage());
    }
    const parsed = parseRepositoryInput(args);
    if (!parsed.ok) {
      return replyHtml(ctx, messages.invalidRepository(parsed.error));
    }
    const input = parsed.value;
    const removed = await unsubscribe(deps.db, chatIdOf(ctx), `${input.owner}/${input.name}`);
    return replyHtml(
      ctx,
      removed.ok ? messages.unsubscribed(removed.value) : messages.notSubscribed(input.owner, input.name),
    );
  };

  return {
    start: (ctx) => replyHtml(ctx, messages.welcome()),
    help: (ctx) => replyHtml(ctx, messages.help(max)),
    add,
    list: async (ctx) => {
      for (const page of messages.subscriptionList(await listSubscriptions(deps.db, chatIdOf(ctx)), max)) {
        await replyHtml(ctx, page);
      }
    },
    remove,
    stats: async (ctx) => {
      const since = utcDay(new Date(now().getTime() - (STATS_DAYS - 1) * DAY_MS));
      return replyHtml(ctx, messages.stats(await getStats(deps.db, since), STATS_DAYS));
    },
  };
}

/**
 * In private chats, a repository sent as plain text (owner/repo or a GitHub
 * URL) is treated as /add, and other text gets a hint. Groups ignore plain
 * text: sharing a link there, or saying "and/or", must not subscribe the
 * whole group. Groups use /add.
 */
export async function handlePlainText(
  ctx: Context,
  text: string,
  handlers: Record<CommandName, CommandHandler>,
): Promise<void> {
  if (ctx.chat?.type !== "private") {
    return;
  }
  return parseRepositoryInput(text).ok ? handlers.add(ctx, text) : replyHtml(ctx, messages.plainTextHint());
}
