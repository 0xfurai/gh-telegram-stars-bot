-- Supabase database schema for Telegram GitHub Stars Bot

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Chats table (Telegram chats/users)
CREATE TABLE chats (
  id BIGINT PRIMARY KEY, -- Telegram chat ID
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  is_active BOOLEAN DEFAULT TRUE
);

-- Repositories table
CREATE TABLE repositories (
  id SERIAL PRIMARY KEY,
  github_id BIGINT UNIQUE NOT NULL, -- GitHub repository ID
  full_name VARCHAR(255) NOT NULL, -- owner/repo format
  description TEXT,
  html_url VARCHAR(500) NOT NULL,
  stars_count INTEGER DEFAULT 0,
  last_star_check TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  is_archived BOOLEAN DEFAULT FALSE
);

-- Chat-Repository subscriptions (many-to-many)
CREATE TABLE chat_repositories (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  chat_id BIGINT REFERENCES chats(id) ON DELETE CASCADE,
  repository_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(chat_id, repository_id)
);

-- Star events for tracking new stars
CREATE TABLE star_events (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  repository_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
  stars_count INTEGER NOT NULL,
  previous_stars_count INTEGER NOT NULL,
  stars_gained INTEGER GENERATED ALWAYS AS (stars_count - previous_stars_count) STORED,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for better performance
CREATE INDEX idx_repositories_github_id ON repositories(github_id);
CREATE INDEX idx_repositories_full_name ON repositories(full_name);
CREATE INDEX idx_repositories_last_star_check ON repositories(last_star_check);
CREATE INDEX idx_chat_repositories_chat_id ON chat_repositories(chat_id);
CREATE INDEX idx_chat_repositories_repository_id ON chat_repositories(repository_id);
CREATE INDEX idx_star_events_repository_id ON star_events(repository_id);
CREATE INDEX idx_star_events_created_at ON star_events(created_at);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers to auto-update updated_at
CREATE TRIGGER update_chats_updated_at BEFORE UPDATE ON chats
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_repositories_updated_at BEFORE UPDATE ON repositories
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS (Row Level Security) policies
ALTER TABLE chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE star_events ENABLE ROW LEVEL SECURITY;

-- Allow service role to access all data
CREATE POLICY "Service role can access all chats" ON chats
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role can access all repositories" ON repositories
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role can access all chat_repositories" ON chat_repositories
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role can access all star_events" ON star_events
    FOR ALL USING (auth.role() = 'service_role');
