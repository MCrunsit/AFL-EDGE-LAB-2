-- Delete old seeded fixtures with short integer api_match_id (length < 20)
-- Keep only real The Odds API fixtures with UUID (length >= 32)
DELETE FROM matches 
WHERE match_date >= CURRENT_DATE 
  AND LENGTH(api_match_id) < 20;

-- Verify remaining fixtures
SELECT 'Remaining fixtures' as status, COUNT(*) as count FROM matches WHERE match_date >= CURRENT_DATE;