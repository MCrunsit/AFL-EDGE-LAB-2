-- Phase 19 — "Report Incorrect Data." Stores user-submitted reports of
-- suspected data errors for later review. Never auto-applied — a report
-- here does not modify player_game_stats/player_role_data/players itself,
-- per spec ("do not automatically overwrite source data from a user report").

CREATE TABLE IF NOT EXISTS data_correction_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid REFERENCES players(id) ON DELETE SET NULL,
  match_id uuid REFERENCES matches(id) ON DELETE SET NULL,
  field text NOT NULL,
  current_value text,
  suggested_value text,
  note text,
  review_status text NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'reviewed', 'applied', 'dismissed')),
  reported_at timestamptz DEFAULT now(),
  reviewed_at timestamptz,
  reviewer_note text
);

CREATE INDEX IF NOT EXISTS idx_data_correction_reports_status ON data_correction_reports(review_status);
CREATE INDEX IF NOT EXISTS idx_data_correction_reports_player ON data_correction_reports(player_id);

ALTER TABLE data_correction_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_data_correction_reports" ON data_correction_reports;
DROP POLICY IF EXISTS "anon_insert_data_correction_reports" ON data_correction_reports;

CREATE POLICY "select_data_correction_reports" ON data_correction_reports FOR SELECT
  TO anon, authenticated USING (true);
CREATE POLICY "anon_insert_data_correction_reports" ON data_correction_reports FOR INSERT
  TO anon, authenticated WITH CHECK (true);
-- No anon UPDATE/DELETE policy — review status changes require direct DB
-- access, consistent with "do not automatically overwrite source data."
