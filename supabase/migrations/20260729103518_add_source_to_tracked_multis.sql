-- Track which builder produced a multi (manual builder vs Round Multi vs
-- Game Get-Up), so Bet Tracker can filter/label by origin. Existing rows
-- (all from the manual builder, the only source until now) default to
-- 'manual'.
ALTER TABLE tracked_multis
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'round_multi', 'game_getup'));

CREATE INDEX IF NOT EXISTS idx_tracked_multis_source ON tracked_multis(source);
