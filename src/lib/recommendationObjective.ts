/**
 * Canonical recommendation-objective gate. One function, three objectives
 * (Safest / Balanced / Best Value), reused everywhere a leg's automatic
 * recommendation eligibility needs to be decided: Best Individual Legs,
 * Top Recommended Legs, Recommended Multis (handleBuild), diagnostics, and
 * the "Recommended Lines Only" filter inside Build Your Own Multi.
 *
 * Does NOT recompute probability, EV, hit-rate, freshness or intelligence —
 * it only reads the already-computed ModelledOddsRow.modelProb and the
 * already-computed PlayerIntelligence to decide eligible/warnings/reasons.
 *
 * Thresholds are user-adjustable (see ObjectiveThresholds) so the risk bar
 * for each objective can be tuned from the UI without a code change.
 */
import type { ModelledOddsRow } from './modelResolver';
import type { PlayerIntelligence } from './playerIntelligenceService';
import { getLast10Hits, getLast5Hits } from './disposalLineSelector';

export type RecommendationObjective = 'safest' | 'balanced' | 'bestValue';

export interface ObjectiveThresholds {
  /** 0-1. Minimum model-adjusted win probability. */
  minAdjustedProb: number;
  /** 0-1. Minimum season hit rate. 0 = no requirement. */
  minHitRate: number;
  /** Minimum genuine unique games in sample. */
  minSampleSize: number;
  /** Minimum hits out of the last 10 games (only enforced when 10 games are available). 0 = no requirement. */
  minLast10Hits: number;
  /** Minimum hits out of the last 5 games (only enforced when 5 games are available). 0 = no requirement. */
  minLast5Hits: number;
  /** Minimum Intelligence Score, only enforced when a score exists. 0 = no requirement. */
  minIntelligenceScore: number;
  /** Highest risk_level still allowed. */
  allowedRisk: 'low' | 'lowMedium' | 'any';
  /** Exclude Team Environment LOW (Very Negative). */
  excludeVeryNegativeEnv: boolean;
  /** Exclude Position Edge NEGATIVE or VERY_NEGATIVE. */
  excludeNegativePosition: boolean;
  /** Exclude Role Intelligence ROLE_REDUCTION (falling role). */
  excludeRoleReduction: boolean;
  /** Require freshness status CURRENT. */
  requireFreshCurrent: boolean;
}

export const DEFAULT_OBJECTIVE_THRESHOLDS: Record<RecommendationObjective, ObjectiveThresholds> = {
  safest: {
    minAdjustedProb: 0.80, minHitRate: 0.70, minSampleSize: 10,
    minLast10Hits: 8, minLast5Hits: 4, minIntelligenceScore: 50,
    allowedRisk: 'low', excludeVeryNegativeEnv: true, excludeNegativePosition: true,
    excludeRoleReduction: true, requireFreshCurrent: true,
  },
  balanced: {
    minAdjustedProb: 0.70, minHitRate: 0, minSampleSize: 8,
    minLast10Hits: 0, minLast5Hits: 0, minIntelligenceScore: 45,
    allowedRisk: 'lowMedium', excludeVeryNegativeEnv: true, excludeNegativePosition: false,
    excludeRoleReduction: true, requireFreshCurrent: true,
  },
  bestValue: {
    minAdjustedProb: 0.55, minHitRate: 0, minSampleSize: 8,
    minLast10Hits: 0, minLast5Hits: 0, minIntelligenceScore: 0,
    allowedRisk: 'any', excludeVeryNegativeEnv: false, excludeNegativePosition: false,
    excludeRoleReduction: false, requireFreshCurrent: true,
  },
};

export interface ObjectiveEvaluation {
  objective: RecommendationObjective;
  eligible: boolean;
  /** Higher is better. Safest/Balanced rank by conservative/adjusted probability; Best Value ranks by EV. */
  score: number;
  reasons: string[];
  warnings: string[];
  rejectionReasons: string[];
}

function pct(n: number | null): string {
  return n === null ? '—' : `${Math.round(n * 100)}%`;
}

