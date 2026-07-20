/*
# Add active player fields to players table

1. Modified Tables
- `players`
  - `is_active` (boolean, default true) — whether the player is currently on an AFL list
  - `last_season_played` (integer, nullable) — most recent season year the player appeared in an AFL game
  - `games_last_two_seasons` (integer, default 0) — total games played in the current and previous season

2. Purpose
- Allows all player selectors and betting tools to filter out retired, delisted,
  historical, and inactive players.
- Populated during player sync by checking player_game_stats for recent appearances.

3. Backfill
- Computes last_season_played and games_last_two_seasons from existing player_game_stats
  data (using match_date year). Marks players with no stats in the last 2 seasons as
  inactive.
*/

ALTER TABLE players ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE players ADD COLUMN IF NOT EXISTS last_season_played integer;
ALTER TABLE players ADD COLUMN IF NOT EXISTS games_last_two_seasons integer NOT NULL DEFAULT 0;

-- Backfill from player_game_stats
WITH player_seasons AS (
  SELECT
    player_id,
    MAX(EXTRACT(YEAR FROM match_date)::int) AS last_season,
    SUM(CASE WHEN EXTRACT(YEAR FROM match_date)::int >= 2025 THEN 1 ELSE 0 END) AS games_recent
  FROM player_game_stats
  GROUP BY player_id
)
UPDATE players p
SET
  last_season_played = ps.last_season,
  games_last_two_seasons = ps.games_recent,
  is_active = (ps.last_season IS NOT NULL AND ps.last_season >= 2025)
FROM player_seasons ps
WHERE ps.player_id = p.id;
