/**
 * Shared bet grading logic: Sweet Spot, Staking Suggestion, Best Line Optimizer,
 * Sample Window types, sample warning tags, confidence by sample size.
 * Reused by EVCalculatorPage and MultiBuilderPage.
 */

export type SampleWindow =
  | 'weighted'
  | 'last5'
  | 'last10'
  | 'last15'
  | 'last20'
  | 'last30'
  | 'season'
  | 'custom';

export const SAMPLE_WINDOW_LABELS: Record<SampleWindow, string> = {
  weighted: 'Weighted Model',
  last5: 'Last 5',
  last10: 'Last 10',
  last15: 'Last 15',
  last20: 'Last 20',
  last30: 'Last 30',
  season: 'Current Season',
  custom: 'Custom Date Range',
};

export interface SampleWindowOption {
  value: SampleWindow;
  label: string;
}

export const SAMPLE_WINDOW_OPTIONS: SampleWindowOption[] = [
  { value: 'weighted', label: 'Weighted Model' },
  { value: 'last5', label: 'Last 5' },
  { value: 'last10', label: 'Last 10' },
  { value: 'last15', label: 'Last 15' },
  { value: 'last20', label: 'Last 20' },
  { value: 'last30', label: 'Last 30' },
  { value: 'season', label: 'Current Season' },
  { value: 'custom', label: 'Custom Date Range' },
];

export interface WindowHitRate {
  window: SampleWindow;
  label: string;
  sample_size: number;
  hit_count: number;
  hit_rate: number;
}

export interface SampleComparison {
  last5: WindowHitRate | null;
  last10: WindowHitRate | null;
  last15: WindowHitRate | null;
  last20: WindowHitRate | null;
  last30: WindowHitRate | null;
  season: WindowHitRate | null;
}

export function computeWindowHitRate(
  values: number[],
  threshold: number,
  window: SampleWindow,
  seasonYear?: number,
  customStart?: string,
  customEnd?: string
): WindowHitRate | null {
  if (values.length === 0) return null;

  let windowed: number[] = [];

  switch (window) {
    case 'last5':
      windowed = values.slice(0, 5);
      break;
    case 'last10':
      windowed = values.slice(0, 10);
      break;
    case 'last15':
      windowed = values.slice(0, 15);
      break;
    case 'last20':
      windowed = values.slice(0, 20);
      break;
    case 'last30':
      windowed = values.slice(0, 30);
      break;
    case 'season':
      // Current season: filter by match_date year if available
      // values array doesn't carry dates, so this is handled by the caller
      // who pre-filters. Here we just use all values as a fallback.
      windowed = values;
      break;
    case 'custom':
      // Custom date range: also handled by caller pre-filtering
      windowed = values;
      break;
    case 'weighted':
    default:
      windowed = values;
      break;
  }

  if (windowed.length === 0) return null;

  const hit_count = windowed.filter(v => v >= threshold).length;
  const hit_rate = hit_count / windowed.length;

  return {
    window,
    label: SAMPLE_WINDOW_LABELS[window],
    sample_size: windowed.length,
    hit_count,
    hit_rate,
  };
}

export function computeSampleComparison(
  values: number[],
  threshold: number,
  seasonValues?: number[]
): SampleComparison {
  return {
    last5: computeWindowHitRate(values, threshold, 'last5'),
    last10: computeWindowHitRate(values, threshold, 'last10'),
    last15: computeWindowHitRate(values, threshold, 'last15'),
    last20: computeWindowHitRate(values, threshold, 'last20'),
    last30: computeWindowHitRate(values, threshold, 'last30'),
    season: seasonValues && seasonValues.length > 0 ? computeWindowHitRate(seasonValues, threshold, 'weighted') : null,
  };
}

export function computeSampleWarningTags(comparison: SampleComparison): string[] {
  const tags: string[] = [];
  const last5 = comparison.last5;
  const last10 = comparison.last10;
  const last30 = comparison.last30;

  if (!last5 || !last30) return tags;

  const last5Rate = last5.hit_rate;
  const last30Rate = last30.hit_rate;
  const last10Rate = last10?.hit_rate ?? null;

  // Small Sample
  if (last30.sample_size < 10) tags.push('Small Sample');

  // Recent Spike: Last 5 hit rate >= 20pp higher than Last 30
  if (last5Rate - last30Rate >= 0.20) tags.push('Recent Spike');

  // Recent Drop: Last 5 hit rate >= 20pp lower than Last 30
  if (last30Rate - last5Rate >= 0.20) tags.push('Recent Drop');

  // Stable: Last 5, Last 10, Last 30 within 15pp of each other
  if (last10Rate !== null) {
    const rates = [last5Rate, last10Rate, last30Rate];
    const spread = Math.max(...rates) - Math.min(...rates);
    if (spread <= 0.15) tags.push('Stable');
  }

  // Volatile: Last 5 and Last 30 differ by more than 30pp
  if (Math.abs(last5Rate - last30Rate) > 0.30) tags.push('Volatile');

  return tags;
}

