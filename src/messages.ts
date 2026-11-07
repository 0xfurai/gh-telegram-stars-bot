// Every text the bot sends, in Telegram's HTML mode.
//
// Values from users or GitHub (names, descriptions) always go through html()
// or link(). The old app used legacy Markdown without escaping, so a "_" or
// "*" in a repository name made Telegram reject the message, and those
// notifications were never delivered.
import { chunk } from "./chunk";
import { COMMANDS } from "./command-list";
import { repositoryUrl, type Repository, type Stats } from "./db";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

/** Escapes text for Telegram HTML (text and attribute values). */
export function html(text: string): string {
  return text.replace(/[&<>"]/g, (char) => ESCAPES[char] ?? char);
}

export function repositoryLink(fullName: string): string {
  return `<a href="${html(repositoryUrl(fullName))}">${html(fullName)}</a>`;
}

/** 1234 -> "1,234". Every number in a message goes through this. */
export function number(n: number): string {
  return n.toLocaleString("en-US");
}

function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${number(n)} ${n === 1 ? singular : plural}`;
}

const COMMAND_LINES = COMMANDS.map(({ command, description }) => `/${command} - ${html(description)}`).join("\n");

const EXAMPLES = [
  "<b>Examples:</b>",
  "<code>/add microsoft/vscode</code>",
  "<code>/add https://github.com/facebook/react</code>",
].join("\n");

export function welcome(): string {
  return [
    "🌟 <b>Welcome to GitHub Stars Bot!</b>",
    "",
    "I'll tell you when your favorite GitHub repositories get new stars.",
    "",
    "<b>Commands:</b>",
    COMMAND_LINES,
    "",
    EXAMPLES,
    "",
    "You can also just send me a repository URL or <code>owner/repo</code>.",
  ].join("\n");
}

export function help(maxReposPerChat: number): string {
  return [
    "🌟 <b>GitHub Stars Bot</b>",
    "",
    "<b>Commands:</b>",
    COMMAND_LINES,
    "",
    "<b>Repository formats:</b>",
    "• <code>owner/repo</code>, e.g. <code>microsoft/vscode</code>",
    "• A GitHub URL, e.g. <code>https://github.com/facebook/react</code>",
    "",
    EXAMPLES,
    "",
    `You can follow up to ${count(maxReposPerChat, "repository", "repositories")} per chat.`,
  ].join("\n");
}

export function addUsage(): string {
  return "Send a repository with the command, for example <code>/add microsoft/vscode</code>.";
}

export function removeUsage(): string {
  return "Send a repository with the command, for example <code>/remove microsoft/vscode</code>.";
}

export function invalidRepository(): string {
  return "That doesn't look like a GitHub repository. Use <code>owner/repo</code> or a GitHub URL.";
}

export function repositoryNotFound(owner: string, name: string): string {
  return `❌ I couldn't find <code>${html(`${owner}/${name}`)}</code> on GitHub. Private repositories aren't supported.`;
}

export function githubUnavailable(): string {
  return "⚠️ I can't reach GitHub right now. Please try again in a few minutes.";
}

export function somethingWentWrong(): string {
  return "⚠️ Something went wrong on my side. Please try again later.";
}

export function subscribed(repo: Repository): string {
  return [
    `✅ <b>Subscribed to ${repositoryLink(repo.fullName)}</b>`,
    `⭐ ${count(repo.starsCount, "star")}`,
    ...(repo.description ? [`📝 ${html(repo.description)}`] : []),
    ...(repo.isArchived ? ["📦 This repository is archived."] : []),
    "",
    "I'll tell you when it gets new stars.",
  ].join("\n");
}

export function alreadySubscribed(fullName: string): string {
  return `You're already subscribed to ${repositoryLink(fullName)}.`;
}

export function limitReached(maxReposPerChat: number): string {
  return `❌ You've reached the limit of ${count(maxReposPerChat, "repository", "repositories")} per chat. Remove one with /remove first.`;
}

export function unsubscribed(fullName: string): string {
  return `✅ Unsubscribed from <b>${html(fullName)}</b>.`;
}

export function notSubscribed(owner: string, name: string): string {
  return `You're not subscribed to <code>${html(`${owner}/${name}`)}</code>.`;
}

/** Most entries in one /list message, to stay well under Telegram's 4096 characters. */
export const MAX_LIST_ENTRIES_PER_MESSAGE = 25;

/** The /list reply: one message, or several for long lists. */
export function subscriptionList(repos: readonly Repository[], maxReposPerChat: number): string[] {
  if (repos.length === 0) {
    return ["📭 You have no subscriptions yet. Use <code>/add owner/repo</code> to add one."];
  }
  const lines = repos.map(
    (repo, index) =>
      `${index + 1}. ${repositoryLink(repo.fullName)}${repo.isArchived ? " 📦" : ""} - ⭐ ${number(repo.starsCount)}`,
  );
  const pages = chunk(lines, MAX_LIST_ENTRIES_PER_MESSAGE);
  return pages.map((page, index) =>
    [
      ...(index === 0 ? [`🌟 <b>Your subscriptions</b> (${repos.length}/${maxReposPerChat})`, ""] : []),
      ...page,
      ...(index === pages.length - 1 ? ["", "Use <code>/remove owner/repo</code> to unsubscribe."] : []),
    ].join("\n"),
  );
}

export function stats(s: Stats, days: number): string {
  return [
    "📊 <b>Bot statistics</b>",
    "",
    `📦 ${count(s.repositories, "repository", "repositories")}`,
    `👥 ${count(s.activeChats, "active chat")}`,
    `🔔 ${count(s.subscriptions, "subscription")}`,
    `⭐ ${count(s.starsGained, "star")} gained in the last ${days} days`,
  ].join("\n");
}

export function unknownCommand(): string {
  return "Unknown command. Type /help to see the available commands.";
}

/** The star notification. `gained` is the change since this chat was last told. */
export function starNotification(fullName: string, gained: number, total: number): string {
  return [
    "🌟 <b>New stars!</b>",
    "",
    `📦 ${repositoryLink(fullName)}`,
    `✨ +${count(gained, "new star")}`,
    `⭐ ${count(total, "star")} in total`,
  ].join("\n");
}

export function plainTextHint(): string {
  return "Send me a GitHub repository (<code>owner/repo</code> or a URL) to subscribe, or /help to see what I can do.";
}

export interface StarUpdate {
  fullName: string;
  /** Stars gained since this chat was last told. */
  gained: number;
  total: number;
}

/** Most repositories in one notification, to stay well under Telegram's 4096 characters. */
export const MAX_UPDATES_PER_MESSAGE = 20;

/**
 * One notification for a chat: a single repository, or several in one
 * message. Takes 1 to MAX_UPDATES_PER_MESSAGE updates; callers split longer
 * lists.
 */
export function starNotifications(updates: readonly StarUpdate[]): string {
  if (updates.length === 0 || updates.length > MAX_UPDATES_PER_MESSAGE) {
    throw new RangeError(`starNotifications takes 1-${MAX_UPDATES_PER_MESSAGE} updates, got ${updates.length}`);
  }
  const [only] = updates;
  if (updates.length === 1 && only) {
    return starNotification(only.fullName, only.gained, only.total);
  }
  return [
    "🌟 <b>New stars!</b>",
    "",
    ...updates.map((u) => `📦 ${repositoryLink(u.fullName)}: +${number(u.gained)} (⭐ ${number(u.total)})`),
  ].join("\n");
}
