/*
# Add Possession Stats Constraints to player_game_stats

Branch: fix/supabase-types-and-null-safety (commit e948d88)

## Summary
The advanced possession stat columns were added in migration
20260723001529_add_advanced_stats_columns_to_player_game_stats.sql and
are already present on the table. This migration:

1. Adds non-negative CHECK constraints to possession/advanced stat columns
   so the database rejects physically impossible values (e.g. negative contested
   possessions). metres_gained is intentionally excluded — the Kali API legitimately
   returns negative metres gained when a player loses net ground.

2. Confirms total_possessions generated column is in place (no-op if already
   created by the earlier migration).

## Modified Tables
- `player_game_stats`
  - `contested_possessions`    CHECK >= 0
  - `uncontested_possessions`  CHECK >= 0
  - `effective_disposals`      CHECK >= 0
  - `disposal_efficiency_pct`  CHECK 0–100
  - `intercepts`               CHECK >= 0
  - `time_on_ground_pct`       CHECK 0–100

## Security Changes
None — RLS policies on player_game_stats are unchanged.

## Notes
- All ADD COLUMN statements are guarded with IF NOT EXISTS so re-running is safe.
- CHECK constraints use DO block with pg_constraint existence check so
  re-running never throws "constraint already exists".
- total_possessions is a STORED GENERATED column (CP + UP); the DO block
  adds it only if it doesn't already exist.
- metres_gained has NO constraint — negative values are valid AFL data.
*/

-- ── Ensure the advanced stat columns exist (idempotent; no-ops if already present) ──
ALTER TABLE player_game_stats
  ADD COLUMN IF NOT EXISTS contested_possessions    numeric,
  ADD COLUMN IF NOT EXISTS uncontested_possessions  numeric,
  ADD COLUMN IF NOT EXISTS effective_disposals      numeric,
  ADD COLUMN IF NOT EXISTS disposal_efficiency_pct  numeric,
  ADD COLUMN IF NOT EXISTS metres_gained            numeric,
  ADD COLUMN IF NOT EXISTS intercepts               numeric,
  ADD COLUMN IF NOT EXISTS time_on_ground_pct       numeric;

-- ── total_possessions generated column (CP + UP) ──
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'player_game_stats' AND column_name = 'total_possessions'
  ) THEN
    ALTER TABLE player_game_stats
      ADD COLUMN total_possessions numeric GENERATED ALWAYS AS (
        CASE
          WHEN contested_possessions IS NOT NULL AND uncontested_possessions IS NOT NULL
          THEN contested_possessions + uncontested_possessions
          ELSE NULL
        END
      ) STORED;
  END IF;
END $$;

-- ── Non-negative CHECK constraints (metres_gained excluded — negative is valid) ──
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'player_game_stats'::regclass
      AND conname = 'chk_contested_possessions_non_negative'
  ) THEN
    ALTER TABLE player_game_stats
      ADD CONSTRAINT chk_contested_possessions_non_negative
      CHECK (contested_possessions IS NULL OR contested_possessions >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'player_game_stats'::regclass
      AND conname = 'chk_uncontested_possessions_non_negative'
  ) THEN
    ALTER TABLE player_game_stats
      ADD CONSTRAINT chk_uncontested_possessions_non_negative
      CHECK (uncontested_possessions IS NULL OR uncontested_possessions >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'player_game_stats'::regclass
      AND conname = 'chk_effective_disposals_non_negative'
  ) THEN
    ALTER TABLE player_game_stats
      ADD CONSTRAINT chk_effective_disposals_non_negative
      CHECK (effective_disposals IS NULL OR effective_disposals >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'player_game_stats'::regclass
      AND conname = 'chk_disposal_efficiency_pct_range'
  ) THEN
    ALTER TABLE player_game_stats
      ADD CONSTRAINT chk_disposal_efficiency_pct_range
      CHECK (disposal_efficiency_pct IS NULL OR (disposal_efficiency_pct >= 0 AND disposal_efficiency_pct <= 100));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'player_game_stats'::regclass
      AND conname = 'chk_intercepts_non_negative'
  ) THEN
    ALTER TABLE player_game_stats
      ADD CONSTRAINT chk_intercepts_non_negative
      CHECK (intercepts IS NULL OR intercepts >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'player_game_stats'::regclass
      AND conname = 'chk_time_on_ground_pct_range'
  ) THEN
    ALTER TABLE player_game_stats
      ADD CONSTRAINT chk_time_on_ground_pct_range
      CHECK (time_on_ground_pct IS NULL OR (time_on_ground_pct >= 0 AND time_on_ground_pct <= 100));
  END IF;
END $$;
