-- Add venue and opponent edge fields to tracked_bets
ALTER TABLE tracked_bets
  ADD COLUMN IF NOT EXISTS venue_edge_value numeric,
  ADD COLUMN IF NOT EXISTS venue_edge_label text,
  ADD COLUMN IF NOT EXISTS venue_edge_adjustment numeric,
  ADD COLUMN IF NOT EXISTS opponent_edge_value numeric,
  ADD COLUMN IF NOT EXISTS opponent_edge_label text,
  ADD COLUMN IF NOT EXISTS opponent_edge_adjustment numeric,
  ADD COLUMN IF NOT EXISTS total_matchup_adjustment numeric,
  ADD COLUMN IF NOT EXISTS use_venue_edge boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS use_opponent_edge boolean DEFAULT false;

-- Add venue and opponent edge fields to watchlist
ALTER TABLE watchlist
  ADD COLUMN IF NOT EXISTS venue_edge_value numeric,
  ADD COLUMN IF NOT EXISTS venue_edge_label text,
  ADD COLUMN IF NOT EXISTS venue_edge_adjustment numeric,
  ADD COLUMN IF NOT EXISTS opponent_edge_value numeric,
  ADD COLUMN IF NOT EXISTS opponent_edge_label text,
  ADD COLUMN IF NOT EXISTS opponent_edge_adjustment numeric,
  ADD COLUMN IF NOT EXISTS total_matchup_adjustment numeric,
  ADD COLUMN IF NOT EXISTS use_venue_edge boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS use_opponent_edge boolean DEFAULT false;

-- Add venue and opponent edge fields to tracked_multi_legs
ALTER TABLE tracked_multi_legs
  ADD COLUMN IF NOT EXISTS venue_edge_value numeric,
  ADD COLUMN IF NOT EXISTS venue_edge_label text,
  ADD COLUMN IF NOT EXISTS venue_edge_adjustment numeric,
  ADD COLUMN IF NOT EXISTS opponent_edge_value numeric,
  ADD COLUMN IF NOT EXISTS opponent_edge_label text,
  ADD COLUMN IF NOT EXISTS opponent_edge_adjustment numeric,
  ADD COLUMN IF NOT EXISTS total_matchup_adjustment numeric;

-- Add venue and opponent edge fields to tracked_multis
ALTER TABLE tracked_multis
  ADD COLUMN IF NOT EXISTS use_venue_edge boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS use_opponent_edge boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS estimated_total_matchup_adjustment numeric;
