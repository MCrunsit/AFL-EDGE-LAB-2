/*
# Layer 1 — bookmaker_odds_raw (Immutable Raw Data Store)

## Purpose
This is the ONLY place bookmaker data is stored. It replaces the existing
bookmaker_odds table as the authoritative source for all raw bookmaker odds.

## Rules (Non-Negotiable)
- Data stored EXACTLY as received from bookmaker APIs
- NO lowercase transformation on market strings
- NO grouping or deduplication beyond the unique constraint
- NO filtering or EV logic
- raw_market and raw_line preserve the original string exactly

## New Table: bookmaker_odds_raw
- `id` — UUID primary key
- `match_id` — FK to matches.id (required)
- `player_name` — raw player name from bookmaker (no normalization)
- `player_id` — optional resolved player UUID (via name alias lookup)
- `bookmaker` — bookmaker slug (e.g. "sportsbet")
- `raw_market` — EXACT market string from bookmaker (e.g. "Player Disposals 27.5")
- `raw_line` — EXACT line string from bookmaker (e.g. "27.5")
- `line` — numeric line value (parsed from raw_line, NEVER derived from stats)
- `over_odds` — decimal over odds
- `under_odds` — decimal under odds
- `fetched_at` — when this row was fetched
- `raw_payload` — full JSON API response for audit

## Unique Constraint
(bookmaker, player_name, match_id, raw_market, raw_line) — prevents exact duplicates
while preserving ALL distinct lines for the same market.

## Security
- RLS enabled, anon + authenticated can read/write (no auth required for this app)
*/

CREATE TABLE IF NOT EXISTS bookmaker_odds_raw (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_name text NOT NULL,
  player_id uuid REFERENCES players(id) ON DELETE SET NULL,
  bookmaker text NOT NULL,
  raw_market text NOT NULL,
  raw_line text NOT NULL,
  line numeric NOT NULL,
  over_odds numeric NOT NULL,
  under_odds numeric NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  raw_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS bookmaker_odds_raw_dedup_idx
  ON bookmaker_odds_raw (bookmaker, player_name, match_id, raw_market, raw_line);

CREATE INDEX IF NOT EXISTS bookmaker_odds_raw_match_idx ON bookmaker_odds_raw (match_id);
CREATE INDEX IF NOT EXISTS bookmaker_odds_raw_player_idx ON bookmaker_odds_raw (player_id);
CREATE INDEX IF NOT EXISTS bookmaker_odds_raw_bookmaker_idx ON bookmaker_odds_raw (bookmaker);
CREATE INDEX IF NOT EXISTS bookmaker_odds_raw_fetched_idx ON bookmaker_odds_raw (fetched_at DESC);

ALTER TABLE bookmaker_odds_raw ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_bookmaker_odds_raw" ON bookmaker_odds_raw;
CREATE POLICY "anon_select_bookmaker_odds_raw" ON bookmaker_odds_raw FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_bookmaker_odds_raw" ON bookmaker_odds_raw;
CREATE POLICY "anon_insert_bookmaker_odds_raw" ON bookmaker_odds_raw FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_bookmaker_odds_raw" ON bookmaker_odds_raw;
CREATE POLICY "anon_update_bookmaker_odds_raw" ON bookmaker_odds_raw FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_bookmaker_odds_raw" ON bookmaker_odds_raw;
CREATE POLICY "anon_delete_bookmaker_odds_raw" ON bookmaker_odds_raw FOR DELETE
  TO anon, authenticated USING (true);
