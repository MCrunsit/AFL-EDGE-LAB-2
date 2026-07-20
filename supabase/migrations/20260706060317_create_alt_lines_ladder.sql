-- Alt Lines Ladder Table
-- Stores derived alternate line odds calculated from bookmaker base lines
-- This is TYPE C (derived_ladder_odds) - calculated ONLY from bookmaker_odds

CREATE TABLE IF NOT EXISTS alt_lines_ladder (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  match_id UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  bookmaker_id TEXT NOT NULL,
  market TEXT NOT NULL,
  
  -- Base line (from bookmaker_odds - never modified)
  base_line NUMERIC(5,1) NOT NULL,
  base_over_odds NUMERIC(6,3) NOT NULL,
  base_under_odds NUMERIC(6,3) NOT NULL,
  
  -- Alternate line (derived)
  alt_line NUMERIC(5,1) NOT NULL,
  alt_over_odds NUMERIC(6,3),
  alt_under_odds NUMERIC(6,3),
  
  -- EV calculation
  ev_over NUMERIC(6,4),
  ev_under NUMERIC(6,4),
  model_prob_over NUMERIC(5,4),
  
  -- Metadata
  derived_at TIMESTAMPTZ DEFAULT now(),
  source TEXT DEFAULT 'derived_from_bookmaker',
  
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Index for quick lookup
CREATE INDEX idx_alt_ladder_player_match ON alt_lines_ladder(player_id, match_id);
CREATE INDEX idx_alt_ladder_market ON alt_lines_ladder(market);
CREATE INDEX idx_alt_ladder_bookmaker ON alt_lines_ladder(bookmaker_id);

-- Unique constraint to prevent duplicates
CREATE UNIQUE INDEX idx_alt_ladder_unique 
  ON alt_lines_ladder(player_id, match_id, bookmaker_id, market, alt_line);

-- RLS
ALTER TABLE alt_lines_ladder ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_alt_lines" ON alt_lines_ladder FOR SELECT
  TO anon, authenticated USING (true);

CREATE POLICY "insert_alt_lines" ON alt_lines_ladder FOR INSERT
  TO authenticated WITH CHECK (true);

CREATE POLICY "update_alt_lines" ON alt_lines_ladder FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "delete_alt_lines" ON alt_lines_ladder FOR DELETE
  TO authenticated USING (true);

COMMENT ON TABLE alt_lines_ladder IS 'Derived alternate line odds calculated from bookmaker base lines. Never mixes with model projections.';
