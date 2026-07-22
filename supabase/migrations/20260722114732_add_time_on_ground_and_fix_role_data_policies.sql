ALTER TABLE player_role_data ADD COLUMN IF NOT EXISTS time_on_ground numeric;
DROP POLICY IF EXISTS "insert_role_data" ON player_role_data;
DROP POLICY IF EXISTS "update_role_data" ON player_role_data;
CREATE POLICY "anon_insert_role_data" ON player_role_data FOR INSERT
  TO anon, authenticated WITH CHECK (true);
CREATE POLICY "anon_update_role_data" ON player_role_data FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);