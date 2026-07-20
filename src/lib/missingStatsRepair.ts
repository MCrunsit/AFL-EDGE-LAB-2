import { supabase } from './supabase';
import type { PlayerGameStat } from './types';

// ── Types ──

export type AuditReason =
  | 'OK_HAS_STATS'
  | 'PLAYER_ID_HAS_ZERO_STATS'
  | 'DUPLICATE_PLAYER_WITH_STATS_FOUND'
  | 'RAW_KALI_ROWS_AVAILABLE'
  | 'NAME_MISMATCH'
  | 'TEAM_MISMATCH'
  | 'NO_PLAYER_ROW'
  | 'BROKEN_PLAYER_ID'
  | 'NO_STATS_ANYWHERE'
  | 'INSUFFICIENT_MARKET_SAMPLE'
  | 'KALI_PLAYER_NOT_FOUND'
  | 'TEAM_UNKNOWN';

export interface AuditEntry {
  playerName: string;
  team: string;
  matchId: string;
  matchName: string;
  season: number | null;
  round: string | null;
  oddsRowsCount: number;
  currentPlayerId: string | null;
  currentStatsCount: number;
  playerExists: boolean;
  duplicateWithStatsFound: boolean;
  duplicatePlayerId: string | null;
  duplicateStatsCount: number;
  rawKaliRowsFound: boolean;
  rawKaliRowCount: number;
  reason: AuditReason;
  recommendedAction: string;
}

export interface AuditResult {
  totalOddsRows: number;
  uniquePlayers: number;
  auditEntries: AuditEntry[];
  errors: string[];
}

export interface DryRunResult {
  bookmakerRowsChecked: number;
  uniquePlayersChecked: number;
  rowsWithNoStats: number;
  duplicateRepairsPossible: number;
  rawKaliPromotionsPossible: number;
  playersStillMissingAfterRepair: number;
  riskyAmbiguousSkipped: number;
  repairs: Array<{
    type: 'RELINK' | 'PROMOTE_KALI';
    playerName: string;
    matchName: string;
    oddsRows: number;
    fromPlayerId: string | null;
    toPlayerId: string;
    reason: string;
  }>;
  ambiguous: Array<{
    playerName: string;
    matchName: string;
    reason: string;
    candidateCount: number;
  }>;
  stillMissing: AuditEntry[];
  errors: string[];
}

export interface ApplyResult {
  bookmakerRowsChecked: number;
  relinked: number;
  rawKaliPromoted: number;
  stillMissing: number;
  ambiguous: number;
  errors: string[];
  missingQueue: AuditEntry[];
}

export interface StepLog {
  step: string;
  message: string;
}

export interface PlayerDetail {
  playerName: string;
  team: string;
  action: 'CREATED' | 'UPDATED' | 'RELINKED' | 'NOT_FOUND' | 'ERROR' | 'NO_STATS_IN_KALI' | 'TEAM_NOT_CONFIRMED';
  statsInserted: number;
  oddsRelinked?: number;
  message: string;
  steps?: StepLog[];
}

export interface BackfillResult {
  success?: boolean;
  action?: string;
  missingPlayersChecked: number;
  playersFoundInKali: number;
  playersCreated: number;
  existingPlayersUpdated: number;
  playerGameStatsRowsInserted: number;
  bookmakerOddsRowsRelinked: number;
  playersStillMissing: number;
  requestsUsed?: number;
  rateLimitRemaining?: number | null;
  errors: string[];
  details: PlayerDetail[];
  envCheck?: {
    KALI_API_KEY: boolean;
    SUPABASE_URL: boolean;
    SUPABASE_SERVICE_ROLE_KEY: boolean;
    kaliBaseUrl: string;
    testEndpoint?: string;
    testHttpStatus?: number;
    testResponseSample?: string;
    rateLimitRemaining?: number | null;
    error?: string;
  };
}

// ── Normalization (FULL NAME, never surname) ──

export function normalizeFullName(name: string): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const TEAM_ALIASES: Record<string, string> = {
  'adelaide crows': 'Adelaide',
  'adelaide': 'Adelaide',
  'brisbane lions': 'Brisbane',
  'brisbane': 'Brisbane',
  'carlton blues': 'Carlton',
  'carlton': 'Carlton',
  'collingwood magpies': 'Collingwood',
  'collingwood': 'Collingwood',
  'essendon bombers': 'Essendon',
  'essendon': 'Essendon',
  'fremantle dockers': 'Fremantle',
  'fremantle': 'Fremantle',
  'geelong cats': 'Geelong',
  'geelong': 'Geelong',
  'gold coast suns': 'Gold Coast',
  'gold-coast': 'Gold Coast',
  'gold coast': 'Gold Coast',
  'greater western sydney giants': 'GWS',
  'gws giants': 'GWS',
  'gws': 'GWS',
  'greater western sydney': 'GWS',
  'hawthorn hawks': 'Hawthorn',
  'hawthorn': 'Hawthorn',
  'melbourne demons': 'Melbourne',
  'melbourne': 'Melbourne',
  'north melbourne kangaroos': 'North Melbourne',
  'north melbourne': 'North Melbourne',
  'north-melbourne': 'North Melbourne',
  'port adelaide power': 'Port Adelaide',
  'port adelaide': 'Port Adelaide',
  'port-adelaide': 'Port Adelaide',
  'richmond tigers': 'Richmond',
  'richmond': 'Richmond',
  'st kilda saints': 'St Kilda',
  'st kilda': 'St Kilda',
  'st-kilda': 'St Kilda',
  'sydney swans': 'Sydney',
  'sydney': 'Sydney',
  'west coast eagles': 'West Coast',
  'west coast': 'West Coast',
  'west-coast': 'West Coast',
  'western bulldogs': 'Western Bulldogs',
  'western-bulldogs': 'Western Bulldogs',
};

export function normalizeTeam(team: string): string {
  if (!team) return '';
  const key = team.toLowerCase().trim().replace(/\s+/g, '-');
  if (TEAM_ALIASES[key]) return TEAM_ALIASES[key];
  const key2 = team.toLowerCase().trim();
  if (TEAM_ALIASES[key2]) return TEAM_ALIASES[key2];
  return team.trim();
}

// ── Fetch helpers ──

interface OddsRow {
  id: string;
  player_id: string | null;
  bookmaker_player_name: string;
  match_id: string;
  market: string | null;
  line: number | null;
  over_odds: number | null;
}

interface PlayerRow {
  id: string;
  name: string;
  team: string | null;
}

interface MatchInfo {
  id: string;
  home_team: string | null;
  away_team: string | null;
  season: number | null;
  round: string | null;
}

async function fetchOddsForMatches(matchIds: string[]): Promise<{ odds: OddsRow[]; errors: string[] }> {
  const errors: string[] = [];
  const odds: OddsRow[] = [];
  const PAGE = 1000;

  for (const matchId of matchIds) {
    let page = 0;
    let hasMore = true;
    while (hasMore) {
      const { data, error } = await supabase
        .from('bookmaker_odds')
        .select('id, player_id, bookmaker_player_name, match_id, market, line, over_odds')
        .eq('match_id', matchId)
        .range(page * PAGE, (page + 1) * PAGE - 1);

      if (error) {
        errors.push(`Fetch error for match ${matchId}: ${error.message}`);
        break;
      }
      if (data && data.length > 0) {
        odds.push(...(data as unknown as OddsRow[]));
        hasMore = data.length === PAGE;
        page++;
      } else {
        hasMore = false;
      }
    }
  }
  return { odds, errors };
}

export async function fetchMatches(matchIds: string[]): Promise<Map<string, MatchInfo>> {
  const map = new Map<string, MatchInfo>();
  if (matchIds.length === 0) return map;
  const { data } = await supabase
    .from('matches')
    .select('id, home_team, away_team, season, round')
    .in('id', matchIds);
  if (data) {
    for (const m of data as unknown as MatchInfo[]) {
      map.set(m.id, m);
    }
  }
  return map;
}

async function fetchAllPlayers(): Promise<{ byId: Map<string, PlayerRow>; byNormName: Map<string, PlayerRow[]> }> {
  const byId = new Map<string, PlayerRow>();
  const byNormName = new Map<string, PlayerRow[]>();
  const PAGE = 1000;
  let page = 0;
  let hasMore = true;
  while (hasMore) {
    const { data, error } = await supabase
      .from('players')
      .select('id, name, team')
      .range(page * PAGE, (page + 1) * PAGE - 1);
    if (error || !data) break;
    for (const p of data as unknown as PlayerRow[]) {
      byId.set(p.id, p);
      const norm = normalizeFullName(p.name);
      if (!byNormName.has(norm)) byNormName.set(norm, []);
      byNormName.get(norm)!.push(p);
    }
    hasMore = data.length === PAGE;
    page++;
  }
  return { byId, byNormName };
}

async function fetchStatsCounts(playerIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (playerIds.length === 0) return map;
  const BATCH = 200;
  for (let i = 0; i < playerIds.length; i += BATCH) {
    const batch = playerIds.slice(i, i + BATCH);
    const { data } = await supabase
      .from('player_game_stats')
      .select('player_id')
      .in('player_id', batch);
    if (data) {
      for (const s of data as unknown as { player_id: string }[]) {
        map.set(s.player_id, (map.get(s.player_id) ?? 0) + 1);
      }
    }
  }
  return map;
}

