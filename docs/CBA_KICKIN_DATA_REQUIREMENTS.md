# CBA / Kick-In Data — Current Status and Import Requirements

**Status as of this phase: schema exists, zero genuine rows.** Player
Intelligence's CBA and kick-in components correctly report `available: false`
/ "Insufficient data" for every player tonight — this is honest, not a bug.
No values have been estimated, derived from disposals, or fabricated.

## What already exists

The `player_role_data` table (migration
`supabase/migrations/20260715034201_create_player_role_data_table.sql`) is
already the correct shape for this data:

```sql
CREATE TABLE player_role_data (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid REFERENCES players(id) ON DELETE CASCADE,
  match_id uuid REFERENCES matches(id) ON DELETE SET NULL,
  round text,
  season integer DEFAULT 2026,
  cba_percentage numeric DEFAULT 0,
  cba_count integer DEFAULT 0,
  team_cba_total integer DEFAULT 0,
  kick_in_count integer DEFAULT 0,
  kick_in_play_on_count integer DEFAULT 0,
  kick_in_share numeric DEFAULT 0,
  source text DEFAULT 'manual_import',
  updated_at timestamptz DEFAULT now(),
  UNIQUE(player_id, match_id)
);
```

Confirmed via direct query against the live database: **0 rows**. No
database schema change is required to light this feature up — only data.

`src/lib/roleTrendService.ts`'s `loadRoleTrends()` already reads this table,
computes season/last-5/last-3 averages, a `latestCba`/`latestKickInShare`
value, a trend direction, and a sample size (`RoleTrendEntry.sampleSize`,
added this phase). `src/lib/playerIntelligenceService.ts`'s
`computeCbaIntel()` / `computeKickInIntel()` already consume it. **The moment
rows exist in `player_role_data`, CBA and kick-in evidence will appear in the
Player Intelligence drawer and badges automatically** — no further code
changes are needed for basic display.

## What's missing: the data itself

No source in this project currently ingests centre-bounce attendance or
kick-in counts per player per match. This needs a real, verifiable source —
never estimated from disposal counts (a player's disposal total says nothing
reliable about how many centre bounces they attended or kick-ins they took).

### Suggested CSV columns for a manual import

To match the existing table 1:1, a CSV import would need:

| Column | Type | Notes |
|---|---|---|
| `player_name` | text | Resolved to `player_id` via canonical player matching (see below) — never surname-only matching |
| `team` | text | Canonical team name, used to disambiguate same-name players |
| `match_date` or `round` | text | Resolved to `match_id` via the `matches` table |
| `cba_count` | integer | Raw centre bounce attendances for that match |
| `team_cba_total` | integer | Total centre bounces contested by the player's team that match (denominator for `cba_percentage`) |
| `kick_in_count` | integer | Raw kick-ins taken |
| `kick_in_play_on_count` | integer | Of those kick-ins, how many were played on (vs kicked short/long) |
| `source` | text | Provenance, e.g. `'champion_data_2026_r20'` — never `'manual_import'` silently; keep it traceable |

`cba_percentage` and `kick_in_share` can be computed at import time
(`cba_count / team_cba_total`, etc.) rather than requiring the source file to
pre-compute them, reducing transcription error.

### Canonical resolution requirements

- Player resolution **must** go through the existing canonical player
  matching used elsewhere in this project (`src/lib/playerMatching.ts` /
  `canonicalPlayerService.ts`), not surname-only or fuzzy string matching —
  the project's existing rule against merging same-name players without team
  validation applies here too.
- Match resolution must use the real `matches.id` for that round, not a
  reconstructed date+team key, to avoid off-by-one round errors.

### Future source options (not evaluated or committed to)

- A licensed stats provider (e.g. Champion Data) that publishes CBA/kick-in
  splits — this is the standard source AFL media and betting products use.
- Manual weekly transcription from AFL match centre "advanced stats" if a
  license isn't available — slower, but genuine.

Neither option was set up this phase. This document exists so a future
import pass has a clear target schema and resolution rules, rather than
re-deriving them from scratch.

## How it connects to Player Intelligence (already wired)

```
player_role_data (rows)
  → roleTrendService.ts: loadRoleTrends()  →  RoleTrendMap
  → playerIntelligenceService.ts: computeCbaIntel() / computeKickInIntel() / computeRoleIntel()
  → PlayerIntelligence.cba / .kickIns / .roleIntelligence
  → Player Intelligence Drawer + badges (MultiOptimizerPanel.tsx)
```

Once genuine rows exist, `available` flips to `true`, season/last-5/latest
values and a trend populate, and Role Intelligence gains a real signal
instead of falling back to the weaker "recent disposal trend" heuristic.
