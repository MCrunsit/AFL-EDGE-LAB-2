import { supabase } from './supabase';

export type RoleTrendLabel =
  | 'STRONG_POSITIVE' | 'POSITIVE' | 'STABLE' | 'NEGATIVE' | 'STRONG_NEGATIVE' | 'UNKNOWN';

export type RoleTrendMode = 'DISPLAY_ONLY' | 'MODEL_ACTIVE';

export interface PlayerRoleData {
  playerId: string;
  matchId: string | null;
  round: string | null;
  cbaPercentage: number;
  cbaCount: number;
  teamCbaTotal: number;
  kickInCount: number;
  kickInPlayOnCount: number;
  kickInShare: number;
  source: string;
  updatedAt: string;
}

export interface RoleTrendEntry {
  playerId: string;
  playerName: string;
  team: string;
  sampleSize: number;
  latestRound: string | null;
  /** @deprecated ambiguous name — kept for existing trend-calc consumers, but
   * this is actually cba_percentage (a 0-1 share), not a count. Use
   * latestCbaCount for the real attendance count. */
  latestCba: number | null;
  latestCbaCount: number | null;
  latestKickInCount: number | null;
  latestKickInShare: number | null;
  latestUpdatedAt: string | null;
  /** @deprecated ambiguous name — these are cba_percentage averages (0-1
   * shares), not attendance-count averages. Use cbaCountSeasonAvg etc. */
  cbaSeasonAvg: number;
  cbaLast10: number;
  cbaLast5: number;
  cbaLast3: number;
  /** Genuine CBA attendance-count averages (raw counts, not shares). */
  cbaCountSeasonAvg: number;
  cbaCountLast10: number;
  cbaCountLast5: number;
  cbaCountLast3: number;
  /** Genuine kick-in count averages (raw counts, not shares). */
  kickInCountSeasonAvg: number;
  kickInCountLast10: number;
  kickInCountLast5: number;
  kickInCountLast3: number;
  kickInSeasonShare: number;
  kickInLast10Share: number;
  kickInLast5Share: number;
  kickInLast3Share: number;
  /** Aggregate (sum play-ons / sum kick-ins) over the window — null when the
   * window has zero genuine kick-ins to compute a percentage from. */
  kickInPlayOnPctSeason: number | null;
  kickInPlayOnPctLast10: number | null;
  kickInPlayOnPctLast5: number | null;
  kickInPlayOnPctLast3: number | null;
  cbaChange: number;
  kickInChange: number;
  trendLabel: RoleTrendLabel;
  confidence: 'high' | 'medium' | 'low';
  adjustment: number;
  mode: RoleTrendMode;
}

export type RoleTrendMap = Map<string, RoleTrendEntry>;

const CURRENT_MODE: RoleTrendMode = 'DISPLAY_ONLY';
const CBA_SIGNIFICANT_CHANGE = 10;
const KICKIN_SIGNIFICANT_CHANGE = 0.08;

function getTrendLabel(cbaChange: number, kickInChange: number, hasData: boolean): RoleTrendLabel {
  if (!hasData) return 'UNKNOWN';

  const cbaPositive = cbaChange >= CBA_SIGNIFICANT_CHANGE;
  const cbaNegative = cbaChange <= -CBA_SIGNIFICANT_CHANGE;
  const kickInPositive = kickInChange >= KICKIN_SIGNIFICANT_CHANGE;
  const kickInNegative = kickInChange <= -KICKIN_SIGNIFICANT_CHANGE;

  if (cbaPositive && kickInPositive) return 'STRONG_POSITIVE';
  if (cbaPositive || kickInPositive) return 'POSITIVE';
  if (cbaNegative && kickInNegative) return 'STRONG_NEGATIVE';
  if (cbaNegative || kickInNegative) return 'NEGATIVE';
  return 'STABLE';
}

function adjustmentFromTrend(label: RoleTrendLabel): number {
  if (CURRENT_MODE !== 'MODEL_ACTIVE') return 0;
  switch (label) {
    case 'STRONG_POSITIVE': return 0.02;
    case 'POSITIVE': return 0.01;
    case 'STABLE': return 0;
    case 'NEGATIVE': return -0.01;
    case 'STRONG_NEGATIVE': return -0.02;
    default: return 0;
  }
}

