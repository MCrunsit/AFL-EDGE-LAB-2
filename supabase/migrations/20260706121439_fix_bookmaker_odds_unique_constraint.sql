-- Fix unique constraint on bookmaker_odds.
-- Old constraint used (bookmaker_id, player_id, match_id, market, line)
-- which allows duplicates when player_id is NULL (NULL != NULL in SQL).
-- New constraint uses (bookmaker_id, bookmaker_player_name, match_id, market, line)
-- which is always non-null and correctly preserves full ladder rows.

-- First ensure bookmaker_player_name is NOT NULL for existing rows
-- (backfill with 'unknown' for any null values)
UPDATE bookmaker_odds
SET bookmaker_player_name = 'unknown'
WHERE bookmaker_player_name IS NULL;

-- Drop the old constraint
ALTER TABLE bookmaker_odds
  DROP CONSTRAINT IF EXISTS bookmaker_odds_bookmaker_id_player_id_match_id_market_line_key;

-- Add new constraint on (bookmaker_id, bookmaker_player_name, match_id, market, line)
-- This allows each ladder level (21+, 22+, 23+...) to coexist as separate rows
-- because each has a distinct integer line value.
ALTER TABLE bookmaker_odds
  ADD CONSTRAINT bookmaker_odds_dedup_key
  UNIQUE (bookmaker_id, bookmaker_player_name, match_id, market, line);

-- Make bookmaker_player_name NOT NULL going forward
ALTER TABLE bookmaker_odds
  ALTER COLUMN bookmaker_player_name SET NOT NULL;
