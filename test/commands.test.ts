// End-to-end command tests: webhook request in, Telegram replies out, with a
// local D1, a fake Telegram API and a fake GitHub API.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleFetch } from "../src/http";
import * as messages from "../src/messages";
import { fakeTelegram, messageUpdate, testConfig, webhookRequest, type TelegramCall } from "./telegram";

const db = env.DB;

interface GitHubRepo {
  databaseId: number;
  nameWithOwner: string;
  stargazerCount: number;
  description?: string | null;
  isArchived?: boolean;
  isPrivate?: boolean;
}

const REPOS: Record<string, GitHubRepo> = {
  "facebook/react": { databaseId: 10, nameWithOwner: "facebook/react", stargazerCount: 230000, description: "UI <lib>" },
  "owner/my_repo": { databaseId: 20, nameWithOwner: "owner/my_repo", stargazerCount: 5 },
  "acme/secret": { databaseId: 30, nameWithOwner: "acme/secret", stargazerCount: 1, isPrivate: true },
};

type GitHubMode = "ok" | "down" | "bad-token";

/** A fake GitHub GraphQL API answering repository(owner, name) lookups. */
function fakeGitHub(mode: GitHubMode) {
  const fetch: typeof globalThis.fetch = (_input, init) => {
    if (mode === "down") {
      return Promise.resolve(new Response("", { status: 502 }));
    }
    if (mode === "bad-token") {
      return Promise.resolve(new Response("", { status: 401 }));
    }
    const { variables } = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
      variables: { owner: string; name: string };
    };
    const repo = REPOS[`${variables.owner}/${variables.name}`.toLowerCase()];
    return Promise.resolve(
      repo
        ? Response.json({
            data: {
              repository: {
                id: `R_${repo.databaseId}`,
                description: null,
                isArchived: false,
                isPrivate: false,
                ...repo,
              },
            },
          })
        : Response.json({ data: { repository: null }, errors: [{ type: "NOT_FOUND", message: "Not found" }] }),
    );
  };
  return fetch;
}

interface SendOptions {
  chatId?: number;
  chatType?: "private" | "group";
  github?: GitHubMode;
  settings?: Record<string, string>;
}

async function send(text: string, options: SendOptions = {}): Promise<TelegramCall[]> {
  const telegram = fakeTelegram();
  const response = await handleFetch(
    webhookRequest(messageUpdate(text, options.chatId ?? 1, options.chatType ?? "private")),
    {
      config: testConfig(options.settings),
      db,
      telegramFetch: telegram.fetch,
      githubFetch: fakeGitHub(options.github ?? "ok"),
      now: () => new Date("2026-11-07T12:00:00Z"),
    },
  );
  expect(response.status).toBe(200);
  return telegram.calls.filter((call) => call.method === "sendMessage");
}

/** The single reply's text. */
async function replyTo(text: string, options: SendOptions = {}): Promise<string> {
  const replies = await send(text, options);
  expect(replies).toHaveLength(1);
  return String(replies[0]?.body.text);
}

async function lastNotified(chatId: number, repositoryId: number) {
  return db
    .prepare("SELECT last_notified_stars FROM chat_repositories WHERE chat_id = ? AND repository_id = ?")
    .bind(chatId, repositoryId)
    .first<number>("last_notified_stars");
}

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM daily_star_gains"),
    db.prepare("DELETE FROM chat_repositories"),
    db.prepare("DELETE FROM repositories"),
    db.prepare("DELETE FROM chats"),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/start and /help", () => {
  it("welcomes the user and registers the chat", async () => {
    expect(await replyTo("/start")).toBe(messages.welcome());
    expect(await db.prepare("SELECT is_active FROM chats WHERE id = 1").first("is_active")).toBe(1);
  });

  it("reactivates a chat that was marked inactive", async () => {
    await db.prepare("INSERT INTO chats (id, is_active) VALUES (1, 0)").run();

    await send("/start");

    expect(await db.prepare("SELECT is_active FROM chats WHERE id = 1").first("is_active")).toBe(1);
  });

  it("shows help with the per-chat limit", async () => {
    expect(await replyTo("/help", { settings: { MAX_REPOS_PER_CHAT: "7" } })).toBe(messages.help(7));
  });

  it("sends HTML without link previews by default", async () => {
    const [reply] = await send("/help");

    expect(reply?.body.parse_mode).toBe("HTML");
    expect(reply?.body.link_preview_options).toEqual({ is_disabled: true });
  });
});

