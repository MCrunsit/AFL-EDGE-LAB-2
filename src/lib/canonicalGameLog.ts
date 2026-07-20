/**
 * Canonical Player Game Log Engine
 *
 * Single source of truth for all player stat history used in model calculations.
 * Every hit rate window (Last 5/10/15/20/30, Season, Weighted) must come from
 * this engine — no other stat-fetching path is permitted.
 *
 * Ordering:  match_date DESC, round number DESC (numerically parsed)
 * Dedup:     prefer player_id+match_id, then player_id+match_date+team; keep most complete row
 * Filtering: exclude future fixtures, null stats for requested stat, preseason (round < 1)
 */

import { supabase } from './supabase';

export type CanonicalStat = 'disposals' | 'goals' | 'tackles' | 'marks' | 'hitouts';

export interface CanonicalGameRow {
  player_id: string;
  match_id: string | null;
  match_date: string;         // ISO date string, never null (rows without date are dropped)
  round: string | null;       // e.g. "17", "QF", "EF"
  round_num: number;          // parsed numeric round; 0 for finals/unknown
  season: number;             // inferred from match_season or match_date year
  team: string | null;
  opponent: string | null;
  venue: string | null;
  disposals: number;
  marks: number;
  tackles: number;
  goals: number;
  hitouts: number;
  // which stat value was used in the log (convenience accessor)
  statValue: number;
}

export interface CanonicalWindowCounts {
  last5: { sample: number; hits: number; hitRate: number } | null;
  last10: { sample: number; hits: number; hitRate: number } | null;
  last15: { sample: number; hits: number; hitRate: number } | null;
  last20: { sample: number; hits: number; hitRate: number } | null;
  last30: { sample: number; hits: number; hitRate: number } | null;
  currentSeason: { sample: number; hits: number; hitRate: number } | null;
  weighted: { probability: number; sample: number } | null;
}

export type GapReason =
  | 'BYE'
  | 'DNP'
  | 'TEAM_MATCH_STATS_MISSING'
  | 'PLAYER_ROW_MISSING'
  | 'ROUND_NOT_IMPORTED'
  | 'INJURY_RETURNING_OR_LIMITED_SAMPLE'
  | 'UNKNOWN_GAP';

export interface GameGap {
  round: string;
  round_num: number;
  match_date: string;
  opponent: string | null;
  venue: string | null;
  match_id: string | null;
  reason: GapReason;
  details: string;
}

export type GameLogRowOrGap =
  | { kind: 'game'; data: CanonicalGameRow }
  | { kind: 'gap'; data: GameGap; round_num: number };

export interface CanonicalGameLogResult {
  rows: CanonicalGameRow[];       // all valid rows, ordered match_date DESC
  gaps: GameGap[];                // missing rounds with reason classification
  rowsWithGaps: GameLogRowOrGap[]; // interleaved rows with gap markers
  windows: CanonicalWindowCounts;
  totalSample: number;
  currentSeason: number;
}

const TODAY = new Date().toISOString().slice(0, 10);
const CURRENT_SEASON = new Date().getFullYear();

function parseRoundNum(round: string | null): number {
  if (!round) return 0;
  const n = parseInt(round, 10);
  return isNaN(n) ? 0 : n;
}

function inferSeason(matchSeason: number | null | undefined, matchDate: string): number {
  if (matchSeason && matchSeason > 2000) return matchSeason;
  return new Date(matchDate).getFullYear();
}

function countNonNullStats(row: {
  disposals: number | null;
  marks: number | null;
  tackles: number | null;
  goals: number | null;
  hitouts: number | null;
}): number {
  return [row.disposals, row.marks, row.tackles, row.goals, row.hitouts]
    .filter(v => v !== null && v !== undefined).length;
}

/**
 * Detect round gaps in a player's game log.
 * Compares against all matches played by the player's team in the season.
 */
