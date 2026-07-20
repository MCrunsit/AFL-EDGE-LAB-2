import { supabase } from './supabase';
import type { Match } from './types';
import { normalizeTeam, CANONICAL_TEAMS } from './teamNormalizer';

export type EnvironmentLabel =
  | 'VERY_POSITIVE' | 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'VERY_NEGATIVE' | 'INSUFFICIENT_DATA';

export type AdjustmentMode = 'DISPLAY_ONLY' | 'MODEL_ACTIVE';

export interface TeamDisposalStats {
  team: string;
  seasonFor: number;
  seasonConceded: number;
  seasonGames: number;
  last5For: number;
  last5Conceded: number;
  last5Games: number;
  last3For: number;
  last3Conceded: number;
  last3Games: number;
  homeFor: number;
  homeConceded: number;
  homeGames: number;
  awayFor: number;
  awayConceded: number;
  awayGames: number;
  forRank: number;
  concededRank: number;
  trend: 'up' | 'down' | 'stable';
}

export interface TeamMatchupEnvironment {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  homeExpected: number;
  awayExpected: number;
  homeLabel: EnvironmentLabel;
  awayLabel: EnvironmentLabel;
  homeEnvironmentDiff: number;
  awayEnvironmentDiff: number;
}

export interface TeamEnvironmentEntry {
  team: string;
  expectedDisposals: number;
  environmentDiff: number;
  label: EnvironmentLabel;
  adjustment: number;
  mode: AdjustmentMode;
}

export type TeamEnvironmentMap = Map<string, TeamEnvironmentEntry>;

interface EnvironmentThresholds {
  veryPositive: number;
  positive: number;
  neutralLow: number;
  neutralHigh: number;
  negative: number;
  veryNegative: number;
}

export const DEFAULT_THRESHOLDS: EnvironmentThresholds = {
  veryPositive: 15,
  positive: 7,
  neutralLow: -6,
  neutralHigh: 6,
  negative: -7,
  veryNegative: -15,
};

const LEAGUE_AVG_DISPOSALS = 370;
const MIN_PLAYERS_PER_TEAM = 10;
const MIN_GAMES_FOR_ENVIRONMENT = 3;
const CURRENT_MODE: AdjustmentMode = 'DISPLAY_ONLY';

function labelFromDiff(diff: number, thresholds: EnvironmentThresholds): EnvironmentLabel {
  if (diff >= thresholds.veryPositive) return 'VERY_POSITIVE';
  if (diff >= thresholds.positive) return 'POSITIVE';
  if (diff >= thresholds.neutralLow && diff <= thresholds.neutralHigh) return 'NEUTRAL';
  if (diff <= thresholds.veryNegative) return 'VERY_NEGATIVE';
  if (diff <= thresholds.negative) return 'NEGATIVE';
  return 'NEUTRAL';
}

function adjustmentFromLabel(label: EnvironmentLabel): number {
  switch (label) {
    case 'VERY_POSITIVE': return 0.02;
    case 'POSITIVE': return 0.01;
    case 'NEUTRAL': return 0;
    case 'NEGATIVE': return -0.01;
    case 'VERY_NEGATIVE': return -0.02;
    default: return 0;
  }
}

export function getLabelDisplay(label: EnvironmentLabel): string {
  switch (label) {
    case 'VERY_POSITIVE': return 'Very Positive';
    case 'POSITIVE': return 'Positive';
    case 'NEUTRAL': return 'Neutral';
    case 'NEGATIVE': return 'Negative';
    case 'VERY_NEGATIVE': return 'Very Negative';
    case 'INSUFFICIENT_DATA': return 'Unavailable';
  }
}

interface MatchAggregation {
  matchId: string;
  matchDate: string;
  round: string;
  homeTeam: string;
  awayTeam: string;
  venue: string;
  teamTotals: Map<string, number>;
  playerCounts: Map<string, Set<string>>;
  excluded: boolean;
  excludeReason: string | null;
}