export function confidenceFactorBySampleSize(sampleSize: number): { factor: number; confidence: 'none' | 'low' | 'medium' | 'high' } {
  if (sampleSize < 5) return { factor: 0, confidence: 'none' };
  if (sampleSize < 10) return { factor: 0.65, confidence: 'low' };
  if (sampleSize < 15) return { factor: 0.80, confidence: 'medium' };
  if (sampleSize < 25) return { factor: 0.90, confidence: 'high' };
  return { factor: 0.95, confidence: 'high' };
}

export interface GradeInput {
  adjustedProb: number | null;
  adjustedEV: number | null;
  qualityScore: number;
  odds: number;
  sampleSize: number;
  hitCount: number;
  venueAdjustment: number;
  opponentAdjustment: number;
  riskLevel: 'Low' | 'Medium' | 'High';
  tags: string[];
}

export interface SweetSpotResult {
  isSweetSpot: boolean;
  reasons: string[];
}

export function isSweetSpot(g: GradeInput): SweetSpotResult {
  const reasons: string[] = [];
  const adjProb = g.adjustedProb ?? 0;
  const evPct = (g.adjustedEV ?? 0) * 100;

  if (adjProb < 0.45 || adjProb > 0.80) reasons.push('Adjusted P outside 45-80%');
  if (evPct < 5) reasons.push('Adjusted EV < 5%');
  if (g.qualityScore < 80) reasons.push('Quality score < 80');
  if (g.odds < 1.40 || g.odds > 3.00) reasons.push('Odds outside 1.40-3.00');
  if (g.sampleSize < 15) reasons.push('Sample size < 15');
  if (g.hitCount < 5) reasons.push('Hit count < 5');
  if (g.venueAdjustment < -0.03) reasons.push('Weak venue');
  if (g.opponentAdjustment < -0.03) reasons.push('Weak opponent');
  if (g.riskLevel === 'High') reasons.push('High-risk longshot');

  return { isSweetSpot: reasons.length === 0, reasons };
}

export type StakeSuggestion = 0 | 0.25 | 0.5 | 0.75 | 1.0;

export function suggestStake(g: GradeInput): { units: StakeSuggestion; label: string } {
  const evPct = (g.adjustedEV ?? 0) * 100;
  const adjProb = g.adjustedProb ?? 0;
  const weakContext = g.venueAdjustment < -0.03 || g.opponentAdjustment < -0.03;

  // 1.0u: elite edge
  if (
    evPct >= 20 &&
    g.qualityScore >= 90 &&
    adjProb >= 0.60 &&
    g.sampleSize >= 20 &&
    g.hitCount >= 15 &&
    !weakContext &&
    (g.riskLevel === 'Low' || g.riskLevel === 'Medium')
  ) {
    return { units: 1.0, label: 'Elite edge' };
  }

  // 0.75u: strong edge
  if (
    evPct >= 12 &&
    evPct < 20 &&
    g.qualityScore >= 85 &&
    adjProb >= 0.55 &&
    !weakContext
  ) {
    return { units: 0.75, label: 'Strong edge' };
  }

  // 0.5u: normal edge
  if (
    evPct >= 6 &&
    evPct < 12 &&
    g.qualityScore >= 80 &&
    adjProb >= 0.50
  ) {
    return { units: 0.5, label: 'Normal edge' };
  }

  // 0.25u: thin edge
  if (
    evPct >= 3 &&
    evPct < 6 &&
    g.qualityScore >= 70
  ) {
    return { units: 0.25, label: 'Thin edge' };
  }

  // Also handle strong edges that don't meet 1.0u but exceed 0.75 thresholds
  if (evPct >= 12 && g.qualityScore >= 85 && adjProb >= 0.55 && !weakContext) {
    return { units: 0.75, label: 'Strong edge' };
  }
  if (evPct >= 6 && g.qualityScore >= 80 && adjProb >= 0.50) {
    return { units: 0.5, label: 'Normal edge' };
  }
  if (evPct >= 3 && g.qualityScore >= 70) {
    return { units: 0.25, label: 'Thin edge' };
  }

  return { units: 0, label: 'No edge' };
}

export interface BestLineCandidate {
  id: string;
  playerKey: string;
  statKey: string;
  playerName: string;
  line: number;
  displayLabel: string;
  odds: number;
  adjustedProb: number | null;
  adjustedEV: number | null;
  qualityScore: number;
  riskLevel: 'Low' | 'Medium' | 'High';
  hitCount: number;
  sampleSize: number;
  sweetSpot: boolean;
  stakeUnits: StakeSuggestion;
  row: unknown;
  positionGroup?: string;
  positionEdge?: unknown;
  positionEdgeAdjustment?: number;
  finalProbability?: number | null;
  finalEV?: number | null;
}