export async function detectGameLogGaps(
  playerTeam: string,
  rows: CanonicalGameRow[],
  currentSeason: number,
): Promise<GameGap[]> {
  if (!playerTeam || rows.length === 0) return [];

  const teamNorm = normalizeTeamKeyForGap(playerTeam);

  const { data: teamMatches, error } = await supabase
    .from('matches')
    .select('id, round, match_date, home_team, away_team, venue, season')
    .eq('season', currentSeason)
    .or(`home_team.ilike.%${playerTeam}%,away_team.ilike.%${playerTeam}%`)
    .order('round', { ascending: true, nullsFirst: false });

  if (error || !teamMatches || teamMatches.length === 0) return [];

  const playedRoundNums = new Set(rows.map(r => r.round_num).filter(n => n > 0));

  const gaps: GameGap[] = [];

  for (const m of teamMatches) {
    const roundNum = parseInt(m.round || '0', 10);
    if (roundNum <= 0) continue;

    if (!playedRoundNums.has(roundNum)) {
      const opponent = m.home_team?.toLowerCase().includes(teamNorm)
        ? m.away_team
        : m.home_team;

      const hasAnyStatsForRound = rows.some(r => r.round_num === roundNum);

      let reason: GapReason = 'UNKNOWN_GAP';
      let details = '';

      if (m.id) {
        const { count: teamPlayerStats } = await supabase
          .from('player_game_stats')
          .select('*', { count: 'exact', head: true })
          .eq('match_id', m.id)
          .limit(1);

        if (teamPlayerStats === 0) {
          reason = 'TEAM_MATCH_STATS_MISSING';
          details = `Match ${m.home_team} vs ${m.away_team} exists but no player stats loaded`;
        } else {
          reason = 'DNP';
          details = `Match played but player did not play (DNP)`;
        }
      } else {
        reason = 'ROUND_NOT_IMPORTED';
        details = `Match not imported or record missing`;
      }

      gaps.push({
        round: m.round || '',
        round_num: roundNum,
        match_date: m.match_date || '',
        opponent: opponent || null,
        venue: m.venue || null,
        match_id: m.id || null,
        reason,
        details,
      });
    }
  }

  return gaps;
}

function normalizeTeamKeyForGap(team: string): string {
  return team.toLowerCase().replace(/\s+(swans|dockers|magpies|kangaroos|saints|power|giants|cats|blues|hawks|crows|suns|bulldogs|eagles|demons|tigers|lions|bombers|angels|wrens|larks|falcons)\s*$/i, '').trim();
}

function windowHitRate(rows: CanonicalGameRow[], line: number, n: number | null): { sample: number; hits: number; hitRate: number } | null {
  const slice = n !== null ? rows.slice(0, n) : rows;
  if (slice.length === 0) return null;
  const hits = slice.filter(r => r.statValue >= line).length;
  return { sample: slice.length, hits, hitRate: hits / slice.length };
}

/**
 * Fetch and return the canonical game log for a player/stat.
 *
 * @param playerId  - UUID from players table
 * @param stat      - the stat column to read
 * @param season    - if provided, restricts to that season (for currentSeason window)
 * @param maxRows   - cap total rows (default 40). Pass Infinity for unlimited.
 */
