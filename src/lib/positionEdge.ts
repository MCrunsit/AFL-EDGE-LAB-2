import { supabase } from './supabase';
import { POSITION_GROUPS, POSITION_GROUP_ALIASES } from './types';

export type StatType = 'disposals' | 'marks' | 'tackles' | 'goals' | 'hitouts';

export const BETTING_RELEVANT_STATS: StatType[] = ['disposals', 'marks', 'tackles', 'goals', 'hitouts'];

export type DataLens = 'this_season' | 'last_2_seasons' | 'all_data';

export type ConfidenceLevel = 'low' | 'weak' | 'moderate' | 'strong';

export interface PositionEdgeResult {
  position_group: string;
  opponent_team: string;
  stat_type: StatType;
  games: number;
  avg_stat_against_opponent: number;
  league_avg_for_position: number;
  edge_value: number;
  consistency: number;
  significance: 'none' | 'significant' | 'very_significant';
  confidence: ConfidenceLevel;
  data_lens: DataLens;
}

export interface PositionEdgeCache {
  [key: string]: PositionEdgeResult;
}

export interface PositionEdgeDiagnostics {
  statsRowsFetched: number;
  rowsWithOpponentColumn: number;
  rowsWithOpponentFromMatchId: number;
  rowsWithOpponentFromDateTeam: number;
  orphanedRows: number;
  playersFetched: number;
  mappedPlayers: number;
  unknownPlayers: number;
  rowsSkippedUnknown: number;
  edgesCreated: number;
  edgesByStatType: Record<string, number>;
  edgesByOpponent: Record<string, number>;
  edgesByPositionGroup: Record<string, number>;
  // Audit fields
  playersByOverride: number;
  playersByAutoProfile: number;
  playersMissingStats: number;
  lowConfidencePlayers: number;
}

const STAT_COLUMNS: Record<StatType, string> = {
  disposals: 'disposals',
  marks: 'marks',
  tackles: 'tackles',
  goals: 'goals',
  hitouts: 'hitouts',
};

// AFL teams as canonical names (used for matrix columns)
const AFL_TEAMS = [
  'Adelaide', 'Brisbane', 'Carlton', 'Collingwood', 'Essendon', 'Fremantle',
  'Geelong', 'Gold Coast', 'GWS', 'Hawthorn', 'Melbourne', 'North Melbourne',
  'Port Adelaide', 'Richmond', 'St Kilda', 'Sydney', 'West Coast', 'Western Bulldogs',
];

// Team code → canonical name mapping (for matrix columns that use codes)
const TEAM_CODE_TO_CANONICAL: Record<string, string> = {
  'ADEL': 'Adelaide', 'ADE': 'Adelaide',
  'BL': 'Brisbane', 'BRL': 'Brisbane',
  'CARL': 'Carlton', 'CAR': 'Carlton',
  'COL': 'Collingwood',
  'ESS': 'Essendon',
  'FRE': 'Fremantle',
  'GEE': 'Geelong',
  'GCS': 'Gold Coast',
  'GWS': 'GWS',
  'HAW': 'Hawthorn',
  'MEL': 'Melbourne',
  'NTH': 'North Melbourne',
  'PORT': 'Port Adelaide', 'PTA': 'Port Adelaide',
  'RICH': 'Richmond', 'RIC': 'Richmond',
  'STK': 'St Kilda',
  'SYD': 'Sydney',
  'WCE': 'West Coast',
  'WB': 'Western Bulldogs', 'WBD': 'Western Bulldogs',
};

// Convert any team variant to a short code (for matrix columns)
export function normalizeTeamKey(name: string | null | undefined): string {
  if (!name) return 'UNK';
  const upper = name.toUpperCase().trim();
  // If already a code, return it
  if (TEAM_CODE_TO_CANONICAL[upper]) {
    return Object.keys(TEAM_CODE_TO_CANONICAL).find(k => TEAM_CODE_TO_CANONICAL[k] === TEAM_CODE_TO_CANONICAL[upper]) ?? upper;
  }
  // Normalize to canonical name, then find the code
  const canonical = normalizeTeamName(name);
  const entry = Object.entries(TEAM_CODE_TO_CANONICAL).find(([, v]) => v === canonical);
  return entry ? entry[0] : upper;
}

