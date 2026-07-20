-- Add unique constraint on players for deduplication
ALTER TABLE players
DROP CONSTRAINT IF EXISTS players_name_team_unique;

ALTER TABLE players
ADD CONSTRAINT players_name_team_unique
UNIQUE (name, team);