import { supabase } from './supabase';
import { normalizeTeamName } from './positionEdge';
import { fetchAllRows } from './supabasePagination';

export interface StatsSyncDiagnostics {
  latestCompletedRound: string | null;
  latestCompletedMatchDate: string | null;
  latestStatRound: string | null;
  latestStatDate: string | null;
  missingRounds: string[];
  missingMatches: { round: string; home_team: string; away_team: string; match_date: string }[];
  missingTeams: string[];
  missingPlayerStatRows: number;
  totalRowsImported: number;
  totalRowsUpdated: number;
  totalRowsSkipped: number;
  failedRows: number;
  errors: string[];
}

export interface BackfillDiagnostics {
  season: number;
  roundsChecked: string[];
  matchesFound: number;
  matchesMissingStats: number;
  playersWithOdds: number;
  playersMissingStats: number;
  rowsToBackfill: number;
  rowsImported: number;
  rowsUpdated: number;
  rowsSkipped: number;
  failedRows: number;
  errors: string[];
  perRound: { round: string; matches: number; missingStats: number }[];
}

export interface StatsImportValidation {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  failedRows: number;
  errors: { row: number; message: string }[];
  inserted: number;
  updated: number;
  skipped: number;
  duplicates: number;
  latestRoundImported: string | null;
}

/**
 * Get the latest completed AFL round for a season
 */
export async function getLatestCompletedRoundInfo(season: number): Promise<{ round: string | null; matchDate: string | null }> {
  const { data } = await supabase
    .from('matches')
    .select('round, match_date')
    .eq('season', season)
    .lt('match_date', new Date().toISOString().split('T')[0])
    .order('match_date', { ascending: false })
    .limit(1);
  if (data && data.length > 0) {
    return { round: data[0].round, matchDate: data[0].match_date };
  }
  return { round: null, matchDate: null };
}

/**
 * Get the latest round currently represented in player_game_stats
 */
export async function getLatestStatRound(): Promise<{ round: string | null; matchDate: string | null }> {
  const { data: stats } = await supabase
    .from('player_game_stats')
    .select('match_id, match_date')
    .order('match_date', { ascending: false })
    .limit(1);

  if (!stats || stats.length === 0) return { round: null, matchDate: null };

  const latestStat = stats[0];
  if (latestStat.match_id) {
    const { data: match } = await supabase
      .from('matches')
      .select('round, match_date')
      .eq('id', latestStat.match_id)
      .maybeSingle();
    if (match) return { round: match.round, matchDate: match.match_date };
  }
  return { round: null, matchDate: latestStat.match_date };
}

/**
 * Dry run: check what's missing without importing anything
 */
export async function dryRunStatsCheck(season: number): Promise<StatsSyncDiagnostics> {
  const diagnostics: StatsSyncDiagnostics = {
    latestCompletedRound: null,
    latestCompletedMatchDate: null,
    latestStatRound: null,
    latestStatDate: null,
    missingRounds: [],
    missingMatches: [],
    missingTeams: [],
    missingPlayerStatRows: 0,
    totalRowsImported: 0,
    totalRowsUpdated: 0,
    totalRowsSkipped: 0,
    failedRows: 0,
    errors: [],
  };

  const { round: latestCompletedRound, matchDate: latestCompletedMatchDate } = await getLatestCompletedRoundInfo(season);
  diagnostics.latestCompletedRound = latestCompletedRound;
  diagnostics.latestCompletedMatchDate = latestCompletedMatchDate;

  const { round: latestStatRound, matchDate: latestStatDate } = await getLatestStatRound();
  diagnostics.latestStatRound = latestStatRound;
  diagnostics.latestStatDate = latestStatDate;

  // Get all completed matches for the season
  const { data: completedMatches } = await supabase
    .from('matches')
    .select('id, round, home_team, away_team, match_date, venue, season')
    .eq('season', season)
    .lt('match_date', new Date().toISOString().split('T')[0])
    .order('match_date', { ascending: true });

  if (!completedMatches || completedMatches.length === 0) {
    diagnostics.errors.push('No completed matches found for this season');
    return diagnostics;
  }

  // Get all match_ids that have player_game_stats. Fully paginated — an
  // unpaginated select here was silently capped at Supabase's 1000-row
  // default, falsely reporting matches that actually have stats as missing.
  const existingStats = await fetchAllRows<{ match_id: string | null }>(
    supabase, 'player_game_stats', 'match_id', (q) => q.not('match_id', 'is', null),
  );

  const matchesWithStats = new Set<string>();
  for (const s of existingStats) {
    if (s.match_id) matchesWithStats.add(s.match_id);
  }

  // Find missing matches
  const missingMatches: StatsSyncDiagnostics['missingMatches'] = [];
  const missingRoundsSet = new Set<string>();
  const missingTeamsSet = new Set<string>();

  for (const m of completedMatches) {
    if (!matchesWithStats.has(m.id)) {
      missingMatches.push({
        round: m.round ?? '?',
        home_team: m.home_team ?? '?',
        away_team: m.away_team ?? '?',
        match_date: m.match_date ?? '?',
      });
      if (m.round) missingRoundsSet.add(m.round);
      if (m.home_team) missingTeamsSet.add(m.home_team);
      if (m.away_team) missingTeamsSet.add(m.away_team);
    }
  }

  diagnostics.missingMatches = missingMatches;
  diagnostics.missingRounds = Array.from(missingRoundsSet).sort((a, b) => parseInt(a) - parseInt(b));
  diagnostics.missingTeams = Array.from(missingTeamsSet);
  diagnostics.missingPlayerStatRows = missingMatches.length * 40; // ~40 players per match estimate

  return diagnostics;
}

