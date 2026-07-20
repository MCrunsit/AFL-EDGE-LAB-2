-- Fix api_match_id to store UUID event IDs from The Odds API

-- 1. Drop the view that depends on api_match_id
DROP VIEW IF EXISTS upcoming_matches;

-- 2. Alter the column type
ALTER TABLE matches ALTER COLUMN api_match_id TYPE VARCHAR(64);

-- 3. Recreate the view
CREATE VIEW upcoming_matches AS
SELECT 
  id, season, round, home_team, away_team, venue, match_date, api_match_id, home_score, away_score
FROM matches
WHERE match_date >= CURRENT_DATE
ORDER BY match_date;

-- 4. Delete old fake bookmaker_feed rows
DELETE FROM bookmaker_odds WHERE source = 'bookmaker_feed';