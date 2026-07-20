-- Add market classification fields to bookmaker_odds (the active source table)
ALTER TABLE bookmaker_odds
  ADD COLUMN IF NOT EXISTS market_type text NOT NULL DEFAULT 'ou_line'
    CHECK (market_type IN ('ou_line', 'alt_ladder')),
  ADD COLUMN IF NOT EXISTS base_line numeric,
  ADD COLUMN IF NOT EXISTS display_label text;

COMMENT ON COLUMN bookmaker_odds.market_type IS
  'ou_line = standard over/under line (e.g. 15.5, 16.5). alt_ladder = Sportsbet player-total ladder (e.g. 21+, 22+).';
COMMENT ON COLUMN bookmaker_odds.base_line IS
  'For alt_ladder: the integer threshold (e.g. 21 for "21+"). NULL for ou_line.';
COMMENT ON COLUMN bookmaker_odds.display_label IS
  'Human-readable label: "21+" for alt_ladder, NULL for ou_line.';

-- Add the same fields to bookmaker_odds_raw (Layer 1 table)
ALTER TABLE bookmaker_odds_raw
  ADD COLUMN IF NOT EXISTS market_type text NOT NULL DEFAULT 'ou_line'
    CHECK (market_type IN ('ou_line', 'alt_ladder')),
  ADD COLUMN IF NOT EXISTS base_line numeric,
  ADD COLUMN IF NOT EXISTS display_label text;

COMMENT ON COLUMN bookmaker_odds_raw.market_type IS
  'ou_line = standard over/under line. alt_ladder = Sportsbet player-total ladder (e.g. 21+).';
COMMENT ON COLUMN bookmaker_odds_raw.base_line IS
  'For alt_ladder: the integer threshold value. NULL for ou_line.';
COMMENT ON COLUMN bookmaker_odds_raw.display_label IS
  'Human-readable label shown in UI. E.g. "21+" for alt_ladder, NULL for standard lines.';

-- Backfill existing rows in bookmaker_odds:
-- Sportsbet rows where raw_market contains '+' AND line is a whole number → alt_ladder
UPDATE bookmaker_odds
SET
  market_type   = 'alt_ladder',
  base_line     = FLOOR(line),
  display_label = FLOOR(line)::text || '+'
WHERE
  bookmaker_id  = 'sportsbet'
  AND raw_market LIKE '%+%'
  AND line = FLOOR(line);

-- All other rows remain ou_line (already the default)
