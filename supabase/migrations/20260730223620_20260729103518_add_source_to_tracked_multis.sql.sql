/*
# Add source column to tracked_multis

1. Changes to tracked_multis
- Add `source` column (text, NOT NULL, default 'manual')
  Tracks which builder produced a multi — 'manual' (Build Your Own Multi),
  'round_multi' (Round Multi Optimizer), or 'game_getup' (Game Get-Up).
  Existing rows default to 'manual' since the manual builder was the only
  source until now.
- Add CHECK constraint enforcing source ∈ ('manual', 'round_multi', 'game_getup').
- Add index idx_tracked_multis_source on source for filtered Bet Tracker queries.
2. Security
- No RLS / policy changes — column is additive, existing policies still apply.
3. Idempotency
- ADD COLUMN IF NOT EXISTS and CREATE INDEX IF NOT EXISTS make this safe to re-run.
*/

ALTER TABLE tracked_multis
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'round_multi', 'game_getup'));

CREATE INDEX IF NOT EXISTS idx_tracked_multis_source ON tracked_multis(source);
