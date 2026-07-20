-- Bet tracking tables
CREATE TABLE IF NOT EXISTS tracked_bets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT now(),
  
  -- Match context
  match_id UUID REFERENCES matches(id),
  match_name TEXT,
  venue TEXT,
  opponent TEXT,
  
  -- Player and market
  player_name TEXT NOT NULL,
  player_id UUID REFERENCES players(id),
  market TEXT,
  line TEXT,
  display_label TEXT,
  bookmaker TEXT,
  
  -- Odds and model
  odds_taken NUMERIC NOT NULL,
  base_conservative_probability NUMERIC,
  venue_adjustment NUMERIC DEFAULT 0,
  opponent_adjustment NUMERIC DEFAULT 0,
  adjusted_probability NUMERIC,
  fair_odds NUMERIC,
  adjusted_ev NUMERIC,
  
  -- Confidence and sample
  confidence TEXT,
  sample_size INTEGER,
  hit_count INTEGER,
  venue_games INTEGER,
  opponent_games INTEGER,
  
  -- Tags
  context_tags TEXT[],
  
  -- Stake and result
  stake_units NUMERIC DEFAULT 1,
  result TEXT DEFAULT 'pending' CHECK (result IN ('pending', 'win', 'loss', 'push')),
  payout NUMERIC,
  profit_loss NUMERIC,
  
  -- Closing
  closing_odds NUMERIC,
  clv_percent NUMERIC,
  
  -- Notes
  notes TEXT
);

-- Multi/parlay tracking
CREATE TABLE IF NOT EXISTS tracked_multis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT now(),
  
  -- Multi details
  combined_odds NUMERIC NOT NULL,
  estimated_adjusted_probability NUMERIC,
  estimated_adjusted_ev NUMERIC,
  stake_units NUMERIC DEFAULT 1,
  result TEXT DEFAULT 'pending' CHECK (result IN ('pending', 'win', 'loss', 'push')),
  payout NUMERIC,
  profit_loss NUMERIC,
  
  -- Closing
  closing_odds NUMERIC,
  clv_percent NUMERIC,
  
  -- Notes
  notes TEXT,
  
  -- Match IDs involved
  match_ids UUID[]
);

-- Multi legs
CREATE TABLE IF NOT EXISTS tracked_multi_legs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  multi_id UUID REFERENCES tracked_multis(id) ON DELETE CASCADE,
  
  -- Leg details
  player_name TEXT NOT NULL,
  player_id UUID REFERENCES players(id),
  market TEXT,
  line TEXT,
  display_label TEXT,
  odds NUMERIC NOT NULL,
  adjusted_probability NUMERIC,
  adjusted_ev NUMERIC,
  venue_adjustment NUMERIC DEFAULT 0,
  opponent_adjustment NUMERIC DEFAULT 0,
  context_tags TEXT[],
  
  -- Match
  match_id UUID REFERENCES matches(id),
  match_name TEXT
);

-- Enable RLS
ALTER TABLE tracked_bets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracked_multis ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracked_multi_legs ENABLE ROW LEVEL SECURITY;

-- Public read/write for anon (no auth flow here)
CREATE POLICY "anon_access_tracked_bets" ON tracked_bets FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "anon_access_tracked_multis" ON tracked_multis FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "anon_access_tracked_multi_legs" ON tracked_multi_legs FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- Indexes
CREATE INDEX idx_tracked_bets_result ON tracked_bets(result);
CREATE INDEX idx_tracked_bets_created ON tracked_bets(created_at DESC);
CREATE INDEX idx_tracked_multis_created ON tracked_multis(created_at DESC);