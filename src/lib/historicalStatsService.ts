import { supabase } from './supabase';
import { normalizeTeamName, type StatType, type VenueEdgeResult, type OpponentEdgeResult } from './positionEdge';
import { normalizeVenueKey } from './matchupEdge';

export const STAT_COLUMNS: Record<string, string> = {
  disposals: 'disposals',
  goals: 'goals',
  tackles: 'tackles',
  marks: 'marks',
  hitouts: 'hitouts',
};

export const BETTING_STATS: StatType[] = ['disposals', 'marks', 'tackles', 'goals', 'hitouts'];

export interface HistoricalStatRow {
  player_id: string;
  match_date: string | null;
  match_id: string | null;
  team: string | null;
  opponent: string | null;
  venue: string | null;
  disposals: number | null;
  marks: number | null;
  tackles: number | null;
  goals: number | null;
  hitouts: number | null;
  match_venue?: string | null;
  match_home_team?: string | null;
  match_away_team?: string | null;
  match_season?: number | null;
  match_round?: string | null;
}

export interface HistoricalStatsCache {
  // player_id|stat_type -> non-null values[] sorted newest-first, capped at 40
  byPlayerStat: Map<string, number[]>;
  // player_id|stat_type|season -> non-null values[] for that season
  byPlayerStatSeason: Map<string, number[]>;
  // player_id -> all deduped rows sorted newest-first
  rawByPlayerId: Map<string, HistoricalStatRow[]>;
  allRows: HistoricalStatRow[];
  playerIds: Set<string>;
}

export interface HistoricalStatsDiagnostics {
  playerIdsQueried: number;
  rowsFetched: number;
  statsQueryPages: number;
  rowsWithVenue: number;
  rowsWithOpponent: number;
  uniqueVenues: Set<string>;
  uniqueOpponents: Set<string>;
}

interface VenueEdgeFromCacheResult {
  venueSamplesCreated: number;
  rowsWithVenueSample3Plus: number;
  rowsWithNonZeroVenueAdjustment: number;
}

interface OpponentEdgeFromCacheResult {
  opponentSamplesCreated: number;
  rowsWithOpponentSample3Plus: number;
  rowsWithNonZeroOpponentAdjustment: number;
}

function statCompleteness(r: any): number {
  return ['disposals', 'marks', 'tackles', 'goals', 'hitouts']
    .filter(col => r[col] !== null && r[col] !== undefined).length;
}

/**
 * Fetch all historical stats rows for the given player IDs.
 * Dedup is per (player_id, match_id) — NOT global — so all players keep their rows.
 * Null stat values are preserved as null; they are excluded from byPlayerStat arrays.
 */
