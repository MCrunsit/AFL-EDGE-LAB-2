-- Adds advanced Kali stat columns to player_game_stats.
--
-- These columns were already applied directly to the live database via Bolt
-- (confirmed present in production before this file was finalized) but no
-- migration file existed to track that change — this file exists so the
-- repo's migration history matches the live schema, and so it can be safely
-- re-applied to any environment that doesn't have it yet. Everything here
-- uses IF NOT EXISTS / conditional guards for that reason.
--
-- disposals remains a separate, independently-sourced metric from the
-- standard Kali endpoint. total_possessions is a Postgres GENERATED column
-- (confirmed live via direct query) — never written to directly, Postgres
-- derives it as contested_possessions + uncontested_possessions.
--
-- metres_gained intentionally has NO non-negative check: Kali legitimately
-- returns negative values for it (e.g. a player who nets backwards
-- territory), confirmed against live data before applying constraints.

ALTER TABLE player_game_stats
  ADD COLUMN IF NOT EXISTS contested_possessions integer,
  ADD COLUMN IF NOT EXISTS uncontested_possessions integer,
  ADD COLUMN IF NOT EXISTS effective_disposals integer,
  ADD COLUMN IF NOT EXISTS disposal_efficiency_pct numeric,
  ADD COLUMN IF NOT EXISTS intercepts integer,
  ADD COLUMN IF NOT EXISTS time_on_ground_pct numeric,
  ADD COLUMN IF NOT EXISTS metres_gained integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
    WHERE attrelid = 'player_game_stats'::regclass
      AND attname = 'total_possessions'
      AND NOT attisdropped) THEN
    ALTER TABLE player_game_stats
      ADD COLUMN total_possessions integer
      GENERATED ALWAYS AS (
        CASE WHEN contested_possessions IS NOT NULL AND uncontested_possessions IS NOT NULL
          THEN contested_possessions + uncontested_possessions
          ELSE NULL
        END
      ) STORED;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'player_game_stats_contested_possessions_check') THEN
    ALTER TABLE player_game_stats ADD CONSTRAINT player_game_stats_contested_possessions_check
      CHECK (contested_possessions IS NULL OR contested_possessions >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'player_game_stats_uncontested_possessions_check') THEN
    ALTER TABLE player_game_stats ADD CONSTRAINT player_game_stats_uncontested_possessions_check
      CHECK (uncontested_possessions IS NULL OR uncontested_possessions >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'player_game_stats_effective_disposals_check') THEN
    ALTER TABLE player_game_stats ADD CONSTRAINT player_game_stats_effective_disposals_check
      CHECK (effective_disposals IS NULL OR effective_disposals >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'player_game_stats_disposal_efficiency_pct_check') THEN
    ALTER TABLE player_game_stats ADD CONSTRAINT player_game_stats_disposal_efficiency_pct_check
      CHECK (disposal_efficiency_pct IS NULL OR (disposal_efficiency_pct >= 0 AND disposal_efficiency_pct <= 100));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'player_game_stats_intercepts_check') THEN
    ALTER TABLE player_game_stats ADD CONSTRAINT player_game_stats_intercepts_check
      CHECK (intercepts IS NULL OR intercepts >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'player_game_stats_time_on_ground_pct_check') THEN
    ALTER TABLE player_game_stats ADD CONSTRAINT player_game_stats_time_on_ground_pct_check
      CHECK (time_on_ground_pct IS NULL OR (time_on_ground_pct >= 0 AND time_on_ground_pct <= 100));
  END IF;
  -- metres_gained: no check constraint — Kali legitimately returns negative values.
END $$;

COMMENT ON COLUMN player_game_stats.contested_possessions IS 'From Kali /player-stats-advanced. Null when Kali has no advanced record, never defaulted to 0.';
COMMENT ON COLUMN player_game_stats.uncontested_possessions IS 'From Kali /player-stats-advanced. Null when Kali has no advanced record, never defaulted to 0.';
COMMENT ON COLUMN player_game_stats.total_possessions IS 'Generated column: contested_possessions + uncontested_possessions. App-derived, not sourced from Kali directly.';
COMMENT ON COLUMN player_game_stats.metres_gained IS 'From Kali /player-stats-advanced. Can be legitimately negative.';