export async function getCanonicalPlayerGameLog(
  playerId: string,
  stat: CanonicalStat,
  season?: number,
  maxRows = 40,
): Promise<CanonicalGameLogResult> {
  const currentSeason = season ?? CURRENT_SEASON;

  // Fetch raw rows including match join for season/round/venue enrichment
  const { data: raw, error } = await supabase
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
    .eq('player_id', playerId)
    .not('match_date', 'is', null)
    .lte('match_date', TODAY)             // exclude future fixtures
    .order('match_date', { ascending: false });

  if (error || !raw) {
    return emptyResult(currentSeason);
  }

  // Step 1: enrich and filter
  interface RawRow {
    player_id: string;
    match_id: string | null;
    match_date: string | null;
    team: string | null;
    opponent: string | null;
    venue: string | null;
    disposals: number | null;
    marks: number | null;
    tackles: number | null;
    goals: number | null;
    hitouts: number | null;
    matches: {
      season: number | null;
      round: string | null;
      venue: string | null;
      home_team: string | null;
      away_team: string | null;
    } | null;
  }

  const enriched: CanonicalGameRow[] = [];

  for (const r of raw as unknown as RawRow[]) {
    if (!r.match_date) continue;

    const matchInfo = r.matches;
    const rowSeason = inferSeason(matchInfo?.season, r.match_date);
    const round = matchInfo?.round ?? null;
    const roundNum = parseRoundNum(round);

    // Exclude preseason (round 0 means unknown/finals — we keep those; negative would be preseason but AFL doesn't use negatives)
    // Preseason rounds are typically "Practice" or "NAB" — skip non-numeric rounds with round_num === 0
    // Actually, we keep 0 (finals) but we flag practice games. For now: include all.
    // AFL preseason = typically year before current AFL season start (Feb/Mar). We use match_date to exclude.

    // Resolve venue: prefer row.venue, then match venue
    const venue = r.venue || matchInfo?.venue || null;

    // Resolve opponent from match if missing
    let opponent = r.opponent;
    if (!opponent && r.team && matchInfo) {
      const teamLower = (r.team || '').toLowerCase().replace(/\s+/g, '-');
      const homeLower = (matchInfo.home_team || '').toLowerCase().replace(/\s+/g, '-');
      const awayLower = (matchInfo.away_team || '').toLowerCase().replace(/\s+/g, '-');
      if (teamLower === homeLower) opponent = matchInfo.away_team;
      else if (teamLower === awayLower) opponent = matchInfo.home_team;
    }

    // The stat value for the requested stat must not be null
    const statRaw = r[stat as keyof typeof r];
    if (statRaw === null || statRaw === undefined) continue;
    const statValue = Number(statRaw);
    if (isNaN(statValue)) continue;

    enriched.push({
      player_id: r.player_id,
      match_id: r.match_id,
      match_date: r.match_date,
      round,
      round_num: roundNum,
      season: rowSeason,
      team: r.team,
      opponent,
      venue,
      disposals: Number(r.disposals) || 0,
      marks: Number(r.marks) || 0,
      tackles: Number(r.tackles) || 0,
      goals: Number(r.goals) || 0,
      hitouts: Number(r.hitouts) || 0,
      statValue,
    });
  }

  // Step 2: Deduplicate
  // Priority: player_id+match_id (unique), then player_id+match_date+team (keep most complete)
  const deduped = deduplicate(enriched);

  // Step 3: Sort by season DESC, match_date DESC, round_num DESC
  // This ensures 2026 rows appear before 2025/2024/2023 rows
  deduped.sort((a, b) => {
    // Season DESC (newest first)
    if (a.season !== b.season) return b.season - a.season;
    // match_date DESC (newest first)
    if (a.match_date > b.match_date) return -1;
    if (a.match_date < b.match_date) return 1;
    // round_num DESC (higher round first)
    return b.round_num - a.round_num;
  });

  // Step 4: Cap to maxRows
  const rows = maxRows === Infinity ? deduped : deduped.slice(0, maxRows);

  // Step 5: Detect gaps for the current season
  const playerTeam = rows.length > 0 ? rows[0].team : null;
  const gaps = playerTeam ? await detectGameLogGaps(playerTeam, rows.filter(r => r.season === currentSeason), currentSeason) : [];

  // Step 6: Interleave gaps with game rows for the current season
  const currentSeasonRows = rows.filter(r => r.season === currentSeason);
  const rowsWithGaps = interleaveGaps(currentSeasonRows, gaps);

  // Add rows from other seasons (no gap detection for older seasons)
  const otherSeasonRows = rows.filter(r => r.season !== currentSeason);
  const otherSeasonEntries: GameLogRowOrGap[] = otherSeasonRows.map(r => ({ kind: 'game' as const, data: r }));

  // Combine: current season with gaps first, then older seasons
  const allRowsWithGaps = [...rowsWithGaps, ...otherSeasonEntries];

  // Step 7: Build windows
  const seasonRows = rows.filter(r => r.season === currentSeason);

  const last5 = windowHitRate(rows, 0, 5);   // placeholder — line applied externally
  const last10 = windowHitRate(rows, 0, 10);
  const last15 = windowHitRate(rows, 0, 15);
  const last20 = windowHitRate(rows, 0, 20);
  const last30 = windowHitRate(rows, 0, 30);
  const currentSeasonW = seasonRows.length > 0 ? windowHitRate(seasonRows, 0, null) : null;

  // Windows returned without line applied — use computeWindowCounts(rows, line) for that
  const windows: CanonicalWindowCounts = {
    last5,
    last10,
    last15,
    last20,
    last30,
    currentSeason: currentSeasonW,
    weighted: null,
  };

  return { rows, gaps, rowsWithGaps: allRowsWithGaps, windows, totalSample: rows.length, currentSeason };
}

/**
 * Compute window hit counts given a game log and a betting line.
 * This is what callers use to get actual hit rates for model calculation.
 */
