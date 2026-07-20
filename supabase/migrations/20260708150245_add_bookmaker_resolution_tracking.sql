-- Add resolution tracking columns to bookmaker_odds
ALTER TABLE bookmaker_odds 
ADD COLUMN IF NOT EXISTS resolved_player_name TEXT,
ADD COLUMN IF NOT EXISTS resolution_status TEXT DEFAULT 'pending',
ADD COLUMN IF NOT EXISTS resolution_reason TEXT;

-- Create index for faster repair queries
CREATE INDEX IF NOT EXISTS idx_bookmaker_odds_player_null 
ON bookmaker_odds(match_id) 
WHERE player_id IS NULL;

-- Check FK constraint
SELECT conname, pg_get_constraintdef(oid) 
FROM pg_constraint 
WHERE conrelid = 'bookmaker_odds'::regclass AND contype = 'f';
