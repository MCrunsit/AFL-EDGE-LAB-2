/**
 * Bet Quality Score
 *
 * Historical stats-only score vs a given bookmaker line.
 * NO bookmaker probability math, NO EV, NO implied probability, NO vig.
 * NO winner-picking or betting recommendation.
 * Returns raw factors only — interpretation is left to the user.
 */

import type { PlayerGameStat, StatType } from './types';

export interface BetQualityResult {
  score: number;
  last5_avg: number | null;
  season_avg: number | null;
  hit_rate_last5: number;
  games_analyzed: number;
  breakdown: {
    last5_factor: number;
    season_factor: number;
    consistency_factor: number;
    venue_adjustment: number;
    opponent_adjustment: number;
  };
}

/**
 * Calculate bet quality score based purely on stats
 */
export function calculateBetQualityScore(
  stats: PlayerGameStat[],
  statType: StatType,
  line: number,
  options?: {
    venueAvg?: number | null;
    opponentAvg?: number | null;
  }
): BetQualityResult | null {
  if (stats.length === 0 || line <= 0) return null;

  // Extract values for this stat type
  const values = stats
    .map(s => (s as unknown as Record<string, unknown>)[statType])
    .filter(v => typeof v === 'number' && isFinite(v)) as number[];

  if (values.length === 0) return null;

  const last5 = values.slice(0, 5);
  const last5Avg = last5.reduce((a, b) => a + b, 0) / last5.length;
  const seasonAvg = values.reduce((a, b) => a + b, 0) / values.length;

  // Calculate hit rates
  const hitLast5 = last5.filter(v => v >= line).length / last5.length;
  const hitSeason = values.filter(v => v >= line).length / values.length;

  // Factors (0-25 each, total possible 100)
  let last5Factor = 0;
  if (last5Avg >= line + 3) last5Factor = 25;
  else if (last5Avg >= line + 1) last5Factor = 20;
  else if (last5Avg >= line - 0.5) last5Factor = 15;
  else if (last5Avg >= line - 2) last5Factor = 10;
  else last5Factor = 5;

  let seasonFactor = 0;
  if (seasonAvg >= line + 2) seasonFactor = 25;
  else if (seasonAvg >= line) seasonFactor = 20;
  else if (seasonAvg >= line - 1) seasonFactor = 15;
  else if (seasonAvg >= line - 3) seasonFactor = 10;
  else seasonFactor = 5;

  // Consistency factor (based on standard deviation)
  const mean = seasonAvg;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  const stdDev = Math.sqrt(variance);
  let consistencyFactor = Math.max(0, 25 - (stdDev / mean) * 50);

  // Venue adjustment (if provided)
  let venueAdjustment = 0;
  if (options?.venueAvg !== null && options?.venueAvg !== undefined) {
    const venueAvg = options.venueAvg;
    if (venueAvg >= line + 2) venueAdjustment = 5;
    else if (venueAvg >= line) venueAdjustment = 2;
    else if (venueAvg < line - 3) venueAdjustment = -3;
  }

  // Opponent adjustment (if provided)
  let opponentAdjustment = 0;
  if (options?.opponentAvg !== null && options?.opponentAvg !== undefined) {
    const oppAvg = options.opponentAvg;
    if (oppAvg >= line + 2) opponentAdjustment = 5;
    else if (oppAvg >= line) opponentAdjustment = 2;
    else if (oppAvg < line - 3) opponentAdjustment = -3;
  }

  // Total score (0-100)
  let score = Math.round(last5Factor + seasonFactor + consistencyFactor + venueAdjustment + opponentAdjustment);
  score = Math.max(0, Math.min(100, score));

  return {
    score,
    last5_avg: last5Avg,
    season_avg: seasonAvg,
    hit_rate_last5: hitLast5,
    games_analyzed: values.length,
    breakdown: {
      last5_factor: last5Factor,
      season_factor: seasonFactor,
      consistency_factor: consistencyFactor,
      venue_adjustment: venueAdjustment,
      opponent_adjustment: opponentAdjustment,
    },
  };
}