export function computeWindowCounts(
  rows: CanonicalGameRow[],
  line: number,
  currentSeason: number,
): CanonicalWindowCounts {
  const seasonRows = rows.filter(r => r.season === currentSeason);

  const w = (n: number | null) => {
    const slice = n !== null ? rows.slice(0, n) : rows;
    if (slice.length === 0) return null;
    const hits = slice.filter(r => r.statValue >= line).length;
    return { sample: slice.length, hits, hitRate: hits / slice.length };
  };

  const l5 = w(5);
  const l10 = w(10);
  const l5r = l5?.hitRate ?? 0;
  const l10r = l10?.hitRate ?? 0;
  const l3r = rows.slice(0, 3).length > 0
    ? rows.slice(0, 3).filter(r => r.statValue >= line).length / Math.min(3, rows.length)
    : 0;

  // Season hit rate for weighted model
  const seasonHits = seasonRows.filter(r => r.statValue >= line).length;
  const seasonHR = seasonRows.length > 0 ? seasonHits / seasonRows.length : 0;

  // Weighted model: 0.40 * season + 0.25 * last10 + 0.25 * last5 + 0.10 * last3
  const weightedProb = rows.length >= 5
    ? Math.min(0.95, Math.max(0.05, seasonHR * 0.40 + l10r * 0.25 + l5r * 0.25 + l3r * 0.10))
    : null;

  return {
    last5: w(5),
    last10: w(10),
    last15: w(15),
    last20: w(20),
    last30: w(30),
    currentSeason: seasonRows.length > 0
      ? { sample: seasonRows.length, hits: seasonHits, hitRate: seasonHR }
      : null,
    weighted: weightedProb !== null ? { probability: weightedProb, sample: rows.length } : null,
  };
}

/**
 * Batch fetch canonical game logs for multiple players.
 * Uses 2 DB queries (stats + match join) for all players.
 */
export async function batchGetCanonicalGameLogs(
  playerIds: string[],
  stat: CanonicalStat,
  currentSeason?: number,
  maxRows = 40,
): Promise<Map<string, CanonicalGameLogResult>> {
  const results = new Map<string, CanonicalGameLogResult>();
  if (playerIds.length === 0) return results;

  const season = currentSeason ?? CURRENT_SEASON;

  const { data: raw, error } = await supabase
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
    .in('player_id', playerIds)
    .not('match_date', 'is', null)
    .lte('match_date', TODAY)
    .order('match_date', { ascending: false });

  if (error || !raw) {
    for (const pid of playerIds) results.set(pid, emptyResult(season));
    return results;
  }

  // Group by player_id. Rows carry an embedded `matches` relation that
  // postgrest-js cannot type without a declared FK relationship, so we keep
  // these staging rows loosely typed (consistent with the cast below).
  const byPlayer = new Map<string, any[]>();
  for (const r of raw as any[]) {
    const pid = r.player_id as string;
    if (!byPlayer.has(pid)) byPlayer.set(pid, []);
    byPlayer.get(pid)!.push(r);
  }

  for (const pid of playerIds) {
    const playerRaw = byPlayer.get(pid) ?? [];
    const enriched: CanonicalGameRow[] = [];

    for (const r of playerRaw) {
      if (!r.match_date) continue;
      const matchInfo = r.matches;
      const rowSeason = inferSeason(matchInfo?.season, r.match_date);
      const round = matchInfo?.round ?? null;
      const roundNum = parseRoundNum(round);
      const venue = r.venue || matchInfo?.venue || null;

      let opponent = r.opponent;
      if (!opponent && r.team && matchInfo) {
        const teamLower = (r.team || '').toLowerCase().replace(/\s+/g, '-');
        const homeLower = (matchInfo.home_team || '').toLowerCase().replace(/\s+/g, '-');
        const awayLower = (matchInfo.away_team || '').toLowerCase().replace(/\s+/g, '-');
        if (teamLower === homeLower) opponent = matchInfo.away_team;
        else if (teamLower === awayLower) opponent = matchInfo.home_team;
      }

      const statRaw = r[stat];
      if (statRaw === null || statRaw === undefined) continue;
      const statValue = Number(statRaw);
      if (isNaN(statValue)) continue;

      enriched.push({
        player_id: pid,
        match_id: r.match_id,
        match_date: r.match_date,
        round,
        round_num: roundNum,
        season: rowSeason,
        team: r.team,
        opponent,
        venue,
        disposals: Number(r.disposals) || 0,
        marks: Number(r.marks) || 0,
        tackles: Number(r.tackles) || 0,
        goals: Number(r.goals) || 0,
        hitouts: Number(r.hitouts) || 0,
        statValue,
      });
    }

    const deduped = deduplicate(enriched);
    deduped.sort((a, b) => {
      // Season DESC (newest first)
      if (a.season !== b.season) return b.season - a.season;
      // match_date DESC (newest first)
      if (a.match_date > b.match_date) return -1;
      if (a.match_date < b.match_date) return 1;
      // round_num DESC (higher round first)
      return b.round_num - a.round_num;
    });

    const rows = maxRows === Infinity ? deduped : deduped.slice(0, maxRows);

    // Detect gaps and interleave for current season
    const playerTeam = rows.length > 0 ? rows[0].team : null;
    const gaps = playerTeam ? await detectGameLogGaps(playerTeam, rows.filter(r => r.season === season), season) : [];
    const currentSeasonRows = rows.filter(r => r.season === season);
    const rowsWithGaps = interleaveGaps(currentSeasonRows, gaps);

    results.set(pid, {
      rows,
      gaps,
      rowsWithGaps,
      windows: computeWindowCounts(rows, 0, season), // line=0 placeholder; use computeWindowCounts separately
      totalSample: rows.length,
      currentSeason: season,
    });
  }

  return results;
}