export async function loadHistoricalStatsForPlayers(
  playerIds: string[],
  _returnDiagnostics: boolean = false
): Promise<{ cache: HistoricalStatsCache; diagnostics: HistoricalStatsDiagnostics }> {
  const diagnostics: HistoricalStatsDiagnostics = {
    playerIdsQueried: playerIds.length,
    rowsFetched: 0,
    statsQueryPages: 0,
    rowsWithVenue: 0,
    rowsWithOpponent: 0,
    uniqueVenues: new Set(),
    uniqueOpponents: new Set(),
  };

  // Resolve all player IDs including legacy/duplicate IDs for the same names
  const { loadAllPlayers, normalizeFullName } = await import('./canonicalPlayerService');
  const { byId, byNormName } = await loadAllPlayers();
  const allIdsSet = new Set<string>(playerIds);
  for (const pid of playerIds) {
    const player = byId.get(pid);
    if (player) {
      const norm = normalizeFullName(player.name);
      const duplicates = byNormName.get(norm) ?? [];
      for (const d of duplicates) {
        allIdsSet.add(d.id);
      }
    }
  }
  const allPlayerIds = [...allIdsSet];

  const empty: HistoricalStatsCache = {
    byPlayerStat: new Map(),
    byPlayerStatSeason: new Map(),
    rawByPlayerId: new Map(),
    allRows: [],
    playerIds: new Set(playerIds),
  };

  if (playerIds.length === 0) return { cache: empty, diagnostics };

  console.log('[historicalStats] loading stats for', playerIds.length, 'players');

  const allStats: any[] = [];
  const pageSize = 1000;
  let page = 0;
  let hasMore = true;

  while (hasMore) {
    const { data: pageData, error } = await supabase
      .from('player_game_stats')
      .select(`
        player_id,
        match_id,
        match_date,
        team,
        opponent,
        venue,
        disposals,
        marks,
        tackles,
        goals,
        hitouts,
        matches:match_id (
          season,
          round,
          venue,
          home_team,
          away_team
        )
      `)
      .in('player_id', allPlayerIds)
      .not('match_date', 'is', null)
      .lte('match_date', new Date().toISOString().slice(0, 10))
      .order('match_date', { ascending: false })
      .range(page * pageSize, (page + 1) * pageSize - 1);

    if (error) {
      console.error('[historicalStats] error on page', page, error.message);
      break;
    }
    if (pageData && pageData.length > 0) {
      allStats.push(...pageData);
      hasMore = pageData.length === pageSize;
      page++;
    } else {
      hasMore = false;
    }
  }

  diagnostics.statsQueryPages = page;
  diagnostics.rowsFetched = allStats.length;
  console.log('[historicalStats] fetched', allStats.length, 'rows across', page, 'pages');

  if (allStats.length === 0) return { cache: empty, diagnostics };

  // Dedup per (player_id, match_id) — keep the row with more non-null stat columns
  const dedupPerPlayer = new Map<string, Map<string, any>>(); // pid -> matchId -> best row
  const dedupByDateTeam = new Map<string, Map<string, any>>(); // pid -> date|team -> best row

  for (const s of allStats) {
    const pid = s.player_id as string;
    if (!pid) continue;

    if (s.match_id) {
      if (!dedupPerPlayer.has(pid)) dedupPerPlayer.set(pid, new Map());
      const pMap = dedupPerPlayer.get(pid)!;
      const existing = pMap.get(s.match_id);
      if (!existing || statCompleteness(s) > statCompleteness(existing)) {
        pMap.set(s.match_id, s);
      }
    } else if (s.match_date && s.team) {
      const key = `${s.match_date}|${s.team}`;
      if (!dedupByDateTeam.has(pid)) dedupByDateTeam.set(pid, new Map());
      const pMap = dedupByDateTeam.get(pid)!;
      const existing = pMap.get(key);
      if (!existing || statCompleteness(s) > statCompleteness(existing)) {
        pMap.set(key, s);
      }
    }
  }

  const rawByPlayerId = new Map<string, HistoricalStatRow[]>();
  const allRows: HistoricalStatRow[] = [];

  for (const pid of playerIds) {
    // Gather stats from this player_id AND all legacy/duplicate IDs for the same name
    const idsToCheck = new Set<string>([pid]);
    const player = byId.get(pid);
    if (player) {
      const norm = normalizeFullName(player.name);
      const duplicates = byNormName.get(norm) ?? [];
      for (const d of duplicates) idsToCheck.add(d.id);
    }
    const fromMatchId: any[] = [];
    const fromDateTeam: any[] = [];
    for (const checkId of idsToCheck) {
      for (const row of (dedupPerPlayer.get(checkId)?.values() ?? [])) fromMatchId.push(row);
      for (const row of (dedupByDateTeam.get(checkId)?.values() ?? [])) fromDateTeam.push(row);
    }
    // Deduplicate across IDs by player_id + match_id — NOT match_id alone.
    // Two different players can share a match_id; only the same player's
    // legacy/duplicate IDs should collapse.
    const seenPlayerMatch = new Set<string>();
    const dedupedMatch = fromMatchId.filter(r => {
      const key = `${r.player_id}|${r.match_id}`;
      if (r.match_id && seenPlayerMatch.has(key)) return false;
      if (r.match_id) seenPlayerMatch.add(key);
      return true;
    });
    const combined = [...dedupedMatch, ...fromDateTeam];

    // Sort newest-first: date DESC, round DESC as fallback
    combined.sort((a, b) => {
      const dateDiff = new Date(b.match_date ?? '').getTime() - new Date(a.match_date ?? '').getTime();
      if (dateDiff !== 0) return dateDiff;
      return Number(b.match_round ?? 0) - Number(a.match_round ?? 0);
    });

    const playerRows: HistoricalStatRow[] = [];

    for (const s of combined) {
      const mi = (s as any).matches;
      const row: HistoricalStatRow = {
        player_id: pid,
        match_date: s.match_date,
        match_id: s.match_id,
        team: s.team,
        opponent: s.opponent,
        venue: s.venue || mi?.venue || null,
        // Preserve null — never coerce null to 0
        disposals: s.disposals !== null && s.disposals !== undefined ? Number(s.disposals) : null,
        marks: s.marks !== null && s.marks !== undefined ? Number(s.marks) : null,
        tackles: s.tackles !== null && s.tackles !== undefined ? Number(s.tackles) : null,
        goals: s.goals !== null && s.goals !== undefined ? Number(s.goals) : null,
        hitouts: s.hitouts !== null && s.hitouts !== undefined ? Number(s.hitouts) : null,
        match_venue: mi?.venue ?? null,
        match_home_team: mi?.home_team ?? null,
        match_away_team: mi?.away_team ?? null,
        match_season: mi?.season ?? null,
        match_round: mi?.round ?? null,
      };

      // Resolve opponent from match if missing
      if (!row.opponent && row.team && mi) {
        const tNorm = normalizeTeamName(row.team);
        const hNorm = normalizeTeamName(mi.home_team || '');
        const aNorm = normalizeTeamName(mi.away_team || '');
        if (tNorm === hNorm) row.opponent = mi.away_team;
        else if (tNorm === aNorm) row.opponent = mi.home_team;
      }

      if (row.venue) {
        diagnostics.rowsWithVenue++;
        diagnostics.uniqueVenues.add(normalizeVenueKey(row.venue));
      }
      if (row.opponent) {
        diagnostics.rowsWithOpponent++;
        diagnostics.uniqueOpponents.add(normalizeTeamName(row.opponent));
      }

      playerRows.push(row);
      allRows.push(row);
    }

    if (playerRows.length > 0) rawByPlayerId.set(pid, playerRows);
  }

  // byPlayerStat: player_id|stat_type -> non-null values[], newest-first, capped at 40.
  // Values are the actual non-null stat numbers. Null game rows are skipped entirely.
  const byPlayerStat = new Map<string, number[]>();
  for (const [pid, playerRows] of rawByPlayerId) {
    for (const statType of BETTING_STATS) {
      const col = STAT_COLUMNS[statType];
      const key = `${pid}|${statType}`;
      const arr: number[] = [];
      for (const row of playerRows) {
        if (arr.length >= 40) break;
        const raw = row[col as keyof HistoricalStatRow];
        if (raw !== null && raw !== undefined && Number.isFinite(Number(raw))) {
          arr.push(Number(raw));
        }
        // null values are skipped — they don't count as sample, don't count as miss
      }
      if (arr.length > 0) byPlayerStat.set(key, arr);
    }
  }

  // byPlayerStatSeason: player_id|stat_type|season -> non-null values[]
  const byPlayerStatSeason = new Map<string, number[]>();
  for (const [pid, playerRows] of rawByPlayerId) {
    for (const statType of BETTING_STATS) {
      const col = STAT_COLUMNS[statType];
      for (const row of playerRows) {
        const raw = row[col as keyof HistoricalStatRow];
        if (raw === null || raw === undefined || !Number.isFinite(Number(raw))) continue;
        const season = row.match_season ?? (row.match_date ? Number(row.match_date.slice(0, 4)) : null);
        if (!season) continue;
        const key = `${pid}|${statType}|${season}`;
        if (!byPlayerStatSeason.has(key)) byPlayerStatSeason.set(key, []);
        byPlayerStatSeason.get(key)!.push(Number(raw));
      }
    }
  }

  console.log('[historicalStats] cache built:', {
    players: rawByPlayerId.size,
    totalRows: allRows.length,
    byPlayerStatKeys: byPlayerStat.size,
  });

  return {
    cache: {
      byPlayerStat,
      byPlayerStatSeason,
      rawByPlayerId,
      allRows,
      playerIds: new Set(playerIds),
    },
    diagnostics,
  };
}

