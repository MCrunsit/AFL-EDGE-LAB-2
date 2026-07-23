/*
# Add Advanced Stats Columns to player_game_stats

1. Modified Tables
- `player_game_stats`
  - `contested_possessions` (numeric) — from Kali /player-stats-advanced contestedPossessions
  - `uncontested_possessions` (numeric) — from Kali /player-stats-advanced uncontestedPossessions
  - `effective_disposals` (numeric) — from Kali /player-stats-advanced effectiveDisposals
  - `disposal_efficiency_pct` (numeric) — from Kali /player-stats-advanced disposalEfficiencyPct
  - `metres_gained` (numeric) — from Kali /player-stats-advanced metresGained
  - `intercepts` (numeric) — from Kali /player-stats-advanced intercepts
  - `time_on_ground_pct` (numeric) — from Kali /player-stats-advanced timeOnGroundPct
  - `total_possessions` (numeric GENERATED) — app-derived as contested_possessions + uncontested_possessions

2. Notes
- All columns are nullable so existing rows without advanced data are unaffected.
- total_possessions is a STORED generated column (CP + UP) so it is never calculated inconsistently.
- No RLS changes needed — existing policies on player_game_stats already cover anon+authenticated.
*/

ALTER TABLE player_game_stats
  ADD COLUMN IF NOT EXISTS contested_possessions numeric,
  ADD COLUMN IF NOT EXISTS uncontested_possessions numeric,
  ADD COLUMN IF NOT EXISTS effective_disposals numeric,
  ADD COLUMN IF NOT EXISTS disposal_efficiency_pct numeric,
  ADD COLUMN IF NOT EXISTS metres_gained numeric,
  ADD COLUMN IF NOT EXISTS intercepts numeric,
  ADD COLUMN IF NOT EXISTS time_on_ground_pct numeric;

-- total_possessions as a stored generated column: CP + UP, null when either is null
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'player_game_stats' AND column_name = 'total_possessions'
  ) THEN
    ALTER TABLE player_game_stats
      ADD COLUMN total_possessions numeric GENERATED ALWAYS AS (
        CASE WHEN contested_possessions IS NOT NULL AND uncontested_possessions IS NOT NULL
          THEN contested_possessions + uncontested_possessions
          ELSE NULL
        END
      ) STORED;
  END IF;
END $$;