async function fetchRawKaliForName(normName: string): Promise<Array<Record<string, unknown>>> {
  const { data } = await supabase
    .from('raw_kali_player_game_stats')
    .select('id, player_id, normalized_player_name, normalized_team, team, match_id, season, round, match_date, opponent, venue, disposals, marks, tackles, goals, hitouts')
    .eq('normalized_player_name', normName);
  return (data as unknown as Array<Record<string, unknown>>) ?? [];
}

/**
 * Derive player team using 5-level fallback:
 * 1. bookmaker_odds.player_team (not available — no such column)
 * 2. joined players.team if player_id exists
 * 3. bookmaker_odds.team (not available — no such column)
 * 4. infer from match home/away if player exists in players for one of those teams
 * 5. if still unknown, return ''
 */
function deriveTeam(
  currentPlayerId: string | null,
  playerRow: PlayerRow | undefined,
  matchInfo: MatchInfo | undefined,
  playersByNormName: Map<string, PlayerRow[]>,
  bookmakerName: string,
): string {
  // Level 2: joined players.team
  if (playerRow?.team) {
    return normalizeTeam(playerRow.team);
  }

  // Level 4: infer from match home/away
  if (matchInfo) {
    const normName = normalizeFullName(bookmakerName);
    const candidates = playersByNormName.get(normName) ?? [];
    const homeNorm = normalizeTeam(matchInfo.home_team ?? '');
    const awayNorm = normalizeTeam(matchInfo.away_team ?? '');

    // Check if any candidate plays for home or away team
    const homeMatch = candidates.find(c => normalizeTeam(c.team ?? '') === homeNorm);
    if (homeMatch) return homeNorm;
    const awayMatch = candidates.find(c => normalizeTeam(c.team ?? '') === awayNorm);
    if (awayMatch) return awayNorm;
  }

  // Level 5: unknown
  return '';
}

// ── Public API: Audit ──

export async function auditMissingStats(matchIds: string[]): Promise<AuditResult> {
  const errors: string[] = [];
  if (matchIds.length === 0) return { totalOddsRows: 0, uniquePlayers: 0, auditEntries: [], errors: ['No matches selected'] };

  const { odds, errors: oddsErrors } = await fetchOddsForMatches(matchIds);
  errors.push(...oddsErrors);

  const matchMap = await fetchMatches(matchIds);
  const { byId: playersById, byNormName: playersByNormName } = await fetchAllPlayers();

  // Group odds by (normName, matchId)
  const grouped = new Map<string, { rows: OddsRow[]; bookmakerName: string; matchId: string }>();
  for (const row of odds) {
    const normName = normalizeFullName(row.bookmaker_player_name);
    const key = `${normName}|${row.match_id}`;
    if (!grouped.has(key)) grouped.set(key, { rows: [], bookmakerName: row.bookmaker_player_name, matchId: row.match_id });
    grouped.get(key)!.rows.push(row);
  }

  // Collect all player_ids to check stats — INCLUDING duplicate candidates
  const allPlayerIdsSet = new Set<string>();
  for (const r of odds) {
    if (r.player_id) allPlayerIdsSet.add(r.player_id);
  }
  // Also add all candidate IDs for players with duplicate names
  for (const [normName] of grouped) {
    const candidates = playersByNormName.get(normName) ?? [];
    for (const c of candidates) {
      allPlayerIdsSet.add(c.id);
    }
  }
  const allPlayerIds = [...allPlayerIdsSet];
  const statsCountMap = await fetchStatsCounts(allPlayerIds);

  const entries: AuditEntry[] = [];

  for (const [, group] of grouped) {
    const firstRow = group.rows[0];
    const bookmakerName = group.bookmakerName;
    const matchId = group.matchId;
    const normName = normalizeFullName(bookmakerName);
    const matchInfo = matchMap.get(matchId);
    const matchName = matchInfo ? `${matchInfo.home_team ?? ''} vs ${matchInfo.away_team ?? ''}` : matchId;

    const currentPlayerId = firstRow.player_id;
    const playerRow = currentPlayerId ? playersById.get(currentPlayerId) : undefined;
    const playerExists = !!playerRow;
    const currentStatsCount = currentPlayerId ? (statsCountMap.get(currentPlayerId) ?? 0) : 0;

    // Derive team
    const derivedTeam = deriveTeam(currentPlayerId, playerRow, matchInfo, playersByNormName, bookmakerName);

    // Find duplicate candidates with same FULL normalized name
    const candidates = playersByNormName.get(normName) ?? [];
    let duplicateWithStatsFound = false;
    let duplicatePlayerId: string | null = null;
    let duplicateStatsCount = 0;

    for (const c of candidates) {
      if (c.id === currentPlayerId) continue;
      // Full name must match exactly (already guaranteed by normName lookup)
      // Also check team matches if we know the team
      if (derivedTeam) {
        const cTeamNorm = normalizeTeam(c.team ?? '');
        if (cTeamNorm !== derivedTeam) continue;
      }
      const stats = statsCountMap.get(c.id) ?? 0;
      if (stats > 0) {
        if (duplicateWithStatsFound) {
          // Multiple candidates with stats — ambiguous
          duplicateWithStatsFound = true;
          duplicatePlayerId = null; // ambiguous
          duplicateStatsCount = -1; // signal multiple
        } else {
          duplicateWithStatsFound = true;
          duplicatePlayerId = c.id;
          duplicateStatsCount = stats;
        }
      }
    }

    // Check raw_kali
    let rawKaliRowsFound = false;
    let rawKaliRowCount = 0;
    if (currentStatsCount === 0) {
      const kaliRows = await fetchRawKaliForName(normName);
      const teamMatchedKali = kaliRows.filter(r => {
        const kaliTeamNorm = normalizeTeam(String(r.team ?? ''));
        const kaliNormTeam = normalizeTeam(String(r.normalized_team ?? ''));
        return kaliTeamNorm === derivedTeam || kaliNormTeam === derivedTeam;
      });
      rawKaliRowsFound = teamMatchedKali.length > 0;
      rawKaliRowCount = teamMatchedKali.length;
    }

    // Determine reason
    let reason: AuditReason;
    let recommendedAction: string;

    if (currentStatsCount >= 5) {
      reason = 'OK_HAS_STATS';
      recommendedAction = 'No action needed';
    } else if (currentStatsCount > 0 && currentStatsCount < 5) {
      reason = 'INSUFFICIENT_MARKET_SAMPLE';
      recommendedAction = `Only ${currentStatsCount} stats rows — below sample threshold. Not a data bug.`;
    } else if (currentPlayerId && !playerExists) {
      reason = 'BROKEN_PLAYER_ID';
      recommendedAction = `bookmaker_odds.player_id ${currentPlayerId?.slice(0, 8)}… does not exist in players table. Search by full name and relink, or backfill from Kali.`;
    } else if (!currentPlayerId) {
      reason = 'NO_PLAYER_ROW';
      recommendedAction = 'No player_id linked. Backfill from Kali to create player + stats.';
    } else if (candidates.length === 0) {
      reason = 'NO_PLAYER_ROW';
      recommendedAction = 'No player found with this full name in players table. Backfill from Kali.';
    } else if (duplicateWithStatsFound && duplicatePlayerId) {
      reason = 'DUPLICATE_PLAYER_WITH_STATS_FOUND';
      recommendedAction = `Relink odds to player ${duplicatePlayerId.slice(0, 8)}… (${duplicateStatsCount} stats)`;
    } else if (duplicateWithStatsFound && !duplicatePlayerId) {
      reason = 'NAME_MISMATCH';
      recommendedAction = `Multiple duplicate players with stats found — ambiguous. Manual review needed.`;
    } else if (rawKaliRowsFound) {
      reason = 'RAW_KALI_ROWS_AVAILABLE';
      recommendedAction = `Promote ${rawKaliRowCount} raw_kali rows to player_game_stats`;
    } else if (!derivedTeam) {
      reason = 'TEAM_UNKNOWN';
      recommendedAction = 'Cannot determine team. Manual team mapping required before repair.';
    } else if (currentPlayerId && playerExists && currentStatsCount === 0) {
      reason = 'NO_STATS_ANYWHERE';
      recommendedAction = `Player exists (${derivedTeam}) but has 0 stats. Backfill from Kali to fetch stats.`;
    } else {
      reason = 'NO_STATS_ANYWHERE';
      recommendedAction = 'No stats found anywhere. Backfill from Kali.';
    }

    entries.push({
      playerName: bookmakerName,
      team: derivedTeam,
      matchId,
      matchName,
      season: matchInfo?.season ?? null,
      round: matchInfo?.round ?? null,
      oddsRowsCount: group.rows.length,
      currentPlayerId,
      currentStatsCount,
      playerExists,
      duplicateWithStatsFound,
      duplicatePlayerId,
      duplicateStatsCount,
      rawKaliRowsFound,
      rawKaliRowCount,
      reason,
      recommendedAction,
    });
  }

  // Sort: problems first
  entries.sort((a, b) => {
    const aOk = a.reason === 'OK_HAS_STATS' ? 1 : 0;
    const bOk = b.reason === 'OK_HAS_STATS' ? 1 : 0;
    if (aOk !== bOk) return aOk - bOk;
    return a.playerName.localeCompare(b.playerName);
  });

  return {
    totalOddsRows: odds.length,
    uniquePlayers: grouped.size,
    auditEntries: entries,
    errors,
  };
}

