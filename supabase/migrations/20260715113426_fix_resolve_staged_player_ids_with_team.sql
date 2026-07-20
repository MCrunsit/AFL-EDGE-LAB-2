-- Fix resolve_staged_player_ids to match by normalized name AND team.
-- The previous version matched by name only, which caused same-name
-- different-team players (e.g. Harrison Jones - Essendon vs Hawthorn,
-- Matthew Kennedy - Western Bulldogs vs Brisbane) to be resolved to
-- the wrong player_id.

CREATE OR REPLACE FUNCTION public.resolve_staged_player_ids() RETURNS void
LANGUAGE plpgsql
AS $function$
BEGIN
  -- First pass: resolve by normalized name + team match (preferred)
  UPDATE raw_kali_player_game_stats r
  SET player_id = p.id
  FROM players p
  WHERE r.player_id IS NULL
    AND normalize_player_name(r.raw_player_name) = normalize_player_name(p.name)
    AND p.team IS NOT NULL
    AND normalize_team_canonical(r.normalized_team) = normalize_team_canonical(p.team);

  -- Second pass: resolve by normalized name only where team is null in players table
  UPDATE raw_kali_player_game_stats r
  SET player_id = p.id
  FROM players p
  WHERE r.player_id IS NULL
    AND normalize_player_name(r.raw_player_name) = normalize_player_name(p.name)
    AND p.team IS NULL;

  -- Third pass: resolve by normalized name only if exactly one player matches
  -- (safe for unique names only)
  UPDATE raw_kali_player_game_stats r
  SET player_id = sub.player_id
  FROM (
    SELECT pl.id AS player_id, normalize_player_name(pl.name) AS norm_name
    FROM players pl
    WHERE pl.team IS NOT NULL
    GROUP BY pl.id, normalize_player_name(pl.name)
    HAVING COUNT(*) = 1
      AND normalize_player_name(pl.name) IN (
        SELECT normalize_player_name(rk.raw_player_name)
        FROM raw_kali_player_game_stats rk
        WHERE rk.player_id IS NULL
      )
  ) sub
  WHERE r.player_id IS NULL
    AND normalize_player_name(r.raw_player_name) = sub.norm_name;
END;
$function$;
