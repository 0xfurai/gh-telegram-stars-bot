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

function subscribeReply(outcome: SubscribeOutcome, repo: Repository, maxReposPerChat: number): string {
  switch (outcome) {
    case "subscribed":
      return messages.subscribed(repo);
    case "already-subscribed":
      return messages.alreadySubscribed(repo.fullName);
    case "limit-reached":
      return messages.limitReached(maxReposPerChat);
    case "unknown-repository":
      // The repository was stored just before; this would be a bug.
      throw new Error(`Repository ${repo.id} missing right after it was stored`);
    default:
      return assertNever(outcome);
  }
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
    const input = parseRepositoryInput(args);
    if (input === null) {
      return replyHtml(ctx, messages.invalidRepository());
    }
    const found = await getRepository(deps.github, input.owner, input.name);
    if (!found.ok) {
      return replyHtml(ctx, lookupFailure(found.error, input));
    }
    await upsertRepository(deps.db, found.value, utcDay(now()));
    const outcome = await subscribe(deps.db, chatIdOf(ctx), found.value.id, max);
    return replyHtml(ctx, subscribeReply(outcome, found.value, max), { preview: outcome === "subscribed" });
  };

  const remove: CommandHandler = async (ctx, args) => {
    if (args === "") {
      return replyHtml(ctx, messages.removeUsage());
    }
    const input = parseRepositoryInput(args);
    if (input === null) {
      return replyHtml(ctx, messages.invalidRepository());
    }
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
    list: async (ctx) => replyHtml(ctx, messages.subscriptionList(await listSubscriptions(deps.db, chatIdOf(ctx)), max)),
    remove,
    stats: async (ctx) => {
      const since = utcDay(new Date(now().getTime() - (STATS_DAYS - 1) * DAY_MS));
      return replyHtml(ctx, messages.stats(await getStats(deps.db, since)));
    },
  };
}

/**
 * Plain text that's a repository is treated as /add. In private chats that's
 * a GitHub URL or owner/repo; in groups only a GitHub URL, because ordinary
 * talk ("and/or") also looks like owner/repo. Other text gets a hint in
 * private chats and is ignored in groups.
 */
export async function handlePlainText(
  ctx: Context,
  text: string,
  handlers: Record<CommandName, CommandHandler>,
): Promise<void> {
  const isPrivate = ctx.chat?.type === "private";
  const isRepository = parseRepositoryInput(text) !== null && (isPrivate || /github\.com\//i.test(text));
  if (isRepository) {
    return handlers.add(ctx, text);
  }
  if (isPrivate) {
    return replyHtml(ctx, messages.plainTextHint());
  }
}