// ── Public API: Dry Run ──

export async function dryRunRepair(matchIds: string[]): Promise<DryRunResult> {
  const audit = await auditMissingStats(matchIds);

  const repairs: DryRunResult['repairs'] = [];
  const ambiguous: DryRunResult['ambiguous'] = [];
  const stillMissing: AuditEntry[] = [];

  for (const entry of audit.auditEntries) {
    if (entry.reason === 'OK_HAS_STATS' || entry.reason === 'INSUFFICIENT_MARKET_SAMPLE') continue;

    if (entry.reason === 'DUPLICATE_PLAYER_WITH_STATS_FOUND' && entry.duplicatePlayerId) {
      repairs.push({
        type: 'RELINK',
        playerName: entry.playerName,
        matchName: entry.matchName,
        oddsRows: entry.oddsRowsCount,
        fromPlayerId: entry.currentPlayerId,
        toPlayerId: entry.duplicatePlayerId,
        reason: `Relink to player with ${entry.duplicateStatsCount} stats`,
      });
    } else if (entry.reason === 'RAW_KALI_ROWS_AVAILABLE' && entry.rawKaliRowCount > 0) {
      repairs.push({
        type: 'PROMOTE_KALI',
        playerName: entry.playerName,
        matchName: entry.matchName,
        oddsRows: entry.oddsRowsCount,
        fromPlayerId: entry.currentPlayerId,
        toPlayerId: entry.currentPlayerId ?? '',
        reason: `Promote ${entry.rawKaliRowCount} raw_kali rows`,
      });
    } else if (entry.reason === 'NAME_MISMATCH') {
      ambiguous.push({
        playerName: entry.playerName,
        matchName: entry.matchName,
        reason: 'Multiple duplicate players with stats — unclear which to relink',
        candidateCount: 2,
      });
    } else {
      stillMissing.push(entry);
    }
  }

  return {
    bookmakerRowsChecked: audit.totalOddsRows,
    uniquePlayersChecked: audit.uniquePlayers,
    rowsWithNoStats: audit.auditEntries.filter(e => e.reason !== 'OK_HAS_STATS' && e.reason !== 'INSUFFICIENT_MARKET_SAMPLE').length,
    duplicateRepairsPossible: repairs.filter(p => p.type === 'RELINK').length,
    rawKaliPromotionsPossible: repairs.filter(p => p.type === 'PROMOTE_KALI').length,
    playersStillMissingAfterRepair: stillMissing.length,
    riskyAmbiguousSkipped: ambiguous.length,
    repairs,
    ambiguous,
    stillMissing,
    errors: audit.errors,
  };
}

// ── Public API: Apply Safe Repair ──

export async function applySafeRepair(matchIds: string[]): Promise<ApplyResult> {
  const dryRun = await dryRunRepair(matchIds);
  const errors: string[] = [...dryRun.errors];

  let relinked = 0;
  let rawKaliPromoted = 0;

  // Apply RELINK repairs
  for (const repair of dryRun.repairs) {
    if (repair.type === 'RELINK') {
      // Find the audit entry to get matchId
      const auditEntry = dryRun.stillMissing.find(s => s.playerName === repair.playerName && s.matchName === repair.matchName);
      const targetMatchId = auditEntry?.matchId ?? '';

      if (!targetMatchId) {
        errors.push(`Could not find matchId for relink: ${repair.playerName}`);
        continue;
      }

      const { data: oddsToUpdate } = await supabase
        .from('bookmaker_odds')
        .select('id')
        .eq('match_id', targetMatchId)
        .ilike('bookmaker_player_name', repair.playerName);

      if (oddsToUpdate && oddsToUpdate.length > 0) {
        const ids = oddsToUpdate.map(o => o.id);
        const { error: updateError } = await supabase
          .from('bookmaker_odds')
          .update({
            player_id: repair.toPlayerId,
            resolved_player_name: repair.playerName,
            resolution_status: 'relinked',
            resolution_reason: 'safe_repair_duplicate_stats',
          })
          .in('id', ids);

        if (updateError) {
          errors.push(`Relink error for ${repair.playerName}: ${updateError.message}`);
        } else {
          relinked += ids.length;
        }
      }
    } else if (repair.type === 'PROMOTE_KALI') {
      const normName = normalizeFullName(repair.playerName);
      const kaliRows = await fetchRawKaliForName(normName);

      if (kaliRows.length === 0) continue;

      const targetPlayerId = repair.toPlayerId || repair.fromPlayerId;
      if (!targetPlayerId) {
        errors.push(`No player_id for kali promotion: ${repair.playerName}`);
        continue;
      }

      // Resolve raw_kali player_id if needed
      const unresolved = kaliRows.filter(r => !r.player_id);
      for (const r of unresolved) {
        await supabase
          .from('raw_kali_player_game_stats')
          .update({ player_id: targetPlayerId })
          .eq('id', String(r.id));
      }

      // Promote to player_game_stats
      for (const r of kaliRows) {
        const insertData = {
          player_id: (r.player_id as string) || targetPlayerId,
          match_id: r.match_id,
          match_date: r.match_date,
          season: r.season,
          round: r.round,
          team: String(r.team ?? ''),
          opponent: String(r.opponent ?? ''),
          venue: String(r.venue ?? ''),
          disposals: r.disposals ?? null,
          marks: r.marks ?? null,
          tackles: r.tackles ?? null,
          goals: r.goals ?? null,
          hitouts: r.hitouts ?? null,
          source: 'promoted_safe_repair',
        };

        const { error: insertError } = await supabase
          .from('player_game_stats')
          // insertData is assembled from loosely-typed raw_kali staging rows;
          // cast preserves the existing promotion behaviour.
          .upsert(insertData as unknown as PlayerGameStat, { onConflict: 'player_id,match_id' });

        if (insertError) {
          errors.push(`Promote error for ${repair.playerName}: ${insertError.message}`);
        } else {
          rawKaliPromoted++;
        }
      }
    }
  }

  return {
    bookmakerRowsChecked: dryRun.bookmakerRowsChecked,
    relinked,
    rawKaliPromoted,
    stillMissing: dryRun.stillMissing.length,
    ambiguous: dryRun.ambiguous.length,
    errors,
    missingQueue: dryRun.stillMissing,
  };
}

// ── Public API: Backfill from Kali ──

export interface MissingPlayerPayload {
  bookmaker_player_name: string;
  current_player_id: string | null;
  match_id: string;
  home_team: string | null;
  away_team: string | null;
  season: number;
  round: string | null;
  player_team: string | null;
  odds_rows: number;
}

async function buildMissingPlayersPayload(matchIds: string[]): Promise<{ missingPlayers: MissingPlayerPayload[]; missingEntries: AuditEntry[]; errors: string[] }> {
  const audit = await auditMissingStats(matchIds);
  const errors: string[] = [...audit.errors];

  const missingEntries = audit.auditEntries.filter(
    e => e.reason !== 'OK_HAS_STATS' && e.reason !== 'INSUFFICIENT_MARKET_SAMPLE'
  );

  const missingPlayers = missingEntries.map(e => ({
    bookmaker_player_name: e.playerName,
    current_player_id: e.currentPlayerId,
    match_id: e.matchId,
    home_team: null as string | null,
    away_team: null as string | null,
    season: e.season ?? new Date().getFullYear(),
    round: e.round,
    player_team: e.team || null,
    odds_rows: e.oddsRowsCount,
  }));

  const matchMap = await fetchMatches(matchIds);
  for (const mp of missingPlayers) {
    const m = matchMap.get(mp.match_id);
    if (m) {
      mp.home_team = m.home_team;
      mp.away_team = m.away_team;
    }
  }

  return { missingPlayers, missingEntries, errors };
}