/**
 * Best Line Optimizer: for each player + stat, pick the single best threshold.
 * Scoring weights: quality score, sweet spot, adjusted EV, adjusted prob, hit count, odds range.
 */
export function pickBestLine<T extends BestLineCandidate>(candidates: T[]): T | null {
  if (candidates.length === 0) return null;

  const scored = candidates.map(c => {
    const evPct = ((c.finalEV ?? c.adjustedEV) ?? 0) * 100;
    const adjProb = ((c.finalProbability ?? c.adjustedProb) ?? 0) * 100;

    // Weighted score: quality 35, sweet spot 20, EV 20, adj prob 10, hit count 10, odds range 5
    let score = c.qualityScore * 0.35;
    if (c.sweetSpot) score += 20;
    score += Math.min(20, evPct) * 0.20;
    score += Math.min(10, adjProb / 8) * 0.10;
    score += Math.min(10, c.hitCount) * 0.10;
    // Prefer odds in the 1.60-2.50 sweet range
    if (c.odds >= 1.60 && c.odds <= 2.50) score += 5;
    else if (c.odds >= 1.40 && c.odds <= 3.00) score += 3;

    return { c, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0].c;
}

/**
 * Group rows by player + stat, return best line per group + all lines for expansion.
 */
export function optimizeBestLines<T extends BestLineCandidate>(
  rows: T[]
): { bestLine: T; allLines: T[] }[] {
  const groups = new Map<string, T[]>();

  for (const row of rows) {
    const key = `${row.playerKey}|${row.statKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  const results: { bestLine: T; allLines: T[] }[] = [];

  for (const [, groupRows] of groups) {
    // Sort each group by line ascending so allLines is a proper ladder
    const sorted = [...groupRows].sort((a, b) => a.line - b.line);
    const best = pickBestLine(sorted);
    if (best) results.push({ bestLine: best, allLines: sorted });
  }

  // Sort groups by best line quality score desc, then sweet spot, then EV
  results.sort((a, b) => {
    if (b.bestLine.qualityScore !== a.bestLine.qualityScore) {
      return b.bestLine.qualityScore - a.bestLine.qualityScore;
    }
    if (b.bestLine.sweetSpot !== a.bestLine.sweetSpot) {
      return b.bestLine.sweetSpot ? 1 : -1;
    }
    return (b.bestLine.finalEV ?? b.bestLine.adjustedEV ?? 0) - (a.bestLine.finalEV ?? a.bestLine.adjustedEV ?? 0);
  });

  return results;
}

export type BestBetTab = 'bestOverall' | 'safeEdge' | 'sweetSpots' | 'valueHunter' | 'longshots';

export function filterBestBetTab<T extends BestLineCandidate>(rows: T[], tab: BestBetTab): T[] {
  switch (tab) {
    case 'bestOverall':
      return rows.filter(r =>
        r.qualityScore >= 75 &&
        (r.adjustedEV ?? 0) * 100 >= 5 &&
        r.sampleSize >= 15 &&
        r.hitCount >= 5 &&
        r.odds <= 4.00
      );
    case 'safeEdge':
      return rows.filter(r =>
        r.qualityScore >= 80 &&
        (r.adjustedEV ?? 0) * 100 >= 3 &&
        r.sampleSize >= 20 &&
        r.hitCount >= 10 &&
        r.odds <= 2.00 &&
        r.riskLevel === 'Low'
      );
    case 'sweetSpots':
      return rows.filter(r => r.sweetSpot);
    case 'valueHunter':
      return rows.filter(r =>
        (r.adjustedEV ?? 0) * 100 >= 8 &&
        r.qualityScore >= 70 &&
        r.odds >= 2.00 &&
        r.odds <= 5.00 &&
        r.sampleSize >= 12 &&
        r.hitCount >= 3
      );
    case 'longshots':
      return rows.filter(r =>
        r.odds >= 3.00 &&
        r.odds <= 8.00 &&
        (r.adjustedEV ?? 0) * 100 >= 5 &&
        r.riskLevel !== 'Low'
      );
    default:
      return rows;
  }
}

/**
 * Sort Best Bets by: quality score, sweet spot, adjusted EV, adjusted prob, hit count.
 */
export function sortBestBets<T extends BestLineCandidate>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (b.qualityScore !== a.qualityScore) return b.qualityScore - a.qualityScore;
    if (b.sweetSpot !== a.sweetSpot) return b.sweetSpot ? 1 : -1;
    if ((b.adjustedEV ?? 0) !== (a.adjustedEV ?? 0)) return (b.adjustedEV ?? 0) - (a.adjustedEV ?? 0);
    if ((b.adjustedProb ?? 0) !== (a.adjustedProb ?? 0)) return (b.adjustedProb ?? 0) - (a.adjustedProb ?? 0);
    return b.hitCount - a.hitCount;
  });
}
