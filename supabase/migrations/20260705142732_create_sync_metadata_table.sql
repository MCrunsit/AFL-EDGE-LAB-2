/*
# Create sync_metadata table for incremental stat sync

1. New Tables
- `sync_metadata`
  - `year` (integer, primary key) — the AFL season year this row tracks
  - `last_synced_at` (timestamptz) — when stats for this year were last fully synced
  - `stats_count` (integer, default 0) — number of stat rows synced for this year
  - `updated_at` (timestamptz, default now()) — row modification timestamp

2. Purpose
- Allows the stats sync to skip years that have already been fully synced in a prior run,
  avoiding re-fetching and re-processing the entire ~15k-row dataset on every sync.
- Only years with no metadata row (never synced) OR with new matches since last_synced_at
  are fetched from the API and processed.

3. Security
- RLS enabled. This is a single-tenant app (no sign-in screen), so anon + authenticated
  have full CRUD — the metadata is intentionally shared/public.
*/

CREATE TABLE IF NOT EXISTS sync_metadata (
  year integer PRIMARY KEY,
  last_synced_at timestamptz,
  stats_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sync_metadata ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_sync_metadata" ON sync_metadata;
CREATE POLICY "anon_select_sync_metadata" ON sync_metadata FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_sync_metadata" ON sync_metadata;
CREATE POLICY "anon_insert_sync_metadata" ON sync_metadata FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_sync_metadata" ON sync_metadata;
CREATE POLICY "anon_update_sync_metadata" ON sync_metadata FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_sync_metadata" ON sync_metadata;
CREATE POLICY "anon_delete_sync_metadata" ON sync_metadata FOR DELETE
  TO anon, authenticated USING (true);
