import { supabase } from './supabase';
import type { Match } from './types';

export interface RoundInfo {
  latestCompletedStatsRound: string | null;
  latestCompletedStatsRoundNum: number;
  nextBettingRound: string | null;
  nextBettingRoundNum: number;
  nextRoundFixtures: Match[];
  nextRoundOddsCount: number;
  fixturesReady: boolean;
  oddsReady: boolean;
  readyForMultiBuilder: boolean;
}

function parseRoundNum(round: string | null): number {
  if (!round) return 0;
  const m = round.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Detect the latest FULLY completed round — every match in the round must
 * have a match_date in the past, not just one. A single Thursday-night game
 * finishing (and its stats syncing) does not mean the whole round is done;
 * treating it as "completed" makes nextBettingRound skip straight past the
 * round that's still actually in progress (e.g. computing round 21 as next
 * when round 20 has only played one of nine games), which is why the Multi
 * Builder's "Auto / Next Betting Round" can silently resolve to zero matches.
 */
export async function getLatestCompletedStatsRound(season = 2026): Promise<{ round: string | null; roundNum: number; matchDate: string | null }> {
  const today = new Date().toISOString().split('T')[0];
  const { data } = await supabase
    .from('matches')
    .select('round, match_date')
    .eq('season', season)
    .neq('round', '0');

  if (!data) return { round: null, roundNum: 0, matchDate: null };

  const byRound = new Map<number, { maxDate: string; hasNullDate: boolean }>();
  for (const row of data) {
    const n = parseRoundNum(row.round);
    if (!n) continue;
    const entry = byRound.get(n) ?? { maxDate: '', hasNullDate: false };
    if (!row.match_date) {
      entry.hasNullDate = true;
    } else if (row.match_date > entry.maxDate) {
      entry.maxDate = row.match_date;
    }
    byRound.set(n, entry);
  }

  let bestRound: number | null = null;
  let bestDate = '';
  for (const [round, entry] of byRound) {
    if (entry.hasNullDate || !entry.maxDate) continue;
    if (entry.maxDate < today && (bestRound === null || round > bestRound)) {
      bestRound = round;
      bestDate = entry.maxDate;
    }
  }

  return {
    round: bestRound !== null ? String(bestRound) : null,
    roundNum: bestRound ?? 0,
    matchDate: bestRound !== null ? bestDate : null,
  };
}

/**
 * Detect the latest completed match round from matches table.
 */
export async function getLatestCompletedMatchRound(season = 2026): Promise<{ round: string | null; roundNum: number; matchDate: string | null }> {
  const today = new Date().toISOString().split('T')[0];
  const { data } = await supabase
    .from('matches')
    .select('round, match_date')
    .eq('season', season)
    .lt('match_date', today)
    .order('match_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (data) {
    return { round: data.round, roundNum: parseRoundNum(data.round), matchDate: data.match_date };
  }
  return { round: null, roundNum: 0, matchDate: null };
}

/**
 * Get the full round info for the "Prepare Next Round" workflow.
 * 1. Detect latest completed stats round
 * 2. Next betting round = latest completed stats round + 1
 * 3. Check if matches table has fixtures for next round (in the current season)
 * 4. Check if bookmaker_odds has player prop odds for next round
 */
export async function getRoundInfo(season = 2026): Promise<RoundInfo> {
  const { round: statsRound, roundNum: statsRoundNum } = await getLatestCompletedStatsRound(season);
  const nextBettingRoundNum = statsRoundNum > 0 ? statsRoundNum + 1 : 0;
  const nextBettingRound = nextBettingRoundNum > 0 ? String(nextBettingRoundNum) : null;

  let nextRoundFixtures: Match[] = [];
  let nextRoundOddsCount = 0;

  if (nextBettingRound) {
    // Fetch fixtures for next round in the current season
    const { data: fixtures } = await supabase
      .from('matches')
      .select('*')
      .eq('season', season)
      .eq('round', nextBettingRound)
      .order('commence_time_utc', { ascending: true, nullsFirst: false });
    nextRoundFixtures = (fixtures ?? []) as Match[];

    // Count bookmaker_odds for those fixtures
    if (nextRoundFixtures.length > 0) {
      const matchIds = nextRoundFixtures.map(m => m.id);
      const { count } = await supabase
        .from('bookmaker_odds')
        .select('id', { count: 'exact', head: true })
        .in('match_id', matchIds);
      nextRoundOddsCount = count ?? 0;
    }
  }

  // A round is only "ready" if it actually lies in the future. The next
  // betting round is derived as (latest completed stats round + 1), but when
  // stats sync lags behind real life that computed round can already have been
  // played — its fixtures exist in the DB with past dates. Without this guard
  // the status panel reports a finished round as "Ready" while Match Hub (which
  // filters on match_date >= today) correctly shows no upcoming fixtures.
  const today = new Date().toISOString().split('T')[0];
  const hasFutureFixture = nextRoundFixtures.some(m => {
    const when = (m.commence_time_utc ?? m.match_date ?? '').split('T')[0];
    return when >= today;
  });

  const fixturesReady = nextRoundFixtures.length > 0 && hasFutureFixture;
  const oddsReady = fixturesReady && nextRoundOddsCount > 0;
  const readyForMultiBuilder = fixturesReady && oddsReady;

  return {
    latestCompletedStatsRound: statsRound,
    latestCompletedStatsRoundNum: statsRoundNum,
    nextBettingRound,
    nextBettingRoundNum,
    nextRoundFixtures,
    nextRoundOddsCount,
    fixturesReady,
    oddsReady,
    readyForMultiBuilder,
  };
}

/**
 * Get matches for a specific round in the current season.
 */
export async function getMatchesForRound(round: string, season = 2026): Promise<Match[]> {
  const { data } = await supabase
    .from('matches')
    .select('*')
    .eq('season', season)
    .eq('round', round)
    .order('commence_time_utc', { ascending: true, nullsFirst: false });
  return (data ?? []) as Match[];
}

/**
 * Get the active betting slate — the next round with fixtures.
 * Priority:
 * 1. Next round after latest completed stats round (in current season)
 * 2. Latest odds-backed round as fallback
 */
export async function getActiveBettingSlate(season = 2026): Promise<{
  round: string | null;
  matches: Match[];
  oddsCount: number;
  statsRound: string | null;
  fixturesReady: boolean;
  oddsReady: boolean;
}> {
  const info = await getRoundInfo(season);
  return {
    round: info.nextBettingRound,
    matches: info.nextRoundFixtures,
    oddsCount: info.nextRoundOddsCount,
    statsRound: info.latestCompletedStatsRound,
    fixturesReady: info.fixturesReady,
    oddsReady: info.oddsReady,
  };
}