/**
 * Load completed match disposal totals for all teams in a season.
 * Only uses complete matches (18+ unique players per team with non-null disposals).
 * Deduplicates by player_id + match_id.
 * Normalizes team names to exactly 18 canonical AFL teams.
 */
export interface TeamStatsDiagnostics {
  totalCompletedMatches: number;
  matchesAccepted: number;
  matchesRejected: number;
  rejectedReasons: {
    tooFewHomePlayers: number;
    tooFewAwayPlayers: number;
    teamMismatch: number;
    missingMatchId: number;
    missingDisposals: number;
    moreThanTwoTeams: number;
    matchNotFound: number;
  };
  rejectedMatches: { matchId: string; match: string; reason: string; homePlayers: number; awayPlayers: number }[];
}

function emptyDiagnostics(): TeamStatsDiagnostics {
  return {
    totalCompletedMatches: 0, matchesAccepted: 0, matchesRejected: 0,
    rejectedReasons: { tooFewHomePlayers: 0, tooFewAwayPlayers: 0, teamMismatch: 0, missingMatchId: 0, missingDisposals: 0, moreThanTwoTeams: 0, matchNotFound: 0 },
    rejectedMatches: [],
  };
}

export async function loadTeamDisposalStats(season = 2026): Promise<{ stats: TeamDisposalStats[]; diagnostics: TeamStatsDiagnostics }> {
  const { data: matches } = await supabase
    .from('matches')
    .select('id, round, home_team, away_team, match_date, venue')
    .eq('season', season)
    .neq('round', '0')
    .order('match_date', { ascending: true });

  if (!matches || matches.length === 0) return { stats: [], diagnostics: emptyDiagnostics() };

  const matchIds = matches.map(m => m.id);

  const { data: stats } = await supabase
    .from('player_game_stats')
    .select('player_id, match_id, team, opponent, venue, disposals, match_date, round')
    .in('match_id', matchIds)
    .not('disposals', 'is', null)
    .order('match_date', { ascending: true });

  if (!stats || stats.length === 0) return { stats: [], diagnostics: emptyDiagnostics() };

  // Build per-match aggregation
  const matchAggregation = new Map<string, MatchAggregation>();
  for (const m of matches) {
    const homeNorm = normalizeTeam(m.home_team);
    const awayNorm = normalizeTeam(m.away_team);
    matchAggregation.set(m.id, {
      matchId: m.id,
      matchDate: m.match_date ?? '',
      round: m.round ?? '',
      homeTeam: homeNorm ?? m.home_team ?? '',
      awayTeam: awayNorm ?? m.away_team ?? '',
      venue: m.venue ?? '',
      teamTotals: new Map(),
      playerCounts: new Map(),
      excluded: false,
      excludeReason: null,
    });
  }

  // Track dedup and aggregate
  const seenPlayerMatch = new Set<string>();
  for (const s of stats) {
    if (!s.match_id || !s.team) continue;

    const dedupeKey = `${s.player_id}-${s.match_id}`;
    if (seenPlayerMatch.has(dedupeKey)) continue;
    seenPlayerMatch.add(dedupeKey);

    const matchInfo = matchAggregation.get(s.match_id);
    if (!matchInfo || matchInfo.excluded) continue;

    const canonicalTeam = normalizeTeam(s.team);
    if (!canonicalTeam) {
      matchInfo.excluded = true;
      matchInfo.excludeReason = 'MISSING_TEAM';
      continue;
    }

    // Sum disposals by canonical team
    matchInfo.teamTotals.set(canonicalTeam, (matchInfo.teamTotals.get(canonicalTeam) ?? 0) + (s.disposals ?? 0));

    // Track unique players per team
    if (!matchInfo.playerCounts.has(canonicalTeam)) matchInfo.playerCounts.set(canonicalTeam, new Set());
    matchInfo.playerCounts.get(canonicalTeam)!.add(s.player_id);
  }

  // Determine which matches are complete and collect per-team game data
  const teamGameData = new Map<string, {
    forGames: { disposals: number; conceded: number; isHome: boolean; matchDate: string }[];
  }>();

  const diag: TeamStatsDiagnostics = emptyDiagnostics();
  const today = new Date().toISOString().split('T')[0];
  diag.totalCompletedMatches = matches.filter(m => m.match_date != null && m.match_date < today).length;

  for (const [matchId, matchInfo] of matchAggregation) {
    const teams = Array.from(matchInfo.teamTotals.keys());
    const matchName = `${matchInfo.homeTeam} vs ${matchInfo.awayTeam}`;
    const homeCount = matchInfo.playerCounts.get(matchInfo.homeTeam)?.size ?? 0;
    const awayCount = matchInfo.playerCounts.get(matchInfo.awayTeam)?.size ?? 0;

    if (matchInfo.matchDate >= today) continue; // skip future matches

    if (teams.length < 2) {
      matchInfo.excluded = true;
      matchInfo.excludeReason = 'MISSING_TEAM';
      diag.matchesRejected++;
      diag.rejectedReasons.missingMatchId++;
      diag.rejectedMatches.push({ matchId, match: matchName, reason: 'Less than 2 teams', homePlayers: homeCount, awayPlayers: awayCount });
      continue;
    }

    let complete = true;
    for (const team of teams) {
      const count = matchInfo.playerCounts.get(team)?.size ?? 0;
      if (count < MIN_PLAYERS_PER_TEAM) { complete = false; break; }
    }
    if (!complete) {
      matchInfo.excluded = true;
      matchInfo.excludeReason = 'TOO_FEW_PLAYERS';
      diag.matchesRejected++;
      if (homeCount < MIN_PLAYERS_PER_TEAM) diag.rejectedReasons.tooFewHomePlayers++;
      if (awayCount < MIN_PLAYERS_PER_TEAM) diag.rejectedReasons.tooFewAwayPlayers++;
      diag.rejectedMatches.push({ matchId, match: matchName, reason: `Too few players (H:${homeCount} A:${awayCount})`, homePlayers: homeCount, awayPlayers: awayCount });
      continue;
    }

    // Verify the two teams match the match row
    const homeTeam = matchInfo.homeTeam;
    const awayTeam = matchInfo.awayTeam;
    const hasHome = matchInfo.teamTotals.has(homeTeam);
    const hasAway = matchInfo.teamTotals.has(awayTeam);
    if (!hasHome || !hasAway) {
      // Try to match by checking if exactly 2 teams present
      if (teams.length === 2) {
        const [t1, t2] = teams;
        const total1 = matchInfo.teamTotals.get(t1)!;
        const total2 = matchInfo.teamTotals.get(t2)!;
        if (!teamGameData.has(t1)) teamGameData.set(t1, { forGames: [] });
        if (!teamGameData.has(t2)) teamGameData.set(t2, { forGames: [] });
        teamGameData.get(t1)!.forGames.push({ disposals: total1, conceded: total2, isHome: t1 === homeTeam, matchDate: matchInfo.matchDate });
        teamGameData.get(t2)!.forGames.push({ disposals: total2, conceded: total1, isHome: t2 === homeTeam, matchDate: matchInfo.matchDate });
        diag.matchesAccepted++;
      } else {
        matchInfo.excluded = true;
        matchInfo.excludeReason = 'MORE_THAN_TWO_TEAMS';
        diag.matchesRejected++;
        diag.rejectedReasons.moreThanTwoTeams++;
        diag.rejectedMatches.push({ matchId, match: matchName, reason: `${teams.length} teams (expected 2)`, homePlayers: homeCount, awayPlayers: awayCount });
      }
      continue;
    }

    const homeTotal = matchInfo.teamTotals.get(homeTeam)!;
    const awayTotal = matchInfo.teamTotals.get(awayTeam)!;

    if (!teamGameData.has(homeTeam)) teamGameData.set(homeTeam, { forGames: [] });
    if (!teamGameData.has(awayTeam)) teamGameData.set(awayTeam, { forGames: [] });
    teamGameData.get(homeTeam)!.forGames.push({ disposals: homeTotal, conceded: awayTotal, isHome: true, matchDate: matchInfo.matchDate });
    teamGameData.get(awayTeam)!.forGames.push({ disposals: awayTotal, conceded: homeTotal, isHome: false, matchDate: matchInfo.matchDate });
    diag.matchesAccepted++;
  }

  // Build stats for all 18 canonical teams
  const result: TeamDisposalStats[] = [];
  for (const team of CANONICAL_TEAMS) {
    const data = teamGameData.get(team);
    if (!data || data.forGames.length === 0) {
      result.push({
        team,
        seasonFor: 0, seasonConceded: 0, seasonGames: 0,
        last5For: 0, last5Conceded: 0, last5Games: 0,
        last3For: 0, last3Conceded: 0, last3Games: 0,
        homeFor: 0, homeConceded: 0, homeGames: 0,
        awayFor: 0, awayConceded: 0, awayGames: 0,
        forRank: 0, concededRank: 0, trend: 'stable',
      });
      continue;
    }

    const games = data.forGames.sort((a, b) => b.matchDate.localeCompare(a.matchDate));

    const seasonFor = Math.round(games.reduce((acc, g) => acc + g.disposals, 0) / Math.max(1, games.length));
    const seasonConceded = Math.round(games.reduce((acc, g) => acc + g.conceded, 0) / Math.max(1, games.length));

    const last5 = games.slice(0, 5);
    const last3 = games.slice(0, 3);
    const home = games.filter(g => g.isHome);
    const away = games.filter(g => !g.isHome);

    const last5For = last5.length > 0 ? Math.round(last5.reduce((acc, g) => acc + g.disposals, 0) / last5.length) : 0;
    const last5Conceded = last5.length > 0 ? Math.round(last5.reduce((acc, g) => acc + g.conceded, 0) / last5.length) : 0;
    const last3For = last3.length > 0 ? Math.round(last3.reduce((acc, g) => acc + g.disposals, 0) / last3.length) : 0;
    const last3Conceded = last3.length > 0 ? Math.round(last3.reduce((acc, g) => acc + g.conceded, 0) / last3.length) : 0;
    const homeFor = home.length > 0 ? Math.round(home.reduce((acc, g) => acc + g.disposals, 0) / home.length) : 0;
    const homeConceded = home.length > 0 ? Math.round(home.reduce((acc, g) => acc + g.conceded, 0) / home.length) : 0;
    const awayFor = away.length > 0 ? Math.round(away.reduce((acc, g) => acc + g.disposals, 0) / away.length) : 0;
    const awayConceded = away.length > 0 ? Math.round(away.reduce((acc, g) => acc + g.conceded, 0) / away.length) : 0;

    const trend = last3For > seasonFor * 1.03 ? 'up' : last3For < seasonFor * 0.97 ? 'down' : 'stable';

    result.push({
      team,
      seasonFor, seasonConceded, seasonGames: games.length,
      last5For, last5Conceded, last5Games: last5.length,
      last3For, last3Conceded, last3Games: last3.length,
      homeFor, homeConceded, homeGames: home.length,
      awayFor, awayConceded, awayGames: away.length,
      forRank: 0, concededRank: 0, trend,
    });
  }

  // Rank only teams with games
  const withGames = result.filter(r => r.seasonGames > 0);
  const sortedFor = [...withGames].sort((a, b) => b.seasonFor - a.seasonFor);
  sortedFor.forEach((t, i) => { t.forRank = i + 1; });
  const sortedConceded = [...withGames].sort((a, b) => a.seasonConceded - b.seasonConceded);
  sortedConceded.forEach((t, i) => { t.concededRank = i + 1; });

  return { stats: result.sort((a, b) => (b.seasonGames > 0 ? 1 : 0) - (a.seasonGames > 0 ? 1 : 0) || a.forRank - b.forRank), diagnostics: diag };
}