export function evaluateRecommendationObjective(
  objective: RecommendationObjective,
  row: ModelledOddsRow,
  intel: PlayerIntelligence | undefined,
  thresholds: ObjectiveThresholds = DEFAULT_OBJECTIVE_THRESHOLDS[objective],
): ObjectiveEvaluation {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const rejectionReasons: string[] = [];

  const mp = row.modelProb;
  const adjustedProb = mp.adjustedProb;
  const conservativeProb = mp.conservativeProb;
  const hitRate = mp.hit_rate;
  const sampleSize = mp.sample_size;
  const risk = mp.risk_level;
  const freshnessStatus = row.freshness?.freshnessStatus ?? 'PARTICIPATION_UNKNOWN';
  const freshOk = freshnessStatus === 'CURRENT';

  const last10Sample = mp.sampleComparison?.last10?.sample_size ?? 0;
  const last5Sample = mp.sampleComparison?.last5?.sample_size ?? 0;
  const last10 = getLast10Hits(row);
  const last5 = getLast5Hits(row);

  const envLabel = intel?.teamEnvironment.label;
  const posLabel = intel?.positionEdge.label;
  const roleLabel = intel?.roleIntelligence.label;
  const intelScore = intel?.intelligenceScore ?? null;

  const isVeryNegativeEnv = envLabel === 'LOW';
  const isVeryNegativePos = posLabel === 'VERY_NEGATIVE';
  const isNegativePos = posLabel === 'NEGATIVE';
  const isRoleReduction = roleLabel === 'ROLE_REDUCTION';
  const isSlightReduction = roleLabel === 'SLIGHT_REDUCTION';

  // Hard technical-validity gates apply to every objective, including Best Value.
  if (row.modelStatus !== 'MODEL_READY') {
    rejectionReasons.push('Model sample not valid or ready');
  }
  if (!row.resolvedPlayerId && !row.player_id) {
    rejectionReasons.push('Unresolved player');
  }

  if (adjustedProb === null || adjustedProb < thresholds.minAdjustedProb) {
    rejectionReasons.push(`Adjusted probability ${pct(adjustedProb)} below ${Math.round(thresholds.minAdjustedProb * 100)}% threshold`);
  }
  if (thresholds.minHitRate > 0 && hitRate < thresholds.minHitRate) {
    rejectionReasons.push(`Season hit rate ${Math.round(hitRate * 100)}% below ${Math.round(thresholds.minHitRate * 100)}% threshold`);
  }
  if (sampleSize < thresholds.minSampleSize) {
    rejectionReasons.push(`Sample size ${sampleSize} below ${thresholds.minSampleSize} genuine games`);
  }
  if (thresholds.minLast10Hits > 0 && last10Sample >= 10 && last10 < thresholds.minLast10Hits) {
    rejectionReasons.push(`Last 10 ${last10}/10 below required ${thresholds.minLast10Hits}/10 consistency`);
  }
  if (thresholds.minLast5Hits > 0 && last5Sample >= 5 && last5 < thresholds.minLast5Hits) {
    rejectionReasons.push(`Last 5 ${last5}/5 below required ${thresholds.minLast5Hits}/5 consistency`);
  }
  if (thresholds.requireFreshCurrent && !freshOk) {
    rejectionReasons.push(`Freshness not verified current (${freshnessStatus})`);
  }
  if (thresholds.allowedRisk === 'low' && risk !== 'Low') {
    rejectionReasons.push('Medium/High risk not allowed at this threshold');
  } else if (thresholds.allowedRisk === 'lowMedium' && risk === 'High') {
    rejectionReasons.push('High risk not allowed at this threshold');
  }
  if (thresholds.minIntelligenceScore > 0 && intelScore !== null && intelScore < thresholds.minIntelligenceScore) {
    rejectionReasons.push(`Intelligence score ${intelScore} below ${thresholds.minIntelligenceScore}`);
  }
  if (thresholds.excludeVeryNegativeEnv && isVeryNegativeEnv) {
    rejectionReasons.push('Very Negative Team Environment');
  }
  if (thresholds.excludeNegativePosition && (isNegativePos || isVeryNegativePos)) {
    rejectionReasons.push('Negative Position Matchup');
  } else if (!thresholds.excludeNegativePosition && isVeryNegativePos) {
    // Even when only-VERY-negative would normally be excluded (balanced's original
    // behavior), keep that one narrower case unless the user disabled position
    // exclusion outright via the toggle.
  }
  if (thresholds.excludeRoleReduction && isRoleReduction) {
    rejectionReasons.push('Falling role (Role Reduction)');
  }
  if (isSlightReduction) warnings.push('Slight role reduction');
  if (objective === 'bestValue') warnings.push('Value focused — not the highest-probability multi.');
  if (risk === 'Medium' && thresholds.allowedRisk !== 'low') warnings.push('Medium risk');
  if (risk === 'High' && thresholds.allowedRisk === 'any') warnings.push('High risk');

  const eligible = rejectionReasons.length === 0;
  if (eligible) {
    if (envLabel === 'HIGH' || envLabel === 'POSITIVE') reasons.push('Positive team environment');
    if (posLabel === 'VERY_POSITIVE' || posLabel === 'POSITIVE') reasons.push('Positive position matchup');
    if (roleLabel === 'ROLE_BOOST' || roleLabel === 'SLIGHT_BOOST') reasons.push('Role boost');
    if (adjustedProb !== null) reasons.push(`${pct(adjustedProb)} adjusted probability`);
    if (risk === 'Low') reasons.push('Low risk');
  }

  const score = objective === 'bestValue'
    ? (row.adjustedEV ?? row.finalEV ?? -Infinity)
    : (conservativeProb ?? adjustedProb ?? 0);

  return { objective, eligible, score, reasons, warnings, rejectionReasons };
}

export const OBJECTIVE_LABELS: Record<RecommendationObjective, string> = {
  safest: 'Safest / Get-Up',
  balanced: 'Balanced',
  bestValue: 'Best Value',
};