export async function testKaliConnectionForBackfill(): Promise<BackfillResult> {
  try {
    const { data: invokeResult, error: invokeError } = await supabase.functions.invoke(
      'backfill-missing-player-stats',
      { body: JSON.stringify({ action: 'test_connection' }) }
    );

    if (invokeError) {
      return {
        success: false,
        missingPlayersChecked: 0,
        playersFoundInKali: 0, playersCreated: 0, existingPlayersUpdated: 0,
        playerGameStatsRowsInserted: 0, bookmakerOddsRowsRelinked: 0,
        playersStillMissing: 0,
        errors: [`Edge function error: ${invokeError.message}`],
        details: [],
        envCheck: {
          KALI_API_KEY: false, SUPABASE_URL: false, SUPABASE_SERVICE_ROLE_KEY: false,
          kaliBaseUrl: 'https://kaliaflstats.com/api/afl/v1',
          error: invokeError.message,
        },
      };
    }

    return invokeResult as BackfillResult;
  } catch (err) {
    return {
      success: false,
      missingPlayersChecked: 0,
      playersFoundInKali: 0, playersCreated: 0, existingPlayersUpdated: 0,
      playerGameStatsRowsInserted: 0, bookmakerOddsRowsRelinked: 0,
      playersStillMissing: 0,
      errors: [err instanceof Error ? err.message : 'Connection test failed'],
      details: [],
      envCheck: {
        KALI_API_KEY: false, SUPABASE_URL: false, SUPABASE_SERVICE_ROLE_KEY: false,
        kaliBaseUrl: 'https://kaliaflstats.com/api/afl/v1',
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

export async function testBackfillOnePlayer(
  matchIds: string[],
  playerName: string
): Promise<BackfillResult> {
  const { missingPlayers, missingEntries, errors } = await buildMissingPlayersPayload(matchIds);

  // Find the specific player
  const playerEntry = missingEntries.find(e =>
    normalizeFullName(e.playerName) === normalizeFullName(playerName)
  );

  if (!playerEntry) {
    return {
      success: false,
      missingPlayersChecked: 1,
      playersFoundInKali: 0, playersCreated: 0, existingPlayersUpdated: 0,
      playerGameStatsRowsInserted: 0, bookmakerOddsRowsRelinked: 0,
      playersStillMissing: 1,
      errors: [`Player "${playerName}" not found in missing stats queue for selected matches`],
      details: [{
        playerName, team: '', action: 'ERROR',
        statsInserted: 0, oddsRelinked: 0,
        message: 'Player not found in missing stats queue',
      }],
    };
  }

  const playerPayload = missingPlayers.find(mp =>
    normalizeFullName(mp.bookmaker_player_name) === normalizeFullName(playerName)
  );

  if (!playerPayload) {
    return {
      success: false,
      missingPlayersChecked: 1,
      playersFoundInKali: 0, playersCreated: 0, existingPlayersUpdated: 0,
      playerGameStatsRowsInserted: 0, bookmakerOddsRowsRelinked: 0,
      playersStillMissing: 1,
      errors: ['Could not build payload for player'],
      details: [],
    };
  }

  try {
    const { data: invokeResult, error: invokeError } = await supabase.functions.invoke(
      'backfill-missing-player-stats',
      {
        body: JSON.stringify({
          action: 'test_one',
          missingPlayers: [playerPayload],
          seasons: [2024, 2025, 2026],
          batchSize: 1,
        }),
      }
    );

    if (invokeError) {
      return {
        success: false,
        missingPlayersChecked: 1,
        playersFoundInKali: 0, playersCreated: 0, existingPlayersUpdated: 0,
        playerGameStatsRowsInserted: 0, bookmakerOddsRowsRelinked: 0,
        playersStillMissing: 1,
        errors: [`Edge function error: ${invokeError.message}`],
        details: [{
          playerName, team: playerEntry.team, action: 'ERROR',
          statsInserted: 0, oddsRelinked: 0,
          message: `Edge function error: ${invokeError.message}`,
        }],
      };
    }

    return invokeResult as BackfillResult;
  } catch (err) {
    return {
      success: false,
      missingPlayersChecked: 1,
      playersFoundInKali: 0, playersCreated: 0, existingPlayersUpdated: 0,
      playerGameStatsRowsInserted: 0, bookmakerOddsRowsRelinked: 0,
      playersStillMissing: 1,
      errors: [err instanceof Error ? err.message : 'Test backfill failed'],
      details: [{
        playerName, team: playerEntry.team, action: 'ERROR',
        statsInserted: 0, oddsRelinked: 0,
        message: err instanceof Error ? err.message : String(err),
      }],
    };
  }
}

export async function backfillMissingFromKali(
  matchIds: string[],
  batchSize: number = 5
): Promise<BackfillResult> {
  const { missingPlayers, missingEntries, errors } = await buildMissingPlayersPayload(matchIds);

  const result: BackfillResult = {
    missingPlayersChecked: missingEntries.length,
    playersFoundInKali: 0,
    playersCreated: 0,
    existingPlayersUpdated: 0,
    playerGameStatsRowsInserted: 0,
    bookmakerOddsRowsRelinked: 0,
    playersStillMissing: 0,
    errors,
    details: [],
  };

  if (missingEntries.length === 0) {
    return result;
  }

  try {
    const { data: invokeResult, error: invokeError } = await supabase.functions.invoke(
      'backfill-missing-player-stats',
      {
        body: JSON.stringify({
          action: 'backfill',
          missingPlayers,
          seasons: [2024, 2025, 2026],
          batchSize: Math.min(batchSize, 10),
        }),
      }
    );

    if (invokeError) {
      errors.push(`Edge function error: ${invokeError.message}`);
      result.errors = errors;
      result.playersStillMissing = missingEntries.length;
      for (const entry of missingEntries) {
        result.details.push({
          playerName: entry.playerName,
          team: entry.team,
          action: 'ERROR',
          statsInserted: 0,
          oddsRelinked: 0,
          message: `Edge function error: ${invokeError.message}`,
        });
      }
      return result;
    }

    const backfillResp = invokeResult as BackfillResult;

    result.success = backfillResp.success;
    result.playersFoundInKali = backfillResp.playersFoundInKali ?? 0;
    result.playersCreated = backfillResp.playersCreated ?? 0;
    result.existingPlayersUpdated = backfillResp.existingPlayersUpdated ?? 0;
    result.playerGameStatsRowsInserted = backfillResp.playerGameStatsRowsInserted ?? 0;
    result.bookmakerOddsRowsRelinked = backfillResp.bookmakerOddsRowsRelinked ?? 0;
    result.playersStillMissing = backfillResp.playersStillMissing ?? 0;
    result.requestsUsed = backfillResp.requestsUsed;
    result.rateLimitRemaining = backfillResp.rateLimitRemaining;
    result.errors = [...errors, ...(backfillResp.errors ?? [])];
    result.details = backfillResp.details ?? [];
  } catch (err) {
    errors.push(err instanceof Error ? err.message : 'Backfill failed');
    result.errors = errors;
    result.playersStillMissing = missingEntries.length;
    for (const entry of missingEntries) {
      result.details.push({
        playerName: entry.playerName,
        team: entry.team,
        action: 'ERROR',
        statsInserted: 0,
        oddsRelinked: 0,
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  return result;
}

// ── Public API: Relink Broken Bookmaker Odds (local only, no Kali) ──

export interface RelinkResult {
  totalOddsRows: number;
  relinked: number;
  ambiguous: number;
  playerNotFound: number;
  alreadyLinked: number;
  errors: string[];
  details: Array<{
    playerName: string;
    matchName: string;
    action: 'RELINKED' | 'AMBIGUOUS' | 'PLAYER_NOT_FOUND' | 'ALREADY_LINKED';
    fromPlayerId: string | null;
    toPlayerId: string | null;
    oddsRows: number;
    message: string;
  }>;
}

export async function relinkBrokenBookmakerOdds(matchIds: string[]): Promise<RelinkResult> {
  const errors: string[] = [];
  const details: RelinkResult['details'] = [];
  let relinked = 0;
  let ambiguous = 0;
  let playerNotFound = 0;
  let alreadyLinked = 0;

  if (matchIds.length === 0) {
    return {
      totalOddsRows: 0, relinked: 0, ambiguous: 0, playerNotFound: 0, alreadyLinked: 0,
      errors: ['No matches selected'], details: [],
    };
  }

  // Fetch all odds for selected matches
  const { odds, errors: oddsErrors } = await fetchOddsForMatches(matchIds);
  errors.push(...oddsErrors);

  // Fetch matches for home/away teams
  const matchMap = await fetchMatches(matchIds);

  // Fetch all players
  const { byNormName: playersByNormName } = await fetchAllPlayers();

  // Group odds by (normName, matchId)
  const grouped = new Map<string, { rows: OddsRow[]; bookmakerName: string; matchId: string }>();
  for (const row of odds) {
    const normName = normalizeFullName(row.bookmaker_player_name);
    const key = `${normName}|${row.match_id}`;
    if (!grouped.has(key)) grouped.set(key, { rows: [], bookmakerName: row.bookmaker_player_name, matchId: row.match_id });
    grouped.get(key)!.rows.push(row);
  }

  for (const [, group] of grouped) {
    const bookmakerName = group.bookmakerName;
    const matchId = group.matchId;
    const normName = normalizeFullName(bookmakerName);
    const matchInfo = matchMap.get(matchId);
    const matchName = matchInfo ? `${matchInfo.home_team ?? ''} vs ${matchInfo.away_team ?? ''}` : matchId;
    const firstRow = group.rows[0];
    const currentPid = firstRow.player_id;

    const homeNorm = normalizeTeam(matchInfo?.home_team ?? '');
    const awayNorm = normalizeTeam(matchInfo?.away_team ?? '');

    // Find candidates by exact full normalized name
    const candidates = playersByNormName.get(normName) ?? [];

    if (candidates.length === 0) {
      playerNotFound++;
      details.push({
        playerName: bookmakerName, matchName,
        action: 'PLAYER_NOT_FOUND',
        fromPlayerId: currentPid, toPlayerId: null,
        oddsRows: group.rows.length,
        message: 'No player found with this exact full name in players table',
      });
      continue;
    }

    // Filter by team: player must belong to home or away team
    const homeSlug = homeNorm.toLowerCase().replace(/\s+/g, '-');
    const awaySlug = awayNorm.toLowerCase().replace(/\s+/g, '-');

    const teamMatches = candidates.filter(c => {
      const cTeamNorm = normalizeTeam(c.team ?? '');
      const cTeamSlug = cTeamNorm.toLowerCase().replace(/\s+/g, '-');
      return cTeamNorm === homeNorm || cTeamNorm === awayNorm ||
             c.team === homeSlug || c.team === awaySlug ||
             c.team === homeNorm.toLowerCase() || c.team === awayNorm.toLowerCase();
    });

    if (teamMatches.length === 0) {
      // No team match — if only one candidate, use it
      if (candidates.length === 1) {
        const target = candidates[0];
        if (target.id === currentPid) {
          alreadyLinked++;
          details.push({
            playerName: bookmakerName, matchName,
            action: 'ALREADY_LINKED',
            fromPlayerId: currentPid, toPlayerId: target.id,
            oddsRows: group.rows.length,
            message: 'Already linked to correct player',
          });
        } else {
          const ids = group.rows.map(r => r.id);
          const { error: updateError } = await supabase
            .from('bookmaker_odds')
            .update({
              player_id: target.id,
              resolved_player_name: bookmakerName,
              resolution_status: 'relinked_local',
              resolution_reason: 'exact_name_match_single_candidate',
            })
            .in('id', ids);

          if (updateError) {
            errors.push(`Relink error for ${bookmakerName}: ${updateError.message}`);
          } else {
            relinked += ids.length;
            details.push({
              playerName: bookmakerName, matchName,
              action: 'RELINKED',
              fromPlayerId: currentPid, toPlayerId: target.id,
              oddsRows: ids.length,
              message: `Relinked to ${target.id.slice(0, 8)}… (single candidate, team=${target.team})`,
            });
          }
        }
      } else {
        ambiguous++;
        details.push({
          playerName: bookmakerName, matchName,
          action: 'AMBIGUOUS',
          fromPlayerId: currentPid, toPlayerId: null,
          oddsRows: group.rows.length,
          message: `${candidates.length} candidates found but none match match teams (${homeNorm}/${awayNorm})`,
        });
      }
      continue;
    }

    if (teamMatches.length > 1) {
      // Multiple candidates matching team — check if current is already correct
      const currentInTeam = teamMatches.find(c => c.id === currentPid);
      if (currentInTeam) {
        alreadyLinked++;
        details.push({
          playerName: bookmakerName, matchName,
          action: 'ALREADY_LINKED',
          fromPlayerId: currentPid, toPlayerId: currentPid,
          oddsRows: group.rows.length,
          message: 'Already linked to correct player (team match)',
        });
        continue;
      }

      ambiguous++;
      details.push({
        playerName: bookmakerName, matchName,
        action: 'AMBIGUOUS',
        fromPlayerId: currentPid, toPlayerId: null,
        oddsRows: group.rows.length,
        message: `${teamMatches.length} candidates match team — cannot determine which`,
      });
      continue;
    }

    // Exactly one team match
    const target = teamMatches[0];
    if (target.id === currentPid) {
      alreadyLinked++;
      details.push({
        playerName: bookmakerName, matchName,
        action: 'ALREADY_LINKED',
        fromPlayerId: currentPid, toPlayerId: target.id,
        oddsRows: group.rows.length,
        message: 'Already linked to correct player',
      });
      continue;
    }

    // Relink
    const ids = group.rows.map(r => r.id);
    const { error: updateError } = await supabase
      .from('bookmaker_odds')
      .update({
        player_id: target.id,
        resolved_player_name: bookmakerName,
        resolution_status: 'relinked_local',
        resolution_reason: 'exact_name_team_match',
      })
      .in('id', ids);

    if (updateError) {
      errors.push(`Relink error for ${bookmakerName}: ${updateError.message}`);
    } else {
      relinked += ids.length;
      details.push({
        playerName: bookmakerName, matchName,
        action: 'RELINKED',
        fromPlayerId: currentPid, toPlayerId: target.id,
        oddsRows: ids.length,
        message: `Relinked to ${target.id.slice(0, 8)}… (${target.name}, team=${target.team})`,
      });
    }
  }

  return {
    totalOddsRows: odds.length,
    relinked,
    ambiguous,
    playerNotFound,
    alreadyLinked,
    errors,
    details,
  };
}

// ── Public API: Database Health Check ──

export interface DatabaseHealth {
  playersTotal: number;
  playerGameStatsTotal: number;
  bookmakerOddsTotal: number;
  brokenPlayerIdCount: number;
  zeroStatsOddsCount: number;
  statsBySeason: Array<{ season: number; count: number }>;
  errors: string[];
}

export async function getDatabaseHealth(): Promise<DatabaseHealth> {
  const errors: string[] = [];

  const { count: playersTotal } = await supabase
    .from('players')
    .select('*', { count: 'exact', head: true });

  const { count: playerGameStatsTotal } = await supabase
    .from('player_game_stats')
    .select('*', { count: 'exact', head: true });

  const { count: bookmakerOddsTotal } = await supabase
    .from('bookmaker_odds')
    .select('*', { count: 'exact', head: true });

  // Count odds with broken player_id (player_id not in players table)
  // Must actually check the join, not just count non-null player_ids
  let brokenPlayerIdCount = 0;
  let zeroStatsOddsCount = 0;
  try {
    const { data: oddsPlayerIds } = await supabase
      .from('bookmaker_odds')
      .select('player_id')
      .not('player_id', 'is', null);

    if (oddsPlayerIds) {
      const uniqueIds = [...new Set(oddsPlayerIds.map((r: any) => r.player_id))];

      // Check which player_ids exist in players table
      const { data: validPlayers } = await supabase
        .from('players')
        .select('id')
        .in('id', uniqueIds);
      const validIds = new Set((validPlayers ?? []).map((p: any) => p.id));

      // Check stats counts
      const statsMap = await fetchStatsCounts(uniqueIds);

      for (const id of uniqueIds) {
        if (!validIds.has(id)) {
          brokenPlayerIdCount++;
        }
        if ((statsMap.get(id) ?? 0) === 0) {
          zeroStatsOddsCount++;
        }
      }
    }
  } catch {
    // Skip if too complex
  }

  // Stats by season
  const statsBySeason: Array<{ season: number; count: number }> = [];
  for (const season of [2024, 2025, 2026]) {
    const { count } = await supabase
      .from('player_game_stats')
      .select('*', { count: 'exact', head: true })
      .eq('season', season);
    statsBySeason.push({ season, count: count ?? 0 });
  }

  return {
    playersTotal: playersTotal ?? 0,
    playerGameStatsTotal: playerGameStatsTotal ?? 0,
    bookmakerOddsTotal: bookmakerOddsTotal ?? 0,
    brokenPlayerIdCount: brokenPlayerIdCount ?? 0,
    zeroStatsOddsCount,
    statsBySeason,
    errors,
  };
}

// ── Complete Coverage for Selected Matches ──

export interface CoverageCompletionResult {
  matchIds: string[];
  totalOddsRows: number;
  uniquePlayers: number;
  alreadyHasStats: number;
  needsBackfill: number;
  relinkedLocally: number;
  playersCreated: number;
  backfillResult: BackfillResult | null;
  errors: string[];
  beforeCoverage: { totalOddsRows: number; withModel: number; noStats: number; insufficientSample: number; modelReady: number };
  afterCoverage: { totalOddsRows: number; withModel: number; noStats: number; insufficientSample: number; modelReady: number };
}

export async function completeCoverageForMatches(matchIds: string[]): Promise<CoverageCompletionResult> {
  const errors: string[] = [];
  if (matchIds.length === 0) {
    return {
      matchIds: [], totalOddsRows: 0, uniquePlayers: 0, alreadyHasStats: 0,
      needsBackfill: 0, relinkedLocally: 0, playersCreated: 0, backfillResult: null,
      errors: ['No matches selected'],
      beforeCoverage: { totalOddsRows: 0, withModel: 0, noStats: 0, insufficientSample: 0, modelReady: 0 },
      afterCoverage: { totalOddsRows: 0, withModel: 0, noStats: 0, insufficientSample: 0, modelReady: 0 },
    };
  }

  // Step 1: Fetch all odds rows for selected matches
  const { odds, errors: oddsErrors } = await fetchOddsForMatches(matchIds);
  errors.push(...oddsErrors);

  const matchMap = await fetchMatches(matchIds);
  const { byId: playersById, byNormName: playersByNormName } = await fetchAllPlayers();

  // Group odds by (normName, matchId) — same as audit
  const grouped = new Map<string, { rows: OddsRow[]; bookmakerName: string; matchId: string }>();
  for (const row of odds) {
    const normName = normalizeFullName(row.bookmaker_player_name);
    const key = `${normName}|${row.match_id}`;
    if (!grouped.has(key)) grouped.set(key, { rows: [], bookmakerName: row.bookmaker_player_name, matchId: row.match_id });
    grouped.get(key)!.rows.push(row);
  }

  // Collect all player_ids for stats check
  const allPlayerIdsSet = new Set<string>();
  for (const r of odds) {
    if (r.player_id) allPlayerIdsSet.add(r.player_id);
    const normName = normalizeFullName(r.bookmaker_player_name);
    const candidates = playersByNormName.get(normName) ?? [];
    for (const c of candidates) {
      allPlayerIdsSet.add(c.id);
    }
  }
  const allPlayerIds = [...allPlayerIdsSet];
  const statsCountMap = await fetchStatsCounts(allPlayerIds);

  let alreadyHasStats = 0;
  let relinkedLocally = 0;
  let playersCreated = 0;
  const needsBackfill: MissingPlayerPayload[] = [];

  for (const [, group] of grouped) {
    const firstRow = group.rows[0];
    const bookmakerName = group.bookmakerName;
    const matchId = group.matchId;
    const normName = normalizeFullName(bookmakerName);
    const matchInfo = matchMap.get(matchId);

    const currentPlayerId = firstRow.player_id;
    const playerRow = currentPlayerId ? playersById.get(currentPlayerId) : undefined;
    const currentStatsCount = currentPlayerId ? (statsCountMap.get(currentPlayerId) ?? 0) : 0;

    const derivedTeam = deriveTeam(currentPlayerId, playerRow, matchInfo, playersByNormName, bookmakerName);

    // Check if already has enough stats (>=15)
    if (currentStatsCount >= 15) {
      alreadyHasStats++;
      continue;
    }

    // Try local relink: find candidate with same exact full name + team that has stats
    const candidates = playersByNormName.get(normName) ?? [];
    let bestCandidate: PlayerRow | null = null;
    let bestCandidateStats = 0;

    for (const c of candidates) {
      if (c.id === currentPlayerId) continue;
      if (derivedTeam) {
        const cTeamNorm = normalizeTeam(c.team ?? '');
        if (cTeamNorm !== derivedTeam) continue;
      }
      const stats = statsCountMap.get(c.id) ?? 0;
      if (stats > bestCandidateStats) {
        bestCandidate = c;
        bestCandidateStats = stats;
      }
    }

    if (bestCandidate && bestCandidateStats >= 15) {
      // Relink locally
      const { error: relinkError } = await supabase
        .from('bookmaker_odds')
        .update({
          player_id: bestCandidate.id,
          resolved_player_name: bestCandidate.name,
          resolution_status: 'relinked_coverage',
        })
        .in('id', group.rows.map(r => r.id));

      if (relinkError) {
        errors.push(`Failed to relink ${bookmakerName}: ${relinkError.message}`);
      } else {
        relinkedLocally++;
      }
      continue;
    }

    // Needs backfill from Kali — add to payload
    needsBackfill.push({
      bookmaker_player_name: bookmakerName,
      current_player_id: currentPlayerId,
      match_id: matchId,
      home_team: matchInfo?.home_team ?? null,
      away_team: matchInfo?.away_team ?? null,
      season: matchInfo?.season ?? new Date().getFullYear(),
      round: matchInfo?.round ?? null,
      player_team: derivedTeam || null,
      odds_rows: group.rows.length,
    });
  }

  // Step 2: Run backfill via edge function for players that need it
  let backfillResult: BackfillResult | null = null;

  if (needsBackfill.length > 0) {
    const BATCH_SIZE = 10;
    const allDetails: any[] = [];
    let totalStatsInserted = 0;
    let totalOddsRelinked = 0;
    let totalPlayersCreated = 0;
    let totalExistingUpdated = 0;
    let totalStillMissing = 0;
    let totalFoundInKali = 0;
    const batchErrors: string[] = [];

    for (let i = 0; i < needsBackfill.length; i += BATCH_SIZE) {
      const batch = needsBackfill.slice(i, i + BATCH_SIZE);
      let batchSuccess = false;
      let retries = 0;
      const maxRetries = 3;

      while (!batchSuccess && retries < maxRetries) {
        try {
          const { data: invokeResult, error: invokeError } = await supabase.functions.invoke(
            'backfill-missing-player-stats',
            {
              body: JSON.stringify({
                action: 'backfill',
                missingPlayers: batch,
                seasons: [2024, 2025, 2026],
                batchSize: batch.length,
              }),
            }
          );

          if (invokeError) {
            retries++;
            if (retries >= maxRetries) {
              batchErrors.push(`Batch ${Math.floor(i / BATCH_SIZE) + 1} failed after ${maxRetries} retries: ${invokeError.message}`);
            } else {
              await new Promise(r => setTimeout(r, 2000 * retries));
            }
          } else {
            batchSuccess = true;
            const br = invokeResult as BackfillResult;
            totalStatsInserted += br.playerGameStatsRowsInserted ?? 0;
            totalOddsRelinked += br.bookmakerOddsRowsRelinked ?? 0;
            totalPlayersCreated += br.playersCreated ?? 0;
            totalExistingUpdated += br.existingPlayersUpdated ?? 0;
            totalStillMissing += br.playersStillMissing ?? 0;
            totalFoundInKali += br.playersFoundInKali ?? 0;
            allDetails.push(...(br.details ?? []));
            batchErrors.push(...(br.errors ?? []));

            // Auto-pause if rate limit low
            if (br.rateLimitRemaining != null && br.rateLimitRemaining < 20) {
              batchErrors.push(`Paused — rate limit low (${br.rateLimitRemaining} remaining). ${needsBackfill.length - i - batch.length} players still pending.`);
              break;
            }
          }
        } catch (err) {
          retries++;
          if (retries >= maxRetries) {
            batchErrors.push(`Batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
          } else {
            await new Promise(r => setTimeout(r, 2000 * retries));
          }
        }
      }
    }

    backfillResult = {
      success: batchErrors.length === 0,
      missingPlayersChecked: needsBackfill.length,
      playersFoundInKali: totalFoundInKali,
      playersCreated: totalPlayersCreated,
      existingPlayersUpdated: totalExistingUpdated,
      playerGameStatsRowsInserted: totalStatsInserted,
      bookmakerOddsRowsRelinked: totalOddsRelinked,
      playersStillMissing: totalStillMissing,
      errors: batchErrors,
      details: allDetails,
    };
    errors.push(...batchErrors);
  }

  return {
    matchIds,
    totalOddsRows: odds.length,
    uniquePlayers: grouped.size,
    alreadyHasStats,
    needsBackfill: needsBackfill.length,
    relinkedLocally,
    playersCreated: backfillResult?.playersCreated ?? 0,
    backfillResult,
    errors,
    beforeCoverage: { totalOddsRows: 0, withModel: 0, noStats: 0, insufficientSample: 0, modelReady: 0 },
    afterCoverage: { totalOddsRows: 0, withModel: 0, noStats: 0, insufficientSample: 0, modelReady: 0 },
  };
}

// ── Fix All NO STATS from DB (all selected matches) ──

export interface NoStatsFixResult {
  totalNoStatsPlayers: number;
  alreadyHasStats: number;
  relinkedToStatsPlayer: number;
  backfilled: number;
  failed: number;
  details: NoStatsFixDetail[];
  errors: string[];
  beforeCoverage: CoverageSnapshot;
  afterCoverage: CoverageSnapshot;
  perMatchCoverage: PerMatchCoverage[];
}

export interface CoverageSnapshot {
  totalOddsRows: number;
  withModel: number;
  noStatsOddsRows: number;
  noStatsUniquePlayers: number;
  insufficientSampleOddsRows: number;
  insufficientSampleUniquePlayers: number;
  multiReadyLegs: number;
}

export interface PerMatchCoverage {
  matchId: string;
  matchName: string;
  totalOddsRows: number;
  withModel: number;
  noStatsOddsRows: number;
  noStatsUniquePlayers: number;
  insufficientSampleOddsRows: number;
  insufficientSampleUniquePlayers: number;
  multiReadyLegs: number;
}

export interface NoStatsFixDetail {
  player_name: string;
  team: string | null;
  current_odds_player_id: string | null;
  current_odds_player_id_stats_count: number;
  matches_affected: number;
  match_names_affected: string[];
  odds_rows_affected: number;
  duplicate_stats_player_id: string | null;
  duplicate_stats_count: number;
  kali_player_found: boolean;
  stats_fetched: number;
  valid_rows_inserted: number;
  odds_relinked: number;
  final_status: NoStatsFixStatus;
  message: string;
}

export type NoStatsFixStatus =
  | 'FIXED_STATS_INSERTED'
  | 'ALREADY_HAS_STATS'
  | 'RELINKED_TO_STATS_PLAYER_ID'
  | 'INSUFFICIENT_SAMPLE_AFTER_INSERT'
  | 'NO_KALI_PLAYER_FOUND'
  | 'TEAM_NOT_CONFIRMED'
  | 'NO_VALID_STATS_ROWS'
  | 'NO_MATCH_DATE_AFTER_ENRICHMENT'
  | 'ERROR';

async function computeCoverageSnapshot(matchIds: string[], matchMap: Map<string, MatchInfo>): Promise<CoverageSnapshot> {
  const { odds, errors } = await fetchOddsForMatches(matchIds);
  const { byId: playersById, byNormName: playersByNormName } = await fetchAllPlayers();
  const allPlayerIdsSet = new Set<string>();
  for (const r of odds) {
    if (r.player_id) allPlayerIdsSet.add(r.player_id);
    const normName = normalizeFullName(r.bookmaker_player_name);
    const candidates = playersByNormName.get(normName) ?? [];
    for (const c of candidates) {
      allPlayerIdsSet.add(c.id);
    }
  }
  const allPlayerIds = [...allPlayerIdsSet];
  const statsCountMap = await fetchStatsCounts(allPlayerIds);

  let withModel = 0;
  let noStatsOddsRows = 0;
  let insufficientSampleOddsRows = 0;
  const noStatsPlayers = new Set<string>();
  const insufficientSamplePlayers = new Set<string>();

  // Group by player_name + match to avoid double counting
  const grouped = new Map<string, { rows: OddsRow[]; bookmakerName: string }>();
  for (const row of odds) {
    const normName = normalizeFullName(row.bookmaker_player_name);
    const key = `${normName}|${row.match_id}`;
    if (!grouped.has(key)) grouped.set(key, { rows: [], bookmakerName: row.bookmaker_player_name });
    grouped.get(key)!.rows.push(row);
  }

  for (const [, group] of grouped) {
    const firstRow = group.rows[0];
    const currentPlayerId = firstRow.player_id;
    const statsCount = currentPlayerId ? (statsCountMap.get(currentPlayerId) ?? 0) : 0;
    const playerRow = currentPlayerId ? playersById.get(currentPlayerId) : undefined;
    const matchInfo = matchMap.get(firstRow.match_id);
    const team = deriveTeam(currentPlayerId, playerRow, matchInfo, playersByNormName, group.bookmakerName);
    const playerKey = `${normalizeFullName(group.bookmakerName)}|${team}`;

    if (!currentPlayerId) {
      noStatsOddsRows += group.rows.length;
      noStatsPlayers.add(playerKey);
    } else if (statsCount === 0) {
      noStatsOddsRows += group.rows.length;
      noStatsPlayers.add(playerKey);
    } else if (statsCount < 15) {
      insufficientSampleOddsRows += group.rows.length;
      insufficientSamplePlayers.add(playerKey);
    } else {
      withModel += group.rows.length;
    }
  }

  return {
    totalOddsRows: odds.length,
    withModel,
    noStatsOddsRows,
    noStatsUniquePlayers: noStatsPlayers.size,
    insufficientSampleOddsRows,
    insufficientSampleUniquePlayers: insufficientSamplePlayers.size,
    multiReadyLegs: withModel,
  };
}

async function computePerMatchCoverage(matchIds: string[], matchMap: Map<string, MatchInfo>): Promise<PerMatchCoverage[]> {
  const results: PerMatchCoverage[] = [];
  const { byId: playersById, byNormName: playersByNormName } = await fetchAllPlayers();

  for (const matchId of matchIds) {
    const { odds } = await fetchOddsForMatches([matchId]);
    const allPlayerIdsSet = new Set<string>();
    for (const r of odds) {
      if (r.player_id) allPlayerIdsSet.add(r.player_id);
      const normName = normalizeFullName(r.bookmaker_player_name);
      const candidates = playersByNormName.get(normName) ?? [];
      for (const c of candidates) {
        allPlayerIdsSet.add(c.id);
      }
    }
    const allPlayerIds = [...allPlayerIdsSet];
    const statsCountMap = await fetchStatsCounts(allPlayerIds);
    const matchInfo = matchMap.get(matchId);
    const matchName = matchInfo ? `${matchInfo.home_team} vs ${matchInfo.away_team}` : matchId;

    let withModel = 0;
    let noStatsOddsRows = 0;
    let insufficientSampleOddsRows = 0;
    const noStatsPlayers = new Set<string>();
    const insufficientSamplePlayers = new Set<string>();

    const grouped = new Map<string, { rows: OddsRow[]; bookmakerName: string }>();
    for (const row of odds) {
      const normName = normalizeFullName(row.bookmaker_player_name);
      if (!grouped.has(normName)) grouped.set(normName, { rows: [], bookmakerName: row.bookmaker_player_name });
      grouped.get(normName)!.rows.push(row);
    }

    for (const [, group] of grouped) {
      const firstRow = group.rows[0];
      const currentPlayerId = firstRow.player_id;
      const statsCount = currentPlayerId ? (statsCountMap.get(currentPlayerId) ?? 0) : 0;
      const playerRow = currentPlayerId ? playersById.get(currentPlayerId) : undefined;
      const team = deriveTeam(currentPlayerId, playerRow, matchInfo, playersByNormName, group.bookmakerName);
      const playerKey = `${normalizeFullName(group.bookmakerName)}|${team}`;

      if (!currentPlayerId || statsCount === 0) {
        noStatsOddsRows += group.rows.length;
        noStatsPlayers.add(playerKey);
      } else if (statsCount < 15) {
        insufficientSampleOddsRows += group.rows.length;
        insufficientSamplePlayers.add(playerKey);
      } else {
        withModel += group.rows.length;
      }
    }

    results.push({
      matchId,
      matchName,
      totalOddsRows: odds.length,
      withModel,
      noStatsOddsRows,
      noStatsUniquePlayers: noStatsPlayers.size,
      insufficientSampleOddsRows,
      insufficientSampleUniquePlayers: insufficientSamplePlayers.size,
      multiReadyLegs: withModel,
    });
  }
  return results;
}

export async function fixAllNoStatsFromDb(
  matchIds: string[]
): Promise<NoStatsFixResult> {
  const errors: string[] = [];
  const details: NoStatsFixDetail[] = [];

  if (matchIds.length === 0) {
    return {
      totalNoStatsPlayers: 0, alreadyHasStats: 0, relinkedToStatsPlayer: 0,
      backfilled: 0, failed: 0, details: [], errors: ['No matches selected'],
      beforeCoverage: { totalOddsRows: 0, withModel: 0, noStatsOddsRows: 0, noStatsUniquePlayers: 0, insufficientSampleOddsRows: 0, insufficientSampleUniquePlayers: 0, multiReadyLegs: 0 },
      afterCoverage: { totalOddsRows: 0, withModel: 0, noStatsOddsRows: 0, noStatsUniquePlayers: 0, insufficientSampleOddsRows: 0, insufficientSampleUniquePlayers: 0, multiReadyLegs: 0 },
      perMatchCoverage: [],
    };
  }

  // Step 1: Fetch ALL odds for ALL selected matches from DB
  const { odds, errors: oddsErrors } = await fetchOddsForMatches(matchIds);
  errors.push(...oddsErrors);

  const matchMap = await fetchMatches(matchIds);
  const { byId: playersById, byNormName: playersByNormName } = await fetchAllPlayers();

  // Compute before coverage
  const beforeCoverage = await computeCoverageSnapshot(matchIds, matchMap);

  // Group odds by normalized full name + team (unique player, not per odds row)
  const grouped = new Map<string, {
    rows: OddsRow[];
    bookmakerName: string;
    matchIds: Set<string>;
    matchNames: string[];
  }>();

  for (const row of odds) {
    const normName = normalizeFullName(row.bookmaker_player_name);
    const matchInfo = matchMap.get(row.match_id);
    const playerRow = row.player_id ? playersById.get(row.player_id) : undefined;
    const team = deriveTeam(row.player_id, playerRow, matchInfo, playersByNormName, row.bookmaker_player_name);
    const key = `${normName}|${team}`;

    if (!grouped.has(key)) {
      grouped.set(key, {
        rows: [],
        bookmakerName: row.bookmaker_player_name,
        matchIds: new Set(),
        matchNames: [],
      });
    }
    const g = grouped.get(key)!;
    g.rows.push(row);
    if (!g.matchIds.has(row.match_id)) {
      g.matchIds.add(row.match_id);
      const m = matchMap.get(row.match_id);
      g.matchNames.push(m ? `${m.home_team} vs ${m.away_team}` : row.match_id);
    }
  }

  // Collect all player_ids for stats check
  const allPlayerIdsSet = new Set<string>();
  for (const r of odds) {
    if (r.player_id) allPlayerIdsSet.add(r.player_id);
    const normName = normalizeFullName(r.bookmaker_player_name);
    const candidates = playersByNormName.get(normName) ?? [];
    for (const c of candidates) {
      allPlayerIdsSet.add(c.id);
    }
  }
  const allPlayerIds = [...allPlayerIdsSet];
  const statsCountMap = await fetchStatsCounts(allPlayerIds);

  // Identify NO_STATS players and build repair jobs
  const needsBackfill: MissingPlayerPayload[] = [];
  let alreadyHasStats = 0;
  let relinkedToStatsPlayer = 0;

  for (const [key, group] of grouped) {
    const firstRow = group.rows[0];
    const bookmakerName = group.bookmakerName;
    const currentPlayerId = firstRow.player_id;
    const currentStatsCount = currentPlayerId ? (statsCountMap.get(currentPlayerId) ?? 0) : 0;
    const playerRow = currentPlayerId ? playersById.get(currentPlayerId) : undefined;
    const matchInfo = matchMap.get(firstRow.match_id);
    const team = deriveTeam(currentPlayerId, playerRow, matchInfo, playersByNormName, bookmakerName);
    const matchIdsList = [...group.matchIds];
    const matchNamesList = group.matchNames;

    // Skip if current player_id already has 15+ stats
    if (currentPlayerId && currentStatsCount >= 15) {
      alreadyHasStats++;
      details.push({
        player_name: bookmakerName, team, current_odds_player_id: currentPlayerId,
        current_odds_player_id_stats_count: currentStatsCount,
        matches_affected: matchIdsList.length, match_names_affected: matchNamesList,
        odds_rows_affected: group.rows.length,
        duplicate_stats_player_id: null, duplicate_stats_count: 0,
        kali_player_found: false, stats_fetched: 0, valid_rows_inserted: 0, odds_relinked: 0,
        final_status: 'ALREADY_HAS_STATS', message: `Already has ${currentStatsCount} stats rows`,
      });
      continue;
    }

    // Check for duplicate player with same exact name + team that has stats
    const normName = normalizeFullName(bookmakerName);
    const candidates = playersByNormName.get(normName) ?? [];
    let bestCandidate: PlayerRow | null = null;
    let bestCandidateStats = 0;

    for (const c of candidates) {
      if (c.id === currentPlayerId) continue;
      if (team) {
        const cTeamNorm = normalizeTeam(c.team ?? '');
        if (cTeamNorm !== team) continue;
      }
      const stats = statsCountMap.get(c.id) ?? 0;
      if (stats > bestCandidateStats) {
        bestCandidate = c;
        bestCandidateStats = stats;
      }
    }

    // If found a duplicate with 15+ stats, relink ALL odds rows across ALL matches
    if (bestCandidate && bestCandidateStats >= 15) {
      const allRowIds = group.rows.map(r => r.id);
      const { error: relinkError } = await supabase
        .from('bookmaker_odds')
        .update({
          player_id: bestCandidate.id,
          resolved_player_name: bestCandidate.name,
          resolution_status: 'relinked_no_stats_fix',
        })
        .in('id', allRowIds);

      if (relinkError) {
        errors.push(`Failed to relink ${bookmakerName}: ${relinkError.message}`);
      } else {
        relinkedToStatsPlayer++;
        details.push({
          player_name: bookmakerName, team,
          current_odds_player_id: currentPlayerId,
          current_odds_player_id_stats_count: currentStatsCount,
          matches_affected: matchIdsList.length, match_names_affected: matchNamesList,
          odds_rows_affected: group.rows.length,
          duplicate_stats_player_id: bestCandidate.id,
          duplicate_stats_count: bestCandidateStats,
          kali_player_found: false, stats_fetched: 0, valid_rows_inserted: 0,
          odds_relinked: allRowIds.length,
          final_status: 'RELINKED_TO_STATS_PLAYER_ID',
          message: `Relinked to ${bestCandidate.name} (${bestCandidate.id.slice(0, 8)}) with ${bestCandidateStats} stats rows`,
        });
        continue;
      }
    }

    // Needs Kali backfill
    needsBackfill.push({
      bookmaker_player_name: bookmakerName,
      current_player_id: currentPlayerId,
      match_id: matchIdsList[0],
      home_team: matchInfo?.home_team ?? null,
      away_team: matchInfo?.away_team ?? null,
      season: matchInfo?.season ?? new Date().getFullYear(),
      round: matchInfo?.round ?? null,
      player_team: team || null,
      odds_rows: group.rows.length,
    });
  }

  // Step 2: Run backfill via edge function in stable batches
  let backfilled = 0;
  let failed = 0;

  if (needsBackfill.length > 0) {
    const BATCH_SIZE = 10;

    for (let i = 0; i < needsBackfill.length; i += BATCH_SIZE) {
      const batch = needsBackfill.slice(i, i + BATCH_SIZE);
      let batchSuccess = false;
      let retries = 0;
      const maxRetries = 3;
      let batchDetails: any[] = [];

      while (!batchSuccess && retries < maxRetries) {
        try {
          const { data: invokeResult, error: invokeError } = await supabase.functions.invoke(
            'backfill-missing-player-stats',
            {
              body: JSON.stringify({
                action: 'backfill',
                missingPlayers: batch,
                seasons: [2024, 2025, 2026],
                batchSize: batch.length,
              }),
            }
          );

          if (invokeError) {
            retries++;
            if (retries >= maxRetries) {
              errors.push(`Batch ${Math.floor(i / BATCH_SIZE) + 1} failed after ${maxRetries} retries: ${invokeError.message}`);
            } else {
              await new Promise(r => setTimeout(r, 2000 * retries));
            }
          } else {
            batchSuccess = true;
            const br = invokeResult as BackfillResult;
            batchDetails = br.details ?? [];
            errors.push(...(br.errors ?? []));

            if (br.rateLimitRemaining != null && br.rateLimitRemaining < 20) {
              errors.push(`Paused — rate limit low (${br.rateLimitRemaining} remaining). ${needsBackfill.length - i - batch.length} players still pending.`);
              break;
            }
          }
        } catch (err) {
          retries++;
          if (retries >= maxRetries) {
            errors.push(`Batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
          } else {
            await new Promise(r => setTimeout(r, 2000 * retries));
          }
        }
      }

      // Map batch results to player-level details
      for (const mp of batch) {
        const batchDetail = batchDetails.find(
          (d: any) => normalizeFullName(d.playerName) === normalizeFullName(mp.bookmaker_player_name)
        );
        const matchingGroup = grouped.get(`${normalizeFullName(mp.bookmaker_player_name)}|${mp.player_team ?? ''}`);
        const matchIdsList = matchingGroup ? [...matchingGroup.matchIds] : [mp.match_id];
        const matchNamesList = matchingGroup ? matchingGroup.matchNames : [];

        if (batchDetail) {
          const statsInserted = batchDetail.statsInserted ?? 0;
          let status: NoStatsFixStatus;
          if (statsInserted >= 15) {
            status = 'FIXED_STATS_INSERTED';
            backfilled++;
          } else if (statsInserted > 0 && statsInserted < 15) {
            status = 'INSUFFICIENT_SAMPLE_AFTER_INSERT';
            backfilled++;
          } else if (batchDetail.message?.includes('not found in Kali')) {
            status = 'NO_KALI_PLAYER_FOUND';
            failed++;
          } else if (batchDetail.message?.includes('team')) {
            status = 'TEAM_NOT_CONFIRMED';
            failed++;
          } else if (batchDetail.message?.includes('no valid stats')) {
            status = 'NO_VALID_STATS_ROWS';
            failed++;
          } else if (batchDetail.message?.includes('match_date')) {
            status = 'NO_MATCH_DATE_AFTER_ENRICHMENT';
            failed++;
          } else if (batchDetail.action === 'UPDATED' && statsInserted === 0) {
            status = 'ALREADY_HAS_STATS';
            alreadyHasStats++;
          } else {
            status = 'ERROR';
            failed++;
          }

          details.push({
            player_name: mp.bookmaker_player_name,
            team: mp.player_team,
            current_odds_player_id: mp.current_player_id,
            current_odds_player_id_stats_count: mp.current_player_id ? (statsCountMap.get(mp.current_player_id) ?? 0) : 0,
            matches_affected: matchIdsList.length,
            match_names_affected: matchNamesList,
            odds_rows_affected: mp.odds_rows,
            duplicate_stats_player_id: null,
            duplicate_stats_count: 0,
            kali_player_found: !batchDetail.message?.includes('not found in Kali'),
            stats_fetched: statsInserted,
            valid_rows_inserted: statsInserted,
            odds_relinked: batchDetail.oddsRelinked ?? 0,
            final_status: status,
            message: batchDetail.message ?? '',
          });
        } else if (!batchSuccess) {
          failed++;
          details.push({
            player_name: mp.bookmaker_player_name,
            team: mp.player_team,
            current_odds_player_id: mp.current_player_id,
            current_odds_player_id_stats_count: mp.current_player_id ? (statsCountMap.get(mp.current_player_id) ?? 0) : 0,
            matches_affected: matchIdsList.length,
            match_names_affected: matchNamesList,
            odds_rows_affected: mp.odds_rows,
            duplicate_stats_player_id: null,
            duplicate_stats_count: 0,
            kali_player_found: false, stats_fetched: 0, valid_rows_inserted: 0, odds_relinked: 0,
            final_status: 'ERROR', message: 'Batch failed after 3 retries',
          });
        }
      }

      if (i + BATCH_SIZE < needsBackfill.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }

  // Compute after coverage
  const afterCoverage = await computeCoverageSnapshot(matchIds, matchMap);
  const perMatchCoverage = await computePerMatchCoverage(matchIds, matchMap);

  return {
    totalNoStatsPlayers: needsBackfill.length + alreadyHasStats + relinkedToStatsPlayer,
    alreadyHasStats,
    relinkedToStatsPlayer,
    backfilled,
    failed,
    details,
    errors,
    beforeCoverage,
    afterCoverage,
    perMatchCoverage,
  };
}