export function getVenueEdgeFromCache(
  cache: HistoricalStatsCache,
  playerId: string,
  statType: StatType,
  targetVenue: string
): { result: VenueEdgeResult | null; diagnostics: VenueEdgeFromCacheResult } {
  const diagnostics: VenueEdgeFromCacheResult = {
    venueSamplesCreated: 0,
    rowsWithVenueSample3Plus: 0,
    rowsWithNonZeroVenueAdjustment: 0,
  };

  const targetVenueNorm = normalizeVenueKey(targetVenue);
  const rows = cache.rawByPlayerId.get(playerId) || [];

  if (rows.length === 0 || !targetVenue) return { result: null, diagnostics };

  const col = STAT_COLUMNS[statType];
  let overallTotal = 0, overallCount = 0, venueTotal = 0, venueCount = 0;

  for (const row of rows) {
    const raw = row[col as keyof HistoricalStatRow];
    if (raw === null || raw === undefined || !Number.isFinite(Number(raw))) continue;
    const val = Number(raw);
    overallTotal += val;
    overallCount++;
    const rowVenueNorm = normalizeVenueKey(row.venue ?? '');
    if (rowVenueNorm === targetVenueNorm) { venueTotal += val; venueCount++; }
  }

  diagnostics.venueSamplesCreated = venueCount;
  if (venueCount < 1 || overallCount < 1) return { result: null, diagnostics };
  if (venueCount >= 3) diagnostics.rowsWithVenueSample3Plus++;

  const playerAvgAtVenue = venueTotal / venueCount;
  const playerOverallAvg = overallTotal / overallCount;
  const edge = playerAvgAtVenue - playerOverallAvg;

  if (Math.abs(edge) >= 1.5) diagnostics.rowsWithNonZeroVenueAdjustment++;

  const getLabel = (s: number, e: number): VenueEdgeResult['label'] => {
    if (s < 3) return 'small_sample';
    if (s >= 5 && e >= 3.0) return 'strong_venue_boost';
    if (s >= 5 && e <= -3.0) return 'strong_venue_suppression';
    if (s >= 3 && e >= 1.5) return 'venue_boost';
    if (s >= 3 && e <= -1.5) return 'venue_suppression';
    return 'none';
  };

  return {
    result: {
      player_id: playerId,
      stat_type: statType,
      venue: targetVenue,
      sample_size: venueCount,
      player_avg_at_venue: playerAvgAtVenue,
      player_overall_avg: playerOverallAvg,
      edge_value: edge,
      label: getLabel(venueCount, edge),
    },
    diagnostics,
  };
}

