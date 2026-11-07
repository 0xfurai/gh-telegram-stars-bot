// Compares Supabase and D1 in full (not by sampling). Pure: no I/O.
import { assertNever } from "../../src/result.ts";
import { dailyGains } from "./to-d1.ts";
import type { CopyMode, D1Snapshot, SupabaseExport } from "./types.ts";

function sortedKeys(values: Iterable<string>): string {
  return [...values].sort().join(", ");
}

function compareCounts(source: SupabaseExport, d1: D1Snapshot): string[] {
  const pairs: [string, number, number][] = [
    ["chats", source.chats.length, d1.chats.length],
    ["repositories", source.repositories.length, d1.repositories.length],
    ["subscriptions", source.subscriptions.length, d1.subscriptions.length],
  ];
  return pairs.flatMap(([table, expected, actual]) =>
    expected === actual ? [] : [`${table}: Supabase has ${expected} rows, D1 has ${actual}`],
  );
}

function compareChats(source: SupabaseExport, d1: D1Snapshot): string[] {
  const active = new Map(d1.chats.map((chat) => [chat.id, chat.is_active === 1]));
  const githubIdOf = new Map(source.repositories.map((repo) => [repo.id, repo.github_id]));
  const expectedSubs = new Map<number, Set<string>>();
  for (const sub of source.subscriptions) {
    const set = expectedSubs.get(sub.chat_id) ?? new Set();
    set.add(String(githubIdOf.get(sub.repository_id)));
    expectedSubs.set(sub.chat_id, set);
  }
  const actualSubs = new Map<number, Set<string>>();
  for (const sub of d1.subscriptions) {
    const set = actualSubs.get(sub.chat_id) ?? new Set();
    set.add(String(sub.repository_id));
    actualSubs.set(sub.chat_id, set);
  }
  return source.chats.flatMap((chat) => {
    const problems: string[] = [];
    if (active.get(chat.id) !== chat.is_active) {
      problems.push(`chat ${chat.id}: active is ${String(active.get(chat.id))} in D1, ${String(chat.is_active)} in Supabase`);
    }
    const expected = sortedKeys(expectedSubs.get(chat.id) ?? []);
    const actual = sortedKeys(actualSubs.get(chat.id) ?? []);
    if (expected !== actual) {
      problems.push(`chat ${chat.id}: subscribed to [${actual}] in D1, [${expected}] in Supabase`);
    }
    return problems;
  });
}

function compareRepositories(source: SupabaseExport, d1: D1Snapshot, mode: CopyMode): string[] {
  const byId = new Map(d1.repositories.map((repo) => [repo.id, repo]));
  return source.repositories.flatMap((repo) => {
    const stored = byId.get(repo.github_id);
    if (!stored) {
      return [`repository ${repo.github_id} (${repo.full_name}) is missing in D1`];
    }
    const problems: string[] = [];
    if (stored.full_name !== repo.full_name) {
      problems.push(`repository ${repo.github_id}: name ${stored.full_name} in D1, ${repo.full_name} in Supabase`);
    }
    if (stored.github_node_id === null && stored.is_archived === 0) {
      problems.push(`repository ${repo.github_id} (${repo.full_name}) has no node ID but isn't archived`);
    }
    if (starsMustMatch(mode) && stored.stars_count !== repo.stars_count) {
      problems.push(`repository ${repo.github_id}: ${stored.stars_count} stars in D1, ${repo.stars_count} in Supabase`);
    }
    return problems;
  });
}

/** In the shadow copy, the Worker's own star counts and gains are expected to differ. */
function starsMustMatch(mode: CopyMode): boolean {
  switch (mode) {
    case "full":
      return true;
    case "shadow":
      return false;
    default:
      return assertNever(mode);
  }
}

function compareNotified(d1: D1Snapshot): string[] {
  const stars = new Map(d1.repositories.map((repo) => [repo.id, repo.stars_count]));
  return d1.subscriptions.flatMap((sub) => {
    const count = stars.get(sub.repository_id) ?? 0;
    return sub.last_notified_stars > count
      ? [`chat ${sub.chat_id}, repository ${sub.repository_id}: last notified ${sub.last_notified_stars}, above its ${count} stars`]
      : [];
  });
}

function compareGains(source: SupabaseExport, d1: D1Snapshot, today: string): string[] {
  const githubIdOf = new Map(source.repositories.map((repo) => [repo.id, repo.github_id]));
  const key = (repositoryId: number, day: string, stars: number) => `${repositoryId}|${day}|${stars}`;
  const expected = sortedKeys(dailyGains(source.starEvents, githubIdOf, today).map((g) => key(g.githubId, g.day, g.starsGained)));
  const actual = sortedKeys(d1.gains.map((g) => key(g.repository_id, g.day, g.stars_gained)));
  return expected === actual ? [] : ["daily star gains differ from Supabase's star events (last 90 days)"];
}

/**
 * Every difference between Supabase and D1, or [] when they match. In the
 * shadow mode, star counts and gains are the Worker's own and aren't
 * compared.
 */
export function compareCopies(
  source: SupabaseExport,
  d1: D1Snapshot,
  options: { mode: CopyMode; today: string },
): string[] {
  return [
    ...compareCounts(source, d1),
    ...compareChats(source, d1),
    ...compareRepositories(source, d1, options.mode),
    ...compareNotified(d1),
    ...(starsMustMatch(options.mode) ? compareGains(source, d1, options.today) : []),
  ];
}
