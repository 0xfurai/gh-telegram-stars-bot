// Every text the bot sends, in Telegram's HTML mode.
//
// Values from users or GitHub (names, descriptions) always go through html()
// or link(). The old app used legacy Markdown without escaping, so a "_" or
// "*" in a repository name made Telegram reject the message, and those
// notifications were never delivered.
import { chunk } from "./chunk";
import { ADMIN_COMMANDS, PUBLIC_COMMANDS } from "./command-list";
import { repositoryUrl, type Repository, type Stats, type SummaryChange, type SummarySettings } from "./db";
import { DEFAULT_SEND_HOUR_UTC, LOCAL_SEND_HOUR, SUMMARY_KINDS, type Period, type SummaryKind } from "./periods";
import type { RepositoryInputError } from "./repo-input";
import { assertNever } from "./result";

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

function commandLines(commands: readonly { command: string; description: string }[]): string {
  return commands.map(({ command, description }) => `/${command} - ${html(description)}`).join("\n");
}

const COMMAND_LINES = commandLines(PUBLIC_COMMANDS);

const EXAMPLES = [
  "<b>Examples:</b>",
  "<code>/add microsoft/vscode</code>",
  "<code>/add https://github.com/facebook/react</code>",
].join("\n");

export function welcome(): string {
  return [
    "🌟 <b>Welcome to GitHub Stars Bot!</b>",
    "",
    "I'll tell you when your favorite GitHub repositories gain or lose stars.",
    "",
    "<b>Commands:</b>",
    COMMAND_LINES,
    "",
    EXAMPLES,
    "",
    "You can also just send me a repository URL or <code>owner/repo</code>.",
  ].join("\n");
}

