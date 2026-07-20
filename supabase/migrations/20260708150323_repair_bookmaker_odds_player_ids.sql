-- Create a function to normalize player names for matching
CREATE OR REPLACE FUNCTION normalize_player_name(name TEXT)
RETURNS TEXT AS $$
BEGIN
  RETURN LOWER(TRIM(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(
    name,
    '[''"`]', '', 'g'),  -- Remove apostrophes (curly and straight)
    '[.\-]', ' ', 'g'),   -- Replace periods and hyphens with space
    '\s+', ' ', 'g')));   -- Collapse multiple spaces
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Create a function to normalize team names to canonical form
CREATE OR REPLACE FUNCTION normalize_team_canonical(team TEXT)
RETURNS TEXT AS $$
BEGIN
  RETURN CASE 
    WHEN LOWER(team) IN ('adelaide', 'adelaide crows') THEN 'adelaide'
    WHEN LOWER(team) IN ('brisbane', 'brisbane lions') THEN 'brisbane'
    WHEN LOWER(team) IN ('carlton', 'carlton blues') THEN 'carlton'
    WHEN LOWER(team) IN ('collingwood', 'collingwood magpies') THEN 'collingwood'
    WHEN LOWER(team) IN ('essendon', 'essendon bombers') THEN 'essendon'
    WHEN LOWER(team) IN ('fremantle', 'fremantle dockers') THEN 'fremantle'
    WHEN LOWER(team) IN ('geelong', 'geelong cats') THEN 'geelong'
    WHEN LOWER(team) IN ('gold coast', 'gold-coast', 'gold coast suns') THEN 'gold-coast'
    WHEN LOWER(team) IN ('gws', 'greater western sydney', 'greater western sydney giants', 'gws giants') THEN 'gws'
    WHEN LOWER(team) IN ('hawthorn', 'hawthorn hawks') THEN 'hawthorn'
    WHEN LOWER(team) IN ('melbourne', 'melbourne demons') THEN 'melbourne'
    WHEN LOWER(team) IN ('north melbourne', 'north-melbourne', 'north melbourne kangaroos') THEN 'north-melbourne'
    WHEN LOWER(team) IN ('port adelaide', 'port-adelaide', 'port adelaide power') THEN 'port-adelaide'
    WHEN LOWER(team) IN ('richmond', 'richmond tigers') THEN 'richmond'
    WHEN LOWER(team) IN ('st kilda', 'st-kilda', 'st kilda saints') THEN 'st-kilda'
    WHEN LOWER(team) IN ('sydney', 'sydney swans') THEN 'sydney'
    WHEN LOWER(team) IN ('west coast', 'west-coast', 'west coast eagles') THEN 'west-coast'
    WHEN LOWER(team) IN ('western bulldogs', 'western-bulldogs') THEN 'western-bulldogs'
    ELSE LOWER(REPLACE(TRIM(team), ' ', '-'))
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Create a function to infer player team from match
CREATE OR REPLACE FUNCTION infer_player_team_from_match(
  p_match_id UUID,
  p_bookmaker_player_name TEXT
)
RETURNS TEXT AS $$
DECLARE
  v_home_team TEXT;
  v_away_team TEXT;
  v_home_norm TEXT;
  v_away_norm TEXT;
  v_inferred_team TEXT;
BEGIN
  -- Get match teams
  SELECT home_team, away_team INTO v_home_team, v_away_team
  FROM matches WHERE id = p_match_id;
  
  IF v_home_team IS NULL OR v_away_team IS NULL THEN
    RETURN NULL;
  END IF;
  
  v_home_norm := normalize_team_canonical(v_home_team);
  v_away_norm := normalize_team_canonical(v_away_team);
  
  -- Try to find player in either team from players table
  SELECT team INTO v_inferred_team
  FROM players 
  WHERE normalize_player_name(name) = normalize_player_name(p_bookmaker_player_name)
    AND team IN (v_home_norm, v_away_norm)
  LIMIT 1;
  
  RETURN v_inferred_team;
END;
$$ LANGUAGE plpgsql;

-- Update bookmaker_odds player_id for all existing rows
-- This is the actual repair job
UPDATE bookmaker_odds bo
SET 
  player_id = p.id,
  resolved_player_name = p.name,
  resolution_status = 'resolved',
  resolution_reason = 'exact_name_match'
FROM players p
WHERE bo.player_id IS NULL
  AND bo.bookmaker_player_name IS NOT NULL
  AND normalize_player_name(bo.bookmaker_player_name) = normalize_player_name(p.name);

-- Report stats
SELECT 
  COUNT(*) as total_rows,
  COUNT(player_id) as resolved_rows,
  COUNT(*) - COUNT(player_id) as unresolved_rows
FROM bookmaker_odds;
