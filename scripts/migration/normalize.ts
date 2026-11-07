// Some of Supabase's columns are nullable even where the old app always set
// them (database.sql on the legacy branch). normalizeExport fills those nulls
// with the old schema's own defaults, so a stray null can't crash the copy,
// turn a chat inactive, or date a row to 1970. Subscriptions and star events
// that refer to nothing (a null chat or repository) are dropped.
import type {
  SupabaseChat,
  SupabaseExport,
  SupabaseRepository,
  SupabaseStarEvent,
  SupabaseSubscription,
} from "./types.ts";

type NullableKeys<T, K extends keyof T> = Omit<T, K> & { [P in K]: T[P] | null };

/** The rows as Supabase returns them: only the columns its schema allows to be null are nullable. */
export interface RawSupabaseExport {
  chats: NullableKeys<SupabaseChat, "is_active" | "created_at" | "updated_at">[];
  repositories: NullableKeys<SupabaseRepository, "stars_count" | "is_archived" | "created_at" | "updated_at">[];
  subscriptions: NullableKeys<SupabaseSubscription, "chat_id" | "repository_id" | "created_at">[];
  starEvents: NullableKeys<SupabaseStarEvent, "repository_id" | "created_at">[];
}

function subscriptions(raw: RawSupabaseExport["subscriptions"], now: string): SupabaseSubscription[] {
  return raw.flatMap((sub) =>
    sub.chat_id === null || sub.repository_id === null
      ? []
      : [{ chat_id: sub.chat_id, repository_id: sub.repository_id, created_at: sub.created_at ?? now }],
  );
}

function starEvents(raw: RawSupabaseExport["starEvents"], now: string): SupabaseStarEvent[] {
  return raw.flatMap((event) =>
    event.repository_id === null ? [] : [{ ...event, repository_id: event.repository_id, created_at: event.created_at ?? now }],
  );
}

/** Applies the old schema's defaults: active, not archived, 0 stars, "now" for timestamps. */
export function normalizeExport(raw: RawSupabaseExport, now: string): SupabaseExport {
  return {
    chats: raw.chats.map((chat) => ({
      id: chat.id,
      is_active: chat.is_active ?? true,
      created_at: chat.created_at ?? now,
      updated_at: chat.updated_at ?? now,
    })),
    repositories: raw.repositories.map((repo) => ({
      ...repo,
      stars_count: repo.stars_count ?? 0,
      is_archived: repo.is_archived ?? false,
      created_at: repo.created_at ?? now,
      updated_at: repo.updated_at ?? now,
    })),
    subscriptions: subscriptions(raw.subscriptions, now),
    starEvents: starEvents(raw.starEvents, now),
  };
}
