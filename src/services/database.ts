import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config';
import { Database, Chat, Repository, ChatRepository, StarEvent, RepositoryInsert, ChatRepositoryInsert, StarEventInsert } from '../types/database';

export class DatabaseService {
  private supabase: SupabaseClient<any>;

  constructor() {
    this.supabase = createClient(
      config.supabase.url,
      config.supabase.anonKey
    );
  }

  // Chat operations
  async getOrCreateChat(chatId: number): Promise<Chat> {
    const { data: existingChat } = await this.supabase
      .from('chats')
      .select('*')
      .eq('id', chatId)
      .single();

    if (existingChat) {
      return existingChat;
    }

    const { data: newChat, error } = await this.supabase
      .from('chats')
      .insert({ id: chatId })
      .select('*')
      .single();

    if (error) {
      throw new Error(`Failed to create chat: ${error.message}`);
    }

    return newChat;
  }

  async getChatSubscriptions(chatId: number): Promise<Repository[]> {
    const { data, error } = await this.supabase
      .from('chat_repositories')
      .select(`
        repositories (*)
      `)
      .eq('chat_id', chatId);

    if (error) {
      throw new Error(`Failed to get chat subscriptions: ${error.message}`);
    }

    return data?.map((item: any) => item.repositories).filter(Boolean) as Repository[] || [];
  }

  // Repository operations
  async getOrCreateRepository(githubRepo: any): Promise<Repository> {
    const { data: existingRepo } = await this.supabase
      .from('repositories')
      .select('*')
      .eq('github_id', githubRepo.id)
      .single();

    if (existingRepo) {
      // Update repository data
      const { data: updatedRepo, error } = await this.supabase
        .from('repositories')
        .update({
          full_name: githubRepo.full_name,
          description: githubRepo.description,
          html_url: githubRepo.html_url,
          stars_count: githubRepo.stargazers_count,
          is_archived: githubRepo.archived,
        })
        .eq('id', existingRepo.id)
        .select('*')
        .single();

      if (error) {
        throw new Error(`Failed to update repository: ${error.message}`);
      }

      return updatedRepo;
    }

    const repoData: RepositoryInsert = {
      github_id: githubRepo.id,
      full_name: githubRepo.full_name,
      description: githubRepo.description,
      html_url: githubRepo.html_url,
      stars_count: githubRepo.stargazers_count,
      is_archived: githubRepo.archived,
    };

    const { data: newRepo, error } = await this.supabase
      .from('repositories')
      .insert(repoData)
      .select('*')
      .single();

    if (error) {
      throw new Error(`Failed to create repository: ${error.message}`);
    }

    return newRepo;
  }

  async getAllRepositories(): Promise<Repository[]> {
    const { data, error } = await this.supabase
      .from('repositories')
      .select('*')
      .eq('is_archived', false);

    if (error) {
      throw new Error(`Failed to get repositories: ${error.message}`);
    }

    return data;
  }

  async updateRepositoryStarsCount(repositoryId: number, starsCount: number): Promise<void> {
    const { error } = await this.supabase
      .from('repositories')
      .update({
        stars_count: starsCount,
        last_star_check: new Date().toISOString()
      })
      .eq('id', repositoryId);

    if (error) {
      throw new Error(`Failed to update repository stars count: ${error.message}`);
    }
  }

  // Subscription operations
  async addSubscription(chatId: number, repositoryId: number): Promise<ChatRepository> {
    // Check if subscription already exists
    const { data: existingSubscription } = await this.supabase
      .from('chat_repositories')
      .select('*')
      .eq('chat_id', chatId)
      .eq('repository_id', repositoryId)
      .single();

    if (existingSubscription) {
      return existingSubscription;
    }

    const subscriptionData: ChatRepositoryInsert = {
      chat_id: chatId,
      repository_id: repositoryId,
    };

    const { data, error } = await this.supabase
      .from('chat_repositories')
      .insert(subscriptionData)
      .select('*')
      .single();

    if (error) {
      throw new Error(`Failed to add subscription: ${error.message}`);
    }

    return data;
  }

  async removeSubscription(chatId: number, repositoryId: number): Promise<void> {
    const { error } = await this.supabase
      .from('chat_repositories')
      .delete()
      .eq('chat_id', chatId)
      .eq('repository_id', repositoryId);

    if (error) {
      throw new Error(`Failed to remove subscription: ${error.message}`);
    }
  }

  async getSubscribersForRepository(repositoryId: number): Promise<number[]> {
    const { data, error } = await this.supabase
      .from('chat_repositories')
      .select('chat_id')
      .eq('repository_id', repositoryId);

    if (error) {
      throw new Error(`Failed to get repository subscribers: ${error.message}`);
    }

    return data?.map((item: any) => item.chat_id) || [];
  }

  // Star event operations
  async createStarEvent(repositoryId: number, starsCount: number, previousStarsCount: number): Promise<StarEvent> {
    const eventData: StarEventInsert = {
      repository_id: repositoryId,
      stars_count: starsCount,
      previous_stars_count: previousStarsCount,
    };

    const { data, error } = await this.supabase
      .from('star_events')
      .insert(eventData)
      .select('*')
      .single();

    if (error) {
      throw new Error(`Failed to create star event: ${error.message}`);
    }

    return data;
  }

  async getRecentStarEvents(repositoryId: number, limit: number = 10): Promise<StarEvent[]> {
    const { data, error } = await this.supabase
      .from('star_events')
      .select('*')
      .eq('repository_id', repositoryId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(`Failed to get star events: ${error.message}`);
    }

    return data;
  }

  // Statistics
  async getStats(): Promise<{
    totalRepositories: number;
    totalChats: number;
    totalSubscriptions: number;
    totalStarEvents: number;
  }> {
    const [reposResult, chatsResult, subscriptionsResult, eventsResult] = await Promise.all([
      this.supabase.from('repositories').select('*', { count: 'exact', head: true }),
      this.supabase.from('chats').select('*', { count: 'exact', head: true }),
      this.supabase.from('chat_repositories').select('*', { count: 'exact', head: true }),
      this.supabase.from('star_events').select('*', { count: 'exact', head: true }),
    ]);

    return {
      totalRepositories: reposResult.count || 0,
      totalChats: chatsResult.count || 0,
      totalSubscriptions: subscriptionsResult.count || 0,
      totalStarEvents: eventsResult.count || 0,
    };
  }
}