/**
 * Calculate expected team disposals for an upcoming match.
 * Returns INSUFFICIENT_DATA if either team has too few games.
 */
export function calculateExpectedDisposals(
  team: TeamDisposalStats,
  opponent: TeamDisposalStats,
  isHome: boolean,
  leagueAvg = LEAGUE_AVG_DISPOSALS,
): { expected: number; diff: number; label: EnvironmentLabel; adjustment: number } {
  if (team.seasonGames < MIN_GAMES_FOR_ENVIRONMENT || opponent.seasonGames < MIN_GAMES_FOR_ENVIRONMENT) {
    return { expected: 0, diff: 0, label: 'INSUFFICIENT_DATA', adjustment: 0 };
  }

  const homeAwayFor = isHome && team.homeFor > 0 ? team.homeFor : team.seasonFor;
  const homeAwayConceded = !isHome && opponent.awayConceded > 0 ? opponent.awayConceded : opponent.seasonConceded;

  const expected =
    team.seasonFor * 0.30 +
    team.last5For * 0.25 +
    opponent.seasonConceded * 0.25 +
    opponent.last5Conceded * 0.15 +
    homeAwayFor * 0.05;

  const diff = expected - leagueAvg;
  const label = labelFromDiff(diff, DEFAULT_THRESHOLDS);
  const adjustment = CURRENT_MODE === 'MODEL_ACTIVE' ? adjustmentFromLabel(label) : 0;

  return { expected: Math.round(expected), diff: Math.round(diff), label, adjustment };
}

