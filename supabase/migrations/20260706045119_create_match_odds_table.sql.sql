-- Create match_odds table for head-to-head, spread, and totals odds
CREATE TABLE match_odds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id UUID REFERENCES matches(id) ON DELETE CASCADE,
  bookmaker TEXT NOT NULL,
  market TEXT NOT NULL, -- 'h2h', 'spreads', 'totals'
  
  -- For h2h: home_odds, away_odds
  home_odds NUMERIC,
  away_odds NUMERIC,
  
  -- For spreads: home_point (negative = fav), away_point
  home_point NUMERIC,
  away_point NUMERIC,
  
  -- For totals: over_odds, under_odds, total_point
  total_point NUMERIC,
  over_odds NUMERIC,
  under_odds NUMERIC,
  
  source TEXT NOT NULL DEFAULT 'api',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  UNIQUE(match_id, bookmaker, market)
);

-- Enable RLS
ALTER TABLE match_odds ENABLE ROW LEVEL SECURITY;

-- RLS policies for anon access
CREATE POLICY "select_match_odds" ON match_odds FOR SELECT
  TO anon, authenticated USING (true);
CREATE POLICY "insert_match_odds" ON match_odds FOR INSERT
  TO anon, authenticated WITH CHECK (true);
CREATE POLICY "update_match_odds" ON match_odds FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "delete_match_odds" ON match_odds FOR DELETE
  TO anon, authenticated USING (true);

-- Index for efficient lookups
CREATE INDEX idx_match_odds_match_id ON match_odds(match_id);
CREATE INDEX idx_match_odds_market ON match_odds(market);
