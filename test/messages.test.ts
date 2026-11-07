import { describe, expect, it } from "vitest";
import type { Repository } from "../src/db";
import * as messages from "../src/messages";

function repo(overrides: Partial<Repository> = {}): Repository {
  return {
    id: 1,
    nodeId: "R_1",
    fullName: "owner/my_repo_name",
    description: null,
    starsCount: 1234,
    isArchived: false,
    ...overrides,
  };
}

// Telegram HTML only allows these tags; everything else must be escaped.
const ALLOWED_TAGS = /<\/?(b|i|u|s|code|pre|a)(\s[^>]*)?>/g;

function stripAllowedTags(text: string): string {
  return text.replace(ALLOWED_TAGS, "");
}

describe("html", () => {
  it("escapes &, <, > and quotes", () => {
    expect(messages.html(`a & b <script> "x"`)).toBe("a &amp; b &lt;script&gt; &quot;x&quot;");
  });
});

describe("messages", () => {
  it("keeps underscores and asterisks in names as plain text (the old Markdown bug)", () => {
    const text = messages.starNotification("owner/my_repo*name", 3, 1003);

    expect(text).toContain("my_repo*name");
    expect(stripAllowedTags(text)).not.toMatch(/[<>]/);
  });

  it("escapes descriptions with <, & and *", () => {
    const text = messages.subscribed(repo({ description: "Fast <b>&</b> *bold* `code`" }));

    expect(text).toContain("Fast &lt;b&gt;&amp;&lt;/b&gt; *bold* `code`");
    expect(stripAllowedTags(text)).not.toMatch(/[<>]/);
  });

  it("escapes names inside link attributes", () => {
    expect(messages.repositoryLink('a"b/c')).toBe('<a href="https://github.com/a&quot;b/c">a&quot;b/c</a>');
  });

  it("formats the star notification", () => {
    expect(messages.starNotification("facebook/react", 1, 230000)).toBe(
      [
        "🌟 <b>New stars!</b>",
        "",
        '📦 <a href="https://github.com/facebook/react">facebook/react</a>',
        "✨ +1 new star",
        "⭐ 230,000 stars in total",
      ].join("\n"),
    );
  });

  it("lists subscriptions with their star counts, or says there are none", () => {
    expect(messages.subscriptionList([], 50)[0]).toContain("no subscriptions yet");

    const [text = ""] = messages.subscriptionList(
      [repo(), repo({ id: 2, fullName: "a/b", isArchived: true, starsCount: 5 })],
      50,
    );
    expect(text).toContain("(2/50)");
    expect(text).toContain("1. <a href=\"https://github.com/owner/my_repo_name\">owner/my_repo_name</a> - ⭐ 1,234");
    expect(text).toContain("📦 - ⭐ 5");
  });

  it("splits long lists, numbering across messages, with the header first and the hint last", () => {
    const repos = Array.from({ length: 30 }, (_, i) => repo({ id: i, fullName: `owner/repo-${i}` }));

    const pages = messages.subscriptionList(repos, 50);

    expect(pages).toHaveLength(2);
    expect(pages[0]).toContain("(30/50)");
    expect(pages[0]).not.toContain("/remove");
    expect(pages[1]).toContain("26. ");
    expect(pages[1]).toContain("/remove");
    for (const page of pages) {
      expect(page.length).toBeLessThan(4096);
    }
  });

  it("formats stats with singular and plural, for the given period", () => {
    expect(messages.stats({ repositories: 1, activeChats: 2, subscriptions: 1, starsGained: 0 }, 30)).toContain(
      "📦 1 repository\n👥 2 active chats\n🔔 1 subscription\n⭐ 0 stars gained in the last 30 days",
    );
  });

  it("escapes user input echoed back", () => {
    expect(messages.repositoryNotFound("own<er", "re&po")).toContain("own&lt;er/re&amp;po");
    expect(messages.notSubscribed("a", "<b>")).toContain("a/&lt;b&gt;");
  });
});