// Canonical team name mapping — handles all 3 formats:
// 1. lowercase-hyphen (player_game_stats.team, players.team): "adelaide", "gold-coast", "north-melbourne"
// 2. Full name (matches.home_team/away_team): "Adelaide Crows", "Fremantle Dockers", "Greater Western Sydney Giants"
// 3. Short name (matches.home_team/away_team): "Adelaide", "Fremantle", "GWS"
const TEAM_CANONICAL: Record<string, string> = {
  // Adelaide
  'adelaide': 'Adelaide',
  'adelaide crows': 'Adelaide',
  'crows': 'Adelaide',
  'adel': 'Adelaide',
  // Brisbane
  'brisbane': 'Brisbane',
  'brisbane lions': 'Brisbane',
  'lions': 'Brisbane',
  'bl': 'Brisbane',
  // Carlton
  'carlton': 'Carlton',
  'carlton blues': 'Carlton',
  'blues': 'Carlton',
  'carl': 'Carlton',
  // Collingwood
  'collingwood': 'Collingwood',
  'collingwood magpies': 'Collingwood',
  'magpies': 'Collingwood',
  'col': 'Collingwood',
  // Essendon
  'essendon': 'Essendon',
  'essendon bombers': 'Essendon',
  'bombers': 'Essendon',
  'ess': 'Essendon',
  // Fremantle
  'fremantle': 'Fremantle',
  'fremantle dockers': 'Fremantle',
  'dockers': 'Fremantle',
  'fre': 'Fremantle',
  // Geelong
  'geelong': 'Geelong',
  'geelong cats': 'Geelong',
  'cats': 'Geelong',
  'gee': 'Geelong',
  // Gold Coast
  'gold-coast': 'Gold Coast',
  'gold coast': 'Gold Coast',
  'gold coast suns': 'Gold Coast',
  'suns': 'Gold Coast',
  'gcs': 'Gold Coast',
  // GWS
  'gws': 'GWS',
  'greater western sydney': 'GWS',
  'greater western sydney giants': 'GWS',
  'gws giants': 'GWS',
  'giants': 'GWS',
  // Hawthorn
  'hawthorn': 'Hawthorn',
  'hawthorn hawks': 'Hawthorn',
  'hawks': 'Hawthorn',
  'haw': 'Hawthorn',
  // Melbourne
  'melbourne': 'Melbourne',
  'melbourne demons': 'Melbourne',
  'demons': 'Melbourne',
  'mel': 'Melbourne',
  // North Melbourne
  'north-melbourne': 'North Melbourne',
  'north melbourne': 'North Melbourne',
  'north melbourne kangaroos': 'North Melbourne',
  'kangaroos': 'North Melbourne',
  'nth': 'North Melbourne',
  // Port Adelaide
  'port-adelaide': 'Port Adelaide',
  'port adelaide': 'Port Adelaide',
  'port adelaide power': 'Port Adelaide',
  'power': 'Port Adelaide',
  'port': 'Port Adelaide',
  // Richmond
  'richmond': 'Richmond',
  'richmond tigers': 'Richmond',
  'tigers': 'Richmond',
  'ric': 'Richmond',
  // St Kilda
  'st-kilda': 'St Kilda',
  'st kilda': 'St Kilda',
  'st kilda saints': 'St Kilda',
  'saints': 'St Kilda',
  'stk': 'St Kilda',
  // Sydney
  'sydney': 'Sydney',
  'sydney swans': 'Sydney',
  'swans': 'Sydney',
  'syd': 'Sydney',
  // West Coast
  'west-coast': 'West Coast',
  'west coast': 'West Coast',
  'west coast eagles': 'West Coast',
  'eagles': 'West Coast',
  'wce': 'West Coast',
  // Western Bulldogs
  'western-bulldogs': 'Western Bulldogs',
  'western bulldogs': 'Western Bulldogs',
  'bulldogs': 'Western Bulldogs',
  'footscray': 'Western Bulldogs',
  'wb': 'Western Bulldogs',
  'wbd': 'Western Bulldogs',
};

export function normalizeTeamName(name: string | null | undefined): string {
  if (!name) return 'UNKNOWN';
  const lower = name.toLowerCase().trim();
  return TEAM_CANONICAL[lower] ?? name.trim();
}

// Alias for backward compatibility
export function normalizeOpponentName(name: string | null | undefined): string {
  return normalizeTeamName(name);
}

function getSignificance(
  games: number,
  edgeValue: number,
  consistency: number
): 'none' | 'significant' | 'very_significant' {
  if (games < 5) return 'none';
  if (games >= 10 && Math.abs(edgeValue) >= 3.0 && consistency >= 70) return 'very_significant';
  if (games >= 8 && Math.abs(edgeValue) >= 1.5) return 'significant';
  return 'none';
}

function getConfidence(games: number): ConfidenceLevel {
  if (games >= 20) return 'strong';
  if (games >= 10) return 'moderate';
  if (games >= 5) return 'weak';
  return 'low';
}

// ============================================================================
// Position group override system
// Manual overrides take priority over auto classification
// ============================================================================

export interface PositionOverride {
  id: string;
  player_name: string;
  team: string | null;
  position_group: string;
  confidence: 'high' | 'medium' | 'low';
  source: string;
  updated_at: string;
}

export async function loadPositionOverrides(): Promise<Map<string, PositionOverride>> {
  const { data, error } = await supabase
    .from('player_position_overrides')
    .select('id, player_name, team, position_group, confidence, source, updated_at');

  if (error || !data) return new Map();

  const map = new Map<string, PositionOverride>();
  for (const row of data) {
    const key = `${row.player_name.toLowerCase()}|${(row.team ?? '').toLowerCase()}`;
    map.set(key, row as PositionOverride);
    // Also store name-only key for fallback matching
    map.set(row.player_name.toLowerCase(), row as PositionOverride);
  }
  return map;
}

