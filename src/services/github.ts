import { Octokit } from '@octokit/rest';
import { config } from '../config';

export interface GitHubRepository {
  id: number;
  full_name: string;
  description: string | null;
  html_url: string;
  stargazers_count: number;
  archived: boolean;
  owner: {
    login: string;
  };
}

export class GitHubService {
  private octokit: Octokit;

  constructor() {
    this.octokit = new Octokit({
      auth: config.github.token,
    });
  }

  async getRepository(owner: string, repo: string): Promise<GitHubRepository | null> {
    try {
      const { data } = await this.octokit.repos.get({
        owner,
        repo,
      });

      return {
        id: data.id,
        full_name: data.full_name,
        description: data.description,
        html_url: data.html_url,
        stargazers_count: data.stargazers_count,
        archived: data.archived,
        owner: {
          login: data.owner.login,
        },
      };
    } catch (error: any) {
      if (error.status === 404) {
        return null;
      }
      throw new Error(`Failed to fetch repository: ${error.message}`);
    }
  }

  async getRepositoryByFullName(fullName: string): Promise<GitHubRepository | null> {
    const [owner, repo] = fullName.split('/');
    if (!owner || !repo) {
      throw new Error('Invalid repository format. Use owner/repo');
    }
    return this.getRepository(owner, repo);
  }

  async getRepositoryStarCount(owner: string, repo: string): Promise<number> {
    try {
      const { data } = await this.octokit.repos.get({
        owner,
        repo,
      });
      return data.stargazers_count;
    } catch (error: any) {
      throw new Error(`Failed to fetch star count: ${error.message}`);
    }
  }

  async searchRepositories(query: string, limit: number = 5): Promise<GitHubRepository[]> {
    try {
      const { data } = await this.octokit.search.repos({
        q: query,
        per_page: limit,
        sort: 'stars',
        order: 'desc',
      });

      return data.items.map(item => ({
        id: item.id,
        full_name: item.full_name,
        description: item.description,
        html_url: item.html_url,
        stargazers_count: item.stargazers_count,
        archived: item.archived,
        owner: {
          login: item.owner?.login || '',
        },
      }));
    } catch (error: any) {
      throw new Error(`Failed to search repositories: ${error.message}`);
    }
  }

  parseRepositoryUrl(url: string): { owner: string; repo: string } | null {
    // Match GitHub URLs like https://github.com/owner/repo
    const githubUrlPattern = /^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)\/?$/;
    const match = url.match(githubUrlPattern);

    if (match) {
      return {
        owner: match[1],
        repo: match[2],
      };
    }

    // Also handle owner/repo format directly
    const directPattern = /^([^\/]+)\/([^\/]+)$/;
    const directMatch = url.match(directPattern);

    if (directMatch) {
      return {
        owner: directMatch[1],
        repo: directMatch[2],
      };
    }

    return null;
  }

  async getRateLimitStatus(): Promise<{
    limit: number;
    remaining: number;
    reset: Date;
  }> {
    try {
      const { data } = await this.octokit.rateLimit.get();
      return {
        limit: data.rate.limit,
        remaining: data.rate.remaining,
        reset: new Date(data.rate.reset * 1000),
      };
    } catch (error: any) {
      throw new Error(`Failed to get rate limit status: ${error.message}`);
    }
  }
}
