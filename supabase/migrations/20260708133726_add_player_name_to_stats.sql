-- Add player_name column to player_game_stats for storing stats when player_id can't be resolved
ALTER TABLE player_game_stats 
ADD COLUMN IF NOT EXISTS player_name TEXT,
ADD COLUMN IF NOT EXISTS season INTEGER,
ADD COLUMN IF NOT EXISTS round TEXT,
ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'unknown',
ADD COLUMN IF NOT EXISTS imported_at TIMESTAMPTZ DEFAULT now(),
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- Add index for faster lookups by player_name + match_date
CREATE INDEX IF NOT EXISTS idx_player_game_stats_player_name_match_date 
ON player_game_stats(player_name, match_date) 
WHERE player_id IS NULL;

-- Add comments
COMMENT ON COLUMN player_game_stats.player_name IS 'Player name from source - used when player_id cannot be resolved';
COMMENT ON COLUMN player_game_stats.season IS 'Season year for the match';
COMMENT ON COLUMN player_game_stats.round IS 'Round number for the match (e.g. "1", "2", "17")';
COMMENT ON COLUMN player_game_stats.source IS 'Source of the stats (e.g. kali_footywire_std, csv_import)';
COMMENT ON COLUMN player_game_stats.imported_at IS 'When this row was first imported';
COMMENT ON COLUMN player_game_stats.updated_at IS 'When this row was last updated';