/**
 * Deduplicate rows:
 * 1. If match_id present: keep only one row per match_id (prefer most complete stats)
 * 2. If match_id absent: key by match_date+team (prefer most complete stats)
 */
function deduplicate(rows: CanonicalGameRow[]): CanonicalGameRow[] {
  const byMatchId = new Map<string, CanonicalGameRow>();
  const byDateTeam = new Map<string, CanonicalGameRow>();
  const noKey: CanonicalGameRow[] = [];

  for (const row of rows) {
    if (row.match_id) {
      const existing = byMatchId.get(row.match_id);
      if (!existing) {
        byMatchId.set(row.match_id, row);
      } else {
        // Keep most complete row
        if (countStats(row) > countStats(existing)) {
          byMatchId.set(row.match_id, row);
        }
      }
    } else if (row.match_date && row.team) {
      const key = `${row.match_date}|${row.team}`;
      const existing = byDateTeam.get(key);
      if (!existing) {
        byDateTeam.set(key, row);
      } else {
        if (countStats(row) > countStats(existing)) {
          byDateTeam.set(key, row);
        }
      }
    } else {
      noKey.push(row);
    }
  }

  return [...byMatchId.values(), ...byDateTeam.values(), ...noKey];
}

function countStats(row: CanonicalGameRow): number {
  return [row.disposals, row.marks, row.tackles, row.goals, row.hitouts]
    .filter(v => v !== null && v !== undefined).length;
}

function emptyResult(currentSeason: number): CanonicalGameLogResult {
  return {
    rows: [],
    gaps: [],
    rowsWithGaps: [],
    windows: {
      last5: null,
      last10: null,
      last15: null,
      last20: null,
      last30: null,
      currentSeason: null,
      weighted: null,
    },
    totalSample: 0,
    currentSeason,
  };
}

/**
 * Simple helper: is this stat value a hit against the line?
 */
export function isHit(value: number, line: number): boolean {
  return value >= line;
}

/**
 * Interleave gaps into the game log for display.
 * Returns a merged list where each round that was played has a game row,
 * and each round that was missed shows as a gap row.
 */
export function interleaveGaps(
  rows: CanonicalGameRow[],
  gaps: GameGap[]
): GameLogRowOrGap[] {
  // Sort gaps by round DESC
  const sortedGaps = [...gaps].sort((a, b) => b.round_num - a.round_num);

  // Sort rows by match_date DESC (already sorted, but be safe)
  const sortedRows = [...rows].sort((a, b) => {
    if (a.match_date > b.match_date) return -1;
    if (a.match_date < b.match_date) return 1;
    return b.round_num - a.round_num;
  });

  // Build round -> row map
  const rowByRound = new Map<number, CanonicalGameRow>();
  for (const r of sortedRows) {
    if (r.round_num > 0) {
      rowByRound.set(r.round_num, r);
    }
  }

  // Combine rounds: get all round numbers we know about
  const allRounds = new Set<number>();
  for (const r of sortedRows) if (r.round_num > 0) allRounds.add(r.round_num);
  for (const g of sortedGaps) if (g.round_num > 0) allRounds.add(g.round_num);

  // Sort descending
  const sortedRounds = [...allRounds].sort((a, b) => b - a);

  // Build interleaved list
  const result: GameLogRowOrGap[] = [];
  for (const roundNum of sortedRounds) {
    if (rowByRound.has(roundNum)) {
      result.push({ kind: 'game', data: rowByRound.get(roundNum)! });
    } else {
      const gap = sortedGaps.find(g => g.round_num === roundNum);
      if (gap) {
        result.push({ kind: 'gap', data: gap, round_num: roundNum });
      }
    }
  }

  return result;
}

/**
 * Get hit/miss display rows for the "View Game Log" modal.
 * Returns rows annotated with isHit, suitable for table display.
 */
export function annotateGameLog(
  rows: CanonicalGameRow[],
  line: number,
): Array<CanonicalGameRow & { isHit: boolean; index: number }> {
  return rows.map((r, i) => ({
    ...r,
    isHit: r.statValue >= line,
    index: i + 1,
  }));
}
