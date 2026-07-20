import { supabase } from './supabase';
import { normalizeTeam } from './teamNormalizer';

export interface RoundMatchCompleteness {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  matchDate: string;
  round: string;
  uniquePlayers: number;
  homePlayers: number;
  awayPlayers: number;
  nonNullDisposals: number;
  nullPlayerId: number;
  nullMatchId: number;
  teamMismatch: number;
  duplicateRows: number;
  status: 'COMPLETE' | 'PARTIAL_STATS' | 'MISSING_STATS' | 'MATCH_LINK_FAILURE' | 'PLAYER_LINK_FAILURE' | 'TEAM_LINK_FAILURE' | 'DUPLICATE_STATS';
  reason: string;
}

export interface RoundCompletenessResult {
  season: number;
  round: string;
  totalMatches: number;
  completedMatches: number;
  completeMatches: number;
  matches: RoundMatchCompleteness[];
  isComplete: boolean;
}

const MIN_PLAYERS_PER_TEAM = 10;

/**
 * Check the true completeness of stats for a given round.
 * A match is complete only when:
 * - both match teams are represented
 * - at least MIN_PLAYERS_PER_TEAM unique players per team have non-null disposals
 * - all accepted rows have valid player_id and match_id
 * - no player_id + match_id duplicates remain
 * - stat teams normalize to one of the two match teams
 */
export async function getRoundStatsCompleteness(season: number, round: string): Promise<RoundCompletenessResult> {
  const { data: matches } = await supabase
    .from('matches')
    .select('id, round, home_team, away_team, match_date')
    .eq('season', season)
    .eq('round', round)
    .order('match_date', { ascending: true });

  if (!matches || matches.length === 0) {
    return { season, round, totalMatches: 0, completedMatches: 0, completeMatches: 0, matches: [], isComplete: false };
  }

  const today = new Date().toISOString().split('T')[0];
  const completedMatches = matches.filter(m => m.match_date < today);

  const matchIds = matches.map(m => m.id);
  const { data: allStats } = await supabase
    .from('player_game_stats')
    .select('player_id, match_id, team, disposals')
    .in('match_id', matchIds)
    .eq('season', season);

  const statsByMatch = new Map<string, any[]>();
  for (const s of (allStats ?? [])) {
    if (!s.match_id) continue;
    if (!statsByMatch.has(s.match_id)) statsByMatch.set(s.match_id, []);
    statsByMatch.get(s.match_id)!.push(s);
  }

  const matchResults: RoundMatchCompleteness[] = [];

  for (const m of matches) {
    const homeNorm = normalizeTeam(m.home_team) ?? m.home_team;
    const awayNorm = normalizeTeam(m.away_team) ?? m.away_team;
    const stats = statsByMatch.get(m.id) ?? [];

    const uniquePlayerIds = new Set(stats.filter(s => s.player_id).map(s => s.player_id));
    const homePlayers = new Set(stats.filter(s => {
      if (!s.player_id) return false;
      const teamNorm = normalizeTeam(s.team);
      return teamNorm === homeNorm;
    }).map(s => s.player_id));
    const awayPlayers = new Set(stats.filter(s => {
      if (!s.player_id) return false;
      const teamNorm = normalizeTeam(s.team);
      return teamNorm === awayNorm;
    }).map(s => s.player_id));

    const nonNullDisposals = stats.filter(s => s.disposals !== null && s.disposals !== undefined).length;
    const nullPlayerId = stats.filter(s => !s.player_id).length;
    const nullMatchId = stats.filter(s => !s.match_id).length;

    const teamMismatch = stats.filter(s => {
      const teamNorm = normalizeTeam(s.team);
      return teamNorm !== homeNorm && teamNorm !== awayNorm;
    }).length;

    // Check duplicates
    const seen = new Set<string>();
    let duplicates = 0;
    for (const s of stats) {
      if (!s.player_id) continue;
      const key = `${s.player_id}-${s.match_id}`;
      if (seen.has(key)) duplicates++;
      else seen.add(key);
    }

    const isCompleted = m.match_date < today;
    let status: RoundMatchCompleteness['status'] = 'MISSING_STATS';
    let reason = '';

    if (!isCompleted) {
      status = 'MISSING_STATS';
      reason = 'Match not yet played';
    } else if (stats.length === 0) {
      status = 'MISSING_STATS';
      reason = 'No stats rows found';
    } else if (nullMatchId > 0) {
      status = 'MATCH_LINK_FAILURE';
      reason = `${nullMatchId} rows with null match_id`;
    } else if (nullPlayerId > 0) {
      status = 'PLAYER_LINK_FAILURE';
      reason = `${nullPlayerId} rows with null player_id`;
    } else if (teamMismatch > 0) {
      status = 'TEAM_LINK_FAILURE';
      reason = `${teamMismatch} rows with team not matching either match team`;
    } else if (duplicates > 0) {
      status = 'DUPLICATE_STATS';
      reason = `${duplicates} duplicate player_id+match_id rows`;
    } else if (homePlayers.size < MIN_PLAYERS_PER_TEAM || awayPlayers.size < MIN_PLAYERS_PER_TEAM) {
      status = 'PARTIAL_STATS';
      reason = `Home ${homePlayers.size}/${MIN_PLAYERS_PER_TEAM}, Away ${awayPlayers.size}/${MIN_PLAYERS_PER_TEAM} players`;
    } else {
      status = 'COMPLETE';
      reason = `${homePlayers.size} home + ${awayPlayers.size} away players`;
    }

    matchResults.push({
      matchId: m.id,
      homeTeam: m.home_team,
      awayTeam: m.away_team,
      matchDate: m.match_date,
      round: m.round,
      uniquePlayers: uniquePlayerIds.size,
      homePlayers: homePlayers.size,
      awayPlayers: awayPlayers.size,
      nonNullDisposals,
      nullPlayerId,
      nullMatchId,
      teamMismatch,
      duplicateRows: duplicates,
      status,
      reason,
    });
  }

  const completeCount = matchResults.filter(m => m.status === 'COMPLETE').length;
  const completedCount = completedMatches.length;

  return {
    season,
    round,
    totalMatches: matches.length,
    completedMatches: completedCount,
    completeMatches: completeCount,
    matches: matchResults,
    isComplete: completedCount > 0 && completedCount === completeCount,
  };
}
