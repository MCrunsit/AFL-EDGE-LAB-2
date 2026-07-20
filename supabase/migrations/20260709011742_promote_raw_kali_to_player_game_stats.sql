-- Promote resolved raw_kali rows to player_game_stats
-- First check current count
SELECT COUNT(*) as player_game_stats_before FROM player_game_stats;

-- Insert promoted rows
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

-- Check result
SELECT COUNT(*) as player_game_stats_after FROM player_game_stats;
