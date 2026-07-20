/*
# Create player_prop_odds table + enriched stats view

1. New Tables
- `player_prop_odds`
  - `id` (uuid, primary key)
  - `player_id` (uuid, foreign key to players, not null)
  - `match_id` (uuid, foreign key to matches, nullable — odds may be posted before match_id resolves)
  - `market` (text, not null — e.g. "disposals", "goals", "marks", "tackles", "hitouts")
  - `line` (numeric, not null — e.g. 29.5)
  - `over_odds` (numeric, nullable — decimal odds for the over)
  - `under_odds` (numeric, nullable — decimal odds for the under)
  - `bookmaker` (text, nullable — e.g. "Sportsbet", "Bet365")
  - `created_at` (timestamptz, default now())
- Indexes on player_id, match_id, market for fast lookups.
- Unique constraint on (player_id, match_id, market, bookmaker) to prevent duplicate odds rows.

2. New View
- `enriched_player_stats` — joins player_game_stats with matches to populate
  opponent (the team in the match that is NOT the player's stat team) and venue
  (from the matches table, since player_game_stats.venue is null). Also exposes
  home_team, away_team, season, round from the match. This view powers the
  matchup-context analytics (vs opponent, venue splits) without modifying the
  existing player_game_stats table or sync logic.

3. Security
- RLS enabled on player_prop_odds. Single-tenant app (no sign-in), so
  anon + authenticated have full CRUD.
- The view is read-only and inherits RLS from its underlying tables.
*/

CREATE TABLE IF NOT EXISTS player_prop_odds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  match_id uuid REFERENCES matches(id) ON DELETE SET NULL,
  market text NOT NULL,
  line numeric NOT NULL,
  over_odds numeric,
  under_odds numeric,
  bookmaker text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE player_prop_odds ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_prop_odds" ON player_prop_odds;
CREATE POLICY "anon_select_prop_odds" ON player_prop_odds FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_prop_odds" ON player_prop_odds;
CREATE POLICY "anon_insert_prop_odds" ON player_prop_odds FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_prop_odds" ON player_prop_odds;
CREATE POLICY "anon_update_prop_odds" ON player_prop_odds FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_prop_odds" ON player_prop_odds;
CREATE POLICY "anon_delete_prop_odds" ON player_prop_odds FOR DELETE
  TO anon, authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_prop_odds_player_id ON player_prop_odds(player_id);
CREATE INDEX IF NOT EXISTS idx_prop_odds_match_id ON player_prop_odds(match_id);
CREATE INDEX IF NOT EXISTS idx_prop_odds_market ON player_prop_odds(market);

CREATE UNIQUE INDEX IF NOT EXISTS idx_prop_odds_unique
  ON player_prop_odds(player_id, match_id, market, bookmaker);

/*
  enriched_player_stats view:
  Derives `opponent` as the match team that is NOT the player's stat team.
  Slug-matches player_game_stats.team (e.g. "western-bulldogs") against
  matches.home_team / away_team (e.g. "Western Bulldogs") by lowercasing
  and replacing spaces with hyphens.
*/
CREATE OR REPLACE VIEW enriched_player_stats AS
SELECT
  pgs.id,
  pgs.player_id,
  pgs.match_id,
  pgs.match_date,
  pgs.team,
  pgs.disposals,
  pgs.marks,
  pgs.tackles,
  pgs.goals,
  pgs.hitouts,
  pgs.created_at,
  m.season,
  m.round,
  m.home_team,
  m.away_team,
  m.venue,
  CASE
    WHEN lower(replace(m.home_team, ' ', '-')) = pgs.team THEN m.away_team
    ELSE m.home_team
  END AS opponent,
  CASE
    WHEN lower(replace(m.home_team, ' ', '-')) = pgs.team THEN true
    ELSE false
  END AS is_home
FROM player_game_stats pgs
LEFT JOIN matches m ON m.id = pgs.match_id;
