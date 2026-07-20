-- Add player_id column to raw_kali_player_game_stats for resolution
ALTER TABLE raw_kali_player_game_stats 
ADD COLUMN IF NOT EXISTS player_id UUID REFERENCES players(id);

CREATE INDEX IF NOT EXISTS idx_raw_kali_player_id ON raw_kali_player_game_stats(player_id);

-- Resolve staged rows to player_id using normalized name matching
-- This matches regardless of team format differences
UPDATE raw_kali_player_game_stats r
SET player_id = p.id
FROM players p
WHERE r.player_id IS NULL
  AND normalize_player_name(r.raw_player_name) = normalize_player_name(p.name);

-- Report resolution stats
SELECT 
  COUNT(*) as total_staged,
  COUNT(player_id) as resolved,
  COUNT(*) - COUNT(player_id) as still_unresolved
FROM raw_kali_player_game_stats;
