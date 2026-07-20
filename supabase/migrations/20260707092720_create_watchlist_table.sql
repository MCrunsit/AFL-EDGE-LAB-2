/*
# Create watchlist table for CLV tracking

1. Purpose
   Stores bets a user wants to monitor before placing them, so they can check
   if the market moves (Closing Line Value / CLV preview).

2. New Table: watchlist
   - id (uuid PK)
   - player_name (text, not null) — player the bet is on
   - player_id (uuid, nullable) — links to players table
   - market (text, nullable) — stat type e.g. disposals
   - line (text, nullable) — threshold label e.g. "23+"
   - display_label (text, nullable) — formatted line label
   - match_id (uuid, nullable) — links to matches table
   - match_name (text, nullable) — "Home vs Away" snapshot
   - odds_at_watch (numeric, not null) — odds when the user watched the bet
   - latest_odds (numeric, nullable) — most recent odds fetched
   - model_probability (numeric, nullable) — adjusted probability at watch time
   - adjusted_ev (numeric, nullable) — adjusted EV at watch time
   - quality_score (numeric, nullable) — quality score at watch time
   - risk_level (text, nullable) — Low/Medium/High
   - notes (text, nullable) — user notes
   - created_at (timestamptz, default now())

3. Security
   - RLS enabled.
   - Single-tenant no-auth app: anon + authenticated CRUD (data is intentionally shared).
*/

CREATE TABLE IF NOT EXISTS watchlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_name text NOT NULL,
  player_id uuid,
  market text,
  line text,
  display_label text,
  match_id uuid,
  match_name text,
  odds_at_watch numeric NOT NULL,
  latest_odds numeric,
  model_probability numeric,
  adjusted_ev numeric,
  quality_score numeric,
  risk_level text,
  notes text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE watchlist ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_watchlist" ON watchlist;
CREATE POLICY "anon_select_watchlist" ON watchlist FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_watchlist" ON watchlist;
CREATE POLICY "anon_insert_watchlist" ON watchlist FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_watchlist" ON watchlist;
CREATE POLICY "anon_update_watchlist" ON watchlist FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_watchlist" ON watchlist;
CREATE POLICY "anon_delete_watchlist" ON watchlist FOR DELETE
  TO anon, authenticated USING (true);
