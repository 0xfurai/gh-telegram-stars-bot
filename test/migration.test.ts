import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { buildD1Statements, dailyGains, type CopyOptions } from "../scripts/migration/to-d1";
import { planChatsAndRepositories, planSubscriptions } from "../scripts/migration/to-supabase";
import { SNAPSHOT_QUERIES, type D1Snapshot, type SupabaseExport } from "../scripts/migration/types";
import { compareCopies } from "../scripts/migration/verify";

const db = env.DB;
const TODAY = "2026-11-07";
const T = "2025-09-06T20:37:27.123456+00:00";

function exportFixture(): SupabaseExport {
  return {
    chats: [
      { id: 1, is_active: true, created_at: T, updated_at: T },
      { id: -1001234567890, is_active: true, created_at: T, updated_at: T },
      { id: 3, is_active: false, created_at: T, updated_at: T },
    ],
    repositories: [
      { id: 1, github_id: 10, full_name: "facebook/react", description: "It's a UI library", html_url: "x", stars_count: 230000, is_archived: false, created_at: T, updated_at: T },
      { id: 2, github_id: 20, full_name: "owner/my_repo", description: null, html_url: "x", stars_count: 5, is_archived: true, created_at: T, updated_at: T },
      { id: 3, github_id: 30, full_name: "gone/deleted", description: null, html_url: "x", stars_count: 7, is_archived: false, created_at: T, updated_at: T },
    ],
    subscriptions: [
      { chat_id: 1, repository_id: 1, created_at: T },
      { chat_id: 1, repository_id: 2, created_at: T },
      { chat_id: -1001234567890, repository_id: 1, created_at: T },
      { chat_id: 3, repository_id: 3, created_at: T },
    ],
    starEvents: [
      { repository_id: 1, stars_count: 229990, previous_stars_count: 229980, created_at: "2026-11-07T01:00:00+00:00" },
      { repository_id: 1, stars_count: 230000, previous_stars_count: 229990, created_at: "2026-11-07T09:00:00+00:00" },
      { repository_id: 1, stars_count: 229000, previous_stars_count: 228000, created_at: "2026-01-01T00:00:00+00:00" },
      { repository_id: 2, stars_count: 4, previous_stars_count: 5, created_at: "2026-11-06T00:00:00+00:00" },
    ],
  };
}

const NODE_IDS = new Map<number, string | null>([
  [10, "R_10"],
  [20, "R_20"],
  [30, null],
]);

async function apply(statements: readonly string[]) {
  await db.batch(statements.map((sql) => db.prepare(sql)));
}

async function snapshot(): Promise<D1Snapshot> {
  const [chats, repositories, subscriptions, gains] = await db.batch([
    db.prepare(SNAPSHOT_QUERIES.chats),
    db.prepare(SNAPSHOT_QUERIES.repositories),
    db.prepare(SNAPSHOT_QUERIES.subscriptions),
    db.prepare(SNAPSHOT_QUERIES.gains),
  ]);
  return {
    chats: (chats?.results ?? []) as D1Snapshot["chats"],
    repositories: (repositories?.results ?? []) as D1Snapshot["repositories"],
    subscriptions: (subscriptions?.results ?? []) as D1Snapshot["subscriptions"],
    gains: (gains?.results ?? []) as D1Snapshot["gains"],
  };
}

/** The copy's statements; a shadow copy is built against D1's current subscriptions, as the script does. */
async function statements(data: SupabaseExport, mode: "full" | "shadow"): Promise<string[]> {
  const options: CopyOptions =
    mode === "full" ? { mode, today: TODAY } : { mode, current: (await snapshot()).subscriptions };
  const built = buildD1Statements(data, NODE_IDS, options);
  if (!built.ok) {
    throw new Error(JSON.stringify(built.error));
  }
  return built.value;
}

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM daily_star_gains"),
    db.prepare("DELETE FROM chat_repositories"),
    db.prepare("DELETE FROM repositories"),
    db.prepare("DELETE FROM chats"),
    db.prepare("UPDATE star_check_state SET cursor = 0"),
  ]);
});

describe("full copy", () => {
  it("makes D1 an exact copy, and the verification finds no differences", async () => {
    await apply(await statements(exportFixture(), "full"));

    expect(compareCopies(exportFixture(), await snapshot(), { mode: "full", today: TODAY })).toEqual([]);
  });

  it("starts every subscription at Supabase's star count, so nobody gets old stars", async () => {
    await apply(await statements(exportFixture(), "full"));

    const { subscriptions } = await snapshot();
    expect(subscriptions).toContainEqual({ chat_id: 1, repository_id: 10, last_notified_stars: 230000 });
    expect(subscriptions).toContainEqual({ chat_id: -1001234567890, repository_id: 10, last_notified_stars: 230000 });
  });

  it("keeps GitHub IDs as keys, inactive chats inactive, and stores repos gone from GitHub as archived", async () => {
    await apply(await statements(exportFixture(), "full"));

    const { chats, repositories } = await snapshot();
    expect(chats.find((c) => c.id === 3)?.is_active).toBe(0);
    expect(repositories.map((r) => r.id)).toEqual([10, 20, 30]);
    expect(repositories.find((r) => r.id === 30)).toMatchObject({ github_node_id: null, is_archived: 1 });
    expect(repositories.find((r) => r.id === 10)?.description).toBe("It's a UI library");
  });

  it("rebuilds daily star gains from the last 90 days of increases", async () => {
    await apply(await statements(exportFixture(), "full"));

    expect((await snapshot()).gains).toEqual([{ repository_id: 10, day: "2026-11-07", stars_gained: 20 }]);
  });

  it("is safe to run twice", async () => {
    await apply(await statements(exportFixture(), "full"));
    await apply(await statements(exportFixture(), "full"));

    expect(compareCopies(exportFixture(), await snapshot(), { mode: "full", today: TODAY })).toEqual([]);
  });
});

