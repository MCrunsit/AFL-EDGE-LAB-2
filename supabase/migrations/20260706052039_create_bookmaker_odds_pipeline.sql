-- ============================================================================
-- BOOKMAKER ODDS INGESTION PIPELINE
-- Real-time player prop odds from multiple bookmakers
-- ============================================================================

-- Bookmaker configuration
CREATE TABLE bookmakers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  api_endpoint TEXT,
  is_active BOOLEAN DEFAULT true,
  last_fetch_at TIMESTAMPTZ,
  fetch_interval_seconds INT DEFAULT 300,
  created_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO bookmakers (id, name, is_active) VALUES
  ('sportsbet', 'Sportsbet', true),
  ('tab', 'TAB', true),
  ('ladbrokes', 'Ladbrokes', true),
  ('pointsbet', 'PointsBet', true),
  ('neds', 'Neds', true),
  ('bet365', 'Bet365', true);

-- Raw bookmaker odds (each row = one line from one bookmaker)
CREATE TABLE bookmaker_odds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Bookmaker identification
  bookmaker_id TEXT NOT NULL REFERENCES bookmakers(id),
  
  -- Player/match linkage
  player_id UUID REFERENCES players(id) ON DELETE CASCADE,
  match_id UUID REFERENCES matches(id) ON DELETE CASCADE,
  
  -- Market details
  market TEXT NOT NULL, -- 'disposals', 'goals', 'tackles', 'marks', 'hitouts'
  line NUMERIC NOT NULL,
  
  -- Odds
  over_odds NUMERIC NOT NULL,
  under_odds NUMERIC NOT NULL,
  
  -- Normalized player name from bookmaker (for debugging)
  bookmaker_player_name TEXT,
  
  -- Timestamps
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until TIMESTAMPTZ, -- when this odds line expires
  
  -- Source tracking
  source TEXT DEFAULT 'bookmaker_feed',
  
  created_at TIMESTAMPTZ DEFAULT now(),
  
  -- Unique constraint: one line per bookmaker per player per match per market
  UNIQUE(bookmaker_id, player_id, match_id, market, line)
);

-- Indexes for efficient queries
CREATE INDEX idx_bookmaker_odds_player ON bookmaker_odds(player_id);
CREATE INDEX idx_bookmaker_odds_match ON bookmaker_odds(match_id);
CREATE INDEX idx_bookmaker_odds_market ON bookmaker_odds(market);
CREATE INDEX idx_bookmaker_odds_fetched ON bookmaker_odds(fetched_at DESC);
CREATE INDEX idx_bookmaker_odds_valid ON bookmaker_odds(valid_until) WHERE valid_until IS NOT NULL;

-- RLS policies
ALTER TABLE bookmaker_odds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_bookmaker_odds" ON bookmaker_odds FOR SELECT
  TO anon, authenticated USING (true);
CREATE POLICY "insert_bookmaker_odds" ON bookmaker_odds FOR INSERT
  TO anon, authenticated WITH CHECK (true);
CREATE POLICY "update_bookmaker_odds" ON bookmaker_odds FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "delete_bookmaker_odds" ON bookmaker_odds FOR DELETE
  TO anon, authenticated USING (true);

-- RLS for bookmakers table
ALTER TABLE bookmakers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_bookmakers" ON bookmakers FOR SELECT
  TO anon, authenticated USING (true);

-- Player name normalization helpers
CREATE TABLE player_name_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  bookmaker_id TEXT, -- which bookmaker uses this alias (null = universal)
  created_at TIMESTAMPTZ DEFAULT now(),
  
  UNIQUE(player_id, alias, bookmaker_id)
);

CREATE INDEX idx_player_name_aliases_alias ON player_name_aliases(lower(alias));

ALTER TABLE player_name_aliases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_player_name_aliases" ON player_name_aliases FOR SELECT
  TO anon, authenticated USING (true);
CREATE POLICY "insert_player_name_aliases" ON player_name_aliases FOR INSERT
  TO anon, authenticated WITH CHECK (true);

