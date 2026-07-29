/**
 * Safety Score — measures whether a player safely clears a selected line,
 * not just whether they historically hit it.
 *
 * The key gap this closes: two players who both went 5/5 against a line can
 * have very different downside risk. A player who cleared a 25+ line by
 * (3, 5, 6, 4, 7) disposals is far safer than one who cleared it by
 * (0, 1, 0, 2, 1) — same hit rate, very different floor. Reuses existing
 * verified sources (modelResolver's ModelProb, disposalLineSelector's
 * last-N hit helpers, roleTrendService's CBA/kick-in trend) rather than
 * recalculating hit rates; the only new computation here is the margin
 * (statValue - line) distribution, i.e. the Floor Buffer.
 *
 * Never invents a value: a component with insufficient sample is dropped
 * from the weighted sum entirely (never scored as 0), matching the pattern
 * already used by playerIntelligenceService.ts.
 */
import type { CanonicalGameRow } from './canonicalGameLog';
import type { ModelProb } from './modelResolver';
import type { RoleTrendEntry } from './roleTrendService';

export interface FloorBuffer {
  last5MinMargin: number | null;
  last10MinMargin: number | null;
  medianMargin: number | null;
  avgMargin: number | null;
  p10Margin: number | null;
  timesExactlyOnLine: number;
  timesOneAboveLine: number;
  stdDev: number | null;
  coefficientOfVariation: number | null;
  sampleSize: number;
}

export interface SafetyScoreResult {
  score: number | null;
  label: 'UNRATED' | 'WEAK' | 'MODERATE' | 'STRONG' | 'ELITE';
  floorBuffer: FloorBuffer;
  breakdown: Record<string, number>;
  dataConfidenceDamping: number;
}

const MIN_GAMES_FOR_FLOOR_BUFFER = 5;

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const frac = idx - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

