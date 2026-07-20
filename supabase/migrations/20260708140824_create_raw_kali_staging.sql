-- Create staging table for unresolved player game stats from Kali
CREATE TABLE IF NOT EXISTS raw_kali_player_game_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season INTEGER NOT NULL,
  round TEXT,
  match_id UUID REFERENCES matches(id),
  match_date DATE,
  raw_player_name TEXT NOT NULL,
  normalized_player_name TEXT,
  team TEXT,
  normalized_team TEXT,
  opponent TEXT,
  venue TEXT,
  disposals INTEGER DEFAULT 0,
  marks INTEGER DEFAULT 0,
  tackles INTEGER DEFAULT 0,
  goals INTEGER DEFAULT 0,
  hitouts INTEGER DEFAULT 0,
  source TEXT DEFAULT 'kali_footywire_std',
  failure_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_raw_kali_match_id ON raw_kali_player_game_stats(match_id);
CREATE INDEX IF NOT EXISTS idx_raw_kali_player_name ON raw_kali_player_game_stats(normalized_player_name);
CREATE INDEX IF NOT EXISTS idx_raw_kali_season_round ON raw_kali_player_game_stats(season, round);

-- Enable RLS
ALTER TABLE raw_kali_player_game_stats ENABLE ROW LEVEL SECURITY;

-- RLS policies for anon/authenticated access
CREATE POLICY "anon_read_raw_kali" ON raw_kali_player_game_stats
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "anon_insert_raw_kali" ON raw_kali_player_game_stats
  FOR INSERT TO anon, authenticated WITH CHECK (true);

-- Check the player_game_stats unique constraint
SELECT conname, contype, pg_get_constraintdef(oid) 
FROM pg_constraint 
WHERE conrelid = 'player_game_stats'::regclass;