/** Help; in the admin chat (`admin`), the admin commands too. */
export function help(maxReposPerChat: number, admin = false): string {
  return [
    "🌟 <b>GitHub Stars Bot</b>",
    "",
    "<b>Commands:</b>",
    COMMAND_LINES,
    "",
    ...(admin ? ["<b>Admin chat only:</b>", commandLines(ADMIN_COMMANDS), ""] : []),
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

/** Why the input isn't a repository, in words. */
export function invalidRepository(error: RepositoryInputError): string {
  switch (error) {
    case "not-github":
      return "I only follow GitHub repositories. Send <code>owner/repo</code> or a <code>github.com</code> URL.";
    case "invalid-name":
      return [
        "That isn't a valid GitHub repository name.",
        "• Owner: 1-39 letters, digits or single hyphens, not starting or ending with one.",
        "• Repository: 1-100 letters, digits, <code>-</code>, <code>_</code> or <code>.</code>, and not <code>.</code> or <code>..</code>.",
      ].join("\n");
    case "not-a-repository":
      return "That doesn't look like a GitHub repository. Use <code>owner/repo</code> or a GitHub URL.";
    default:
      return assertNever(error);
  }
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
    "I'll tell you when it gains or loses stars.",
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

/** "+5" or "−2", with a real minus sign. A change is never 0: nothing is due then. */
function signed(change: number): string {
  if (change === 0) {
    throw new RangeError("A star change can't be 0");
  }
  return change > 0 ? `+${number(change)}` : `\u2212${number(-change)}`;
}

/** The heading for a set of changes: gains, losses, or both. */
function changeHeading(changes: readonly number[]): string {
  const gains = changes.some((change) => change > 0);
  const losses = changes.some((change) => change < 0);
  if (gains && losses) {
    return "⭐ <b>Star changes</b>";
  }
  return losses ? "📉 <b>Stars lost</b>" : "🌟 <b>New stars!</b>";
}

/** One repository's change since the chat was last told: positive for gains, negative for losses. */
export function starNotification(fullName: string, change: number, total: number): string {
  const noun = Math.abs(change) === 1 ? "star" : "stars";
  const line = change > 0 ? `✨ ${signed(change)} new ${noun}` : `💔 ${signed(change)} ${noun}`;
  return [changeHeading([change]), "", `📦 ${repositoryLink(fullName)}`, line, `⭐ ${count(total, "star")} in total`].join(
    "\n",
  );
}

export function plainTextHint(): string {
  return "Send me a GitHub repository (<code>owner/repo</code> or a URL) to subscribe, or /help to see what I can do.";
}

export interface StarUpdate {
  fullName: string;
  /** Stars gained (positive) or lost (negative) since this chat was last told. */
  change: number;
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
    return starNotification(only.fullName, only.change, only.total);
  }
  return [
    changeHeading(updates.map((u) => u.change)),
    "",
    ...updates.map((u) => `📦 ${repositoryLink(u.fullName)}: ${signed(u.change)} (⭐ ${number(u.total)})`),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Summaries (GSB-23)

/** Most repositories listed in one summary, to stay well under Telegram's 4096 characters. */
export const MAX_SUMMARY_LINES = 25;

const SUMMARY_TITLES: Record<SummaryKind, string> = {
  weekly: "📅 <b>Your weekly star summary</b>",
  monthly: "🗓 <b>Your monthly star summary</b>",
  yearly: "🎉 <b>Your year in stars</b>",
};

const DAY_MS = 24 * 60 * 60 * 1000;

function formatDay(day: string, options: Intl.DateTimeFormatOptions): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", { ...options, timeZone: "UTC" });
}

/** "3 Nov 2026 – 9 Nov 2026", "October 2026" or "2026". */
export function periodLabel(period: Period): string {
  switch (period.kind) {
    case "weekly": {
      const last = new Date(Date.parse(`${period.end}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
      const short = { day: "numeric", month: "short", year: "numeric" } as const;
      return `${formatDay(period.start, short)} \u2013 ${formatDay(last, short)}`;
    }
    case "monthly":
      return formatDay(period.start, { month: "long", year: "numeric" });
    case "yearly":
      return period.start.slice(0, 4);
    default:
      return assertNever(period.kind);
  }
}

/** "+130" or "−3"; "0" only for a total whose gains and losses cancel out. */
function signedTotal(total: number): string {
  return total === 0 ? "0" : signed(total);
}

/**
 * A summary of the repositories that changed in `period`, in the order
 * given (biggest gain first). Takes at least one change.
 */
export function starSummary(period: Period, changes: readonly SummaryChange[]): string {
  if (changes.length === 0) {
    throw new RangeError("A summary needs at least one change");
  }
  const shown = changes.slice(0, MAX_SUMMARY_LINES);
  const hidden = changes.length - shown.length;
  const total = changes.reduce((sum, c) => sum + c.change, 0);
  return [
    SUMMARY_TITLES[period.kind],
    html(periodLabel(period)),
    "",
    ...shown.map((c) => `📦 ${repositoryLink(c.fullName)}: ${signed(c.change)} (⭐ ${number(c.stars)})`),
    ...(hidden > 0 ? [`…and ${count(hidden, "more repository", "more repositories")}`] : []),
    "",
    `<b>Total:</b> ${signedTotal(total)} across ${count(changes.length, "repository", "repositories")}`,
    "",
    "Change or turn off summaries with /summaries.",
  ].join("\n");
}

const SUMMARY_SCHEDULE: Record<SummaryKind, string> = {
  weekly: "Mondays, for the week before",
  monthly: "on the 1st, for the month before",
  yearly: "on 1 January, for the year before",
};

function sendTimeLine(timeZone: string | null): string {
  return timeZone === null
    ? `They go out at ${DEFAULT_SEND_HOUR_UTC}:00 UTC. Use /timezone to get them at ${LOCAL_SEND_HOUR}:00 your time.`
    : `They go out at ${LOCAL_SEND_HOUR}:00 in <code>${html(timeZone)}</code>. Change it with /timezone.`;
}

const SUMMARIES_USAGE = [
  "<b>Change them:</b>",
  "<code>/summaries weekly off</code>",
  "<code>/summaries monthly on</code>",
  "<code>/summaries off</code> - all off",
  "<code>/summaries on</code> - all on",
].join("\n");

/** The /summaries reply: what this chat gets, and when. */
export function summarySettings(settings: SummarySettings): string {
  return [
    "📅 <b>Star summaries</b>",
    "",
    ...SUMMARY_KINDS.map(
      (kind) => `${settings.enabled[kind] ? "✅" : "⏸"} ${capitalize(kind)}: ${settings.enabled[kind] ? "on" : "off"} (${SUMMARY_SCHEDULE[kind]})`,
    ),
    "",
    "A summary shows each repository's net star change in the period. When nothing changed, I don't send one.",
    sendTimeLine(settings.timeZone),
    "",
    SUMMARIES_USAGE,
  ].join("\n");
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function summariesUsage(): string {
  return ["I didn't understand that.", "", SUMMARIES_USAGE].join("\n");
}

/** After /summaries changed something. */
export function summariesChanged(kinds: readonly SummaryKind[], enabled: boolean): string {
  const what = kinds.length === SUMMARY_KINDS.length ? "All summaries are" : `${capitalize(kinds.join(", "))} summaries are`;
  return `✅ ${what} ${enabled ? "on" : "off"}.`;
}

const TIME_ZONE_USAGE = [
  "<b>Examples:</b>",
  "<code>/timezone Europe/Berlin</code>",
  "<code>/timezone America/New_York</code>",
  "<code>/timezone +3</code> or <code>/timezone -5:30</code>",
  "<code>/timezone reset</code> - back to the default",
].join("\n");

/** The /timezone reply without arguments. */
export function timeZoneInfo(timeZone: string | null): string {
  const current =
    timeZone === null
      ? `No time zone set. Summaries go out at ${DEFAULT_SEND_HOUR_UTC}:00 UTC.`
      : `Your time zone: <code>${html(timeZone)}</code>. Summaries go out at ${LOCAL_SEND_HOUR}:00 there.`;
  return [
    "🕙 <b>Time zone</b>",
    "",
    current,
    `Set one to get summaries at ${LOCAL_SEND_HOUR}:00 your time. Names follow daylight saving time; offsets like +3 don't.`,
    "",
    TIME_ZONE_USAGE,
  ].join("\n");
}

export function timeZoneSet(timeZone: string): string {
  return `✅ Time zone set to <code>${html(timeZone)}</code>. Summaries go out at ${LOCAL_SEND_HOUR}:00 there.`;
}

export function timeZoneReset(): string {
  return `✅ Time zone removed. Summaries go out at ${DEFAULT_SEND_HOUR_UTC}:00 UTC.`;
}

export function invalidTimeZone(input: string): string {
  return [
    `❌ I don't know the time zone <code>${html(input)}</code>.`,
    "Use a name from the tz database, or an offset from UTC.",
    "",
    TIME_ZONE_USAGE,
  ].join("\n");
}
