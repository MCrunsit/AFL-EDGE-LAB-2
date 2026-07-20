/*
# Fixture-first rebuild: odds dedup constraint + is_upcoming view

1. Modified Tables
- `player_prop_odds` — add unique constraint for deduplication by
  (player_id, match_id, market, line, bookmaker)

2. New Views
- `upcoming_matches` — convenience view of matches where match_date >= today,
  ordered by match_date ascending. Includes all match columns.

3. Purpose
- Fixture-first architecture: matches are the primary entity.
- Odds deduplication prevents duplicate lines from the same bookmaker.
- The upcoming_matches view powers the Match Hub and player context enrichment.
*/

-- Dedup constraint: one odds line per (player, match, market, line, bookmaker)
ALTER TABLE player_prop_odds
  DROP CONSTRAINT IF EXISTS player_prop_odds_player_match_market_line_book_uq;
ALTER TABLE player_prop_odds
  ADD CONSTRAINT player_prop_odds_player_match_market_line_book_uq
  UNIQUE (player_id, match_id, market, line, bookmaker);

-- Convenience view for upcoming matches
CREATE OR REPLACE VIEW upcoming_matches AS
SELECT
  id,
  season,
  round,
  home_team,
  away_team,
  venue,
  match_date,
  api_match_id,
  home_score,
  away_score
FROM matches
WHERE match_date >= CURRENT_DATE
ORDER BY match_date ASC;
