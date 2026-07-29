/**
 * Probability calibration — leakage-proof backfill.
 *
 * Recomputes what the model would genuinely have predicted for a completed
 * match, using ONLY player_game_stats dated strictly before that match
 * (via getCanonicalPlayerGameLogAsOf), then compares the prediction to the
 * real outcome. Reuses the live model's own math (calculateModelProb from
 * modelResolver.ts) rather than reimplementing it, so calibration measures
 * the actual production formula, not an approximation of it.
 *
 * Data reality check (verified against the live DB before building this):
 * bookmaker_odds only has genuine historical rows from 2026-07-07 onward —
 * a real but thin sample (~20-23 completed matches as of this writing).
 * Every report built on this data must say so plainly rather than implying
 * more statistical confidence than a few weeks of odds history supports.
 */
import { supabase } from './supabase';
import { getCanonicalPlayerGameLogAsOf, isHit } from './canonicalGameLog';
import { calculateModelProb } from './modelResolver';

export interface BackfillPrediction {
  matchId: string;
  matchDate: string;
  playerId: string;
  playerName: string;
  line: number;
  overOdds: number;
  predictedProb: number;
  actualHit: boolean;
  historicalSample: number;
}

export interface CompletedMatchInput {
  matchId: string;
  matchDate: string; // ISO date, must be strictly in the past
}

/**
 * Rebuilds every genuine disposals prediction for one completed match,
 * using only pre-match history, and checks it against the real result.
 */
export async function backfillMatchPredictions(match: CompletedMatchInput): Promise<BackfillPrediction[]> {
  const today = new Date().toISOString().slice(0, 10);
  if (match.matchDate >= today) {
    // Belt-and-braces leakage guard — this function must never be pointed
    // at a match that hasn't been played yet.
    return [];
  }

  const { data: oddsRows, error } = await supabase
    .from('bookmaker_odds')
    .select('player_id, resolved_player_name, bookmaker_player_name, line, market, over_odds')
    .eq('match_id', match.matchId)
    .eq('market', 'disposals');

  if (error || !oddsRows || oddsRows.length === 0) return [];

  // One prediction per genuine (player, line) pair — multiple bookmakers
  // offering the same line don't need separate predictions.
  const uniqueLines = new Map<string, { playerId: string; playerName: string; line: number; overOdds: number }>();
  for (const row of oddsRows) {
    if (!row.player_id || row.line === null || row.over_odds === null) continue;
    const key = `${row.player_id}|${row.line}`;
    if (!uniqueLines.has(key)) {
      uniqueLines.set(key, {
        playerId: row.player_id,
        playerName: row.resolved_player_name ?? row.bookmaker_player_name ?? 'Unknown player',
        line: row.line,
        overOdds: row.over_odds,
      });
    }
  }

  if (uniqueLines.size === 0) return [];

  const playerIds = Array.from(new Set(Array.from(uniqueLines.values()).map(v => v.playerId)));

  // Real outcome for this exact match — never derived from anything but the
  // recorded result.
  const { data: actualRows } = await supabase
    .from('player_game_stats')
    .select('player_id, disposals')
    .eq('match_id', match.matchId)
    .in('player_id', playerIds);

  const actualByPlayer = new Map<string, number>();
  for (const row of actualRows ?? []) {
    if (row.player_id && row.disposals !== null) actualByPlayer.set(row.player_id, row.disposals);
  }

  const results = await Promise.all(Array.from(uniqueLines.values()).map(async ({ playerId, playerName, line, overOdds }) => {
    const actualValue = actualByPlayer.get(playerId);
    if (actualValue === undefined) return null; // match not fully synced yet — skip, don't guess

    const { rows, seasonRows } = await getCanonicalPlayerGameLogAsOf(playerId, 'disposals', match.matchDate);
    if (rows.length < 5) return null; // not enough pre-match history to genuinely predict

    const values = rows.map(r => r.statValue);
    const seasonValues = seasonRows.map(r => r.statValue);
    const modelProb = calculateModelProb(values, line, null, 'weighted', seasonValues);
    if (modelProb.adjustedProb === null) return null;

    const prediction: BackfillPrediction = {
      matchId: match.matchId,
      matchDate: match.matchDate,
      playerId,
      playerName,
      line,
      overOdds,
      predictedProb: modelProb.adjustedProb,
      actualHit: isHit(actualValue, line),
      historicalSample: rows.length,
    };
    return prediction;
  }));

  return results.filter((p): p is BackfillPrediction => p !== null);
}

export async function runCalibrationBackfill(matches: CompletedMatchInput[]): Promise<BackfillPrediction[]> {
  const perMatch = await Promise.all(matches.map(match => backfillMatchPredictions(match)));
  return perMatch.flat();
}

