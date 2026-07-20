-- Add raw_market column to bookmaker_odds for audit trail.
-- Stores the EXACT market string from the bookmaker API (e.g. "Player Disposals 27.5")
-- alongside the normalized market column (e.g. "disposals").
-- This ensures we can always verify what the upstream source actually sent.

ALTER TABLE bookmaker_odds
  ADD COLUMN IF NOT EXISTS raw_market text;

-- Add raw_line column to store the exact line string from the API
-- (in case formatting differs from the numeric line column)
ALTER TABLE bookmaker_odds
  ADD COLUMN IF NOT EXISTS raw_line text;

-- Add a raw_api_response jsonb column for full audit logging
ALTER TABLE bookmaker_odds
  ADD COLUMN IF NOT EXISTS raw_api_response jsonb;

-- Backfill existing rows: set raw_market = market, raw_line = line::text
-- for rows that already exist (so they're not null)
UPDATE bookmaker_odds
  SET raw_market = market
  WHERE raw_market IS NULL;

UPDATE bookmaker_odds
  SET raw_line = line::text
  WHERE raw_line IS NULL;

COMMENT ON COLUMN bookmaker_odds.raw_market IS 'Exact market string from bookmaker API, before any normalization. E.g. "Player Disposals 27.5"';
COMMENT ON COLUMN bookmaker_odds.raw_line IS 'Exact line string from bookmaker API, before numeric conversion.';
COMMENT ON COLUMN bookmaker_odds.raw_api_response IS 'Full raw API response for this odds row, for audit/debugging.';