-- Aggregate view: Best available odds per player/match/market/line
CREATE VIEW best_available_odds AS
WITH ranked_odds AS (
  SELECT 
    bo.*,
    b.name as bookmaker_name,
    p.name as player_name,
    m.home_team,
    m.away_team,
    m.match_date,
    -- Calculate implied probabilities
    100 / bo.over_odds as over_implied_prob,
    100 / bo.under_odds as under_implied_prob,
    -- Vig calculation
    (100 / bo.over_odds + 100 / bo.under_odds - 100) as vig_pct,
    -- Rank over odds (best = highest)
    ROW_NUMBER() OVER (
      PARTITION BY bo.player_id, bo.match_id, bo.market, bo.line
      ORDER BY bo.over_odds DESC
    ) as over_rank,
    ROW_NUMBER() OVER (
      PARTITION BY bo.player_id, bo.match_id, bo.market, bo.line
      ORDER BY bo.under_odds DESC
    ) as under_rank
  FROM bookmaker_odds bo
  JOIN bookmakers b ON b.id = bo.bookmaker_id
  JOIN players p ON p.id = bo.player_id
  JOIN matches m ON m.id = bo.match_id
  WHERE bo.valid_until IS NULL OR bo.valid_until > now()
)
SELECT 
  player_id,
  match_id,
  market,
  line,
  player_name,
  home_team,
  away_team,
  match_date,
  
  -- Best over odds
  MAX(CASE WHEN over_rank = 1 THEN over_odds END) as best_over_odds,
  MAX(CASE WHEN over_rank = 1 THEN bookmaker_name END) as best_over_bookmaker,
  MAX(CASE WHEN over_rank = 1 THEN over_implied_prob END) as best_over_implied_prob,
  
  -- Best under odds
  MAX(CASE WHEN under_rank = 1 THEN under_odds END) as best_under_odds,
  MAX(CASE WHEN under_rank = 1 THEN bookmaker_name END) as best_under_bookmaker,
  MAX(CASE WHEN under_rank = 1 THEN under_implied_prob END) as best_under_implied_prob,
  
  -- Min vig (best line overall)
  MIN(vig_pct) as min_vig_pct,
  
  -- Count of bookmakers offering this line
  COUNT(*) as bookmaker_count,
  
  -- Average odds across books
  AVG(over_odds) as avg_over_odds,
  AVG(under_odds) as avg_under_odds,
  
  MAX(fetched_at) as last_updated
  
FROM ranked_odds
GROUP BY player_id, match_id, market, line, player_name, home_team, away_team, match_date;

-- Model stats view (computed from player_game_stats)
CREATE VIEW player_model_stats AS
SELECT 
  player_id,
  AVG(disposals) as avg_disposals,
  AVG(goals) as avg_goals,
  AVG(tackles) as avg_tackles,
  AVG(marks) as avg_marks,
  AVG(hitouts) as avg_hitouts,
  COUNT(*) as games_played,
  STDDEV(disposals) as stddev_disposals,
  STDDEV(goals) as stddev_goals,
  STDDEV(tackles) as stddev_tackles
FROM player_game_stats
WHERE match_date >= CURRENT_DATE - INTERVAL '12 months'
GROUP BY player_id;