describe("/add", () => {
  it("subscribes, starting at the current star count, with a link preview", async () => {
    const [reply] = await send("/add facebook/react");

    expect(reply?.body.text).toBe(
      messages.subscribed({
        id: 10,
        nodeId: "R_10",
        fullName: "facebook/react",
        description: "UI <lib>",
        starsCount: 230000,
        isArchived: false,
      }),
    );
    expect(reply?.body.link_preview_options).toEqual({ is_disabled: false });
    expect(await lastNotified(1, 10)).toBe(230000);
  });

  it("accepts GitHub URLs and any capitalization", async () => {
    await send("/add https://github.com/Facebook/React/tree/main");

    expect(await lastNotified(1, 10)).toBe(230000);
  });

  it("delivers the confirmation for names with underscores (the old Markdown bug)", async () => {
    const text = await replyTo("/add owner/my_repo");

    expect(text).toContain("owner/my_repo");
  });

  it("says when the chat is already subscribed", async () => {
    await send("/add facebook/react");

    expect(await replyTo("/add facebook/react")).toBe(messages.alreadySubscribed("facebook/react"));
  });

  it("enforces the per-chat limit", async () => {
    const settings = { MAX_REPOS_PER_CHAT: "1" };
    await send("/add facebook/react", { settings });

    expect(await replyTo("/add owner/my_repo", { settings })).toBe(messages.limitReached(1));
  });

  it("answers the limit and duplicates from the chat's subscriptions, without calling GitHub or storing anything", async () => {
    const settings = { MAX_REPOS_PER_CHAT: "1" };
    await send("/add facebook/react", { settings });

    // GitHub is "down": a lookup would answer "can't reach GitHub".
    expect(await replyTo("/add owner/my_repo", { settings, github: "down" })).toBe(messages.limitReached(1));
    expect(await replyTo("/add FACEBOOK/react", { settings, github: "down" })).toBe(
      messages.alreadySubscribed("facebook/react"),
    );
    expect(await db.prepare("SELECT COUNT(*) AS n FROM repositories").first("n")).toBe(1);
  });

  it("explains missing input and invalid names without calling GitHub", async () => {
    expect(await replyTo("/add")).toBe(messages.addUsage());
    expect(await replyTo("/add not a repo", { github: "down" })).toBe(messages.invalidRepository("not-a-repository"));
  });

  it("says why the input isn't a repository", async () => {
    expect(await replyTo("/add https://gitlab.com/owner/repo")).toBe(messages.invalidRepository("not-github"));
    expect(await replyTo("/add -owner/repo")).toBe(messages.invalidRepository("invalid-name"));
    expect(await replyTo("/add https://github.com/owner")).toBe(messages.invalidRepository("not-a-repository"));
  });

  it("treats missing and private repositories as not found", async () => {
    expect(await replyTo("/add facebook/nope")).toBe(messages.repositoryNotFound("facebook", "nope"));
    expect(await replyTo("/add acme/secret")).toBe(messages.repositoryNotFound("acme", "secret"));
  });

  it("says GitHub is unavailable when it is", async () => {
    expect(await replyTo("/add facebook/react", { github: "down" })).toBe(messages.githubUnavailable());
  });

  it("logs a rejected GitHub token as an operator problem", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await replyTo("/add facebook/react", { github: "bad-token" })).toBe(messages.somethingWentWrong());
    expect(String(error.mock.calls[0]?.[0])).toContain("GitHub token rejected");
  });
});

describe("/list, /remove and /stats", () => {
  beforeEach(async () => {
    await send("/add facebook/react");
    await send("/add owner/my_repo");
  });

  it("splits a long list into several messages", async () => {
    const inserts = Array.from({ length: 30 }, (_, i) => [
      db
        .prepare("INSERT INTO repositories (id, github_node_id, full_name, stars_count) VALUES (?, ?, ?, ?)")
        .bind(1000 + i, `R_${1000 + i}`, `some-long-owner-name/a-fairly-long-repository-name-${i}`, i),
      db.prepare("INSERT INTO chat_repositories (chat_id, repository_id, last_notified_stars) VALUES (1, ?, 0)").bind(1000 + i),
    ]);
    await db.batch(inserts.flat());

    const replies = await send("/list", { settings: { MAX_REPOS_PER_CHAT: "50" } });

    expect(replies).toHaveLength(2);
    expect(String(replies[0]?.body.text)).toContain("(32/50)");
    expect(String(replies[1]?.body.text)).toContain("26. ");
  });

  it("lists the subscriptions, most-starred first", async () => {
    const text = await replyTo("/list");

    expect(text.indexOf("facebook/react")).toBeLessThan(text.indexOf("owner/my_repo"));
    expect(text).toContain("(2/50)");
  });

  it("unsubscribes by name, case-insensitively", async () => {
    expect(await replyTo("/remove Facebook/React")).toBe(messages.unsubscribed("facebook/react"));
    expect(await replyTo("/remove facebook/react")).toBe(messages.notSubscribed("facebook", "react"));
  });

  it("unsubscribes by URL", async () => {
    expect(await replyTo("/remove https://github.com/owner/my_repo")).toBe(messages.unsubscribed("owner/my_repo"));
  });

  it("explains missing or invalid input for /remove", async () => {
    expect(await replyTo("/remove")).toBe(messages.removeUsage());
    expect(await replyTo("/remove nope")).toBe(messages.invalidRepository("not-a-repository"));
  });

  it("shows stats", async () => {
    expect(await replyTo("/stats")).toBe(
      messages.stats({ repositories: 2, activeChats: 1, subscriptions: 2, starsGained: 0 }, 90),
    );
  });
});

describe("plain text", () => {
  it("treats a repository in a private chat as /add", async () => {
    await send("facebook/react");
    await send("https://github.com/owner/my_repo");

    expect(await lastNotified(1, 10)).toBe(230000);
    expect(await lastNotified(1, 20)).toBe(5);
  });

  it("gives a hint for other text in a private chat", async () => {
    expect(await replyTo("hello there")).toBe(messages.plainTextHint());
  });

  it("ignores plain text in groups, links included, and doesn't touch D1 for it", async () => {
    const group = { chatId: -100, chatType: "group" } as const;

    expect(await send("and/or", group)).toEqual([]);
    expect(await send("hello", group)).toEqual([]);
    expect(await send("https://github.com/facebook/react", group)).toEqual([]);

    expect(await lastNotified(-100, 10)).toBeNull();
    expect(await db.prepare("SELECT COUNT(*) AS n FROM chats WHERE id = -100").first("n")).toBe(0);
  });

  it("subscribes a group with /add", async () => {
    await send("/add facebook/react", { chatId: -100, chatType: "group" });

    expect(await lastNotified(-100, 10)).toBe(230000);
  });
});
