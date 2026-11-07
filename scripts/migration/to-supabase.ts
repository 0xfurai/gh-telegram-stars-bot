// Plans the reverse copy, D1 back to Supabase, for a rollback. Pure: no I/O.
//
// It copies chats, repositories with their current star counts, and
// subscriptions. The star counts matter: the old app notifies when a count
// differs from the stored one, so without them it would re-send every
// notification the Worker already sent.
import type { D1Snapshot, SupabaseRepository } from "./types.ts";

// The Worker builds the same URL (src/db.ts repositoryUrl); not imported here
// because src/db.ts needs the Workers runtime types, and scripts run on Node.
function repositoryUrl(fullName: string): string {
  return `https://github.com/${fullName}`;
}

export interface SupabaseChatWrite {
  id: number;
  is_active: boolean;
}

export interface SupabaseRepositoryWrite {
  github_id: number;
  full_name: string;
  description: string | null;
  html_url: string;
  stars_count: number;
  is_archived: boolean;
}

export interface SupabaseSubscriptionKey {
  chat_id: number;
  /** Supabase's serial repository ID. */
  repository_id: number;
}

/** Step 1: chats and repositories (upserted on chats.id and repositories.github_id). */
export function planChatsAndRepositories(d1: D1Snapshot): {
  chats: SupabaseChatWrite[];
  repositories: SupabaseRepositoryWrite[];
} {
  return {
    chats: d1.chats.map((chat) => ({ id: chat.id, is_active: chat.is_active === 1 })),
    repositories: d1.repositories.map((repo) => ({
      github_id: repo.id,
      full_name: repo.full_name,
      description: repo.description,
      html_url: repositoryUrl(repo.full_name),
      stars_count: repo.stars_count,
      is_archived: repo.is_archived === 1,
    })),
  };
}

/**
 * Step 2, after step 1 (so every repository has a Supabase ID): the
 * subscriptions to add and to delete so Supabase matches D1. Subscriptions
 * removed after the switch are deleted.
 */
export function planSubscriptions(
  d1: D1Snapshot,
  supabaseRepositories: readonly Pick<SupabaseRepository, "id" | "github_id">[],
  supabaseSubscriptions: readonly SupabaseSubscriptionKey[],
): { add: SupabaseSubscriptionKey[]; remove: SupabaseSubscriptionKey[]; unmapped: number[] } {
  const supabaseIdOf = new Map(supabaseRepositories.map((repo) => [repo.github_id, repo.id]));
  const unmapped: number[] = [];
  const wanted = new Map<string, SupabaseSubscriptionKey>();
  for (const sub of d1.subscriptions) {
    const repositoryId = supabaseIdOf.get(sub.repository_id);
    if (repositoryId === undefined) {
      unmapped.push(sub.repository_id);
    } else {
      wanted.set(`${sub.chat_id}|${repositoryId}`, { chat_id: sub.chat_id, repository_id: repositoryId });
    }
  }
  const existing = new Set(supabaseSubscriptions.map((sub) => `${sub.chat_id}|${sub.repository_id}`));
  return {
    add: [...wanted].filter(([key]) => !existing.has(key)).map(([, sub]) => sub),
    remove: supabaseSubscriptions.filter((sub) => !wanted.has(`${sub.chat_id}|${sub.repository_id}`)),
    unmapped,
  };
}