/**
 * Backfill missing player_game_stats for all rounds from 1 to latest completed
 * This finds matches that have no stats and reports them
 */
export async function backfillMissingRounds(season: number): Promise<BackfillDiagnostics> {
  const diagnostics: BackfillDiagnostics = {
    season,
    roundsChecked: [],
    matchesFound: 0,
    matchesMissingStats: 0,
    playersWithOdds: 0,
    playersMissingStats: 0,
    rowsToBackfill: 0,
    rowsImported: 0,
    rowsUpdated: 0,
    rowsSkipped: 0,
    failedRows: 0,
    errors: [],
    perRound: [],
  };

  // Get all completed matches for the season
  const { data: completedMatches } = await supabase
    .from('matches')
    .select('id, round, home_team, away_team, match_date, venue, season')
    .eq('season', season)
    .lt('match_date', new Date().toISOString().split('T')[0])
    .order('match_date', { ascending: true });

  if (!completedMatches || completedMatches.length === 0) {
    diagnostics.errors.push('No completed matches found for this season');
    return diagnostics;
  }

  diagnostics.matchesFound = completedMatches.length;

  // Get all match_ids that have player_game_stats. Fully paginated — an
  // unpaginated select here was silently capped at Supabase's 1000-row
  // default, falsely reporting matches that actually have stats as missing.
  const existingStats = await fetchAllRows<{ match_id: string | null }>(
    supabase, 'player_game_stats', 'match_id', (q) => q.not('match_id', 'is', null),
  );

  const matchesWithStats = new Set<string>();
  for (const s of existingStats) {
    if (s.match_id) matchesWithStats.add(s.match_id);
  }

  // Group by round
  const roundsMap = new Map<string, typeof completedMatches>();
  for (const m of completedMatches) {
    const round = m.round ?? '?';
    if (!roundsMap.has(round)) roundsMap.set(round, []);
    roundsMap.get(round)!.push(m);
  }

  for (const [round, matches] of roundsMap) {
    const missing = matches.filter(m => !matchesWithStats.has(m.id));
    diagnostics.perRound.push({ round, matches: matches.length, missingStats: missing.length });
    diagnostics.roundsChecked.push(round);
    if (missing.length > 0) {
      diagnostics.matchesMissingStats += missing.length;
    }
  }

  diagnostics.rowsToBackfill = diagnostics.matchesMissingStats * 40;

  return diagnostics;
}

/**
 * Validate and import player game stats from CSV rows
 * Uses upsert by player_id + match_id (or player_name + match_date fallback)
 */
