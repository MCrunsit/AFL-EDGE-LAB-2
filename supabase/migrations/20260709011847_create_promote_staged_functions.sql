-- Function to get match completeness stats
CREATE OR REPLACE FUNCTION get_match_completeness_stats()
RETURNS TABLE(empty_matches bigint, incomplete_matches bigint, complete_matches bigint) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    COUNT(*) FILTER (WHERE stat_count = 0)::bigint as empty_matches,
    COUNT(*) FILTER (WHERE stat_count > 0 AND stat_count < 35)::bigint as incomplete_matches,
    COUNT(*) FILTER (WHERE stat_count >= 35)::bigint as complete_matches
  FROM (
    SELECT match_id, COUNT(*) as stat_count
    FROM player_game_stats
    GROUP BY match_id
  ) t;
END;
$$ LANGUAGE plpgsql;

-- Function to resolve player_id for staged rows
CREATE OR REPLACE FUNCTION resolve_staged_player_ids()
RETURNS void AS $$
BEGIN
  -- Resolve by normalized name match
  UPDATE raw_kali_player_game_stats r
  SET player_id = p.id
  FROM players p
  WHERE r.player_id IS NULL
    AND normalize_player_name(r.raw_player_name) = normalize_player_name(p.name);
END;
$$ LANGUAGE plpgsql;

-- Function to promote staged rows to player_game_stats
CREATE OR REPLACE FUNCTION promote_staged_to_player_game_stats()
RETURNS integer AS $$
DECLARE
  promoted_count integer;
BEGIN
  -- Insert/update staged rows into player_game_stats
  INSERT INTO player_game_stats (
    player_id, match_id, match_date, season, round, team, opponent, venue,
    disposals, marks, tackles, goals, hitouts, source
  )
  SELECT 
    r.player_id,
    r.match_id,
    r.match_date,
    r.season,
    r.round,
    normalize_team_canonical(r.team) as team,
    r.opponent,
    r.venue,
    r.disposals,
    r.marks,
    r.tackles,
    r.goals,
    r.hitouts,
    'promoted_raw_kali' as source
  FROM raw_kali_player_game_stats r
  WHERE r.player_id IS NOT NULL
    AND r.match_id IS NOT NULL
  ON CONFLICT (player_id, match_id) DO UPDATE SET
    disposals = EXCLUDED.disposals,
    marks = EXCLUDED.marks,
    tackles = EXCLUDED.tackles,
    goals = EXCLUDED.goals,
    hitouts = EXCLUDED.hitouts,
    source = EXCLUDED.source;

  GET DIAGNOSTICS promoted_count = ROW_COUNT;
  RETURN promoted_count;
END;
$$ LANGUAGE plpgsql;