describe("shadow copy", () => {
  it("mirrors chats and subscriptions but keeps the star counts the Worker tracks", async () => {
    await apply(await statements(exportFixture(), "full"));
    // The Worker checked GitHub since: new counts and a gain.
    await db.prepare("UPDATE repositories SET stars_count = 230050 WHERE id = 10").run();
    await db.prepare("INSERT INTO daily_star_gains (repository_id, day, stars_gained) VALUES (10, '2026-11-08', 50)").run();

    // In Supabase: chat 1 unsubscribed from my_repo, chat 3 subscribed to react and became active.
    const changed = exportFixture();
    changed.subscriptions = changed.subscriptions.filter((s) => !(s.chat_id === 1 && s.repository_id === 2));
    changed.subscriptions.push({ chat_id: 3, repository_id: 1, created_at: T });
    changed.chats = changed.chats.map((c) => (c.id === 3 ? { ...c, is_active: true } : c));

    await apply(await statements(changed, "shadow"));

    const after = await snapshot();
    expect(after.repositories.find((r) => r.id === 10)?.stars_count).toBe(230050);
    expect(after.gains).toContainEqual({ repository_id: 10, day: "2026-11-08", stars_gained: 50 });
    expect(after.subscriptions).not.toContainEqual(expect.objectContaining({ chat_id: 1, repository_id: 20 }));
    // New subscriptions start at the Worker's count, not Supabase's older one.
    expect(after.subscriptions).toContainEqual({ chat_id: 3, repository_id: 10, last_notified_stars: 230050 });
    expect(compareCopies(changed, after, { mode: "shadow", today: TODAY })).toEqual([]);
  });

  it("handles a Supabase with no subscriptions left", async () => {
    await apply(await statements(exportFixture(), "full"));
    const empty = { ...exportFixture(), subscriptions: [] };

    await apply(await statements(empty, "shadow"));

    expect((await snapshot()).subscriptions).toEqual([]);
  });

  it("deletes exactly the removed subscriptions, however many", async () => {
    const many = exportFixture();
    for (let id = 100; id < 350; id++) {
      many.chats.push({ id, is_active: true, created_at: T, updated_at: T });
      many.subscriptions.push({ chat_id: id, repository_id: 1, created_at: T });
    }
    await apply(await statements(many, "full"));
    // Every other one unsubscribed.
    const fewer = { ...many, subscriptions: many.subscriptions.filter((s) => s.chat_id < 100 || s.chat_id % 2 === 0) };

    const built = await statements(fewer, "shadow");
    await apply(built);

    expect(built.filter((sql) => sql.startsWith("DELETE")).length).toBe(2);
    expect(compareCopies(fewer, await snapshot(), { mode: "shadow", today: TODAY })).toEqual([]);
  });

  it("only rewrites rows, and their updated_at, when something changed", async () => {
    await apply(await statements(exportFixture(), "full"));
    await db.prepare("UPDATE chats SET updated_at = 'before'").run();
    await db.prepare("UPDATE repositories SET updated_at = 'before'").run();
    const changed = exportFixture();
    changed.chats = changed.chats.map((c) => (c.id === 3 ? { ...c, is_active: true } : c));
    changed.repositories = changed.repositories.map((r) => (r.id === 1 ? { ...r, full_name: "Facebook/React" } : r));

    await apply(await statements(changed, "shadow"));

    const chats = await db.prepare("SELECT id, updated_at FROM chats ORDER BY id").all<{ id: number; updated_at: string }>();
    const repos = await db.prepare("SELECT id, updated_at FROM repositories ORDER BY id").all<{ id: number; updated_at: string }>();
    expect(chats.results.filter((c) => c.updated_at !== "before").map((c) => c.id)).toEqual([3]);
    // A change in letter case alone is a rename too.
    expect(repos.results.filter((r) => r.updated_at !== "before").map((r) => r.id)).toEqual([10]);
  });
});

describe("problems in the export", () => {
  it("refuses to copy, listing every problem", () => {
    const broken = exportFixture();
    broken.repositories.push({ ...broken.repositories[0]!, id: 9 });
    broken.subscriptions.push({ chat_id: 99, repository_id: 1, created_at: T }, { chat_id: 1, repository_id: 77, created_at: T });
    const nodeIds = new Map(NODE_IDS);
    nodeIds.delete(20);

    const built = buildD1Statements(broken, nodeIds, { mode: "full", today: TODAY });

    expect(built.ok).toBe(false);
    expect(!built.ok && built.error.map((p) => p.kind).sort()).toEqual([
      "duplicate-github-id",
      "missing-node-id",
      "unknown-chat",
      "unknown-repository",
    ]);
  });
});