/**
 * Build a TeamEnvironmentMap for all teams in upcoming matches.
 */
export async function buildTeamEnvironmentMap(
  upcomingMatches: Match[],
  season = 2026,
): Promise<{ map: TeamEnvironmentMap; stats: TeamDisposalStats[]; matchups: TeamMatchupEnvironment[] }> {
  const { stats: teamStatsRaw, diagnostics: _diag } = await loadTeamDisposalStats(season);
  const stats = teamStatsRaw;
  if (stats.length === 0) {
    return { map: new Map(), stats: [], matchups: [] };
  }

  const statsByTeam = new Map(stats.map(s => [s.team, s]));
  const map: TeamEnvironmentMap = new Map();
  const matchups: TeamMatchupEnvironment[] = [];

  for (const m of upcomingMatches) {
    const homeNorm = normalizeTeam(m.home_team) ?? m.home_team ?? '';
    const awayNorm = normalizeTeam(m.away_team) ?? m.away_team ?? '';
    const homeStats = statsByTeam.get(homeNorm);
    const awayStats = statsByTeam.get(awayNorm);
    if (!homeStats || !awayStats) continue;

    const homeEnv = calculateExpectedDisposals(homeStats, awayStats, true);
    const awayEnv = calculateExpectedDisposals(awayStats, homeStats, false);

    map.set(homeNorm, {
      team: homeNorm,
      expectedDisposals: homeEnv.expected,
      environmentDiff: homeEnv.diff,
      label: homeEnv.label,
      adjustment: homeEnv.adjustment,
      mode: CURRENT_MODE,
    });
    map.set(awayNorm, {
      team: awayNorm,
      expectedDisposals: awayEnv.expected,
      environmentDiff: awayEnv.diff,
      label: awayEnv.label,
      adjustment: awayEnv.adjustment,
      mode: CURRENT_MODE,
    });

    matchups.push({
      matchId: m.id,
      homeTeam: homeNorm,
      awayTeam: awayNorm,
      homeExpected: homeEnv.expected,
      awayExpected: awayEnv.expected,
      homeLabel: homeEnv.label,
      awayLabel: awayEnv.label,
      homeEnvironmentDiff: homeEnv.diff,
      awayEnvironmentDiff: awayEnv.diff,
    });
  }

  return { map, stats, matchups };
}

export { CURRENT_MODE };
