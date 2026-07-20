-- Drop the existing unique constraint
ALTER TABLE player_game_stats DROP CONSTRAINT IF EXISTS player_game_stats_player_match_unique;

-- Create a unique index that handles both resolved and unresolved players
-- For resolved players: (player_id, match_id)
-- For unresolved players: (player_name, team, match_date)
CREATE UNIQUE INDEX IF NOT EXISTS player_game_stats_unique_resolved 
ON player_game_stats (player_id, match_id) 
WHERE player_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS player_game_stats_unique_unresolved
ON player_game_stats (player_name, team, match_date)
WHERE player_id IS NULL;

-- Add comment
COMMENT ON INDEX player_game_stats_unique_resolved IS 'Ensures one stats row per resolved player per match';
COMMENT ON INDEX player_game_stats_unique_unresolved IS 'Ensures one stats row per unresolved player name per team per date';
