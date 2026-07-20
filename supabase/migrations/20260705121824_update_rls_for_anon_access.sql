-- Update RLS policies to allow anon access (no auth required)
-- Since authentication was removed, we need to allow anon users full access

-- Drop existing authenticated-only policies
DROP POLICY IF EXISTS "auth_select_players" ON players;
DROP POLICY IF EXISTS "auth_insert_players" ON players;
DROP POLICY IF EXISTS "auth_update_players" ON players;
DROP POLICY IF EXISTS "auth_delete_players" ON players;

DROP POLICY IF EXISTS "auth_select_matches" ON matches;
DROP POLICY IF EXISTS "auth_insert_matches" ON matches;
DROP POLICY IF EXISTS "auth_update_matches" ON matches;
DROP POLICY IF EXISTS "auth_delete_matches" ON matches;

DROP POLICY IF EXISTS "auth_select_pgs" ON player_game_stats;
DROP POLICY IF EXISTS "auth_insert_pgs" ON player_game_stats;
DROP POLICY IF EXISTS "auth_update_pgs" ON player_game_stats;
DROP POLICY IF EXISTS "auth_delete_pgs" ON player_game_stats;

-- Create new policies allowing both anon and authenticated access
CREATE POLICY "anon_select_players" ON players FOR SELECT
  TO anon, authenticated USING (true);

CREATE POLICY "anon_insert_players" ON players FOR INSERT
  TO anon, authenticated WITH CHECK (true);

CREATE POLICY "anon_update_players" ON players FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

CREATE POLICY "anon_delete_players" ON players FOR DELETE
  TO anon, authenticated USING (true);

CREATE POLICY "anon_select_matches" ON matches FOR SELECT
  TO anon, authenticated USING (true);

CREATE POLICY "anon_insert_matches" ON matches FOR INSERT
  TO anon, authenticated WITH CHECK (true);

CREATE POLICY "anon_update_matches" ON matches FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

CREATE POLICY "anon_delete_matches" ON matches FOR DELETE
  TO anon, authenticated USING (true);

CREATE POLICY "anon_select_pgs" ON player_game_stats FOR SELECT
  TO anon, authenticated USING (true);

CREATE POLICY "anon_insert_pgs" ON player_game_stats FOR INSERT
  TO anon, authenticated WITH CHECK (true);

CREATE POLICY "anon_update_pgs" ON player_game_stats FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

CREATE POLICY "anon_delete_pgs" ON player_game_stats FOR DELETE
  TO anon, authenticated USING (true);

-- Add unique constraint to prevent duplicate stats (player_id + match_id)
ALTER TABLE player_game_stats 
DROP CONSTRAINT IF EXISTS player_game_stats_player_match_unique;

ALTER TABLE player_game_stats 
ADD CONSTRAINT player_game_stats_player_match_unique 
UNIQUE (player_id, match_id);

-- Add unique constraint on matches to prevent duplicates
ALTER TABLE matches
DROP CONSTRAINT IF EXISTS matches_season_round_teams_unique;

ALTER TABLE matches
ADD CONSTRAINT matches_season_round_teams_unique
UNIQUE (season, round, home_team, away_team);