-- EV calculation with model probability
CREATE VIEW odds_with_ev AS
SELECT 
  bo.*,
  pms.avg_disposals,
  pms.avg_goals,
  pms.avg_tackles,
  pms.avg_marks,
  pms.avg_hitouts,
  pms.games_played,
  pms.stddev_disposals,
  pms.stddev_goals,
  pms.stddev_tackles,
  
  -- Model probability calculation based on market type
  CASE 
    WHEN bo.market = 'disposals' AND pms.avg_disposals IS NOT NULL AND pms.stddev_disposals > 0
      THEN GREATEST(0.05, LEAST(0.95, 0.5 + (pms.avg_disposals - bo.line) / (pms.stddev_disposals * 2)))
    WHEN bo.market = 'goals' AND pms.avg_goals IS NOT NULL AND pms.stddev_goals > 0
      THEN GREATEST(0.05, LEAST(0.95, 0.5 + (pms.avg_goals - bo.line) / (pms.stddev_goals * 2)))
    WHEN bo.market = 'tackles' AND pms.avg_tackles IS NOT NULL AND pms.stddev_tackles > 0
      THEN GREATEST(0.05, LEAST(0.95, 0.5 + (pms.avg_tackles - bo.line) / (pms.stddev_tackles * 2)))
    WHEN bo.market = 'marks' AND pms.avg_marks IS NOT NULL
      THEN GREATEST(0.05, LEAST(0.95, 0.5 + (pms.avg_marks - bo.line) * 0.08))
    WHEN bo.market = 'hitouts' AND pms.avg_hitouts IS NOT NULL
      THEN GREATEST(0.05, LEAST(0.95, 0.5 + (pms.avg_hitouts - bo.line) * 0.03))
    ELSE NULL
  END as model_prob_over,
  
  -- Expected Value calculations
  CASE 
    WHEN bo.best_over_odds IS NULL THEN NULL
    ELSE (
      CASE 
        WHEN bo.market = 'disposals' AND pms.avg_disposals IS NOT NULL AND pms.stddev_disposals > 0
          THEN GREATEST(0.05, LEAST(0.95, 0.5 + (pms.avg_disposals - bo.line) / (pms.stddev_disposals * 2)))
        WHEN bo.market = 'goals' AND pms.avg_goals IS NOT NULL AND pms.stddev_goals > 0
          THEN GREATEST(0.05, LEAST(0.95, 0.5 + (pms.avg_goals - bo.line) / (pms.stddev_goals * 2)))
        WHEN bo.market = 'tackles' AND pms.avg_tackles IS NOT NULL AND pms.stddev_tackles > 0
          THEN GREATEST(0.05, LEAST(0.95, 0.5 + (pms.avg_tackles - bo.line) / (pms.stddev_tackles * 2)))
        WHEN bo.market = 'marks' AND pms.avg_marks IS NOT NULL
          THEN GREATEST(0.05, LEAST(0.95, 0.5 + (pms.avg_marks - bo.line) * 0.08))
        WHEN bo.market = 'hitouts' AND pms.avg_hitouts IS NOT NULL
          THEN GREATEST(0.05, LEAST(0.95, 0.5 + (pms.avg_hitouts - bo.line) * 0.03))
        ELSE NULL
      END * bo.best_over_odds
    ) - 1
  END as ev_over,
  
  CASE 
    WHEN bo.best_under_odds IS NULL THEN NULL
    ELSE (
      (1 - CASE 
        WHEN bo.market = 'disposals' AND pms.avg_disposals IS NOT NULL AND pms.stddev_disposals > 0
          THEN GREATEST(0.05, LEAST(0.95, 0.5 + (pms.avg_disposals - bo.line) / (pms.stddev_disposals * 2)))
        WHEN bo.market = 'goals' AND pms.avg_goals IS NOT NULL AND pms.stddev_goals > 0
          THEN GREATEST(0.05, LEAST(0.95, 0.5 + (pms.avg_goals - bo.line) / (pms.stddev_goals * 2)))
        WHEN bo.market = 'tackles' AND pms.avg_tackles IS NOT NULL AND pms.stddev_tackles > 0
          THEN GREATEST(0.05, LEAST(0.95, 0.5 + (pms.avg_tackles - bo.line) / (pms.stddev_tackles * 2)))
        WHEN bo.market = 'marks' AND pms.avg_marks IS NOT NULL
          THEN GREATEST(0.05, LEAST(0.95, 0.5 + (pms.avg_marks - bo.line) * 0.08))
        WHEN bo.market = 'hitouts' AND pms.avg_hitouts IS NOT NULL
          THEN GREATEST(0.05, LEAST(0.95, 0.5 + (pms.avg_hitouts - bo.line) * 0.03))
        ELSE 0.5
      END) * bo.best_under_odds
    ) - 1
  END as ev_under

FROM best_available_odds bo
LEFT JOIN player_model_stats pms ON pms.player_id = bo.player_id;

-- Function to clean up expired odds
CREATE OR REPLACE FUNCTION cleanup_expired_bookmaker_odds()
RETURNS void AS $$
BEGIN
  DELETE FROM bookmaker_odds 
  WHERE valid_until IS NOT NULL AND valid_until < now();
  
  DELETE FROM bookmaker_odds 
  WHERE fetched_at < now() - INTERVAL '24 hours';
END;
$$ LANGUAGE plpgsql;

-- Ingestion metadata table
CREATE TABLE bookmaker_ingestion_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bookmaker_id TEXT NOT NULL REFERENCES bookmakers(id),
  ingest_type TEXT NOT NULL, -- 'scheduled', 'manual', 'webhook'
  status TEXT NOT NULL, -- 'success', 'failed', 'partial'
  odds_count INT DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_ingestion_log_bookmaker ON bookmaker_ingestion_log(bookmaker_id, started_at DESC);

ALTER TABLE bookmaker_ingestion_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_ingestion_log" ON bookmaker_ingestion_log FOR SELECT
  TO anon, authenticated USING (true);