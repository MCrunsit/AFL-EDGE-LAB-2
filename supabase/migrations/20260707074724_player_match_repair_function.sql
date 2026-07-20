-- Player matching repair function
-- Updates bookmaker_odds.player_id where bookmaker_player_name matches players.name

-- Create a function to repair player matches
CREATE OR REPLACE FUNCTION repair_player_matches()
RETURNS TABLE(
  total_odds bigint,
  matched_count bigint,
  unmatched_count bigint,
  unique_matched_players bigint,
  unique_unmatched_players bigint
) 
LANGUAGE plpgsql
AS $$
DECLARE
  v_total bigint;
  v_matched bigint;
  v_unmatched bigint;
  v_unique_matched bigint;
  v_unique_unmatched bigint;
BEGIN
  -- Count starting state
  SELECT COUNT(*) INTO v_total FROM bookmaker_odds WHERE source = 'the_odds_api';
  
  -- Match and update player_ids for The Odds API odds
  -- Match by exact normalized name (case-insensitive, trimmed)
  UPDATE bookmaker_odds o
  SET player_id = p.id
  FROM players p
  WHERE o.source = 'the_odds_api'
    AND o.player_id IS NULL
    AND o.bookmaker_player_name IS NOT NULL
    AND LOWER(TRIM(o.bookmaker_player_name)) = LOWER(TRIM(p.name));
  
  GET DIAGNOSTICS v_matched = ROW_COUNT;
  
  -- Count unmatched
  SELECT COUNT(*) INTO v_unmatched 
  FROM bookmaker_odds 
  WHERE source = 'the_odds_api' AND player_id IS NULL;
  
  -- Count remaining unmatched
  SELECT COUNT(DISTINCT bookmaker_player_name) INTO v_unique_unmatched
  FROM bookmaker_odds
  WHERE source = 'the_odds_api' AND player_id IS NULL AND bookmaker_player_name IS NOT NULL;
  
  SELECT COUNT(DISTINCT p.name) INTO v_unique_matched
  FROM bookmaker_odds o
  JOIN players p ON p.id = o.player_id
  WHERE o.source = 'the_odds_api';
  
  RETURN QUERY SELECT v_total, v_matched, v_unmatched, v_unique_matched, v_unique_unmatched;
END;
$$;

-- Run the repair
SELECT * FROM repair_player_matches();