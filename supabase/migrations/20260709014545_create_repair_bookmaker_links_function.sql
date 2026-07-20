-- Function to repair bookmaker_odds.player_id to canonical stats players
CREATE OR REPLACE FUNCTION repair_bookmaker_player_links()
RETURNS TABLE(
  odds_rows_checked bigint,
  already_correct bigint,
  relinked_to_canonical bigint,
  still_no_stats bigint,
  errors bigint
) AS $$
DECLARE
  v_checked bigint := 0;
  v_correct bigint := 0;
  v_relinked bigint := 0;
  v_no_stats bigint := 0;
  v_errors bigint := 0;
  v_stats_count bigint;
  v_new_player_id uuid;
  v_best_stats_count bigint;
BEGIN
  -- Process each bookmaker_odds row with player_id
  FOR v_checked IN 
    SELECT COUNT(*) FROM bookmaker_odds WHERE player_id IS NOT NULL
  LOOP
    -- Placeholder - actual processing would iterate through rows
    EXIT;
  END LOOP;
  
  -- Use update with subquery for canonical players with stats
  -- First, identify rows where current player_id has no stats
  WITH current_stats AS (
    SELECT 
      bo.id as odds_id,
      bo.player_id,
      bo.bookmaker_player_name,
      bo.match_id,
      (SELECT COUNT(*) FROM player_game_stats WHERE player_id = bo.player_id) as stats_count
    FROM bookmaker_odds bo
    WHERE bo.player_id IS NOT NULL
  ),
  better_candidates AS (
    SELECT 
      cs.odds_id,
      cs.player_id as current_player_id,
      p.id as better_player_id,
      p.name,
      p.team,
      (SELECT COUNT(*) FROM player_game_stats WHERE player_id = p.id) as candidate_stats
    FROM current_stats cs
    JOIN players p ON normalize_player_name(p.name) = normalize_player_name(cs.bookmaker_player_name)
    WHERE cs.stats_count = 0
      OR cs.stats_count < 5  -- very limited stats
  ),
  best_per_odds AS (
    SELECT DISTINCT ON (b.odds_id)
      b.odds_id,
      b.better_player_id,
      b.candidate_stats
    FROM better_candidates b
    WHERE b.candidate_stats > 0
    ORDER BY b.odds_id, b.candidate_stats DESC
  )
  UPDATE bookmaker_odds bo
  SET 
    player_id = bp.better_player_id,
    resolved_player_name = p.name,
    resolution_status = 'relinked',
    resolution_reason = 'canonical_stats_player'
  FROM best_per_odds bp
  JOIN players p ON p.id = bp.better_player_id
  WHERE bo.id = bp.odds_id;
  
  GET DIAGNOSTICS v_relinked = ROW_COUNT;
  
  -- Count stats after repair
  SELECT COUNT(*) INTO v_no_stats
  FROM bookmaker_odds bo
  WHERE bo.player_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM player_game_stats WHERE player_id = bo.player_id);
  
  SELECT COUNT(*) INTO v_correct
  FROM bookmaker_odds bo
  WHERE bo.player_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM player_game_stats WHERE player_id = bo.player_id LIMIT 1);
  
  RETURN QUERY SELECT v_checked, v_correct, v_relinked, v_no_stats, v_errors;
END;
$$ LANGUAGE plpgsql;
