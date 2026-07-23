/*
# Create data_correction_reports table (Phase 19 — "Report Incorrect Data")

1. Purpose
   Stores user-submitted reports of suspected data errors for later manual review.
   Reports are NEVER auto-applied — a report here does not modify
   player_game_stats, player_role_data, or players itself, per spec
   ("do not automatically overwrite source data from a user report").

2. New Table: data_correction_reports
   - id (uuid, primary key, auto-generated)
   - player_id (uuid, FK to players, ON DELETE SET NULL — report survives player deletion)
   - match_id (uuid, FK to matches, ON DELETE SET NULL — report survives match deletion)
   - field (text, not null) — the data field reported as incorrect
   - current_value (text) — what the system currently shows
   - suggested_value (text) — what the user believes is correct
   - note (text) — freeform user note
   - review_status (text, not null, default 'pending', CHECK: pending/reviewed/applied/dismissed)
   - reported_at (timestamptz, default now())
   - reviewed_at (timestamptz, nullable — set when a reviewer acts)
   - reviewer_note (text, nullable — internal note for reviewers)

3. Indexes
   - idx_data_correction_reports_status on review_status (filter by review queue)
   - idx_data_correction_reports_player on player_id (lookup by player)

4. Security (RLS)
   - RLS enabled on data_correction_reports.
   - SELECT: anon + authenticated can read all reports (shared/public data, single-tenant app).
   - INSERT: anon + authenticated can submit new reports.
   - No UPDATE/DELETE policy for anon — review status changes require direct DB access,
     consistent with "do not automatically overwrite source data."
*/

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
