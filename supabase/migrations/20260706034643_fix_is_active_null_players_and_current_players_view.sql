/*
# Fix is_active: null last_season_played players are NOT active

## Problem
2300 players have last_season_played IS NULL (no stats ever recorded) but
is_active = true (column default). This caused every AFL team to show 100-180
"active" players instead of the real ~18-22 current roster.

## Fix
1. Mark all players with null last_season_played as is_active = false.
2. Mark players with last_season_played < 2024 as is_active = false (2+ years retired).
3. Active = last_season_played >= 2025 (played in 2025 or 2026 season).
4. Recreate update_player_active_status() to use the same threshold.
5. Create current_players view: is_active = true (used by all UI).

## Result
~10-21 players per team — consistent with real AFL rosters.
*/

-- Step 1: Fix is_active based on last_season_played
UPDATE players
SET is_active = CASE
  WHEN last_season_played IS NULL THEN false
  WHEN last_season_played >= 2025 THEN true
  ELSE false
END;

-- Step 2: Recreate update_player_active_status() with correct threshold
CREATE OR REPLACE FUNCTION update_player_active_status()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  WITH player_seasons AS (
    SELECT
      player_id,
      MAX(EXTRACT(YEAR FROM match_date)::int) AS last_season,
      SUM(CASE
        WHEN EXTRACT(YEAR FROM match_date)::int >= EXTRACT(YEAR FROM NOW())::int - 1
        THEN 1 ELSE 0
      END) AS games_recent
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

  -- Players with no stats at all are always inactive
  UPDATE players
  SET is_active = false
  WHERE last_season_played IS NULL;
END;
$$;

-- Step 3: Current players view (canonical definition used by all UI)
CREATE OR REPLACE VIEW current_players AS
SELECT *
FROM players
WHERE is_active = true
  AND last_season_played >= 2025
ORDER BY team, name;
