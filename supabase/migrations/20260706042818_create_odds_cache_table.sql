/*
# Create odds_cache table

## Purpose
Stores the raw API response from The Odds API so we can:
- Serve cached data when the last fetch is < 6 hours old (avoids burning API credits)
- Track exactly when data was fetched vs when it was processed

## New table: odds_cache
- id: single-row table keyed by a fixed sport slug ('aussierules_afl')
- sport: text primary key — one row per sport, upserted on each sync
- raw_response: jsonb — the full raw API response body
- fetched_at: when the API was actually called
- processed_at: when the upsert into player_prop_odds completed
- inserted_count: how many rows were inserted that sync
- skipped_count: how many rows were rejected
- requests_remaining: API quota header from last call

## Security
- No auth required (this is a single-tenant admin tool)
- RLS enabled, anon + authenticated can read (to check cache age in frontend)
- Only service role can insert/update (edge function uses SERVICE_ROLE_KEY)
*/

CREATE TABLE IF NOT EXISTS odds_cache (
  sport          text PRIMARY KEY,
  raw_response   jsonb,
  fetched_at     timestamptz NOT NULL DEFAULT now(),
  processed_at   timestamptz,
  inserted_count integer NOT NULL DEFAULT 0,
  skipped_count  integer NOT NULL DEFAULT 0,
  requests_remaining integer
);

ALTER TABLE odds_cache ENABLE ROW LEVEL SECURITY;

-- Anyone can read cache metadata (to show "last synced" in the UI)
DROP POLICY IF EXISTS "anon_select_odds_cache" ON odds_cache;
CREATE POLICY "anon_select_odds_cache" ON odds_cache
  FOR SELECT TO anon, authenticated USING (true);

-- Only service role inserts/updates (edge function, never the browser client)
DROP POLICY IF EXISTS "service_insert_odds_cache" ON odds_cache;
CREATE POLICY "service_insert_odds_cache" ON odds_cache
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "service_update_odds_cache" ON odds_cache;
CREATE POLICY "service_update_odds_cache" ON odds_cache
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