export async function importValidatedStats(rows: Record<string, string>[]): Promise<StatsImportValidation> {
  const result: StatsImportValidation = {
    totalRows: rows.length,
    validRows: 0,
    invalidRows: 0,
    failedRows: 0,
    errors: [],
    inserted: 0,
    updated: 0,
    skipped: 0,
    duplicates: 0,
    latestRoundImported: null,
  };

  // Load all players for name matching (paginated — no 1,000-row truncation)
  const { fetchAllPlayers } = await import('./playerMatching');
  const players = await fetchAllPlayers();
  const playerMap = new Map<string, { id: string; team: string }>();
  for (const p of players) {
    playerMap.set(p.name.toLowerCase().trim(), { id: p.id, team: p.team ?? '' });
  }

  // Load all matches for match_id resolution
  const { data: matches } = await supabase.from('matches').select('id, match_date, home_team, away_team, round, season, venue');
  const matchByDate = new Map<string, typeof matches>();
  for (const m of (matches ?? []) as { id: string; match_date: string; home_team: string; away_team: string; round: string; season: number; venue: string }[]) {
    const dateKey = m.match_date?.split('T')[0];
    if (!dateKey) continue;
    if (!matchByDate.has(dateKey)) matchByDate.set(dateKey, []);
    matchByDate.get(dateKey)!.push(m);
  }

  let latestRound = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const playerName = (row.player_name ?? row.name ?? '').trim();
    const matchDate = row.match_date?.trim();
    const team = row.team?.trim();

    // Validate required fields
    if (!playerName || !matchDate || !team) {
      result.invalidRows++;
      result.errors.push({ row: i + 2, message: `Missing required fields (player_name, match_date, team): ${JSON.stringify(row)}` });
      continue;
    }

    const playerKey = playerName.toLowerCase().trim();
    const player = playerMap.get(playerKey);
    if (!player) {
      result.invalidRows++;
      result.errors.push({ row: i + 2, message: `Player not found: "${playerName}" — import player first` });
      continue;
    }

    const isoDate = matchDate.match(/^\d{4}-\d{2}-\d{2}$/) ? matchDate : undefined;
    if (!isoDate) {
      result.invalidRows++;
      result.errors.push({ row: i + 2, message: `Invalid date format: "${matchDate}"` });
      continue;
    }

    // Try to resolve match_id
    let matchId: string | null = null;
    let matchRound: string | null = null;
    const dateMatches = matchByDate.get(isoDate);
    if (dateMatches && dateMatches.length > 0) {
      const teamNorm = normalizeTeamName(team);
      const match = dateMatches.find(m =>
        normalizeTeamName(m.home_team) === teamNorm || normalizeTeamName(m.away_team) === teamNorm
      );
      if (match) {
        matchId = match.id;
        matchRound = match.round;
      }
    }

    // Check for existing row (dedup by player_id + match_id, or player_id + match_date)
    let existingId: string | null = null;
    if (matchId) {
      const { data: existing } = await supabase
        .from('player_game_stats')
        .select('id')
        .eq('player_id', player.id)
        .eq('match_id', matchId)
        .maybeSingle();
      if (existing) {
        existingId = (existing as { id: string }).id;
        result.duplicates++;
      }
    }
    if (!existingId) {
      const { data: existing } = await supabase
        .from('player_game_stats')
        .select('id')
        .eq('player_id', player.id)
        .eq('match_date', isoDate)
        .maybeSingle();
      if (existing) {
        existingId = (existing as { id: string }).id;
        result.duplicates++;
      }
    }

    const statRow = {
      player_id: player.id,
      match_id: matchId,
      match_date: isoDate,
      team: team.toLowerCase().replace(/\s+/g, '-'),
      opponent: row.opponent?.trim() || null,
      venue: row.venue?.trim() || null,
      disposals: parseInt(row.disposals ?? '0') || 0,
      marks: parseInt(row.marks ?? '0') || 0,
      tackles: parseInt(row.tackles ?? '0') || 0,
      goals: parseInt(row.goals ?? '0') || 0,
      hitouts: parseInt(row.hitouts ?? '0') || 0,
    };

    if (existingId) {
      const { error } = await supabase
        .from('player_game_stats')
        .update(statRow)
        .eq('id', existingId);
      if (error) {
        result.failedRows++;
        result.errors.push({ row: i + 2, message: `${playerName} on ${matchDate}: ${error.message}` });
      } else {
        result.updated++;
        result.validRows++;
      }
    } else {
      const { error } = await supabase
        .from('player_game_stats')
        .insert(statRow);
      if (error) {
        result.failedRows++;
        result.errors.push({ row: i + 2, message: `${playerName} on ${matchDate}: ${error.message}` });
      } else {
        result.inserted++;
        result.validRows++;
      }
    }

    if (matchRound) {
      const roundNum = parseInt(matchRound, 10);
      if (!isNaN(roundNum) && roundNum > latestRound) latestRound = roundNum;
    }
  }

  result.latestRoundImported = latestRound > 0 ? `R${latestRound}` : null;
  result.skipped = result.invalidRows;
  return result;
}

/**
 * Deduplicate existing player_game_stats rows
 * Removes duplicates by player_id + match_id (keeps earliest), then by player_id + match_date
 */
