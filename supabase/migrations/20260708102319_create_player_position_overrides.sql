/*
# Create player_position_overrides table

1. New Tables
- `player_position_overrides`
  - `id` (uuid, primary key)
  - `player_name` (text, not null) — player display name
  - `team` (text, nullable) — player team for disambiguation
  - `position_group` (text, not null) — canonical position group (DEF-GEN, MID-INC, etc.)
  - `confidence` (text, not null, default 'high') — high/medium/low
  - `source` (text, not null, default 'manual') — manual/auto_profile/stats
  - `updated_at` (timestamptz, default now())
2. Security
- Enable RLS on `player_position_overrides`.
- Allow anon + authenticated CRUD (single-tenant app, no sign-in).
3. Indexes
- Unique index on (player_name, team) to prevent duplicate overrides.
*/

CREATE TABLE IF NOT EXISTS player_position_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_name text NOT NULL,
  team text,
  position_group text NOT NULL,
  confidence text NOT NULL DEFAULT 'high',
  source text NOT NULL DEFAULT 'manual',
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE player_position_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_position_overrides" ON player_position_overrides;
CREATE POLICY "anon_select_position_overrides" ON player_position_overrides FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_position_overrides" ON player_position_overrides;
CREATE POLICY "anon_insert_position_overrides" ON player_position_overrides FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_position_overrides" ON player_position_overrides;
CREATE POLICY "anon_update_position_overrides" ON player_position_overrides FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_position_overrides" ON player_position_overrides;
CREATE POLICY "anon_delete_position_overrides" ON player_position_overrides FOR DELETE
  TO anon, authenticated USING (true);

CREATE UNIQUE INDEX IF NOT EXISTS idx_player_position_overrides_name_team
  ON player_position_overrides (lower(player_name), COALESCE(lower(team), ''));
