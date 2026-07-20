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
  cbaSeasonAvg: number;
  cbaLast5: number;
  cbaLast3: number;
  kickInSeasonShare: number;
  kickInLast5Share: number;
  kickInLast3Share: number;
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
  const { data, error } = await supabase
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
    .order('updated_at', { ascending: false });

  if (error || !data || data.length === 0) {
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

  const result: RoleTrendMap = new Map();
  for (const [playerId, records] of byPlayer) {
    const sorted = records.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    const seasonRecords = sorted;
    const last5 = sorted.slice(0, 5);
    const last3 = sorted.slice(0, 3);

    const cbaSeasonAvg = seasonRecords.reduce((acc, r) => acc + r.cbaPercentage, 0) / Math.max(1, seasonRecords.length);
    const cbaLast5 = last5.reduce((acc, r) => acc + r.cbaPercentage, 0) / Math.max(1, last5.length);
    const cbaLast3 = last3.reduce((acc, r) => acc + r.cbaPercentage, 0) / Math.max(1, last3.length);

    const kickInSeasonShare = seasonRecords.reduce((acc, r) => acc + r.kickInShare, 0) / Math.max(1, seasonRecords.length);
    const kickInLast5Share = last5.reduce((acc, r) => acc + r.kickInShare, 0) / Math.max(1, last5.length);
    const kickInLast3Share = last3.reduce((acc, r) => acc + r.kickInShare, 0) / Math.max(1, last3.length);

    const cbaChange = cbaLast3 - cbaSeasonAvg;
    const kickInChange = kickInLast3Share - kickInSeasonShare;

    const hasData = seasonRecords.length > 0;
    const trendLabel = getTrendLabel(cbaChange, kickInChange, hasData);
    const confidence = getConfidence(seasonRecords.length);
    const adjustment = adjustmentFromTrend(trendLabel);

    const first = sorted[0];
    result.set(playerId, {
      playerId,
      playerName: '',
      team: '',
      cbaSeasonAvg,
      cbaLast5,
      cbaLast3,
      kickInSeasonShare,
      kickInLast5Share,
      kickInLast3Share,
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
CREATE POLICY "insert_role_data" ON player_role_data FOR INSERT
  TO authenticated WITH CHECK (true);
CREATE POLICY "update_role_data" ON player_role_data FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "delete_role_data" ON player_role_data FOR DELETE
  TO authenticated USING (true);
`;