describe("compareCopies", () => {
  it("reports each difference", async () => {
    await apply(await statements(exportFixture(), "full"));
    await db.batch([
      db.prepare("UPDATE repositories SET full_name = 'facebook/renamed', stars_count = 1 WHERE id = 10"),
      db.prepare("DELETE FROM chat_repositories WHERE chat_id = 1 AND repository_id = 20"),
      db.prepare("UPDATE chats SET is_active = 0 WHERE id = 1"),
    ]);

    const differences = compareCopies(exportFixture(), await snapshot(), { mode: "full", today: TODAY });

    expect(differences.join("\n")).toContain("subscriptions: Supabase has 4 rows, D1 has 3");
    expect(differences.join("\n")).toContain("chat 1: active is false in D1, true in Supabase");
    expect(differences.join("\n")).toContain("chat 1: subscribed to [10] in D1, [10, 20] in Supabase");
    expect(differences.join("\n")).toContain("name facebook/renamed in D1, facebook/react in Supabase");
    expect(differences.join("\n")).toContain("1 stars in D1, 230000 in Supabase");
    expect(differences.join("\n")).toContain("last notified 230000, not its 1 stars");
  });
});

describe("dailyGains", () => {
  it("sums positive gains per repository and UTC day, within 90 days", () => {
    const githubIdOf = new Map([[1, 10]]);
    const gains = dailyGains(
      [
        { repository_id: 1, stars_count: 12, previous_stars_count: 10, created_at: "2026-08-10T23:59:00Z" },
        { repository_id: 1, stars_count: 15, previous_stars_count: 12, created_at: "2026-08-10T00:00:00Z" },
        { repository_id: 1, stars_count: 20, previous_stars_count: 15, created_at: "2026-08-09T23:59:59Z" },
        { repository_id: 2, stars_count: 9, previous_stars_count: 1, created_at: "2026-11-01T00:00:00Z" },
      ],
      githubIdOf,
      TODAY,
    );

    // 2026-08-10 is the oldest day kept for 2026-11-07; repository 2 isn't in the export.
    expect(gains).toEqual([{ githubId: 10, day: "2026-08-10", starsGained: 5 }]);
  });
});

describe("reverse copy plan", () => {
  const d1: D1Snapshot = {
    chats: [
      { id: 1, is_active: 1 },
      { id: 2, is_active: 0 },
    ],
    repositories: [
      { id: 10, github_node_id: "R_10", full_name: "facebook/react", description: null, stars_count: 230050, is_archived: 0 },
      { id: 40, github_node_id: "R_40", full_name: "new/added-after-switch", description: "d", stars_count: 3, is_archived: 0 },
    ],
    subscriptions: [
      { chat_id: 1, repository_id: 10, last_notified_stars: 230050 },
      { chat_id: 2, repository_id: 40, last_notified_stars: 3 },
    ],
    gains: [],
  };

  it("copies chats and repositories with their star counts", () => {
    const plan = planChatsAndRepositories(d1);

    expect(plan.chats).toEqual([
      { id: 1, is_active: true },
      { id: 2, is_active: false },
    ]);
    expect(plan.repositories[0]).toEqual({
      github_id: 10,
      full_name: "facebook/react",
      description: null,
      html_url: "https://github.com/facebook/react",
      stars_count: 230050,
      is_archived: false,
    });
  });

  it("sends back the lowest count any subscriber was last told, so due gains aren't lost", () => {
    const behind: D1Snapshot = {
      ...d1,
      subscriptions: [
        { chat_id: 1, repository_id: 10, last_notified_stars: 230050 },
        // Chat 2's notification failed: still due.
        { chat_id: 2, repository_id: 10, last_notified_stars: 230010 },
      ],
    };

    const stars = planChatsAndRepositories(behind).repositories.map((r) => [r.github_id, r.stars_count]);

    // Repository 40 has no subscribers left: its own count.
    expect(stars).toEqual([
      [10, 230010],
      [40, 3],
    ]);
  });

  it("adds subscriptions made after the switch and removes ones deleted since", () => {
    const supabaseRepos = [
      { id: 1, github_id: 10 },
      { id: 4, github_id: 40 },
    ];
    const supabaseSubs = [
      { chat_id: 1, repository_id: 1 },
      { chat_id: 3, repository_id: 1 },
    ];

    expect(planSubscriptions(d1, supabaseRepos, supabaseSubs)).toEqual({
      add: [{ chat_id: 2, repository_id: 4 }],
      remove: [{ chat_id: 3, repository_id: 1 }],
      unmapped: [],
    });
  });

  it("reports repositories that have no Supabase ID yet", () => {
    expect(planSubscriptions(d1, [{ id: 1, github_id: 10 }], []).unmapped).toEqual([40]);
  });
});