/**
 * Finds every completed match that has genuine bookmaker_odds coverage —
 * the only matches this module can honestly backfill. Paginates through
 * bookmaker_odds (it can hold tens of thousands of rows) to collect every
 * distinct match_id, then filters to matches whose date has passed.
 */
export async function getCompletedMatchesWithGenuineOdds(): Promise<CompletedMatchInput[]> {
  const matchIds = new Set<string>();
  const pageSize = 5000;
  let offset = 0;
  for (let guard = 0; guard < 30; guard++) {
    const { data, error } = await supabase
      .from('bookmaker_odds')
      .select('match_id')
      .eq('market', 'disposals')
      .range(offset, offset + pageSize - 1);
    if (error || !data || data.length === 0) break;
    for (const row of data) if (row.match_id) matchIds.add(row.match_id);
    if (data.length < pageSize) break;
    offset += pageSize;
  }

  if (matchIds.size === 0) return [];

  const { data: matches, error: matchError } = await supabase
    .from('matches')
    .select('id, match_date')
    .in('id', Array.from(matchIds));

  if (matchError || !matches) return [];

  const today = new Date().toISOString().slice(0, 10);
  return matches
    .filter((m): m is { id: string; match_date: string } => Boolean(m.match_date) && m.match_date! < today)
    .map(m => ({ matchId: m.id, matchDate: m.match_date }))
    .sort((a, b) => a.matchDate.localeCompare(b.matchDate));
}

export interface CalibrationBucket {
  label: string;
  rangeMin: number;
  rangeMax: number;
  predictionsMade: number;
  expectedHits: number;
  actualHits: number;
  expectedHitRate: number | null;
  actualHitRate: number | null;
  calibrationDifference: number | null; // actual - expected, signed
  brierScore: number | null;
  provisional: boolean; // true when sample is too small to trust the numbers above
}

const MIN_BUCKET_SAMPLE = 5;

const BUCKET_RANGES: { label: string; min: number; max: number }[] = [
  { label: '70-74%', min: 0.70, max: 0.75 },
  { label: '75-79%', min: 0.75, max: 0.80 },
  { label: '80-84%', min: 0.80, max: 0.85 },
  { label: '85-89%', min: 0.85, max: 0.90 },
  { label: '90-94%', min: 0.90, max: 0.95 },
  { label: '95%+', min: 0.95, max: 1.01 },
];

export interface CalibrationReport {
  buckets: CalibrationBucket[];
  overallBrierScore: number | null;
  totalPredictions: number;
  matchesUsed: number;
}

/**
 * Buckets predictions into the spec's 6 probability ranges and computes
 * expected vs actual hit rate, calibration difference, and Brier score per
 * bucket. Buckets under MIN_BUCKET_SAMPLE are marked provisional rather
 * than given a falsely precise number.
 */
export function buildCalibrationReport(predictions: BackfillPrediction[]): CalibrationReport {
  const buckets: CalibrationBucket[] = BUCKET_RANGES.map(range => {
    const inBucket = predictions.filter(p => p.predictedProb >= range.min && p.predictedProb < range.max);
    const predictionsMade = inBucket.length;
    const expectedHits = inBucket.reduce((s, p) => s + p.predictedProb, 0);
    const actualHits = inBucket.filter(p => p.actualHit).length;
    const expectedHitRate = predictionsMade > 0 ? expectedHits / predictionsMade : null;
    const actualHitRate = predictionsMade > 0 ? actualHits / predictionsMade : null;
    const calibrationDifference = expectedHitRate !== null && actualHitRate !== null ? actualHitRate - expectedHitRate : null;
    const brierScore = predictionsMade > 0
      ? inBucket.reduce((s, p) => s + (p.predictedProb - (p.actualHit ? 1 : 0)) ** 2, 0) / predictionsMade
      : null;

    return {
      label: range.label,
      rangeMin: range.min,
      rangeMax: range.max,
      predictionsMade,
      expectedHits,
      actualHits,
      expectedHitRate,
      actualHitRate,
      calibrationDifference,
      brierScore,
      provisional: predictionsMade < MIN_BUCKET_SAMPLE,
    };
  });

  const overallBrierScore = predictions.length > 0
    ? predictions.reduce((s, p) => s + (p.predictedProb - (p.actualHit ? 1 : 0)) ** 2, 0) / predictions.length
    : null;

  return {
    buckets,
    overallBrierScore,
    totalPredictions: predictions.length,
    matchesUsed: new Set(predictions.map(p => p.matchId)).size,
  };
}
