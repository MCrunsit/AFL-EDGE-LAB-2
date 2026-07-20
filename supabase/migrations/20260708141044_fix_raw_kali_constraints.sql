-- Add unique constraint for raw staging table (for upsert)
CREATE UNIQUE INDEX IF NOT EXISTS raw_kali_unique_match_player
ON raw_kali_player_game_stats (match_id, normalized_player_name, team);