export async function savePositionOverride(
  playerName: string,
  team: string | null,
  positionGroup: string,
  confidence: 'high' | 'medium' | 'low' = 'high',
  source: string = 'manual'
): Promise<boolean> {
  const { error } = await supabase
    .from('player_position_overrides')
    .upsert({
      player_name: playerName,
      team,
      position_group: positionGroup,
      confidence,
      source,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'player_name,team' });

  return !error;
}

export async function deletePositionOverride(id: string): Promise<boolean> {
  const { error } = await supabase
    .from('player_position_overrides')
    .delete()
    .eq('id', id);
  return !error;
}

export function canonicalizePositionGroup(group: string): string {
  if (POSITION_GROUPS.includes(group as never)) return group;
  if (POSITION_GROUP_ALIASES[group]) return POSITION_GROUP_ALIASES[group];
  return 'UNKNOWN';
}

export function resolvePositionGroup(
  playerId: string | null,
  playerName: string,
  playerTeam: string | null,
  playerPositionGroup: string | null,
  overrides: Map<string, PositionOverride>
): { group: string; source: string; confidence: 'high' | 'medium' | 'low' } {
  // 1. Manual override (highest priority)
  const nameKey = playerName.toLowerCase();
  const teamKey = `${nameKey}|${(playerTeam ?? '').toLowerCase()}`;
  const override = overrides.get(teamKey) ?? overrides.get(nameKey);
  if (override) {
    return { group: override.position_group, source: 'manual', confidence: override.confidence };
  }

  // 2. Existing player.position_group
  if (playerPositionGroup && playerPositionGroup !== 'UNKNOWN') {
    const canonical = canonicalizePositionGroup(playerPositionGroup);
    if (canonical !== 'UNKNOWN') {
      return { group: canonical, source: 'auto_profile', confidence: 'medium' };
    }
  }

  return { group: 'UNKNOWN', source: 'none', confidence: 'low' };
}

