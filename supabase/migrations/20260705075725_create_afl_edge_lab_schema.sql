/*
# AFL Edge Lab - Core Schema

## Overview
Creates the three core tables for AFL player analytics:
- players: Player registry with team and position info
- matches: Game records with scores and metadata
- player_game_stats: Per-player per-game performance data (the analytics engine)

## Tables

### players
- id (uuid, PK)
- name (text, not null)
- team (text, not null)
- position (text) — e.g. Forward, Midfielder, Defender, Ruck
- created_at (timestamp)

### matches
- id (uuid, PK)
- season (integer) — e.g. 2024
- round (text) — e.g. "Round 1", "Final"
- home_team (text)
- away_team (text)
- venue (text)
- match_date (date)
- home_score (integer)
- away_score (integer)
- created_at (timestamp)

### player_game_stats
- id (uuid, PK)
- player_id (uuid, FK → players)
- match_id (uuid, FK → matches)
- match_date (date) — denormalized for faster queries
- team (text) — player's team in this game
- opponent (text)
- venue (text)
- disposals (integer)
- marks (integer)
- tackles (integer)
- goals (integer)
- hitouts (integer)
- created_at (timestamp)

## Security
- RLS enabled on all tables
- Authenticated users can read all data (analytics is shared/global)
- Authenticated users can insert/update/delete (for data import)
- Anon users have no access (private platform)

## Notes
- player_game_stats has indexes on player_id and match_date for fast analytics queries
- match_date is denormalized into player_game_stats to avoid joins in hot analytics paths
*/

-- Players table
CREATE TABLE IF NOT EXISTS players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  team text NOT NULL,
  position text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE players ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_select_players" ON players;
CREATE POLICY "auth_select_players" ON players FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_insert_players" ON players;
CREATE POLICY "auth_insert_players" ON players FOR INSERT
  TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "auth_update_players" ON players;
CREATE POLICY "auth_update_players" ON players FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_delete_players" ON players;
CREATE POLICY "auth_delete_players" ON players FOR DELETE
  TO authenticated USING (true);

-- Matches table
CREATE TABLE IF NOT EXISTS matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season integer NOT NULL,
  round text,
  home_team text,
  away_team text,
  venue text,
  match_date date,
  home_score integer,
  away_score integer,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE matches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_select_matches" ON matches;
CREATE POLICY "auth_select_matches" ON matches FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_insert_matches" ON matches;
CREATE POLICY "auth_insert_matches" ON matches FOR INSERT
  TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "auth_update_matches" ON matches;
CREATE POLICY "auth_update_matches" ON matches FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_delete_matches" ON matches;
CREATE POLICY "auth_delete_matches" ON matches FOR DELETE
  TO authenticated USING (true);

-- Player game stats table
CREATE TABLE IF NOT EXISTS player_game_stats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  match_id uuid REFERENCES matches(id) ON DELETE SET NULL,
  match_date date NOT NULL,
  team text NOT NULL,
  opponent text,
  venue text,
  disposals integer DEFAULT 0,
  marks integer DEFAULT 0,
  tackles integer DEFAULT 0,
  goals integer DEFAULT 0,
  hitouts integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE player_game_stats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_select_pgs" ON player_game_stats;
CREATE POLICY "auth_select_pgs" ON player_game_stats FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_insert_pgs" ON player_game_stats;
CREATE POLICY "auth_insert_pgs" ON player_game_stats FOR INSERT
  TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "auth_update_pgs" ON player_game_stats;
CREATE POLICY "auth_update_pgs" ON player_game_stats FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_delete_pgs" ON player_game_stats;
CREATE POLICY "auth_delete_pgs" ON player_game_stats FOR DELETE
  TO authenticated USING (true);

-- Indexes for analytics performance
CREATE INDEX IF NOT EXISTS idx_pgs_player_id ON player_game_stats(player_id);
CREATE INDEX IF NOT EXISTS idx_pgs_match_date ON player_game_stats(match_date);
CREATE INDEX IF NOT EXISTS idx_pgs_player_date ON player_game_stats(player_id, match_date DESC);
CREATE INDEX IF NOT EXISTS idx_players_team ON players(team);
CREATE INDEX IF NOT EXISTS idx_matches_season_round ON matches(season, round);
