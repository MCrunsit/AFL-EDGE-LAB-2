/**
 * Team-match possession aggregation — the single shared source for Team
 * Stats, Team Environment, matchup intelligence and Player Intelligence.
 *
 * Produces exactly two records per completed match (one per side), each with
 * disposals/contested/uncontested/total possessions "for" and "allowed",
 * plus points for/against. Every large query here is fully paginated —
 * unpaginated queries were the root cause of prior Team Environment bugs.
 */
import { supabase } from './supabase';
import { normalizeTeam, CANONICAL_TEAMS } from './teamNormalizer';

export interface TeamMatchRecord {
  matchId: string;
  season: number;
  round: string;
  matchDate: string;
  team: string;
  opponent: string;
  isHome: boolean;
  playersCounted: number;
  advancedPlayersCounted: number;
  disposalsFor: number;
  disposalsAllowed: number;
  contestedPossessionsFor: number | null;
  contestedPossessionsAllowed: number | null;
  uncontestedPossessionsFor: number | null;
  uncontestedPossessionsAllowed: number | null;
  totalPossessionsFor: number | null;
  totalPossessionsAllowed: number | null;
  pointsFor: number | null;
  pointsAgainst: number | null;
  standardDataComplete: boolean;
  advancedDataComplete: boolean;
}

