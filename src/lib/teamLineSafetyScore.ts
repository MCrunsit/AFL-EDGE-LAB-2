/**
 * Team Line Safety Score — deliberately separate from the player-prop
 * Safety Score (safetyScore.ts). A team's margin-vs-line history is not a
 * per-player game log, so this is its own floor-buffer-style calc with its
 * own thresholds, not a parameter swap on the player formula. Never
 * fabricates a score from too little history — degrades to UNRATED below
 * MIN_MATCHES_FOR_TEAM_FLOOR_BUFFER, same convention as safetyScore.ts.
 */
import type { TeamLineHistoryEntry } from './teamLine';

export interface TeamLineFloorBuffer {
  last5MinMargin: number | null;
  medianMargin: number | null;
  avgMargin: number | null;
  sampleSize: number;
}

export interface TeamLineSafetyScoreResult {
  score: number | null;
  label: 'UNRATED' | 'WEAK' | 'MODERATE' | 'STRONG' | 'ELITE';
  floorBuffer: TeamLineFloorBuffer;
}

const MIN_MATCHES_FOR_TEAM_FLOOR_BUFFER = 5;

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

/**
 * history must be pre-filtered to comparable-magnitude lines (see
 * calculateTeamLineCoverProbability's tolerancePoints) and ordered
 * newest-first, as returned by getTeamLineHistory.
 */
export function calculateTeamLineFloorBuffer(history: TeamLineHistoryEntry[]): TeamLineFloorBuffer {
  const sampleSize = history.length;
  if (sampleSize === 0) {
    return { last5MinMargin: null, medianMargin: null, avgMargin: null, sampleSize: 0 };
  }
  // Cover margin: how far above/below the line the team actually finished.
  const coverMargins = history.map(h => h.actualMargin + h.point);
  const last5 = coverMargins.slice(0, 5);
  const last5MinMargin = last5.length > 0 ? Math.min(...last5) : null;
  const sortedAsc = [...coverMargins].sort((a, b) => a - b);
  const medianMargin = percentile(sortedAsc, 50);
  const avgMargin = coverMargins.reduce((a, b) => a + b, 0) / coverMargins.length;
  return { last5MinMargin, medianMargin, avgMargin, sampleSize };
}

/**
 * history must already be filtered to comparable-magnitude lines (see
 * calculateTeamLineCoverProbability). coverProbability/dataConfidence come
 * from teamLine.ts / computeTeamLineDataConfidence.
 */
export function calculateTeamLineSafetyScore(
  history: TeamLineHistoryEntry[],
  coverProbability: number | null,
  dataConfidence: number,
): TeamLineSafetyScoreResult {
  const floorBuffer = calculateTeamLineFloorBuffer(history);

  if (coverProbability === null || history.length < MIN_MATCHES_FOR_TEAM_FLOOR_BUFFER) {
    return { score: null, label: 'UNRATED', floorBuffer };
  }

  const breakdown: Record<string, number> = {};
  let weightedSum = 0;
  let totalWeight = 0;
  const add = (key: string, value: number | null, weight: number, scaleToUnit: (v: number) => number) => {
    if (value === null || Number.isNaN(value)) return;
    const unit = Math.max(0, Math.min(1, scaleToUnit(value)));
    breakdown[key] = unit * weight;
    weightedSum += unit * weight;
    totalWeight += weight;
  };

  add('coverProbability', coverProbability, 40, v => v);
  add('last5MinMargin', floorBuffer.last5MinMargin, 30, v => 0.5 + v / 40);
  add('avgMargin', floorBuffer.avgMargin, 20, v => 0.5 + v / 40);
  add('sampleSize', floorBuffer.sampleSize, 10, v => Math.min(1, v / 15));

  if (totalWeight === 0) return { score: null, label: 'UNRATED', floorBuffer };

  const rawUnit = weightedSum / totalWeight;
  const damping = 0.55 + 0.45 * Math.max(0, Math.min(1, dataConfidence / 100));
  const score = Math.round(rawUnit * damping * 100);
  const label: TeamLineSafetyScoreResult['label'] =
    score >= 88 ? 'ELITE' : score >= 75 ? 'STRONG' : score >= 55 ? 'MODERATE' : 'WEAK';

  return { score, label, floorBuffer };
}

/**
 * 0-100, always returned (never UNRATED) — reflects how much to trust the
 * cover-rate sample: more matches, fresher odds sync, more bookmakers
 * agreeing on the line all increase confidence.
 */
export function computeTeamLineDataConfidence(sampleSize: number, updatedAt: string, bookmakerCount: number): number {
  const sampleUnit = Math.min(1, sampleSize / 15);
  const daysSinceSync = (Date.now() - new Date(updatedAt).getTime()) / (1000 * 60 * 60 * 24);
  const freshnessUnit = Math.max(0, 1 - daysSinceSync / 14);
  const bookmakerUnit = Math.min(1, bookmakerCount / 4);
  const unit = sampleUnit * 0.5 + freshnessUnit * 0.3 + bookmakerUnit * 0.2;
  return Math.round(Math.max(0, Math.min(1, unit)) * 100);
}
