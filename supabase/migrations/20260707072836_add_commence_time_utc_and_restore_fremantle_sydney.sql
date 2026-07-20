-- Add commence_time_utc for full timestamp storage and restore missing Fremantle vs Sydney fixture

-- 1. Add commence_time_utc column
ALTER TABLE matches ADD COLUMN IF NOT EXISTS commence_time_utc TIMESTAMPTZ;

-- 2. Drop view that depends on matches
DROP VIEW IF EXISTS upcoming_matches;

-- 3. Insert missing Fremantle vs Sydney fixture that was deleted
INSERT INTO matches (
  id, season, round, home_team, away_team, venue, match_date, api_match_id, commence_time_utc
) VALUES (
  gen_random_uuid(),
  2026,
  'R16',
  'Fremantle Dockers',
  'Sydney Swans',
  'Optus Stadium',
  '2026-07-09',
  '84b6de9f7b35130c08d2d350415a02e4',
  '2026-07-09T10:10:00Z'
) ON CONFLICT DO NOTHING;

-- 4. Update existing fixtures with commence_time_utc based on The Odds API schedule
-- Thu Jul 9 2026
UPDATE matches SET commence_time_utc = '2026-07-09T10:10:00Z' 
WHERE api_match_id = '84b6de9f7b35130c08d2d350415a02e4';

-- Fri Jul 10 2026 - 7:40pm AEST = 09:40 UTC
UPDATE matches SET commence_time_utc = '2026-07-10T09:40:00Z' 
WHERE api_match_id = 'cc95f6dde494fb94b9b04f2291f8fb80';

-- Sat Jul 11 2026
UPDATE matches SET commence_time_utc = '2026-07-11T03:15:00Z' WHERE api_match_id = '623c67ea943712bd04fcf89861655a63'; -- 1:15pm AEST
UPDATE matches SET commence_time_utc = '2026-07-11T06:15:00Z' WHERE api_match_id = 'f6d3d763bb1dcde33192abc47f1859b3'; -- 4:15pm AEST
UPDATE matches SET commence_time_utc = '2026-07-11T09:35:00Z' WHERE api_match_id = '6db04f1bce8d12056071015cd4d48cd9'; -- 7:35pm AEST
UPDATE matches SET commence_time_utc = '2026-07-11T10:10:00Z' WHERE api_match_id = '24f75fcd633532ddb6245098fde3db79'; -- 8:10pm AEST

-- Sun Jul 12 2026
UPDATE matches SET commence_time_utc = '2026-07-12T03:10:00Z' WHERE api_match_id = 'c2a8fb6181bea95d76d92bce47eabea1'; -- 1:10pm AEST
UPDATE matches SET commence_time_utc = '2026-07-12T05:15:00Z' WHERE api_match_id = '8fb7f76d9cf01948d2f7da59fec30559'; -- 3:15pm AEST
UPDATE matches SET commence_time_utc = '2026-07-12T06:40:00Z' WHERE api_match_id = 'b84ae87285f4c99364899798456d3cb1'; -- 4:40pm AEST

-- 5. Recreate upcoming_matches view
CREATE VIEW upcoming_matches AS
SELECT 
  id, season, round, home_team, away_team, venue, match_date, api_match_id, home_score, away_score, commence_time_utc
FROM matches
WHERE match_date >= CURRENT_DATE
ORDER BY commence_time_utc NULLS LAST, match_date;

-- 6. Verify
SELECT 'matches' as table_name, COUNT(*) as total FROM matches WHERE match_date >= CURRENT_DATE;