export function getOpponentEdgeFromCache(
  cache: HistoricalStatsCache,
  playerId: string,
  statType: StatType,
  playerTeam: string | null,
  homeTeam: string,
  awayTeam: string
): { result: OpponentEdgeResult | null; diagnostics: OpponentEdgeFromCacheResult } {
  const diagnostics: OpponentEdgeFromCacheResult = {
    opponentSamplesCreated: 0,
    rowsWithOpponentSample3Plus: 0,
    rowsWithNonZeroOpponentAdjustment: 0,
  };

  const playerTeamNorm = normalizeTeamName(playerTeam || '');
  const homeNorm = normalizeTeamName(homeTeam);
  const awayNorm = normalizeTeamName(awayTeam);

  let targetOpponent: string | null = null;
  if (playerTeamNorm === homeNorm) targetOpponent = awayTeam;
  else if (playerTeamNorm === awayNorm) targetOpponent = homeTeam;
  else return { result: null, diagnostics };

  const targetOppNorm = normalizeTeamName(targetOpponent);
  const rows = cache.rawByPlayerId.get(playerId) || [];

  if (rows.length === 0) return { result: null, diagnostics };

  const col = STAT_COLUMNS[statType];
  let overallTotal = 0, overallCount = 0, oppTotal = 0, oppCount = 0;

  for (const row of rows) {
    const raw = row[col as keyof HistoricalStatRow];
    if (raw === null || raw === undefined || !Number.isFinite(Number(raw))) continue;
    const val = Number(raw);
    overallTotal += val;
    overallCount++;
    const rowOppNorm = normalizeTeamName(row.opponent ?? '');
    if (rowOppNorm === targetOppNorm) { oppTotal += val; oppCount++; }
  }

  diagnostics.opponentSamplesCreated = oppCount;
  if (oppCount < 1 || overallCount < 1) return { result: null, diagnostics };
  if (oppCount >= 3) diagnostics.rowsWithOpponentSample3Plus++;

  const playerAvgVsOpponent = oppTotal / oppCount;
  const playerOverallAvg = overallTotal / overallCount;
  const edge = playerAvgVsOpponent - playerOverallAvg;

  if (Math.abs(edge) >= 1.5) diagnostics.rowsWithNonZeroOpponentAdjustment++;

  const getLabel = (s: number, e: number): OpponentEdgeResult['label'] => {
    if (s < 3) return 'small_sample';
    if (s >= 5 && e >= 3.0) return 'strong_opp_boost';
    if (s >= 5 && e <= -3.0) return 'strong_opp_suppression';
    if (s >= 3 && e >= 1.5) return 'opp_boost';
    if (s >= 3 && e <= -1.5) return 'opp_suppression';
    return 'none';
  };

  return {
    result: {
      player_id: playerId,
      stat_type: statType,
      opponent: targetOpponent,
      sample_size: oppCount,
      player_avg_vs_opponent: playerAvgVsOpponent,
      player_overall_avg: playerOverallAvg,
      edge_value: edge,
      label: getLabel(oppCount, edge),
    },
    diagnostics,
  };
}

export function getValuesForPlayerStat(
  cache: HistoricalStatsCache,
  playerId: string,
  statType: string
): number[] {
  return cache.byPlayerStat.get(`${playerId}|${statType}`) || [];
}