function stddev(values: number[], mean: number): number {
  if (values.length < 2) return 0;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Compute the margin-above-line distribution (Floor Buffer) from a game log
 * ordered newest-first, as returned by getCanonicalPlayerGameLog.
 */
export function calculateFloorBuffer(gameLog: CanonicalGameRow[], line: number): FloorBuffer {
  const sampleSize = gameLog.length;
  if (sampleSize === 0) {
    return {
      last5MinMargin: null, last10MinMargin: null, medianMargin: null, avgMargin: null,
      p10Margin: null, timesExactlyOnLine: 0, timesOneAboveLine: 0, stdDev: null,
      coefficientOfVariation: null, sampleSize: 0,
    };
  }

  const margins = gameLog.map(r => r.statValue - line);
  const last5 = margins.slice(0, 5);
  const last10 = margins.slice(0, 10);

  const last5MinMargin = last5.length > 0 ? Math.min(...last5) : null;
  const last10MinMargin = last10.length > 0 ? Math.min(...last10) : null;

  const sortedAsc = [...margins].sort((a, b) => a - b);
  const medianMargin = percentile(sortedAsc, 50);
  const avgMargin = margins.reduce((a, b) => a + b, 0) / margins.length;
  const p10Margin = percentile(sortedAsc, 10);

  const timesExactlyOnLine = gameLog.filter(r => r.statValue === line).length;
  const timesOneAboveLine = gameLog.filter(r => r.statValue === line + 1).length;

  const sd = sampleSize >= 2 ? stddev(margins, avgMargin) : null;
  // CV is only meaningful relative to a positive average margin
  const coefficientOfVariation = sd !== null && avgMargin > 0 ? sd / avgMargin : null;

  return {
    last5MinMargin, last10MinMargin, medianMargin, avgMargin, p10Margin,
    timesExactlyOnLine, timesOneAboveLine, stdDev: sd, coefficientOfVariation, sampleSize,
  };
}

export interface SafetyScoreStabilityInputs {
  seasonTogStdDev?: number | null;
  roleTrend?: RoleTrendEntry | null;
  substituteRisk?: boolean | null;
  tagRiskDataAvailable?: boolean;
  tagRiskLevel?: 'low' | 'moderate' | 'high' | 'very_high' | null;
}

/**
 * Calculate a 0-100 Safety Score for a single player line.
 *
 * gameLog must be ordered newest-first (as returned by
 * getCanonicalPlayerGameLog). dataConfidence (0-100) comes from
 * computeDataConfidence in playerIntelligenceService.ts and is applied as a
 * damping multiplier — a line with thin/incomplete data cannot reach a high
 * Safety Score no matter how good its recent record looks.
 */
export function calculateSafetyScore(
  gameLog: CanonicalGameRow[],
  line: number,
  modelProb: ModelProb,
  dataConfidence: number | null,
  stability: SafetyScoreStabilityInputs = {},
): SafetyScoreResult {
  const floorBuffer = calculateFloorBuffer(gameLog, line);

  if (modelProb.adjustedProb === null || gameLog.length < MIN_GAMES_FOR_FLOOR_BUFFER) {
    return {
      score: null,
      label: 'UNRATED',
      floorBuffer,
      breakdown: {},
      dataConfidenceDamping: 1,
    };
  }

  const breakdown: Record<string, number> = {};
  let weightedSum = 0;
  let totalWeight = 0;

  const add = (key: string, value: number | null, weight: number, scaleToUnit: (v: number) => number) => {
    if (value === null || Number.isNaN(value)) return;
    const unit = Math.max(0, Math.min(1, scaleToUnit(value)));
    breakdown[key] = Math.round(unit * weight * 100) / 100;
    weightedSum += unit * weight;
    totalWeight += weight;
  };

  // Calibrated adjusted probability — core signal, moderate weight
  add('adjustedProbability', modelProb.adjustedProb, 20, v => v);

  // Hit-rate windows — season carries more weight than recent, since a long
  // consistent record is harder to fake than a hot streak
  add('seasonHitRate', modelProb.hit_rate, 10, v => v);

  // Floor Buffer — the differentiator. A min margin of 0 (landed exactly on
  // the line) is the floor; +5 or more margin is treated as very safe.
  add('last5MinMargin', floorBuffer.last5MinMargin, 20, v => 0.5 + v / 10);
  add('last10MinMargin', floorBuffer.last10MinMargin, 12, v => 0.5 + v / 10);
  add('p10Margin', floorBuffer.p10Margin, 10, v => 0.5 + v / 10);
  add('avgMargin', floorBuffer.avgMargin, 8, v => 0.5 + v / 12);

  // Consistency: fewer near-miss games (exactly on line, one above) = safer.
  // Expressed as a rate over sample size so larger samples aren't unfairly punished.
  if (floorBuffer.sampleSize > 0) {
    const nearMissRate = (floorBuffer.timesExactlyOnLine + floorBuffer.timesOneAboveLine) / floorBuffer.sampleSize;
    add('nearMissPenalty', nearMissRate, 8, v => 1 - v);
  }

  // Coefficient of variation — lower volatility relative to margin = safer
  if (floorBuffer.coefficientOfVariation !== null) {
    add('volatility', floorBuffer.coefficientOfVariation, 6, v => 1 - Math.min(1, v));
  }

  // Sample size — more history = more trustworthy floor estimate
  add('sampleSize', modelProb.sample_size, 6, v => Math.min(1, v / 30));

  // Role/TOG stability signals — optional, dropped when unavailable
  if (stability.seasonTogStdDev !== null && stability.seasonTogStdDev !== undefined) {
    add('togStability', stability.seasonTogStdDev, 4, v => 1 - Math.min(1, v / 15));
  }
  if (stability.roleTrend) {
    const trendUnit = stability.roleTrend.trendLabel === 'STRONG_POSITIVE' || stability.roleTrend.trendLabel === 'POSITIVE' ? 1
      : stability.roleTrend.trendLabel === 'STABLE' ? 0.75
      : stability.roleTrend.trendLabel === 'NEGATIVE' ? 0.35
      : stability.roleTrend.trendLabel === 'STRONG_NEGATIVE' ? 0.1
      : null;
    if (trendUnit !== null) add('roleStability', trendUnit, 6, v => v);
  }
  // Tag risk: only scored when genuine data exists. When unavailable, it is
  // dropped from the weighted sum entirely — never treated as neutral-good
  // or fabricated as a risk level.
  if (stability.tagRiskDataAvailable && stability.tagRiskLevel) {
    const tagUnit = stability.tagRiskLevel === 'low' ? 1
      : stability.tagRiskLevel === 'moderate' ? 0.6
      : stability.tagRiskLevel === 'high' ? 0.25
      : 0.05; // very_high
    add('tagRisk', tagUnit, 5, v => v);
  }

  if (totalWeight === 0) {
    return { score: null, label: 'UNRATED', floorBuffer, breakdown, dataConfidenceDamping: 1 };
  }

  const rawUnit = weightedSum / totalWeight;

  // Data Confidence damping: a leg with 40% data confidence cannot exceed a
  // proportionally reduced ceiling, regardless of how safe its raw signals look.
  const damping = dataConfidence !== null ? 0.55 + 0.45 * Math.max(0, Math.min(1, dataConfidence / 100)) : 0.7;
  const score = Math.round(rawUnit * damping * 100);

  const label: SafetyScoreResult['label'] =
    score >= 88 ? 'ELITE' : score >= 75 ? 'STRONG' : score >= 55 ? 'MODERATE' : 'WEAK';

  return { score, label, floorBuffer, breakdown, dataConfidenceDamping: damping };
}
