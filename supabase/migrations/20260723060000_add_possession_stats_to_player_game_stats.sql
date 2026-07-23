-- Adds contested/uncontested/total possession columns to player_game_stats.
--
-- These columns were already applied directly to the live database via Bolt
-- (confirmed present in production before this file was written) but no
-- migration file existed to track that change — this file exists so the
-- repo's migration history matches the live schema, and so this migration
-- can be safely re-applied to any environment that doesn't have it yet.
--
-- disposals remains a separate, independently-sourced metric from the
-- standard Kali endpoint. total_possessions is an app-derived sum of the two
-- advanced fields (contested_possessions + uncontested_possessions), never
-- treated as identical to disposals.

ALTER TABLE player_game_stats
  ADD COLUMN IF NOT EXISTS contested_possessions integer,
  ADD COLUMN IF NOT EXISTS uncontested_possessions integer,
  ADD COLUMN IF NOT EXISTS total_possessions integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'player_game_stats_contested_possessions_check'
  ) THEN
    ALTER TABLE player_game_stats
      ADD CONSTRAINT player_game_stats_contested_possessions_check
      CHECK (contested_possessions IS NULL OR contested_possessions >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'player_game_stats_uncontested_possessions_check'
  ) THEN
    ALTER TABLE player_game_stats
      ADD CONSTRAINT player_game_stats_uncontested_possessions_check
      CHECK (uncontested_possessions IS NULL OR uncontested_possessions >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'player_game_stats_total_possessions_check'
  ) THEN
    ALTER TABLE player_game_stats
      ADD CONSTRAINT player_game_stats_total_possessions_check
      CHECK (total_possessions IS NULL OR total_possessions >= 0);
  END IF;
END $$;

COMMENT ON COLUMN player_game_stats.contested_possessions IS 'From Kali /player-stats-advanced. Null when Kali has no advanced record for this player-game, never defaulted to 0.';
COMMENT ON COLUMN player_game_stats.uncontested_possessions IS 'From Kali /player-stats-advanced. Null when Kali has no advanced record for this player-game, never defaulted to 0.';
COMMENT ON COLUMN player_game_stats.total_possessions IS 'App-derived: contested_possessions + uncontested_possessions. Null unless both source fields are present. Not sourced from Kali directly.';