function getConfidence(games: number): 'high' | 'medium' | 'low' {
  if (games >= 10) return 'high';
  if (games >= 5) return 'medium';
  return 'low';
}

function getTrendDisplay(label: RoleTrendLabel): string {
  switch (label) {
    case 'STRONG_POSITIVE': return 'Strong Positive';
    case 'POSITIVE': return 'Positive';
    case 'STABLE': return 'Stable';
    case 'NEGATIVE': return 'Negative';
    case 'STRONG_NEGATIVE': return 'Strong Negative';
    case 'UNKNOWN': return 'Unknown';
  }
}

/**
 * Load role trend data from the player_role_data table.
 * If the table doesn't exist or has no data, returns an empty map.
 */
export async function loadRoleTrends(season = 2026): Promise<RoleTrendMap> {
  // Fully paginated — an unpaginated select here was silently capped at
  // Supabase's 1000-row default (out of 7000+ role rows for a full season),
  // and since it was ordered by updated_at desc, only whichever 1000 rows
  // happened to be most recently touched survived. Every other player's
  // rows were silently dropped, producing tiny sample sizes and stale
  // "latest round" values across most of the season's coverage.
  const data: any[] = [];
  {
    const pageSize = 1000;
    let offset = 0;
    for (;;) {
      const { data: page, error } = await supabase
        .from('player_role_data')
        .select(`
          player_id,
          match_id,
          round,
          cba_percentage,
          cba_count,
          team_cba_total,
          kick_in_count,
          kick_in_play_on_count,
          kick_in_share,
          source,
          updated_at
        `)
        .eq('season', season)
        .order('id')
        .range(offset, offset + pageSize - 1);
      if (error) { console.error('loadRoleTrends pagination error:', error); break; }
      if (!page || page.length === 0) break;
      data.push(...page);
      if (page.length < pageSize) break;
      offset += pageSize;
    }
  }

  if (data.length === 0) {
    return new Map();
  }

  const byPlayer = new Map<string, PlayerRoleData[]>();
  for (const row of data) {
    const pid = row.player_id as string;
    if (!byPlayer.has(pid)) byPlayer.set(pid, []);
    byPlayer.get(pid)!.push({
      playerId: pid,
      matchId: row.match_id ?? '',
      round: row.round ?? '',
      cbaPercentage: row.cba_percentage ?? 0,
      cbaCount: row.cba_count ?? 0,
      teamCbaTotal: row.team_cba_total ?? 0,
      kickInCount: row.kick_in_count ?? 0,
      kickInPlayOnCount: row.kick_in_play_on_count ?? 0,
      kickInShare: row.kick_in_share ?? 0,
      source: row.source ?? 'unknown',
      updatedAt: row.updated_at ?? '',
    });
  }

  const avg = (records: PlayerRoleData[], pick: (r: PlayerRoleData) => number) =>
    records.length > 0 ? records.reduce((acc, r) => acc + pick(r), 0) / records.length : 0;

  /** Aggregate play-on percentage over a window: sum(play-ons) / sum(kick-ins).
   * Never averages per-match percentages (which breaks down on 0-kick-in
   * matches) and returns null rather than 0 when the window has no genuine
   * kick-ins to compute from. */
  const playOnPct = (records: PlayerRoleData[]): number | null => {
    const totalKickIns = records.reduce((acc, r) => acc + r.kickInCount, 0);
    if (totalKickIns <= 0) return null;
    const totalPlayOns = records.reduce((acc, r) => acc + r.kickInPlayOnCount, 0);
    return totalPlayOns / totalKickIns;
  };

  const result: RoleTrendMap = new Map();
  for (const [playerId, records] of byPlayer) {
    // Sort by round chronologically, NOT updated_at (row insert/update time).
    // Sorting by updated_at was the root cause of "latest round shows Round 1":
    // if an early-round row got re-touched during a later backfill/repair run,
    // its updated_at became more recent than genuinely later rounds' rows,
    // making it look like the "latest" match even though it wasn't. This table
    // has no match_date column, so round (always a clean numeric string here,
    // confirmed against live data) is the correct chronological sort key.
    const sorted = [...records].sort((a, b) => {
      const ra = parseInt(a.round, 10);
      const rb = parseInt(b.round, 10);
      if (!Number.isNaN(ra) && !Number.isNaN(rb) && ra !== rb) return rb - ra;
      if (!Number.isNaN(ra) && Number.isNaN(rb)) return -1;
      if (Number.isNaN(ra) && !Number.isNaN(rb)) return 1;
      return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
    });
    const seasonRecords = sorted;
    const last10 = sorted.slice(0, 10);
    const last5 = sorted.slice(0, 5);
    const last3 = sorted.slice(0, 3);

    const cbaSeasonAvg = avg(seasonRecords, r => r.cbaPercentage);
    const cbaLast10 = avg(last10, r => r.cbaPercentage);
    const cbaLast5 = avg(last5, r => r.cbaPercentage);
    const cbaLast3 = avg(last3, r => r.cbaPercentage);

    const cbaCountSeasonAvg = avg(seasonRecords, r => r.cbaCount);
    const cbaCountLast10 = avg(last10, r => r.cbaCount);
    const cbaCountLast5 = avg(last5, r => r.cbaCount);
    const cbaCountLast3 = avg(last3, r => r.cbaCount);

    const kickInCountSeasonAvg = avg(seasonRecords, r => r.kickInCount);
    const kickInCountLast10 = avg(last10, r => r.kickInCount);
    const kickInCountLast5 = avg(last5, r => r.kickInCount);
    const kickInCountLast3 = avg(last3, r => r.kickInCount);

    const kickInSeasonShare = avg(seasonRecords, r => r.kickInShare);
    const kickInLast10Share = avg(last10, r => r.kickInShare);
    const kickInLast5Share = avg(last5, r => r.kickInShare);
    const kickInLast3Share = avg(last3, r => r.kickInShare);

    const cbaChange = cbaLast3 - cbaSeasonAvg;
    const kickInChange = kickInLast3Share - kickInSeasonShare;

    // Never classify a strong trend from fewer than three genuine matches.
    const hasData = seasonRecords.length >= 3;
    const trendLabel = getTrendLabel(cbaChange, kickInChange, hasData);
    const confidence = getConfidence(seasonRecords.length);
    const adjustment = adjustmentFromTrend(trendLabel);

    const first = sorted[0];
    result.set(playerId, {
      playerId,
      playerName: '',
      team: '',
      sampleSize: seasonRecords.length,
      latestRound: first ? (first.round || null) : null,
      latestCba: first ? first.cbaPercentage : null,
      latestCbaCount: first ? first.cbaCount : null,
      latestKickInCount: first ? first.kickInCount : null,
      latestKickInShare: first ? first.kickInShare : null,
      latestUpdatedAt: first ? (first.updatedAt || null) : null,
      cbaSeasonAvg,
      cbaLast10,
      cbaLast5,
      cbaLast3,
      cbaCountSeasonAvg,
      cbaCountLast10,
      cbaCountLast5,
      cbaCountLast3,
      kickInCountSeasonAvg,
      kickInCountLast10,
      kickInCountLast5,
      kickInCountLast3,
      kickInSeasonShare,
      kickInLast10Share,
      kickInLast5Share,
      kickInLast3Share,
      kickInPlayOnPctSeason: playOnPct(seasonRecords),
      kickInPlayOnPctLast10: playOnPct(last10),
      kickInPlayOnPctLast5: playOnPct(last5),
      kickInPlayOnPctLast3: playOnPct(last3),
      cbaChange,
      kickInChange,
      trendLabel,
      confidence,
      adjustment,
      mode: CURRENT_MODE,
    });
  }

  return result;
}

export { getTrendDisplay, CURRENT_MODE as ROLE_TREND_MODE };

/**
 * Create the player_role_data table for storing CBA and kick-in data.
 * This table is optional — the system runs in DISPLAY_ONLY mode without it.
 */
export const CREATE_ROLE_DATA_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS player_role_data (
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

ALTER TABLE player_role_data ENABLE ROW LEVEL SECURITY;

CREATE POLICY "select_role_data" ON player_role_data FOR SELECT
  TO anon, authenticated USING (true);
CREATE POLICY "anon_insert_role_data" ON player_role_data FOR INSERT
  TO anon, authenticated WITH CHECK (true);
CREATE POLICY "anon_update_role_data" ON player_role_data FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "delete_role_data" ON player_role_data FOR DELETE
  TO authenticated USING (true);
`;
