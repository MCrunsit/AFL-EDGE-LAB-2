-- Add Position Edge fields to tracked_bets
ALTER TABLE tracked_bets
  ADD COLUMN IF NOT EXISTS position_group text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS position_edge_value numeric DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS position_edge_significance text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS position_edge_adjustment numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS final_probability numeric DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS final_ev numeric DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS use_position_edge boolean DEFAULT false;

-- Add Position Edge fields to tracked_multi_legs
ALTER TABLE tracked_multi_legs
  ADD COLUMN IF NOT EXISTS position_group text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS position_edge_value numeric DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS position_edge_significance text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS position_edge_adjustment numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS final_probability numeric DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS final_ev numeric DEFAULT NULL;

-- Add Position Edge fields to tracked_multis (parent)
ALTER TABLE tracked_multis
  ADD COLUMN IF NOT EXISTS use_position_edge boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS estimated_final_probability numeric DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS estimated_final_ev numeric DEFAULT NULL;

-- Add Position Edge fields to watchlist
ALTER TABLE watchlist
  ADD COLUMN IF NOT EXISTS position_group text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS position_edge_value numeric DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS position_edge_significance text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS position_edge_adjustment numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS final_probability numeric DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS final_ev numeric DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS use_position_edge boolean DEFAULT false;
