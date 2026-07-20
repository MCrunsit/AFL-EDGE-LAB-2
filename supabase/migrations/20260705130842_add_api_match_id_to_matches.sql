-- Add api_match_id column to matches table for reliable API linking
ALTER TABLE matches ADD COLUMN IF NOT EXISTS api_match_id integer;

-- Create unique index on api_match_id (drop first if exists)
DROP INDEX IF EXISTS idx_matches_api_match_id;
CREATE UNIQUE INDEX idx_matches_api_match_id ON matches(api_match_id) WHERE api_match_id IS NOT NULL;