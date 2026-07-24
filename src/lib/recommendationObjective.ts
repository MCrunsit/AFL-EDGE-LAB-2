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
 */
import type { ModelledOddsRow } from './modelResolver';
import type { PlayerIntelligence } from './playerIntelligenceService';
import { getLast10Hits, getLast5Hits } from './disposalLineSelector';

export type RecommendationObjective = 'safest' | 'balanced' | 'bestValue';

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

  if (objective === 'safest') {
    if (adjustedProb === null || adjustedProb < 0.80) {
      rejectionReasons.push(`Adjusted probability ${pct(adjustedProb)} below 80% Safest threshold`);
    }
    if (hitRate < 0.70) {
      rejectionReasons.push(`Season hit rate ${Math.round(hitRate * 100)}% below 70% Safest threshold`);
    }
    if (sampleSize < 10) {
      rejectionReasons.push(`Sample size ${sampleSize} below 10 genuine games`);
    }
    if (last10Sample >= 10 && last10 < 8) {
      rejectionReasons.push(`Last 10 ${last10}/10 below required consistency`);
    }
    if (last5Sample >= 5 && last5 < 4) {
      rejectionReasons.push(`Last 5 ${last5}/5 below required consistency`);
    }
    if (!freshOk) {
      rejectionReasons.push(`Freshness not verified current (${freshnessStatus})`);
    }
    if (risk !== 'Low') {
      rejectionReasons.push('Medium/High risk not allowed in Safest');
    }
    if (intelScore !== null && intelScore < 50) {
      rejectionReasons.push(`Intelligence score ${intelScore} below 50`);
    }
    if (isVeryNegativeEnv) rejectionReasons.push('Very Negative Team Environment');
    if (isNegativePos || isVeryNegativePos) rejectionReasons.push('Negative Position Matchup');
    if (isRoleReduction) rejectionReasons.push('Falling role (Role Reduction)');
    if (isSlightReduction) warnings.push('Slight role reduction');
  } else if (objective === 'balanced') {
    if (adjustedProb === null || adjustedProb < 0.70) {
      rejectionReasons.push(`Adjusted probability ${pct(adjustedProb)} below 70% Balanced threshold`);
    }
    if (sampleSize < 8) rejectionReasons.push(`Sample size ${sampleSize} below 8 genuine games`);
    if (!freshOk) rejectionReasons.push(`Freshness not verified current (${freshnessStatus})`);
    if (intelScore !== null && intelScore < 45) rejectionReasons.push(`Intelligence score ${intelScore} below 45`);
    if (isVeryNegativeEnv) rejectionReasons.push('Very Negative Team Environment');
    if (isVeryNegativePos) rejectionReasons.push('Very Negative Position Matchup');
    if (isRoleReduction) rejectionReasons.push('Falling role (Role Reduction)');
    if (isSlightReduction) warnings.push('Slight role reduction');
    if (risk === 'High') warnings.push('High risk');
  } else {
    // bestValue
    if (adjustedProb === null || adjustedProb < 0.55) {
      rejectionReasons.push(`Adjusted probability ${pct(adjustedProb)} below 55% Best Value threshold`);
    }
    if (sampleSize < 8) rejectionReasons.push(`Sample size ${sampleSize} below 8 genuine games`);
    if (!freshOk) rejectionReasons.push(`Freshness not verified current (${freshnessStatus})`);
    warnings.push('Value focused — not the highest-probability multi.');
  }

  const eligible = rejectionReasons.length === 0;
  if (eligible) {
    if (envLabel === 'HIGH' || envLabel === 'POSITIVE') reasons.push('Positive team environment');
    if (posLabel === 'VERY_POSITIVE' || posLabel === 'POSITIVE') reasons.push('Positive position matchup');
    if (roleLabel === 'ROLE_BOOST' || roleLabel === 'SLIGHT_BOOST') reasons.push('Role boost');
    if (adjustedProb !== null) reasons.push(`${pct(adjustedProb)} adjusted probability`);
    if (objective !== 'bestValue' && risk === 'Low') reasons.push('Low risk');
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