export async function deduplicateStats(): Promise<{ duplicatesRemoved: number; errors: string[] }> {
  let duplicatesRemoved = 0;
  const errors: string[] = [];

  // Find duplicates by player_id + match_id. Fully paginated — an
  // unpaginated select here was silently capped at Supabase's 1000-row
  // default (ordered by created_at asc), so only the first ~1000 rows were
  // ever checked for duplicates and the rest of the table was never
  // deduplicated.
  let allStats: { id: string; player_id: string; match_id: string | null; match_date: string }[];
  try {
    allStats = await fetchAllRows(supabase, 'player_game_stats', 'id, player_id, match_id, match_date',
      (q) => q.not('match_id', 'is', null));
  } catch {
    return { duplicatesRemoved: 0, errors: ['Failed to fetch stats'] };
  }

  const seen = new Map<string, string>(); // player_id|match_id -> kept id
  const toDelete: string[] = [];

  for (const s of allStats as { id: string; player_id: string; match_id: string; match_date: string }[]) {
    const key = `${s.player_id}|${s.match_id}`;
    if (seen.has(key)) {
      toDelete.push(s.id);
    } else {
      seen.set(key, s.id);
    }
  }

  if (toDelete.length > 0) {
    const BATCH = 500;
    for (let i = 0; i < toDelete.length; i += BATCH) {
      const batch = toDelete.slice(i, i + BATCH);
      const { error } = await supabase.from('player_game_stats').delete().in('id', batch);
      if (error) errors.push(`Batch delete error: ${error.message}`);
      else duplicatesRemoved += batch.length;
    }
  }

  return { duplicatesRemoved, errors };
}

/**
 * Get data status for readiness gate
 */
export async function getDataStatus(season: number): Promise<{
  status: 'READY' | 'WARNING' | 'BROKEN';
  latestCompletedRound: string | null;
  latestStatRound: string | null;
  isStale: boolean;
  reasons: string[];
}> {
  const reasons: string[] = [];

  const { round: latestCompletedRound } = await getLatestCompletedRoundInfo(season);
  const { round: latestStatRound } = await getLatestStatRound();

  const completedNum = latestCompletedRound ? parseInt(latestCompletedRound, 10) : 0;
  const statNum = latestStatRound ? parseInt(latestStatRound, 10) : 0;
  const isStale = completedNum > 0 && statNum > 0 && statNum < completedNum;

  if (isStale) {
    reasons.push(`Player stats are stale — latest stat is R${latestStatRound} but latest completed round is R${latestCompletedRound}. Kali sync required.`);
  }

  let status: 'READY' | 'WARNING' | 'BROKEN' = 'READY';
  if (isStale) status = 'BROKEN';
  else if (completedNum > 0 && statNum === 0) {
    status = 'BROKEN';
    reasons.push('No player stats found at all — Kali sync required');
  }

  return { status, latestCompletedRound, latestStatRound, isStale, reasons };
}

/**
 * Check if position_edges table is stale relative to player_game_stats
 */
export async function getPositionEdgeStaleness(): Promise<{
  isStale: boolean;
  positionEdgesUpdatedAt: string | null;
  latestStatDate: string | null;
  reason: string | null;
}> {
  const { data: peData } = await supabase
    .from('position_edges')
    .select('updated_at')
    .order('updated_at', { ascending: false })
    .limit(1);

  const positionEdgesUpdatedAt = peData?.[0]?.updated_at ?? null;

  const { data: statData } = await supabase
    .from('player_game_stats')
    .select('match_date')
    .order('match_date', { ascending: false })
    .limit(1);

  const latestStatDate = statData?.[0]?.match_date ?? null;

  let isStale = false;
  let reason: string | null = null;

  if (!positionEdgesUpdatedAt) {
    isStale = true;
    reason = 'Position Edge table is empty — recalculation needed';
  } else if (latestStatDate) {
    const statDate = new Date(latestStatDate);
    const peDate = new Date(positionEdgesUpdatedAt);
    if (statDate > peDate) {
      isStale = true;
      reason = `Position Edge is stale — last computed ${positionEdgesUpdatedAt.slice(0, 10)} but latest stats are from ${latestStatDate}`;
    }
  }

  return { isStale, positionEdgesUpdatedAt, latestStatDate, reason };
}

/**
 * Trigger position edge recalculation by calling the edge function
 */
export async function recalculatePositionEdges(): Promise<{ success: boolean; error: string | null }> {
  try {
    const { data, error } = await supabase.functions.invoke('compute-position-edges');
    if (error) return { success: false, error: error.message };
    return { success: true, error: null };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Unknown error' };
  }
}
