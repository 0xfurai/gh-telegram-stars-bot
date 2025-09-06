export interface Database {
  public: {
    Tables: {
      chats: {
        Row: {
          id: number;
          created_at: string;
          updated_at: string;
          is_active: boolean;
        };
        Insert: {
          id: number;
          created_at?: string;
          updated_at?: string;
          is_active?: boolean;
        };
        Update: {
          id?: number;
          created_at?: string;
          updated_at?: string;
          is_active?: boolean;
        };
      };
      repositories: {
        Row: {
          id: number;
          github_id: number;
          full_name: string;
          description: string | null;
          html_url: string;
          stars_count: number;
          last_star_check: string;
          created_at: string;
          updated_at: string;
          is_archived: boolean;
        };
        Insert: {
          id?: number;
          github_id: number;
          full_name: string;
          description?: string | null;
          html_url: string;
          stars_count?: number;
          last_star_check?: string;
          created_at?: string;
          updated_at?: string;
          is_archived?: boolean;
        };
        Update: {
          id?: number;
          github_id?: number;
          full_name?: string;
          description?: string | null;
          html_url?: string;
          stars_count?: number;
          last_star_check?: string;
          created_at?: string;
          updated_at?: string;
          is_archived?: boolean;
        };
      };
      chat_repositories: {
        Row: {
          id: string;
          chat_id: number;
          repository_id: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          chat_id: number;
          repository_id: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          chat_id?: number;
          repository_id?: number;
          created_at?: string;
        };
      };
      star_events: {
        Row: {
          id: string;
          repository_id: number;
          stars_count: number;
          previous_stars_count: number;
          stars_gained: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          repository_id: number;
          stars_count: number;
          previous_stars_count: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          repository_id?: number;
          stars_count?: number;
          previous_stars_count?: number;
          created_at?: string;
        };
      };
    };
  };
}

export type Chat = Database['public']['Tables']['chats']['Row'];
export type Repository = Database['public']['Tables']['repositories']['Row'];
export type ChatRepository = Database['public']['Tables']['chat_repositories']['Row'];
export type StarEvent = Database['public']['Tables']['star_events']['Row'];

export type ChatInsert = Database['public']['Tables']['chats']['Insert'];
export type RepositoryInsert = Database['public']['Tables']['repositories']['Insert'];
export type ChatRepositoryInsert = Database['public']['Tables']['chat_repositories']['Insert'];
export type StarEventInsert = Database['public']['Tables']['star_events']['Insert'];