export function getSeasonValuesForPlayerStat(
  cache: HistoricalStatsCache,
  playerId: string,
  statType: string,
  season: number
): number[] {
  return cache.byPlayerStatSeason.get(`${playerId}|${statType}|${season}`) || [];
}

export function inferCurrentSeason(matchSeason?: number | null): number {
  if (matchSeason) return matchSeason;
  return new Date().getFullYear();
}

export type FreshnessStatus =
  | 'CURRENT'
  | 'STALE'
  | 'PARTICIPATION_UNKNOWN'
  | 'NO_HISTORY'
  | 'IDENTITY_UNRESOLVED';

export interface PlayerFreshness {
  canonicalPlayerId: string | null;
  confirmedPlayerIds: string[];
  historicalMatchCount: number;
  latestMatchDate: string | null;
  latestRound: number | null;
  latestDisposals: number | null;
  latestFiveValues: number[];
  latestTenValues: number[];
  // Backward-compatible aliases
  latestFiveDisposals: number[];
  latestTenDisposals: number[];
  freshnessStatus: FreshnessStatus;
}

/**
 * Compute freshness for a player from the historical stats cache.
 * `latestCompletedStatsRound` is the most recent round where all matches have been played
 * and stats have been synced (e.g. 18). If a player's latest stats are from that round,
 * they are CURRENT. If their latest is from an earlier round, they are STALE.
 */
export function computePlayerFreshness(
  cache: HistoricalStatsCache,
  resolvedPlayerId: string | null,
  allIds: string[],
  latestCompletedStatsRound: number | null,
): PlayerFreshness {
  if (!resolvedPlayerId || allIds.length === 0) {
    return {
      canonicalPlayerId: null,
      confirmedPlayerIds: [],
      historicalMatchCount: 0,
      latestMatchDate: null,
      latestRound: null,
      latestDisposals: null,
      latestFiveValues: [],
      latestTenValues: [],
      latestFiveDisposals: [],
      latestTenDisposals: [],
      freshnessStatus: 'IDENTITY_UNRESOLVED',
    };
  }

  // Gather all rows across confirmed canonical and legacy IDs.
  // Deduplicate by player_id + match_id so rows from different players
  // sharing the same match_id are NOT merged.
  const seenPlayerMatch = new Set<string>();
  const allRows: HistoricalStatRow[] = [];
  for (const pid of allIds) {
    const rows = cache.rawByPlayerId.get(pid) ?? [];
    for (const r of rows) {
      const key = `${r.player_id}|${r.match_id}`;
      if (seenPlayerMatch.has(key)) continue;
      seenPlayerMatch.add(key);
      allRows.push(r);
    }
  }

  // Sort newest first: date DESC, round DESC as fallback
  allRows.sort((a, b) => {
    const dateDiff = new Date(b.match_date ?? '').getTime() - new Date(a.match_date ?? '').getTime();
    if (dateDiff !== 0) return dateDiff;
    return Number(b.match_round ?? 0) - Number(a.match_round ?? 0);
  });

  if (allRows.length === 0) {
    return {
      canonicalPlayerId: resolvedPlayerId,
      confirmedPlayerIds: allIds,
      historicalMatchCount: 0,
      latestMatchDate: null,
      latestRound: null,
      latestDisposals: null,
      latestFiveValues: [],
      latestTenValues: [],
      latestFiveDisposals: [],
      latestTenDisposals: [],
      freshnessStatus: 'NO_HISTORY',
    };
  }

  const latest = allRows[0];
  const latestRound = latest.match_round ? parseInt(latest.match_round, 10) : null;

  // Extract disposal values (non-null only), newest first
  const disposalRows = allRows.filter(r => r.disposals !== null && r.disposals !== undefined);
  const disposalValues = disposalRows.map(r => r.disposals as number);
  const latestFiveValues = disposalValues.slice(0, 5);
  const latestTenValues = disposalValues.slice(0, 10);

  // Determine freshness
  let status: FreshnessStatus;
  if (latestCompletedStatsRound !== null && latestRound !== null) {
    if (latestRound >= latestCompletedStatsRound) {
      status = 'CURRENT';
    } else {
      status = 'STALE';
    }
  } else {
    status = 'PARTICIPATION_UNKNOWN';
  }

  return {
    canonicalPlayerId: resolvedPlayerId,
    confirmedPlayerIds: allIds,
    historicalMatchCount: allRows.length,
    latestMatchDate: latest.match_date ?? null,
    latestRound,
    latestDisposals: latest.disposals ?? null,
    latestFiveValues,
    latestTenValues,
    latestFiveDisposals: latestFiveValues,
    latestTenDisposals: latestTenValues,
    freshnessStatus: status,
  };
}
