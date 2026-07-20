/**
 * Model Probability Calculator
 *
 * All stat history now comes from the canonical game log engine (canonicalGameLog.ts).
 * No separate DB fetch — callers must pass pre-fetched canonical rows.
 *
 * Model probability formula:
 *   0.40 * season_hit_rate +
 *   0.25 * last_10_hit_rate +
 *   0.25 * last_5_hit_rate +
 *   0.10 * last_3_hit_rate
 */

import { computeWindowCounts, type CanonicalGameRow, type CanonicalStat } from './canonicalGameLog';

export interface ModelProbabilityResult {
  probability: number | null;
  sample_size: number;
  confidence: 'none' | 'low' | 'medium' | 'high';
  season_hit_rate: number | null;
  last_10_hit_rate: number | null;
  last_5_hit_rate: number | null;
  last_3_hit_rate: number | null;
  games_analyzed: number;
}

/**
 * Calculate model probability from canonical game rows (no DB fetch).
 * rows must already be sorted match_date DESC and deduplicated.
 */
export function calculateModelProbabilityFromRows(
  rows: CanonicalGameRow[],
  threshold: number,
  currentSeason: number,
): ModelProbabilityResult {
  if (rows.length < 5) {
    return {
      probability: null,
      sample_size: rows.length,
      confidence: 'none',
      season_hit_rate: null,
      last_10_hit_rate: null,
      last_5_hit_rate: null,
      last_3_hit_rate: null,
      games_analyzed: rows.length,
    };
  }

  const windows = computeWindowCounts(rows, threshold, currentSeason);
  const seasonHR = windows.currentSeason?.hitRate ?? null;
  const l10HR = windows.last10 ? windows.last10.hitRate : null;
  const l5HR = windows.last5 ? windows.last5.hitRate : null;
  const l3Slice = rows.slice(0, 3);
  const l3HR = l3Slice.length >= 3
    ? l3Slice.filter(r => r.statValue >= threshold).length / 3
    : null;

  // Weighted model
  let prob = (seasonHR ?? 0) * 0.40;
  if (l10HR !== null) prob += l10HR * 0.25;
  if (l5HR !== null) prob += l5HR * 0.25;
  if (l3HR !== null) prob += l3HR * 0.10;

  let confidence: 'none' | 'low' | 'medium' | 'high';
  if (rows.length >= 15) confidence = 'high';
  else if (rows.length >= 10) confidence = 'medium';
  else confidence = 'low';

  return {
    probability: Math.min(0.95, Math.max(0.05, prob)),
    sample_size: rows.length,
    confidence,
    season_hit_rate: seasonHR,
    last_10_hit_rate: l10HR,
    last_5_hit_rate: l5HR,
    last_3_hit_rate: l3HR,
    games_analyzed: rows.length,
  };
}
