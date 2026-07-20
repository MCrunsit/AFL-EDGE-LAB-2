-- Add position_group column to players table
ALTER TABLE players ADD COLUMN IF NOT EXISTS position_group text DEFAULT 'UNKNOWN';

-- Create position edge cache table for storing calculated edges
CREATE TABLE IF NOT EXISTS position_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  season integer NOT NULL DEFAULT EXTRACT(YEAR FROM CURRENT_DATE)::integer,
  position_group text NOT NULL,
  opponent_team text NOT NULL,
  stat_type text NOT NULL,
  games integer NOT NULL DEFAULT 0,
  avg_stat_against_opponent numeric NOT NULL DEFAULT 0,
  league_avg_for_position numeric NOT NULL DEFAULT 0,
  edge_value numeric NOT NULL DEFAULT 0,
  consistency numeric NOT NULL DEFAULT 0,
  significance text NOT NULL DEFAULT 'none',
  updated_at timestamptz DEFAULT now(),
  UNIQUE(season, position_group, opponent_team, stat_type)
);

ALTER TABLE position_edges ENABLE ROW LEVEL SECURITY;

-- RLS policies for position_edges (anon + authenticated for read, authenticated for write)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'position_edges' AND policyname = 'anon_select_position_edges'
  ) THEN
    CREATE POLICY "anon_select_position_edges" ON position_edges FOR SELECT
      TO anon, authenticated USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'position_edges' AND policyname = 'auth_insert_position_edges'
  ) THEN
    CREATE POLICY "auth_insert_position_edges" ON position_edges FOR INSERT
      TO authenticated WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'position_edges' AND policyname = 'auth_update_position_edges'
  ) THEN
    CREATE POLICY "auth_update_position_edges" ON position_edges FOR UPDATE
      TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Create index for fast lookups
CREATE INDEX IF NOT EXISTS idx_position_edges_lookup ON position_edges(season, position_group, opponent_team, stat_type);
CREATE INDEX IF NOT EXISTS idx_players_position_group ON players(position_group);

-- Update any existing NULL position_group to UNKNOWN
UPDATE players SET position_group = 'UNKNOWN' WHERE position_group IS NULL;