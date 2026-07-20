/*
# Create update_player_active_status function

1. New Functions
- `update_player_active_status()` — recomputes is_active, last_season_played, and
  games_last_two_seasons for all players based on player_game_stats data.
  Call this after any stats sync to keep active flags current.

2. Logic
- last_season_played = MAX year from player_game_stats.match_date
- games_last_two_seasons = COUNT of stats where match_date year >= current_year - 1
- is_active = true if last_season_played >= current_year - 1, else false
*/

CREATE OR REPLACE FUNCTION update_player_active_status()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  WITH player_seasons AS (
    SELECT
      player_id,
      MAX(EXTRACT(YEAR FROM match_date)::int) AS last_season,
      SUM(CASE WHEN EXTRACT(YEAR FROM match_date)::int >= EXTRACT(YEAR FROM NOW())::int - 1 THEN 1 ELSE 0 END) AS games_recent
    FROM player_game_stats
    GROUP BY player_id
  )
  UPDATE players p
  SET
    last_season_played = ps.last_season,
    games_last_two_seasons = ps.games_recent,
    is_active = (ps.last_season IS NOT NULL AND ps.last_season >= EXTRACT(YEAR FROM NOW())::int - 1)
  FROM player_seasons ps
  WHERE ps.player_id = p.id;
END;
$$;
