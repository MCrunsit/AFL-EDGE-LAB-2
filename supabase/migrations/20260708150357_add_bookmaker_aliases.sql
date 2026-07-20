-- Add missing players for unresolved bookmaker names
INSERT INTO players (id, name, team, position_group, is_active, games_last_two_seasons)
VALUES 
  (gen_random_uuid(), 'Oliver Francou', 'gold-coast', 'UNKNOWN', true, 0)
ON CONFLICT DO NOTHING;

-- Create alias table for bookmaker name variations
CREATE TABLE IF NOT EXISTS bookmaker_player_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_player_id UUID REFERENCES players(id),
  alias_name TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bookmaker_aliases_name ON bookmaker_player_aliases(normalized_alias);

-- Seed common aliases
INSERT INTO bookmaker_player_aliases (canonical_player_id, alias_name, normalized_alias)
SELECT id, 'Lachie McNeil', 'lachie mcneil' FROM players WHERE name = 'Lachlan McNeil'
UNION ALL
SELECT id, 'Sam Swadling', 'sam swadling' FROM players WHERE name = 'Samuel Swadling'
ON CONFLICT DO NOTHING;

-- Now resolve those aliases
UPDATE bookmaker_odds bo
SET 
  player_id = bpa.canonical_player_id,
  resolved_player_name = p.name,
  resolution_status = 'resolved',
  resolution_reason = 'alias_match'
FROM bookmaker_player_aliases bpa
JOIN players p ON p.id = bpa.canonical_player_id
WHERE bo.player_id IS NULL
  AND normalize_player_name(bo.bookmaker_player_name) = bpa.normalized_alias;
