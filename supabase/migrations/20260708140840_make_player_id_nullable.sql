-- Make player_id nullable so we can store stats for unresolved players
ALTER TABLE player_game_stats ALTER COLUMN player_id DROP NOT NULL;

-- Add comment
COMMENT ON COLUMN player_game_stats.player_id IS 'Player ID resolved from players table. NULL if player could not be matched.';

-- Check for unique constraints
SELECT conname, contype, pg_get_constraintdef(oid) 
FROM pg_constraint 
WHERE conrelid = 'player_game_stats'::regclass;