export async function autoAssignPositionGroups(): Promise<{ updated: number; skipped: number; checked: number; alreadyMapped: number; stillUnknown: number; errors: number }> {
  // Fetch all player_game_stats with pagination
  const PAGE_SIZE = 1000;
  let from = 0;
  const allStats: any[] = [];

  while (true) {
    const { data, error } = await supabase
      .from('player_game_stats')
      .select('player_id, disposals, marks, tackles, goals, hitouts')
      .range(from, from + PAGE_SIZE - 1);

    if (error || !data || data.length === 0) break;
    allStats.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  if (allStats.length === 0) return { updated: 0, skipped: 0, checked: 0, alreadyMapped: 0, stillUnknown: 0, errors: 0 };

  // Aggregate by player
  const playerAgg = new Map<string, { disp: number; marks: number; tackles: number; goals: number; hitouts: number; games: number }>();
  for (const s of allStats) {
    const pid = s.player_id as string;
    if (!pid) continue;
    const curr = playerAgg.get(pid) ?? { disp: 0, marks: 0, tackles: 0, goals: 0, hitouts: 0, games: 0 };
    curr.disp += Number(s.disposals) || 0;
    curr.marks += Number(s.marks) || 0;
    curr.tackles += Number(s.tackles) || 0;
    curr.goals += Number(s.goals) || 0;
    curr.hitouts += Number(s.hitouts) || 0;
    curr.games++;
    playerAgg.set(pid, curr);
  }

  // Load existing players to check which are already mapped
  const { fetchAllPlayers } = await import('./playerMatching');
  const allPlayers = await fetchAllPlayers();
  const playerMap = new Map<string, { id: string; position_group: string | null }>();
  for (const p of allPlayers) {
    playerMap.set(p.id, { id: p.id, position_group: p.position_group as string | null });
  }

  // Infer position group from stat profile
  const updates: { id: string; position_group: string }[] = [];
  let skipped = 0;
  let checked = 0;
  let alreadyMapped = 0;
  let stillUnknown = 0;
  let errors = 0;

  for (const [pid, agg] of playerAgg) {
    checked++;
    const player = playerMap.get(pid);
    if (player?.position_group && player.position_group !== 'UNKNOWN') {
      alreadyMapped++;
      continue;
    }
    if (agg.games < 3) { skipped++; continue; }
    const avgDisp = agg.disp / agg.games;
    const avgMarks = agg.marks / agg.games;
    const avgTackles = agg.tackles / agg.games;
    const avgGoals = agg.goals / agg.games;
    const avgHitouts = agg.hitouts / agg.games;

    let group = 'UNKNOWN';
    if (avgHitouts >= 10) group = 'RUC-TAP';
    else if (avgHitouts >= 5 && avgDisp < 15) group = 'RUC-FWD';
    else if (avgDisp >= 25 && avgTackles >= 4) group = 'MID-INC';
    else if (avgDisp >= 22 && avgHitouts < 3 && avgTackles >= 3) group = 'MID-OUT';
    else if (avgDisp >= 20 && avgGoals >= 1) group = 'MID-FWD';
    else if (avgDisp >= 18 && avgTackles < 3 && avgHitouts < 3 && avgGoals < 1) group = 'WING';
    else if (avgGoals >= 2 && avgDisp < 18) group = 'FWD-KEY';
    else if (avgGoals >= 1.5 && avgDisp < 15) group = 'FWD-SML';
    else if (avgGoals >= 0.8 && avgDisp < 20) group = 'FWD-GEN';
    else if (avgDisp < 15 && avgTackles >= 3 && avgGoals < 0.5) group = 'DEF-GEN';
    else if (avgDisp < 12 && avgMarks >= 4 && avgGoals < 0.5) group = 'DEF-KEY';
    else if (avgDisp < 18 && avgTackles >= 2 && avgGoals < 0.5) group = 'DEF-USER';
    else if (avgDisp >= 15 && avgGoals < 0.5 && avgTackles < 3) group = 'DEF-USER';

    if (group === 'UNKNOWN') { skipped++; stillUnknown++; continue; }
    updates.push({ id: pid, position_group: group });
  }

  // Only update players where position_group is null or UNKNOWN
  let updated = 0;
  for (const u of updates) {
    const { error } = await supabase
      .from('players')
      .update({ position_group: u.position_group })
      .eq('id', u.id)
      .or('position_group.is.null,position_group.eq.UNKNOWN');
    if (error) errors++;
    else updated++;
  }

  return { updated, skipped, checked, alreadyMapped, stillUnknown, errors };
}

export async function calculatePositionEdges(season?: number): Promise<{ cache: PositionEdgeCache; diagnostics: PositionEdgeDiagnostics }> {
  const currentSeason = season ?? new Date().getFullYear();
  const cache: PositionEdgeCache = {};

  const diagnostics: PositionEdgeDiagnostics = {
    statsRowsFetched: 0,
    rowsWithOpponentColumn: 0,
    rowsWithOpponentFromMatchId: 0,
    rowsWithOpponentFromDateTeam: 0,
    orphanedRows: 0,
    playersFetched: 0,
    mappedPlayers: 0,
    unknownPlayers: 0,
    rowsSkippedUnknown: 0,
    edgesCreated: 0,
    edgesByStatType: {},
    edgesByOpponent: {},
    edgesByPositionGroup: {},
  };

  // Fetch all player_game_stats (not limited to current season — use all available data)
  const { data: stats, error: statsError } = await supabase
    .from('player_game_stats')
    .select('player_id, opponent, match_id, team, match_date, disposals, marks, tackles, goals, hitouts');

  if (statsError || !stats) return { cache, diagnostics };
  diagnostics.statsRowsFetched = stats.length;

  // Fetch players with position_group
  const playerIds = [...new Set(stats.map(s => s.player_id).filter(Boolean))] as string[];
  const { data: players } = await supabase
    .from('players')
    .select('id, position_group, team')
    .in('id', playerIds);

  diagnostics.playersFetched = players?.length ?? 0;

  const playerPositionMap = new Map<string, string>();
  for (const p of players ?? []) {
    const pg = p.position_group ?? 'UNKNOWN';
    playerPositionMap.set(p.id, pg);
    if (pg !== 'UNKNOWN') diagnostics.mappedPlayers++;
    else diagnostics.unknownPlayers++;
  }

  // Fetch matches for opponent detection
  const matchIds = [...new Set(stats.map(s => s.match_id).filter(Boolean))] as string[];
  const matchMap = new Map<string, { home: string; away: string; date: string | null }>();
  if (matchIds.length > 0) {
    const { data: matches } = await supabase
      .from('matches')
      .select('id, home_team, away_team, match_date')
      .in('id', matchIds);
    for (const m of matches ?? []) {
      matchMap.set(m.id, {
        home: normalizeTeamName(m.home_team),
        away: normalizeTeamName(m.away_team),
        date: m.match_date,
      });
    }
  }

  // Also build a date+team index for fallback opponent detection
  const matchesByDateTeam = new Map<string, { home: string; away: string }[]>();
  for (const [, m] of matchMap) {
    if (m.date) {
      const dateKey = m.date.split('T')[0];
      const homeKey = `${dateKey}|${m.home}`;
      const awayKey = `${dateKey}|${m.away}`;
      if (!matchesByDateTeam.has(homeKey)) matchesByDateTeam.set(homeKey, []);
      matchesByDateTeam.get(homeKey)!.push(m);
      if (!matchesByDateTeam.has(awayKey)) matchesByDateTeam.set(awayKey, []);
      matchesByDateTeam.get(awayKey)!.push(m);
    }
  }

  // Determine opponent for each stat row
  const statsWithOpponent: { player_id: string; opponent: string; disposals: number; marks: number; tackles: number; goals: number; hitouts: number; position_group: string }[] = [];

  for (const s of stats) {
    const pid = s.player_id as string;
    const pg = playerPositionMap.get(pid) ?? 'UNKNOWN';

    let opponent: string | null = null;

    // A. Use opponent column if it exists
    if (s.opponent && String(s.opponent).trim()) {
      opponent = normalizeTeamName(s.opponent);
      diagnostics.rowsWithOpponentColumn++;
    }
    // B. Use match_id join
    else if (s.match_id && matchMap.has(s.match_id)) {
      const m = matchMap.get(s.match_id)!;
      const playerTeamNorm = normalizeTeamName(s.team);
      if (playerTeamNorm === m.home) {
        opponent = m.away;
        diagnostics.rowsWithOpponentFromMatchId++;
      } else if (playerTeamNorm === m.away) {
        opponent = m.home;
        diagnostics.rowsWithOpponentFromMatchId++;
      } else {
        // Team doesn't match either side — try date/team fallback
        opponent = null;
      }
    }
    // C. Fallback: match by date + team
    if (!opponent && s.match_date && s.team) {
      const dateKey = s.match_date.split('T')[0];
      const playerTeamNorm = normalizeTeamName(s.team);
      const key = `${dateKey}|${playerTeamNorm}`;
      const matches = matchesByDateTeam.get(key);
      if (matches && matches.length > 0) {
        const m = matches[0];
        if (playerTeamNorm === m.home) {
          opponent = m.away;
          diagnostics.rowsWithOpponentFromDateTeam++;
        } else if (playerTeamNorm === m.away) {
          opponent = m.home;
          diagnostics.rowsWithOpponentFromDateTeam++;
        }
      }
    }

    // D. Orphaned
    if (!opponent) {
      diagnostics.orphanedRows++;
      continue;
    }

    if (pg === 'UNKNOWN') {
      diagnostics.rowsSkippedUnknown++;
      continue;
    }

    statsWithOpponent.push({
      player_id: pid,
      opponent,
      disposals: Number(s.disposals) || 0,
      marks: Number(s.marks) || 0,
      tackles: Number(s.tackles) || 0,
      goals: Number(s.goals) || 0,
      hitouts: Number(s.hitouts) || 0,
      position_group: pg,
    });
  }

  // Calculate league averages per position_group per stat
  const leagueTotals = new Map<string, { total: number; count: number }>();
  for (const statType of BETTING_RELEVANT_STATS) {
    for (const pg of POSITION_GROUPS) {
      leagueTotals.set(`${pg}|${statType}`, { total: 0, count: 0 });
    }
  }

  for (const s of statsWithOpponent) {
    for (const statType of BETTING_RELEVANT_STATS) {
      const col = STAT_COLUMNS[statType];
      const val = s[col as keyof typeof s] as number;
      const key = `${s.position_group}|${statType}`;
      const curr = leagueTotals.get(key) ?? { total: 0, count: 0 };
      leagueTotals.set(key, { total: curr.total + val, count: curr.count + 1 });
    }
  }

  const leagueAverages = new Map<string, number>();
  for (const [key, { total, count }] of leagueTotals) {
    leagueAverages.set(key, count > 0 ? total / count : 0);
  }

  // Aggregate per position_group + opponent + stat_type
  const aggregates = new Map<string, { total: number; count: number; aboveExpected: number }>();

  for (const s of statsWithOpponent) {
    for (const statType of BETTING_RELEVANT_STATS) {
      const col = STAT_COLUMNS[statType];
      const val = s[col as keyof typeof s] as number;
      const key = `${s.position_group}|${s.opponent}|${statType}`;
      const leagueAvg = leagueAverages.get(`${s.position_group}|${statType}`) ?? 0;

      const curr = aggregates.get(key) ?? { total: 0, count: 0, aboveExpected: 0 };
      aggregates.set(key, {
        total: curr.total + val,
        count: curr.count + 1,
        aboveExpected: curr.aboveExpected + (val >= leagueAvg ? 1 : 0),
      });
    }
  }

  // Build cache and diagnostics
  for (const [key, { total, count, aboveExpected }] of aggregates) {
    const [pg, opponent, statType] = key.split('|');
    const avgAgainst = count > 0 ? total / count : 0;
    const leagueAvg = leagueAverages.get(`${pg}|${statType}`) ?? 0;
    const edge = avgAgainst - leagueAvg;
    const consistency = count > 0 ? (aboveExpected / count) * 100 : 0;

    const result: PositionEdgeResult = {
      position_group: pg,
      opponent_team: opponent,
      stat_type: statType as StatType,
      games: count,
      avg_stat_against_opponent: avgAgainst,
      league_avg_for_position: leagueAvg,
      edge_value: edge,
      consistency,
      significance: getSignificance(count, edge, consistency),
      confidence: getConfidence(count),
      data_lens: 'all_data',
    };

    cache[key] = result;
    diagnostics.edgesCreated++;
    diagnostics.edgesByStatType[statType] = (diagnostics.edgesByStatType[statType] ?? 0) + 1;
    diagnostics.edgesByOpponent[opponent] = (diagnostics.edgesByOpponent[opponent] ?? 0) + 1;
    diagnostics.edgesByPositionGroup[pg] = (diagnostics.edgesByPositionGroup[pg] ?? 0) + 1;
  }

  return { cache, diagnostics };
}

export async function loadPositionEdgeCache(): Promise<PositionEdgeCache> {
  const season = new Date().getFullYear();
  // Paginate all rows — don't rely on a single .range() cap
  const PAGE_SIZE = 1000;
  let from = 0;
  const allData: any[] = [];

  while (true) {
    const { data, error } = await supabase
      .from('position_edges')
      .select('*')
      .eq('season', season)
      .range(from, from + PAGE_SIZE - 1);

    if (error) break;
    const page = data ?? [];
    allData.push(...page);
    if (page.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  if (allData.length === 0) {
    // Fallback: calculate on the fly (but don't persist)
    const { cache } = await calculatePositionEdges(season);
    return cache;
  }

  console.log('[PositionEdgeCache] rows loaded', allData.length);

  const cache: PositionEdgeCache = {};
  for (const row of allData) {
    const key = `${row.position_group}|${row.opponent_team}|${row.stat_type}`;
    cache[key] = {
      position_group: row.position_group,
      opponent_team: row.opponent_team,
      stat_type: row.stat_type,
      games: row.games,
      avg_stat_against_opponent: row.avg_stat_against_opponent,
      league_avg_for_position: row.league_avg_for_position,
      edge_value: row.edge_value,
      consistency: row.consistency,
      significance: row.significance,
      confidence: (row.confidence as ConfidenceLevel) ?? getConfidence(row.games),
      data_lens: (row.data_lens as DataLens) ?? 'all_data',
    };
  }

  return cache;
}

export async function savePositionEdges(edges: PositionEdgeCache): Promise<number> {
  const season = new Date().getFullYear();
  const rows = Object.values(edges).map(e => ({
    season,
    position_group: e.position_group,
    opponent_team: e.opponent_team,
    stat_type: e.stat_type,
    games: e.games,
    avg_stat_against_opponent: e.avg_stat_against_opponent,
    league_avg_for_position: e.league_avg_for_position,
    edge_value: e.edge_value,
    consistency: e.consistency,
    significance: e.significance,
    confidence: e.confidence,
    data_lens: e.data_lens,
  }));

  const batchSize = 50;
  let saved = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await supabase
      .from('position_edges')
      .upsert(batch, { onConflict: 'season,position_group,opponent_team,stat_type' });
    if (!error) saved += batch.length;
    if (error) console.error('Error saving position edges batch:', error);
  }
  return saved;
}

export async function createTestEdge(): Promise<void> {
  const season = new Date().getFullYear();
  const { error } = await supabase
    .from('position_edges')
    .upsert({
      season,
      position_group: 'MID-OUT',
      opponent_team: 'Fremantle',
      stat_type: 'disposals',
      games: 20,
      avg_stat_against_opponent: 28.5,
      league_avg_for_position: 24.5,
      edge_value: 4.0,
      consistency: 80,
      significance: 'very_significant',
    }, { onConflict: 'season,position_group,opponent_team,stat_type' });

  if (error) throw new Error(error.message);
}

export async function getPositionEdgeCount(): Promise<number> {
  const season = new Date().getFullYear();
  const { count } = await supabase
    .from('position_edges')
    .select('*', { count: 'exact', head: true })
    .eq('season', season);
  return count ?? 0;
}

export function getPositionEdge(
  cache: PositionEdgeCache,
  positionGroup: string | null,
  opponent: string | null,
  statType: string
): PositionEdgeResult | null {
  const pg = positionGroup ?? 'UNKNOWN';
  const opp = normalizeTeamName(opponent);
  const key = `${pg}|${opp}|${statType}`;
  return cache[key] ?? null;
}

export function formatPositionEdgeLabel(result: PositionEdgeResult | null): string {
  if (!result) return 'Neutral';

  const { edge_value, significance } = result;

  if (edge_value > 0) {
    const prefix = `+${edge_value.toFixed(1)}`;
    if (significance === 'very_significant') return `${prefix} Very Significant Boost`;
    if (significance === 'significant') return `${prefix} Boost`;
    return `${prefix} Slight Boost`;
  } else if (edge_value < 0) {
    const prefix = `${edge_value.toFixed(1)}`;
    if (significance === 'very_significant') return `${prefix} Very Significant Suppress`;
    if (significance === 'significant') return `${prefix} Suppression`;
    return `${prefix} Slight Suppress`;
  }

  return 'Neutral';
}

export function getPositionEdgeColor(result: PositionEdgeResult | null): string {
  if (!result) return 'text-gray-500 bg-gray-500/10 border-gray-600/30';

  const { edge_value, significance } = result;

  if (edge_value > 0) {
    if (significance === 'very_significant') return 'text-emerald-400 bg-emerald-500/15 border-emerald-500/30';
    if (significance === 'significant') return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
    return 'text-emerald-400 bg-emerald-500/5 border-emerald-500/10';
  } else if (edge_value < 0) {
    if (significance === 'very_significant') return 'text-red-400 bg-red-500/15 border-red-500/30';
    if (significance === 'significant') return 'text-red-400 bg-red-500/10 border-red-500/20';
    return 'text-red-400 bg-red-500/5 border-red-500/10';
  }

  return 'text-gray-500 bg-gray-500/10 border-gray-600/30';
}

export function getPositionEdgeAdjustment(
  result: PositionEdgeResult | null,
  positionGroup: string | null
): number {
  if (!result || !positionGroup || positionGroup === 'UNKNOWN') return 0;

  const { significance, edge_value } = result;

  if (edge_value > 0) {
    if (significance === 'very_significant') return 0.04;
    if (significance === 'significant') return 0.02;
  } else if (edge_value < 0) {
    if (significance === 'very_significant') return -0.04;
    if (significance === 'significant') return -0.02;
  }

  return 0;
}

export function capAdjustment(adjustment: number): number {
  return Math.max(-0.05, Math.min(0.05, adjustment));
}

export function computeFinalProbability(
  adjustedProb: number | null,
  adjustment: number
): number | null {
  if (adjustedProb === null) return null;
  return Math.max(0.01, Math.min(0.99, adjustedProb + adjustment));
}

export function computeFinalEV(
  finalProb: number | null,
  odds: number
): number | null {
  if (finalProb === null) return null;
  return finalProb * odds - 1;
}

export function getPositionEdgeQualityAdjustment(
  result: PositionEdgeResult | null,
  positionGroup: string | null
): number {
  if (!result || !positionGroup || positionGroup === 'UNKNOWN') return 0;

  const { significance, edge_value } = result;

  if (edge_value > 0) {
    if (significance === 'very_significant') return 5;
    if (significance === 'significant') return 3;
  } else if (edge_value < 0) {
    if (significance === 'very_significant') return -5;
    if (significance === 'significant') return -3;
  }

  return 0;
}

export function formatPositionEdgeShortLabel(
  result: PositionEdgeResult | null,
  positionGroup: string | null
): string {
  if (!result || !positionGroup || positionGroup === 'UNKNOWN') {
    return 'No Position Group';
  }

  const { edge_value, significance, opponent_team } = result;
  const prefix = edge_value > 0 ? `+${edge_value.toFixed(1)}` : edge_value.toFixed(1);

  if (edge_value > 0) {
    if (significance === 'very_significant') return `${positionGroup} vs ${opponent_team}: ${prefix} Very Significant Boost`;
    if (significance === 'significant') return `${positionGroup} vs ${opponent_team}: ${prefix} Significant Boost`;
    return `${positionGroup} vs ${opponent_team}: ${prefix} Slight Boost`;
  } else if (edge_value < 0) {
    if (significance === 'very_significant') return `${positionGroup} vs ${opponent_team}: ${prefix} Very Significant Suppression`;
    if (significance === 'significant') return `${positionGroup} vs ${opponent_team}: ${prefix} Significant Suppression`;
    return `${positionGroup} vs ${opponent_team}: ${prefix} Slight Suppression`;
  }

  return `${positionGroup} vs ${opponent_team}: Neutral`;
}

// ============================================================================
// Venue Edge
// ============================================================================

export interface VenueEdgeResult {
  player_id: string;
  stat_type: StatType;
  venue: string;
  sample_size: number;
  player_avg_at_venue: number;
  player_overall_avg: number;
  edge_value: number;
  label: 'none' | 'venue_boost' | 'venue_suppression' | 'strong_venue_boost' | 'strong_venue_suppression' | 'small_sample';
}

export interface VenueEdgeCache {
  [key: string]: VenueEdgeResult;
}

/**
 * Normalize a venue name for matching.
 * This is duplicated from playerMatching to avoid circular imports.
 */
function normalizeVenueName(venue: string | null | undefined): string {
  if (!venue) return '';
  return venue
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function getVenueEdge(
  cache: VenueEdgeCache,
  playerId: string | null,
  statType: string,
  venue: string | null
): VenueEdgeResult | null {
  if (!playerId || !venue) return null;

  // First try exact match
  const key = `${playerId}|${statType}|${venue}`;
  if (cache[key]) return cache[key];

  // Then try normalized venue match (scan cache for matching normalized venue)
  const targetVenueNorm = normalizeVenueName(venue);
  for (const [cacheKey, result] of Object.entries(cache)) {
    if (result.player_id === playerId && result.stat_type === statType) {
      const cacheVenueNorm = normalizeVenueName(result.venue);
      if (cacheVenueNorm === targetVenueNorm) {
        return result;
      }
    }
  }

  return null;
}

export function getVenueEdgeAdjustment(result: VenueEdgeResult | null): number {
  if (!result) return 0;
  switch (result.label) {
    case 'strong_venue_boost': return 0.02;
    case 'venue_boost': return 0.01;
    case 'venue_suppression': return -0.01;
    case 'strong_venue_suppression': return -0.02;
    default: return 0;
  }
}

export function capVenueAdjustment(adj: number): number {
  return Math.max(-0.02, Math.min(0.02, adj));
}

export function formatVenueEdgeLabel(result: VenueEdgeResult | null): string {
  if (!result) return 'No Venue Data';
  if (result.label === 'small_sample') return `Small Venue Sample (${result.sample_size}g)`;
  const sign = result.edge_value > 0 ? '+' : '';
  const val = `${sign}${result.edge_value.toFixed(1)}`;
  switch (result.label) {
    case 'strong_venue_boost': return `${val} Strong Venue Boost (${result.sample_size}g)`;
    case 'venue_boost': return `${val} Venue Boost (${result.sample_size}g)`;
    case 'venue_suppression': return `${val} Venue Suppression (${result.sample_size}g)`;
    case 'strong_venue_suppression': return `${val} Strong Venue Suppression (${result.sample_size}g)`;
    default: return `${val} Neutral (${result.sample_size}g)`;
  }
}

export function getVenueEdgeColor(result: VenueEdgeResult | null): string {
  if (!result) return 'text-gray-500 bg-gray-500/10 border-gray-600/30';
  switch (result.label) {
    case 'strong_venue_boost': return 'text-emerald-400 bg-emerald-500/15 border-emerald-500/30';
    case 'venue_boost': return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
    case 'strong_venue_suppression': return 'text-red-400 bg-red-500/15 border-red-500/30';
    case 'venue_suppression': return 'text-red-400 bg-red-500/10 border-red-500/20';
    default: return 'text-gray-500 bg-gray-500/10 border-gray-600/30';
  }
}

// ============================================================================
// Player vs Opponent Edge
// ============================================================================

export interface OpponentEdgeResult {
  player_id: string;
  stat_type: StatType;
  opponent: string;
  sample_size: number;
  player_avg_vs_opponent: number;
  player_overall_avg: number;
  edge_value: number;
  label: 'none' | 'opp_boost' | 'opp_suppression' | 'strong_opp_boost' | 'strong_opp_suppression' | 'small_sample';
}

export interface OpponentEdgeCache {
  [key: string]: OpponentEdgeResult;
}

export function getOpponentEdge(
  cache: OpponentEdgeCache,
  playerId: string | null,
  statType: string,
  opponent: string | null
): OpponentEdgeResult | null {
  if (!playerId || !opponent) return null;

  const oppNorm = normalizeTeamName(opponent);

  // First try exact match with normalized opponent
  const key = `${playerId}|${statType}|${oppNorm}`;
  if (cache[key]) return cache[key];

  // Then try scanning cache for matching normalized opponent
  for (const [cacheKey, result] of Object.entries(cache)) {
    if (result.player_id === playerId && result.stat_type === statType) {
      const cacheOppNorm = normalizeTeamName(result.opponent);
      if (cacheOppNorm === oppNorm) {
        return result;
      }
    }
  }

  return null;
}

export function getOpponentEdgeAdjustment(result: OpponentEdgeResult | null): number {
  if (!result) return 0;
  switch (result.label) {
    case 'strong_opp_boost': return 0.02;
    case 'opp_boost': return 0.01;
    case 'opp_suppression': return -0.01;
    case 'strong_opp_suppression': return -0.02;
    default: return 0;
  }
}

export function capOpponentAdjustment(adj: number): number {
  return Math.max(-0.02, Math.min(0.02, adj));
}

export function formatOpponentEdgeLabel(result: OpponentEdgeResult | null): string {
  if (!result) return 'No Opp Data';
  if (result.label === 'small_sample') return `Small Opp Sample (${result.sample_size}g)`;
  const sign = result.edge_value > 0 ? '+' : '';
  const val = `${sign}${result.edge_value.toFixed(1)}`;
  switch (result.label) {
    case 'strong_opp_boost': return `${val} Strong Opp Boost vs ${result.opponent} (${result.sample_size}g)`;
    case 'opp_boost': return `${val} Opp Boost vs ${result.opponent} (${result.sample_size}g)`;
    case 'opp_suppression': return `${val} Opp Suppression vs ${result.opponent} (${result.sample_size}g)`;
    case 'strong_opp_suppression': return `${val} Strong Opp Suppression vs ${result.opponent} (${result.sample_size}g)`;
    default: return `${val} Neutral vs ${result.opponent} (${result.sample_size}g)`;
  }
}

export function getOpponentEdgeColor(result: OpponentEdgeResult | null): string {
  if (!result) return 'text-gray-500 bg-gray-500/10 border-gray-600/30';
  switch (result.label) {
    case 'strong_opp_boost': return 'text-emerald-400 bg-emerald-500/15 border-emerald-500/30';
    case 'opp_boost': return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
    case 'strong_opp_suppression': return 'text-red-400 bg-red-500/15 border-red-500/30';
    case 'opp_suppression': return 'text-red-400 bg-red-500/10 border-red-500/20';
    default: return 'text-gray-500 bg-gray-500/10 border-gray-600/30';
  }
}

// ============================================================================
// Combined Matchup Adjustment
// ============================================================================

export function computeTotalMatchupAdjustment(
  posAdj: number,
  venueAdj: number,
  oppAdj: number
): number {
  return Math.max(-0.07, Math.min(0.07, posAdj + venueAdj + oppAdj));
}

export { AFL_TEAMS, POSITION_GROUPS };
