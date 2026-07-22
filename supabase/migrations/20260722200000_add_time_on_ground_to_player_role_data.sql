-- NOTE: this migration file could NOT be applied in this session — the
-- environment only has anon-key REST access (no Supabase CLI / service-role
-- DB-admin connection available), and PostgREST cannot execute DDL. It is
-- checked in ready to run via the Supabase SQL editor (or CLI) by someone
-- with direct database access. Confirmed empirically: an anon-key INSERT
-- into player_role_data returns 42501 "new row violates row-level security
-- policy" today.
--
-- Two genuine, verified gaps this fixes:
--
-- 1. player_role_data's original migration (20260715034201) only granted
--    INSERT/UPDATE to the "authenticated" role. Every other writable table
--    in this schema (players, matches, player_game_stats) was deliberately
--    migrated in 20260705121824_update_rls_for_anon_access.sql to also allow
--    "anon" INSERT/UPDATE, because this app has no login system and reads/
--    writes entirely via the anon key. player_role_data missing that grant
--    is an inconsistency with the rest of the schema, not an intentional
--    restriction — this brings it in line with the established pattern.
--
-- 2. player_role_data has no column for genuine time-on-ground data, which
--    the DFS Australia importer (src/lib/dfsAustraliaImportService.ts)
--    parses but cannot yet persist.
--
-- Once applied, re-running the DFS Australia importer will both start
-- writing successfully and backfill time_on_ground for already-imported
-- rows (upsert by player_id + match_id).

ALTER TABLE player_role_data ADD COLUMN IF NOT EXISTS time_on_ground numeric;

DROP POLICY IF EXISTS "insert_role_data" ON player_role_data;
DROP POLICY IF EXISTS "update_role_data" ON player_role_data;

CREATE POLICY "anon_insert_role_data" ON player_role_data FOR INSERT
  TO anon, authenticated WITH CHECK (true);
CREATE POLICY "anon_update_role_data" ON player_role_data FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);
