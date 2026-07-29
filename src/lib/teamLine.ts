/**
 * Team Lines — team handicap/spread bets (e.g. "Carlton +72.5"), sourced
 * from the existing match_odds table (market='spreads'), which is already
 * fed by the "Sync Match Odds" button on the Import page. No new schema or
 * ingest is needed here — this module just shapes that data for the
 * builders and computes a genuine historical cover-rate probability from
 * each team's actual results (matches.home_score/away_score) vs their past
 * lines. Below MIN_MATCHES_FOR_COVER_RATE, returns "insufficient sample"
 * rather than fabricating a number — same convention as safetyScore.ts.
 */
import { supabase } from './supabase';
import { normalizeTeam } from './teamNormalizer';

export interface TeamLineOption {
  matchId: string;
  matchName: string;
  team: 'home' | 'away';
  teamName: string;
  opponentName: string;
  point: number;
  odds: number;
  bookmaker: string;
  updatedAt: string;
  /** How many bookmakers are offering a price for this side — feeds
   * computeTeamLineDataConfidence, not the odds/point shown to the user. */
  bookmakerCount: number;
}

/** Best (shortest) price per side, one option per side per match. */
export async function getTeamLineOptionsForMatch(
  matchId: string,
  homeTeam: string,
  awayTeam: string,
): Promise<TeamLineOption[]> {
  const { data, error } = await supabase
    .from('match_odds')
    .select('*')
    .eq('match_id', matchId)
    .eq('market', 'spreads');

  if (error || !data || data.length === 0) return [];

  const matchName = `${homeTeam} vs ${awayTeam}`;
  const homeCount = data.filter(r => r.home_point !== null && r.home_odds !== null).length;
  const awayCount = data.filter(r => r.away_point !== null && r.away_odds !== null).length;
  let best: { home: TeamLineOption | null; away: TeamLineOption | null } = { home: null, away: null };

  for (const row of data) {
    if (row.home_point !== null && row.home_odds !== null) {
      const option: TeamLineOption = {
        matchId, matchName, team: 'home', teamName: homeTeam, opponentName: awayTeam,
        point: row.home_point, odds: row.home_odds, bookmaker: row.bookmaker, updatedAt: row.updated_at,
        bookmakerCount: homeCount,
      };
      if (!best.home || option.odds > best.home.odds) best.home = option;
    }
    if (row.away_point !== null && row.away_odds !== null) {
      const option: TeamLineOption = {
        matchId, matchName, team: 'away', teamName: awayTeam, opponentName: homeTeam,
        point: row.away_point, odds: row.away_odds, bookmaker: row.bookmaker, updatedAt: row.updated_at,
        bookmakerCount: awayCount,
      };
      if (!best.away || option.odds > best.away.odds) best.away = option;
    }
  }

  return [best.home, best.away].filter((o): o is TeamLineOption => o !== null);
}

export interface TeamLineHistoryEntry {
  matchId: string;
  matchDate: string | null;
  point: number;
  actualMargin: number;
  covered: boolean;
}

/**
 * A team's actual results vs their match_odds line in past completed
 * matches. excludeMatchId keeps the match currently being built out of its
 * own history sample. Since match_odds rows are keyed by (match_id,
 * bookmaker, market) and never resynced once a match is old news, a row
 * that survives here approximates the closing line for that match.
 */
export async function getTeamLineHistory(teamName: string, excludeMatchId?: string): Promise<TeamLineHistoryEntry[]> {
  const canonicalTeam = normalizeTeam(teamName) ?? teamName;

  // Team names are inconsistent across rows in this schema ("Fremantle" vs
  // "Fremantle Dockers", "Geelong" vs "Geelong Cats", etc. — confirmed by
  // spot-checking live data). An exact-match .or() filter would silently
  // under-count history for any team with more than one spelling in use, so
  // match client-side via the shared canonical normalizer instead.
  const { data: matches, error: matchesError } = await supabase
    .from('matches')
    .select('id, home_team, away_team, home_score, away_score, match_date')
    .not('home_score', 'is', null)
    .not('away_score', 'is', null);

  if (matchesError || !matches || matches.length === 0) return [];

  const relevantMatches = matches.filter(m =>
    m.id !== excludeMatchId &&
    (normalizeTeam(m.home_team) === canonicalTeam || normalizeTeam(m.away_team) === canonicalTeam),
  );
  if (relevantMatches.length === 0) return [];

  const matchIds = relevantMatches.map(m => m.id);
  const { data: oddsRows, error: oddsError } = await supabase
    .from('match_odds')
    .select('match_id, home_point, away_point')
    .in('match_id', matchIds)
    .eq('market', 'spreads');

  if (oddsError || !oddsRows) return [];

  const pointByMatchId = new Map<string, number>();
  for (const row of oddsRows) {
    if (pointByMatchId.has(row.match_id ?? '')) continue;
    const match = relevantMatches.find(m => m.id === row.match_id);
    const isHome = normalizeTeam(match?.home_team) === canonicalTeam;
    const point = isHome ? row.home_point : row.away_point;
    if (point !== null && row.match_id) pointByMatchId.set(row.match_id, point);
  }

  const history: TeamLineHistoryEntry[] = [];
  for (const m of relevantMatches) {
    const point = pointByMatchId.get(m.id);
    if (point === undefined) continue;
    const isHome = normalizeTeam(m.home_team) === canonicalTeam;
    const teamScore = isHome ? m.home_score : m.away_score;
    const opponentScore = isHome ? m.away_score : m.home_score;
    if (teamScore === null || opponentScore === null) continue;
    const actualMargin = teamScore - opponentScore;
    history.push({ matchId: m.id, matchDate: m.match_date, point, actualMargin, covered: actualMargin > -point });
  }

  history.sort((a, b) => (b.matchDate ?? '').localeCompare(a.matchDate ?? ''));
  return history;
}

export interface TeamLineCoverProbability {
  coverProbability: number | null;
  sampleSize: number;
  label: 'UNRATED' | 'RATED';
}

const MIN_MATCHES_FOR_COVER_RATE = 5;

/**
 * Past lines of comparable magnitude to the one being evaluated (within
 * tolerancePoints) — a team's record covering -50 lines isn't a reliable
 * guide to a -12 line. Shared by calculateTeamLineCoverProbability and
 * teamLineSafetyScore.ts so both read the same filtered sample.
 */
export function filterComparableHistory(
  history: TeamLineHistoryEntry[],
  point: number,
  tolerancePoints = 6,
): TeamLineHistoryEntry[] {
  return history.filter(h => Math.abs(point - h.point) <= tolerancePoints);
}

/**
 * Cover rate among past lines of comparable magnitude to the one being
 * evaluated. Below MIN_MATCHES_FOR_COVER_RATE, returns null rather than a
 * number built on too little data.
 */
export function calculateTeamLineCoverProbability(
  history: TeamLineHistoryEntry[],
  point: number,
  tolerancePoints = 6,
): TeamLineCoverProbability {
  const comparable = filterComparableHistory(history, point, tolerancePoints);
  if (comparable.length < MIN_MATCHES_FOR_COVER_RATE) {
    return { coverProbability: null, sampleSize: comparable.length, label: 'UNRATED' };
  }
  const covers = comparable.filter(h => h.covered).length;
  return { coverProbability: covers / comparable.length, sampleSize: comparable.length, label: 'RATED' };
}
