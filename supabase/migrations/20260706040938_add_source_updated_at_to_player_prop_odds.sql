/*
# Add source + updated_at to player_prop_odds; fix upsert uniqueness constraint

## Summary
The player_prop_odds table needs two additions to support a real odds ingestion pipeline:

1. `source` (text, not null, default 'csv') — tracks WHERE odds came from:
   - 'csv'  : manually imported via the Import page
   - 'api'  : fetched from an external bookmaker API (e.g. The Odds API)
   - 'manual' : entered by hand

2. `updated_at` (timestamptz, default now()) — tracks WHEN this row was last refreshed.
   Used by the UI to show "Last updated: X minutes ago".

## Constraint fix
The existing unique constraint is (player_id, match_id, market, bookmaker).
This allows duplicate rows if the same bookmaker posts two different lines for the
same player/match/market — which happens legitimately (line moves).
The correct uniqueness unit is (player_id, match_id, market, bookmaker, line) so
line movement creates a new record, not a conflict. We drop the old index and create
the correct one.

## RLS
Existing policies on player_prop_odds remain unchanged. No new tables created.
*/

-- 1. Add source column (default 'csv' so existing rows stay valid)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'player_prop_odds' AND column_name = 'source'
  ) THEN
    ALTER TABLE player_prop_odds ADD COLUMN source text NOT NULL DEFAULT 'csv';
  END IF;
END $$;

-- 2. Add updated_at column
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'player_prop_odds' AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE player_prop_odds ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
  END IF;
END $$;

-- 3. Drop the old unique constraint (name may vary — drop both likely names)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'player_prop_odds_player_id_match_id_market_bookmaker_key'
      AND conrelid = 'player_prop_odds'::regclass
  ) THEN
    ALTER TABLE player_prop_odds
      DROP CONSTRAINT player_prop_odds_player_id_match_id_market_bookmaker_key;
  END IF;
END $$;

-- 4. Create the correct unique constraint: (player_id, match_id, market, bookmaker, line)
--    This is the upsert key for the odds pipeline.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'player_prop_odds_upsert_key'
      AND conrelid = 'player_prop_odds'::regclass
  ) THEN
    ALTER TABLE player_prop_odds
      ADD CONSTRAINT player_prop_odds_upsert_key
      UNIQUE (player_id, match_id, market, bookmaker, line);
  END IF;
END $$;

-- 5. Trigger to keep updated_at fresh on every UPDATE
CREATE OR REPLACE FUNCTION update_player_prop_odds_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_player_prop_odds_updated_at ON player_prop_odds;
CREATE TRIGGER trg_player_prop_odds_updated_at
  BEFORE UPDATE ON player_prop_odds
  FOR EACH ROW EXECUTE FUNCTION update_player_prop_odds_updated_at();
