CREATE TABLE IF NOT EXISTS player_role_data (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid REFERENCES players(id) ON DELETE CASCADE,
  match_id uuid REFERENCES matches(id) ON DELETE SET NULL,
  round text,
  season integer DEFAULT 2026,
  cba_percentage numeric DEFAULT 0,
  cba_count integer DEFAULT 0,
  team_cba_total integer DEFAULT 0,
  kick_in_count integer DEFAULT 0,
  kick_in_play_on_count integer DEFAULT 0,
  kick_in_share numeric DEFAULT 0,
  source text DEFAULT 'manual_import',
  updated_at timestamptz DEFAULT now(),
  UNIQUE(player_id, match_id)
);

ALTER TABLE player_role_data ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_role_data" ON player_role_data FOR SELECT
  TO anon, authenticated USING (true);
CREATE POLICY "insert_role_data" ON player_role_data FOR INSERT
  TO authenticated WITH CHECK (true);
CREATE POLICY "update_role_data" ON player_role_data FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "delete_role_data" ON player_role_data FOR DELETE
  TO authenticated USING (true);
