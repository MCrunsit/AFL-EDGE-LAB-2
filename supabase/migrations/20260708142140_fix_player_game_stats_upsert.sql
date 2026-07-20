-- Drop the partial unique indexes (they can't be used for ON CONFLICT)
DROP INDEX IF EXISTS player_game_stats_unique_resolved;
DROP INDEX IF EXISTS player_game_stats_unique_unresolved;

-- Create a proper unique constraint for player_id + match_id (resolved players)
-- This will work with ON CONFLICT
ALTER TABLE player_game_stats 
ADD CONSTRAINT player_game_stats_player_match_unique 
UNIQUE (player_id, match_id);

-- For unresolved rows (player_id is null), we need a different approach
-- Create a unique index with COALESCE to handle nulls
-- Actually, we can't do this easily. Let's use player_name + match_id as a fallback unique
-- But since player_id can be null, we need a filtered approach

-- The simplest solution: player_game_stats STRICTLY requires player_id (resolved only)
-- Unresolved rows go to raw_kali_player_game_stats only

-- Make player_id NOT NULL again for player_game_stats
-- This ensures we only store resolved players in player_game_stats
ALTER TABLE player_game_stats ALTER COLUMN player_id SET NOT NULL;
