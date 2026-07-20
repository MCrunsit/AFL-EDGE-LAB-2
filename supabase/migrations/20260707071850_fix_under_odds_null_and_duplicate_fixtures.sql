-- Fix under_odds column to allow NULL and set NULL for _over markets

-- 1. Alter column to allow NULL
ALTER TABLE bookmaker_odds ALTER COLUMN under_odds DROP NOT NULL;

-- 2. Update under_odds to NULL for _over markets (they are over-only)
UPDATE bookmaker_odds 
SET under_odds = NULL 
WHERE source = 'the_odds_api' 
  AND raw_market LIKE '%_over';

-- 3. Archive old manual fixtures that don't have api_match_id from The Odds API
-- Delete duplicates where same teams exist with api_match_id
DELETE FROM matches 
WHERE api_match_id IS NULL 
  AND match_date >= CURRENT_DATE
  AND id IN (
    SELECT m1.id FROM matches m1
    JOIN matches m2 ON m2.api_match_id IS NOT NULL AND m2.match_date >= CURRENT_DATE
    WHERE m1.api_match_id IS NULL
      AND m1.match_date >= CURRENT_DATE
      AND (
        LOWER(m1.home_team) LIKE '%' || LOWER(SPLIT_PART(m2.home_team, ' ', 1)) || '%'
        OR LOWER(m2.home_team) LIKE '%' || LOWER(SPLIT_PART(m1.home_team, ' ', 1)) || '%'
      )
  );