-- Reclassify bookmaker_odds market_type based on line format.
--
-- RULE: integer line (whole number) = alt_ladder product (e.g. "21+")
--       half-point line (e.g. 15.5) = ou_line product
--
-- This applies to ALL bookmakers, not just Sportsbet.
-- Integer lines are the "player total" / alt-line ladder markets.
-- Half-point lines are standard over/under markets.

-- Reset all rows to ou_line first (clean slate)
UPDATE bookmaker_odds
SET market_type = 'ou_line',
    display_label = NULL,
    base_line = NULL;

-- Classify integer-line rows as alt_ladder
UPDATE bookmaker_odds
SET
  market_type   = 'alt_ladder',
  base_line     = FLOOR(line),
  display_label = FLOOR(line)::int::text || '+'
WHERE line = FLOOR(line);

-- Sanity check counts
DO $$
DECLARE
  v_alt  INT;
  v_ou   INT;
BEGIN
  SELECT COUNT(*) INTO v_alt FROM bookmaker_odds WHERE market_type = 'alt_ladder';
  SELECT COUNT(*) INTO v_ou  FROM bookmaker_odds WHERE market_type = 'ou_line';
  RAISE NOTICE 'Reclassification complete: alt_ladder=% ou_line=%', v_alt, v_ou;
END $$;

-- Apply the same logic to bookmaker_odds_raw (Layer 1 table)
UPDATE bookmaker_odds_raw
SET market_type = 'ou_line',
    display_label = NULL,
    base_line = NULL;

UPDATE bookmaker_odds_raw
SET
  market_type   = 'alt_ladder',
  base_line     = FLOOR(line),
  display_label = FLOOR(line)::int::text || '+'
WHERE line = FLOOR(line);
