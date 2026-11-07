// Data shapes for copying between Supabase (the old app) and D1 (the Worker).
// Pure types: used by the command-line scripts and by the tests.

/** Supabase rows, as its REST API returns them. */
export interface SupabaseChat {
  id: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface SupabaseRepository {
  /** Supabase's own serial ID; subscriptions refer to it. */
  id: number;
  github_id: number;
  full_name: string;
  description: string | null;
  html_url: string;
  stars_count: number;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface SupabaseSubscription {
  chat_id: number;
  /** Supabase's serial repository ID, not the GitHub ID. */
  repository_id: number;
  created_at: string;
}

export interface SupabaseStarEvent {
  repository_id: number;
  stars_count: number;
  previous_stars_count: number;
  created_at: string;
}

export interface SupabaseExport {
  chats: SupabaseChat[];
  repositories: SupabaseRepository[];
  subscriptions: SupabaseSubscription[];
  starEvents: SupabaseStarEvent[];
}

/** GitHub node IDs by GitHub repository ID; null for repositories gone from GitHub or private. */
export type NodeIds = ReadonlyMap<number, string | null>;

/** D1 rows, read back for verification and for the reverse copy. */
export interface D1Snapshot {
  chats: { id: number; is_active: number }[];
  repositories: {
    id: number;
    github_node_id: string | null;
    full_name: string;
    description: string | null;
    stars_count: number;
    is_archived: number;
  }[];
  subscriptions: { chat_id: number; repository_id: number; last_notified_stars: number }[];
  gains: { repository_id: number; day: string; stars_gained: number }[];
}

/**
 * full: the final copy at the switch. D1 becomes an exact copy of Supabase,
 * and every subscription starts at Supabase's star count.
 * shadow: the daily copy during the shadow run. Chats and subscriptions are
 * mirrored, but the star counts and gains the Worker tracks itself are left
 * alone.
 */
export type CopyMode = "full" | "shadow";

/** The queries that read a D1Snapshot (the scripts run them through wrangler). */
export const SNAPSHOT_QUERIES = {
  chats: "SELECT id, is_active FROM chats ORDER BY id",
  repositories:
    "SELECT id, github_node_id, full_name, description, stars_count, is_archived FROM repositories ORDER BY id",
  subscriptions: "SELECT chat_id, repository_id, last_notified_stars FROM chat_repositories ORDER BY chat_id, repository_id",
  gains: "SELECT repository_id, day, stars_gained FROM daily_star_gains ORDER BY repository_id, day",
} as const satisfies Record<keyof D1Snapshot, string>;