async function fetchAllRows<T>(
  table: string,
  select: string,
  applyFilters?: (q: any) => any,
  pageSize = 1000,
): Promise<T[]> {
  const rows: T[] = [];
  let offset = 0;
  for (;;) {
    let q = supabase.from(table).select(select).order('id').range(offset, offset + pageSize - 1);
    if (applyFilters) q = applyFilters(q);
    const { data, error } = await q;
    if (error) throw new Error(`fetchAllRows(${table}) failed: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...(data as T[]));
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

const MIN_PLAYERS_STANDARD = 10;
const MIN_PLAYERS_ADVANCED = 10;

export interface TeamMatchAggregationResult {
  records: TeamMatchRecord[];
  mirrorMismatches: { matchId: string; field: string; teamAValue: number; teamBValue: number }[];
  matchesConsidered: number;
  matchesWithStandardData: number;
  matchesWithAdvancedData: number;
}

/** Builds two TeamMatchRecord rows (one per side) for every completed match
 * in a season that has at least some standard player-game data. A match
 * missing advanced CP/UP data still counts for disposals — only the
 * possession fields go null, the whole match is never dropped for that. */
export async function buildTeamMatchRecords(season: number): Promise<TeamMatchAggregationResult> {
  const matches = await fetchAllRows<any>(
    'matches',
    'id, round, season, home_team, away_team, match_date, home_score, away_score',
    (q) => q.eq('season', season).neq('round', '0'),
  );

  const today = new Date().toISOString().split('T')[0];
  const completedMatches = matches.filter(m => m.match_date && m.match_date < today);
  const matchIds = completedMatches.map(m => m.id);
  if (matchIds.length === 0) {
    return { records: [], mirrorMismatches: [], matchesConsidered: 0, matchesWithStandardData: 0, matchesWithAdvancedData: 0 };
  }

  const stats = await fetchAllRows<any>(
    'player_game_stats',
    'player_id, match_id, team, disposals, contested_possessions, uncontested_possessions, total_possessions',
    (q) => q.in('match_id', matchIds),
  );

  interface Agg {
    playerIds: Set<string>;
    disposals: number;
    cp: number; cpCount: number;
    up: number; upCount: number;
    advancedPlayers: Set<string>;
  }
  const byMatchTeam = new Map<string, Agg>();
  const seenPlayerMatch = new Set<string>();

  for (const s of stats) {
    if (!s.match_id || !s.team) continue;
    const dedupeKey = `${s.player_id}-${s.match_id}`;
    if (seenPlayerMatch.has(dedupeKey)) continue;
    seenPlayerMatch.add(dedupeKey);

    const canonicalTeam = normalizeTeam(s.team) ?? s.team;
    const key = `${s.match_id}|${canonicalTeam}`;
    if (!byMatchTeam.has(key)) {
      byMatchTeam.set(key, { playerIds: new Set(), disposals: 0, cp: 0, cpCount: 0, up: 0, upCount: 0, advancedPlayers: new Set() });
    }
    const agg = byMatchTeam.get(key)!;
    agg.playerIds.add(s.player_id);
    agg.disposals += s.disposals ?? 0;
    if (s.contested_possessions != null && s.uncontested_possessions != null) {
      agg.cp += s.contested_possessions;
      agg.up += s.uncontested_possessions;
      agg.cpCount++;
      agg.advancedPlayers.add(s.player_id);
    }
  }

  const records: TeamMatchRecord[] = [];
  const mirrorMismatches: TeamMatchAggregationResult['mirrorMismatches'] = [];
  let matchesWithStandardData = 0;
  let matchesWithAdvancedData = 0;

  for (const m of completedMatches) {
    const homeTeam = normalizeTeam(m.home_team) ?? m.home_team;
    const awayTeam = normalizeTeam(m.away_team) ?? m.away_team;
    const homeAgg = byMatchTeam.get(`${m.id}|${homeTeam}`);
    const awayAgg = byMatchTeam.get(`${m.id}|${awayTeam}`);
    if (!homeAgg || !awayAgg) continue; // no player data for this match at all yet

    const homeStandardComplete = homeAgg.playerIds.size >= MIN_PLAYERS_STANDARD;
    const awayStandardComplete = awayAgg.playerIds.size >= MIN_PLAYERS_STANDARD;
    const standardComplete = homeStandardComplete && awayStandardComplete;
    if (standardComplete) matchesWithStandardData++;

    const homeAdvComplete = homeAgg.advancedPlayers.size >= MIN_PLAYERS_ADVANCED;
    const awayAdvComplete = awayAgg.advancedPlayers.size >= MIN_PLAYERS_ADVANCED;
    const advancedComplete = homeAdvComplete && awayAdvComplete;
    if (advancedComplete) matchesWithAdvancedData++;

    const homeCp = homeAdvComplete ? homeAgg.cp : null;
    const homeUp = homeAdvComplete ? homeAgg.up : null;
    const awayCp = awayAdvComplete ? awayAgg.cp : null;
    const awayUp = awayAdvComplete ? awayAgg.up : null;

    const base = {
      matchId: m.id, season: m.season, round: m.round, matchDate: m.match_date,
    };

    records.push({
      ...base, team: homeTeam, opponent: awayTeam, isHome: true,
      playersCounted: homeAgg.playerIds.size, advancedPlayersCounted: homeAgg.advancedPlayers.size,
      disposalsFor: homeAgg.disposals, disposalsAllowed: awayAgg.disposals,
      contestedPossessionsFor: homeCp, contestedPossessionsAllowed: awayCp,
      uncontestedPossessionsFor: homeUp, uncontestedPossessionsAllowed: awayUp,
      totalPossessionsFor: (homeCp != null && homeUp != null) ? homeCp + homeUp : null,
      totalPossessionsAllowed: (awayCp != null && awayUp != null) ? awayCp + awayUp : null,
      pointsFor: m.home_score ?? null, pointsAgainst: m.away_score ?? null,
      standardDataComplete: standardComplete, advancedDataComplete: advancedComplete,
    });
    records.push({
      ...base, team: awayTeam, opponent: homeTeam, isHome: false,
      playersCounted: awayAgg.playerIds.size, advancedPlayersCounted: awayAgg.advancedPlayers.size,
      disposalsFor: awayAgg.disposals, disposalsAllowed: homeAgg.disposals,
      contestedPossessionsFor: awayCp, contestedPossessionsAllowed: homeCp,
      uncontestedPossessionsFor: awayUp, uncontestedPossessionsAllowed: homeUp,
      totalPossessionsFor: (awayCp != null && awayUp != null) ? awayCp + awayUp : null,
      totalPossessionsAllowed: (homeCp != null && homeUp != null) ? homeCp + homeUp : null,
      pointsFor: m.away_score ?? null, pointsAgainst: m.home_score ?? null,
      standardDataComplete: standardComplete, advancedDataComplete: advancedComplete,
    });
  }

  mirrorMismatches.push(...validateMirroring(records));

  return {
    records, mirrorMismatches,
    matchesConsidered: completedMatches.length,
    matchesWithStandardData, matchesWithAdvancedData,
  };
}

/** Sanity check: for every match, teamA's "allowed" figures must equal
 * teamB's "for" figures. True by construction today, but this catches the
 * class of bug that broke this exact invariant before if the aggregation
 * logic above is ever edited incorrectly. */
export function validateMirroring(records: TeamMatchRecord[]): TeamMatchAggregationResult['mirrorMismatches'] {
  const mismatches: TeamMatchAggregationResult['mirrorMismatches'] = [];
  const byMatch = new Map<string, TeamMatchRecord[]>();
  for (const r of records) {
    if (!byMatch.has(r.matchId)) byMatch.set(r.matchId, []);
    byMatch.get(r.matchId)!.push(r);
  }
  const fields: Array<[keyof TeamMatchRecord, keyof TeamMatchRecord]> = [
    ['disposalsFor', 'disposalsAllowed'],
    ['contestedPossessionsFor', 'contestedPossessionsAllowed'],
    ['uncontestedPossessionsFor', 'uncontestedPossessionsAllowed'],
    ['totalPossessionsFor', 'totalPossessionsAllowed'],
  ];
  for (const [matchId, pair] of byMatch) {
    if (pair.length !== 2) continue;
    const [a, b] = pair;
    for (const [forField, allowedField] of fields) {
      const aFor = a[forField] as number | null;
      const bAllowed = b[allowedField] as number | null;
      if (aFor != null && bAllowed != null && aFor !== bAllowed) {
        mismatches.push({ matchId, field: String(forField), teamAValue: aFor, teamBValue: bAllowed });
      }
    }
  }
  return mismatches;
}

export interface TeamPeriodStats {
  games: number;
  disposalsFor: number; disposalsAllowed: number;
  contestedFor: number | null; contestedAllowed: number | null;
  uncontestedFor: number | null; uncontestedAllowed: number | null;
  totalPossessionsFor: number | null; totalPossessionsAllowed: number | null;
  pointsFor: number | null; pointsAgainst: number | null;
  advancedSampleGames: number;
}

export interface TeamFullStats {
  team: string;
  season: TeamPeriodStats;
  last5: TeamPeriodStats;
  last3: TeamPeriodStats;
  home: TeamPeriodStats;
  away: TeamPeriodStats;
  disposalForRank: number; disposalAllowedRank: number;
  contestedForRank: number; uncontestedForRank: number;
  pointsForRank: number; pointsAllowedRank: number;
  disposalForIndex: number | null; disposalAllowedIndex: number | null;
  contestedForIndex: number | null; contestedAllowedIndex: number | null;
  uncontestedForIndex: number | null; uncontestedAllowedIndex: number | null;
}

function avgPeriod(records: TeamMatchRecord[]): TeamPeriodStats {
  const n = records.length;
  const advRecords = records.filter(r => r.contestedPossessionsFor != null && r.contestedPossessionsAllowed != null);
  const sum = (f: (r: TeamMatchRecord) => number) => records.reduce((acc, r) => acc + f(r), 0);
  const sumAdv = (f: (r: TeamMatchRecord) => number | null) => advRecords.reduce((acc, r) => acc + (f(r) ?? 0), 0);
  const pointsRecords = records.filter(r => r.pointsFor != null && r.pointsAgainst != null);
  return {
    games: n,
    disposalsFor: n > 0 ? Math.round(sum(r => r.disposalsFor) / n) : 0,
    disposalsAllowed: n > 0 ? Math.round(sum(r => r.disposalsAllowed) / n) : 0,
    contestedFor: advRecords.length > 0 ? Math.round(sumAdv(r => r.contestedPossessionsFor) / advRecords.length) : null,
    contestedAllowed: advRecords.length > 0 ? Math.round(sumAdv(r => r.contestedPossessionsAllowed) / advRecords.length) : null,
    uncontestedFor: advRecords.length > 0 ? Math.round(sumAdv(r => r.uncontestedPossessionsFor) / advRecords.length) : null,
    uncontestedAllowed: advRecords.length > 0 ? Math.round(sumAdv(r => r.uncontestedPossessionsAllowed) / advRecords.length) : null,
    totalPossessionsFor: advRecords.length > 0 ? Math.round(sumAdv(r => r.totalPossessionsFor) / advRecords.length) : null,
    totalPossessionsAllowed: advRecords.length > 0 ? Math.round(sumAdv(r => r.totalPossessionsAllowed) / advRecords.length) : null,
    pointsFor: pointsRecords.length > 0 ? Math.round(pointsRecords.reduce((a, r) => a + (r.pointsFor ?? 0), 0) / pointsRecords.length) : null,
    pointsAgainst: pointsRecords.length > 0 ? Math.round(pointsRecords.reduce((a, r) => a + (r.pointsAgainst ?? 0), 0) / pointsRecords.length) : null,
    advancedSampleGames: advRecords.length,
  };
}

/** Builds season/last-5/last-3/home/away stats plus league ranks and
 * league-relative indexes (metric / league average * 100) for every
 * canonical team, from a shared set of TeamMatchRecords. */
export function buildTeamFullStats(records: TeamMatchRecord[]): TeamFullStats[] {
  const byTeam = new Map<string, TeamMatchRecord[]>();
  for (const r of records) {
    if (!byTeam.has(r.team)) byTeam.set(r.team, []);
    byTeam.get(r.team)!.push(r);
  }
  for (const list of byTeam.values()) list.sort((a, b) => b.matchDate.localeCompare(a.matchDate));

  const partial: Omit<TeamFullStats, 'disposalForRank' | 'disposalAllowedRank' | 'contestedForRank' | 'uncontestedForRank' | 'pointsForRank' | 'pointsAllowedRank' | 'disposalForIndex' | 'disposalAllowedIndex' | 'contestedForIndex' | 'contestedAllowedIndex' | 'uncontestedForIndex' | 'uncontestedAllowedIndex'>[] = [];

  for (const team of CANONICAL_TEAMS) {
    const list = byTeam.get(team) ?? [];
    partial.push({
      team,
      season: avgPeriod(list),
      last5: avgPeriod(list.slice(0, 5)),
      last3: avgPeriod(list.slice(0, 3)),
      home: avgPeriod(list.filter(r => r.isHome)),
      away: avgPeriod(list.filter(r => !r.isHome)),
    });
  }

  const withGames = partial.filter(t => t.season.games > 0);
  const leagueAvg = (f: (t: TeamFullStats) => number | null) => {
    const vals = withGames.map(f).filter((v): v is number => v != null);
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  const asFull = partial as TeamFullStats[];
  const leagueDisposalFor = leagueAvg(t => t.season.disposalsFor);
  const leagueDisposalAllowed = leagueAvg(t => t.season.disposalsAllowed);
  const leagueContestedFor = leagueAvg(t => t.season.contestedFor);
  const leagueContestedAllowed = leagueAvg(t => t.season.contestedAllowed);
  const leagueUncontestedFor = leagueAvg(t => t.season.uncontestedFor);
  const leagueUncontestedAllowed = leagueAvg(t => t.season.uncontestedAllowed);

  const rankOf = (list: TeamFullStats[], f: (t: TeamFullStats) => number, ascending = false) => {
    const sorted = [...list].sort((a, b) => ascending ? f(a) - f(b) : f(b) - f(a));
    const rankMap = new Map<string, number>();
    sorted.forEach((t, i) => rankMap.set(t.team, i + 1));
    return rankMap;
  };
  const disposalForRanks = rankOf(withGames, t => t.season.disposalsFor);
  const disposalAllowedRanks = rankOf(withGames, t => t.season.disposalsAllowed, true); // fewer allowed = better rank
  const contestedForRanks = rankOf(withGames, t => t.season.contestedFor ?? 0);
  const uncontestedForRanks = rankOf(withGames, t => t.season.uncontestedFor ?? 0);
  const pointsForRanks = rankOf(withGames, t => t.season.pointsFor ?? 0);
  const pointsAllowedRanks = rankOf(withGames, t => t.season.pointsAgainst ?? 0, true);

  const index = (val: number | null, leagueVal: number | null) => (val != null && leagueVal != null && leagueVal !== 0) ? Math.round((val / leagueVal) * 100) : null;

  for (const t of asFull) {
    t.disposalForRank = disposalForRanks.get(t.team) ?? 0;
    t.disposalAllowedRank = disposalAllowedRanks.get(t.team) ?? 0;
    t.contestedForRank = contestedForRanks.get(t.team) ?? 0;
    t.uncontestedForRank = uncontestedForRanks.get(t.team) ?? 0;
    t.pointsForRank = pointsForRanks.get(t.team) ?? 0;
    t.pointsAllowedRank = pointsAllowedRanks.get(t.team) ?? 0;
    t.disposalForIndex = index(t.season.disposalsFor, leagueDisposalFor);
    t.disposalAllowedIndex = index(t.season.disposalsAllowed, leagueDisposalAllowed);
    t.contestedForIndex = index(t.season.contestedFor, leagueContestedFor);
    t.contestedAllowedIndex = index(t.season.contestedAllowed, leagueContestedAllowed);
    t.uncontestedForIndex = index(t.season.uncontestedFor, leagueUncontestedFor);
    t.uncontestedAllowedIndex = index(t.season.uncontestedAllowed, leagueUncontestedAllowed);
  }

  return asFull;
}
