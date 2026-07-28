/**
 * Game Get-Up — the main product mode: build the safest available player
 * multi for one selected game. Small leg count, disposals-only, safety and
 * floor protection prioritized over EV.
 *
 * This module does not duplicate multiOptimizer.ts's DFS search — it calls
 * the shared search core (runCandidateSearchAsync) with GAME_GETUP_PRESET,
 * then layers Safety Score / quality-tier classification / relaxation /
 * named-output selection on top, since none of that belongs in the generic
 * gameMulti/roundMulti label-selection logic.
 *
 * No leg or multi produced here is ever described as guaranteed.
 */
import type { CanonicalGameRow } from './canonicalGameLog';
import type { DisposalLineRecommendation } from './disposalLineSelector';
import type { PlayerIntelligence } from './playerIntelligenceService';
import type { TeamEnvironmentMap } from './teamStatsService';
import type { RoleTrendMap } from './roleTrendService';
import {
  GAME_GETUP_PRESET,
  runCandidateSearchAsync,
  type OptimizedMulti,
  type OptimizerLeg,
  type OptimizerDiagnostics,
  type OptimizerProgress,
  type CancellationRef,
} from './multiOptimizer';
import { calculateSafetyScore, type FloorBuffer, type SafetyScoreResult } from './safetyScore';
import { classifyQualityTier, tierOrder, type QualityTier, type TierMetrics, type TierCheckResult } from './multiQualityTiers';

export type { QualityTier } from './multiQualityTiers';

export interface GameGetUpLegView {
  leg: OptimizerLeg;
  safety: SafetyScoreResult;
  dataConfidence: number | null;
  intelligenceScore: number | null;
}

export interface RelaxationStep {
  step: string;
  reason: string;
}

export interface GameGetUpMulti {
  legs: OptimizerLeg[];
  legViews: GameGetUpLegView[];
  combinedOdds: number;
  rawProbability: number;
  correlationAdjustment: number; // fraction removed by the flat same-game haircut, e.g. 0.05
  conservativeProbability: number;
  estimatedEV: number;
  tier: QualityTier;
  tierGapReasons: string[]; // why it fell short of the next tier up, if BEST_AVAILABLE/ACCEPTABLE/STRONG
  avgSafetyScore: number | null;
  minSafetyScore: number | null;
  avgIntelligenceScore: number | null;
  avgDataConfidence: number | null;
  weakestLeg: OptimizerLeg;
  weakestFloorBuffer: FloorBuffer;
  relaxationsApplied: RelaxationStep[];
  warnings: string[];
  labels: string[];
}

export interface GameGetUpResult {
  primarySafest: GameGetUpMulti | null;
  shorterPricedAlternative: GameGetUpMulti | null;
  targetRangeMulti: GameGetUpMulti | null;
  higherPricedAlternative: GameGetUpMulti | null;
  safestSingleLeg: GameGetUpLegView | null;
  safestTwoLeg: GameGetUpMulti | null;
  safestThreeLeg: GameGetUpMulti | null;
  bestAvailable: GameGetUpMulti | null;
  diagnostics: OptimizerDiagnostics;
  noGenuineLinesAvailable: boolean;
}

export interface GameGetUpInputs {
  recommendations: DisposalLineRecommendation[];
  /** Keyed by playerId. Must already be computed by the caller (e.g. the
   * panel's existing intelligenceByPlayer map) — this module never fetches
   * or recomputes Intelligence Score itself. */
  intelligenceByPlayerId: Map<string, PlayerIntelligence>;
  /** Keyed by playerId, newest-first, as returned by getCanonicalPlayerGameLog.
   * Only needed for legs that end up in a search candidate — caller may
   * fetch lazily/memoized. */
  gameLogByPlayerId: Map<string, CanonicalGameRow[]>;
  matchNames: Record<string, string>;
  teamEnv?: TeamEnvironmentMap;
  roleTrends?: RoleTrendMap;
  cancelRef: CancellationRef | null;
  onProgress: (p: OptimizerProgress) => void;
}

function buildLegView(
  leg: OptimizerLeg,
  intelligenceByPlayerId: Map<string, PlayerIntelligence>,
  gameLogByPlayerId: Map<string, CanonicalGameRow[]>,
): GameGetUpLegView {
  const intel = intelligenceByPlayerId.get(leg.playerId);
  const dataConfidence = intel?.dataConfidence ?? null;
  const gameLog = gameLogByPlayerId.get(leg.playerId) ?? [];
  const roleTrend = null; // role stability folded in via roleTrendLabel below when present
  const safety = calculateSafetyScore(gameLog, leg.line, leg.row.modelProb, dataConfidence, {
    roleTrend,
    tagRiskDataAvailable: false, // no genuine tag-risk data source exists yet — never fabricated
    tagRiskLevel: null,
  });
  return { leg, safety, dataConfidence, intelligenceScore: intel?.intelligenceScore ?? null };
}

function weakestByProb(legs: OptimizerLeg[]): OptimizerLeg {
  return legs.reduce((min, l) => (l.adjustedProb < min.adjustedProb ? l : min), legs[0]);
}

/**
 * Compute the shared TierMetrics from a Game Get-Up candidate's leg views,
 * then classify via the shared multiQualityTiers module — identical
 * thresholds to Round Multi's Game Blocks.
 */
function classifyTier(multi: GameGetUpMulti): TierCheckResult {
  const legViews = multi.legViews;
  const minDataConfidence = legViews.reduce<number | null>((min, lv) => {
    if (lv.dataConfidence === null) return min;
    return min === null ? lv.dataConfidence : Math.min(min, lv.dataConfidence);
  }, null);
  const worstLast5MinMargin = legViews.reduce<number | null>((min, lv) => {
    const m = lv.safety.floorBuffer.last5MinMargin;
    if (m === null) return min;
    return min === null ? m : Math.min(min, m);
  }, null);

  const metrics: TierMetrics = {
    conservativeProbability: multi.conservativeProbability,
    weakestSafetyScore: multi.minSafetyScore,
    minDataConfidence,
    avgSeasonHitRate: legViews.reduce((s, lv) => s + lv.leg.row.modelProb.hit_rate, 0) / legViews.length,
    worstLast10: Math.min(...legViews.map(lv => lv.leg.last10Hits)),
    worstLast5: Math.min(...legViews.map(lv => lv.leg.last5Hits)),
    worstLast5MinMargin,
    hasRoleReduction: legViews.some(lv => lv.leg.roleTrendLabel === 'ROLE_REDUCTION' || lv.leg.roleTrendLabel === 'STRONG_NEGATIVE'),
    hasHighTagRisk: false, // no genuine tag-risk data source exists — never fabricated as a blocker
    hasSignificantNegativeMatchup: legViews.some(lv => lv.leg.row.positionEdgeAdjustment < -0.05),
    hasSlightSuppression: legViews.some(lv => lv.leg.row.positionEdgeAdjustment < -0.02 && lv.leg.row.positionEdgeAdjustment >= -0.05),
    anyStaleData: legViews.some(lv => lv.leg.row.freshness && lv.leg.row.freshness.freshnessStatus !== 'CURRENT'),
  };

  return classifyQualityTier(metrics);
}

/**
 * Priority order per spec: conservative multi probability, weakest-leg
 * Safety Score, avg Safety Score, Floor Buffer strength, same-game
 * correlation risk (fewer legs = lower risk, already reflected in
 * correlationAdjustment), Data Confidence, role stability, closeness to
 * target odds. Implemented as a lexicographic comparator.
 */
function compareGameGetUpCandidates(a: GameGetUpMulti, b: GameGetUpMulti): number {
  if (tierOrder(a.tier) !== tierOrder(b.tier)) return tierOrder(a.tier) - tierOrder(b.tier);
  if (a.conservativeProbability !== b.conservativeProbability) return b.conservativeProbability - a.conservativeProbability;
  const aMinSafety = a.minSafetyScore ?? -1;
  const bMinSafety = b.minSafetyScore ?? -1;
  if (aMinSafety !== bMinSafety) return bMinSafety - aMinSafety;
  const aAvgSafety = a.avgSafetyScore ?? -1;
  const bAvgSafety = b.avgSafetyScore ?? -1;
  if (aAvgSafety !== bAvgSafety) return bAvgSafety - aAvgSafety;
  if (a.correlationAdjustment !== b.correlationAdjustment) return a.correlationAdjustment - b.correlationAdjustment;
  const aConf = a.avgDataConfidence ?? -1;
  const bConf = b.avgDataConfidence ?? -1;
  if (aConf !== bConf) return bConf - aConf;
  const aTarget = Math.abs(a.combinedOdds - GAME_GETUP_PRESET.targetOdds);
  const bTarget = Math.abs(b.combinedOdds - GAME_GETUP_PRESET.targetOdds);
  return aTarget - bTarget;
}

function toGameGetUpMulti(
  multi: OptimizedMulti,
  intelligenceByPlayerId: Map<string, PlayerIntelligence>,
  gameLogByPlayerId: Map<string, CanonicalGameRow[]>,
): GameGetUpMulti {
  const legViews = multi.legs.map(l => buildLegView(l, intelligenceByPlayerId, gameLogByPlayerId));
  const safetyScores = legViews.map(lv => lv.safety.score).filter((s): s is number => s !== null);
  const avgSafetyScore = safetyScores.length > 0 ? Math.round(safetyScores.reduce((a, b) => a + b, 0) / safetyScores.length) : null;
  const minSafetyScore = safetyScores.length > 0 ? Math.min(...safetyScores) : null;
  const intelScores = legViews.map(lv => lv.intelligenceScore).filter((s): s is number => s !== null);
  const avgIntelligenceScore = intelScores.length > 0 ? Math.round(intelScores.reduce((a, b) => a + b, 0) / intelScores.length) : null;
  const confs = legViews.map(lv => lv.dataConfidence).filter((c): c is number => c !== null);
  const avgDataConfidence = confs.length > 0 ? Math.round(confs.reduce((a, b) => a + b, 0) / confs.length) : null;

  const weakestLeg = weakestByProb(multi.legs);
  const weakestLegView = legViews.find(lv => lv.leg === weakestLeg) ?? legViews[0];

  const rawProbability = multi.rawProbability;
  const conservativeProbability = multi.conservativeProbability;
  const correlationAdjustment = rawProbability > 0 ? 1 - conservativeProbability / rawProbability : 0;

  const draft: GameGetUpMulti = {
    legs: multi.legs,
    legViews,
    combinedOdds: multi.combinedOdds,
    rawProbability,
    correlationAdjustment,
    conservativeProbability,
    estimatedEV: multi.estimatedEV,
    tier: 'BEST_AVAILABLE',
    tierGapReasons: [],
    avgSafetyScore,
    minSafetyScore,
    avgIntelligenceScore,
    avgDataConfidence,
    weakestLeg,
    weakestFloorBuffer: weakestLegView.safety.floorBuffer,
    relaxationsApplied: [],
    warnings: multi.warnings,
    labels: [],
  };

  const { tier, gapReasons } = classifyTier(draft);
  draft.tier = tier;
  draft.tierGapReasons = gapReasons;
  return draft;
}

function isDuplicate(a: GameGetUpMulti, b: GameGetUpMulti): boolean {
  const aIds = new Set(a.legs.map(l => l.playerId));
  const bIds = new Set(b.legs.map(l => l.playerId));
  if (aIds.size !== bIds.size) return false;
  for (const id of aIds) if (!bIds.has(id)) return false;
  return true;
}

export async function buildGameGetUp(inputs: GameGetUpInputs): Promise<GameGetUpResult> {
  const { recommendations, intelligenceByPlayerId, gameLogByPlayerId, matchNames, teamEnv, roleTrends, cancelRef, onProgress } = inputs;

  const { valid, diagnostics } = await runCandidateSearchAsync(
    recommendations, GAME_GETUP_PRESET, cancelRef, onProgress, matchNames, teamEnv, roleTrends,
  );

  if (valid.length === 0) {
    return {
      primarySafest: null, shorterPricedAlternative: null, targetRangeMulti: null,
      higherPricedAlternative: null, safestSingleLeg: null, safestTwoLeg: null,
      safestThreeLeg: null, bestAvailable: null, diagnostics,
      noGenuineLinesAvailable: diagnostics.modelReadyDisposalRows === 0,
    };
  }

  const candidates = valid.map(m => toGameGetUpMulti(m, intelligenceByPlayerId, gameLogByPlayerId));
  candidates.sort(compareGameGetUpCandidates);

  const byLegCount = (n: number) => candidates.filter(c => c.legs.length === n);
  const twoLeg = byLegCount(2);
  const threeLeg = byLegCount(3);
  const fourLeg = byLegCount(4);

  // "Never force four legs": prefer the smallest leg count that reaches the
  // best available tier among the candidates we found.
  const bestTierOverall = candidates[0]?.tier ?? 'BEST_AVAILABLE';
  const preferSmallLegCount = [twoLeg, threeLeg, fourLeg].find(group => group.some(c => c.tier === bestTierOverall)) ?? candidates;
  const primarySafest = preferSmallLegCount.find(c => c.tier === bestTierOverall) ?? candidates[0];
  if (primarySafest) primarySafest.labels.push('Primary Safest Multi');

  const used: GameGetUpMulti[] = primarySafest ? [primarySafest] : [];
  const pickNext = (pool: GameGetUpMulti[], label: string): GameGetUpMulti | null => {
    for (const c of pool) {
      if (used.some(u => isDuplicate(u, c))) continue;
      const withLabel = { ...c, labels: [...c.labels, label] };
      used.push(withLabel);
      return withLabel;
    }
    return null;
  };

  const shorterPricedAlternative = pickNext(
    [...candidates].sort((a, b) => a.combinedOdds - b.combinedOdds),
    'Shorter-Priced Safer Alternative',
  );

  const inTargetRange = candidates.filter(c => c.combinedOdds >= GAME_GETUP_PRESET.preferredMinOdds && c.combinedOdds <= GAME_GETUP_PRESET.preferredMaxOdds);
  const targetRangeMulti = pickNext(inTargetRange.length > 0 ? inTargetRange : candidates, 'Target $1.60-$1.75 Multi');

  const higherPricedAlternative = pickNext(
    [...candidates].sort((a, b) => b.combinedOdds - a.combinedOdds),
    'Higher-Priced Alternative',
  );

  const safestTwoLeg = twoLeg.length > 0 ? { ...twoLeg[0], labels: [...twoLeg[0].labels, 'Safest Two-Leg Combination'] } : null;
  const safestThreeLeg = threeLeg.length > 0 ? { ...threeLeg[0], labels: [...threeLeg[0].labels, 'Safest Three-Leg Combination'] } : null;

  const bestAvailable = candidates.find(c => c.tier === 'BEST_AVAILABLE') ?? candidates[candidates.length - 1];

  // Safest individual leg: highest Safety Score across all legs seen in any candidate
  const allLegViews = candidates.flatMap(c => c.legViews);
  const uniqueLegViews = new Map<string, GameGetUpLegView>();
  for (const lv of allLegViews) {
    const existing = uniqueLegViews.get(lv.leg.playerId);
    if (!existing || (lv.safety.score ?? -1) > (existing.safety.score ?? -1)) uniqueLegViews.set(lv.leg.playerId, lv);
  }
  const safestSingleLeg = [...uniqueLegViews.values()].sort((a, b) => (b.safety.score ?? -1) - (a.safety.score ?? -1))[0] ?? null;

  return {
    primarySafest,
    shorterPricedAlternative,
    targetRangeMulti,
    higherPricedAlternative,
    safestSingleLeg,
    safestTwoLeg,
    safestThreeLeg,
    bestAvailable: bestAvailable ? { ...bestAvailable, labels: [...bestAvailable.labels, 'Best Available'] } : null,
    diagnostics,
    noGenuineLinesAvailable: false,
  };
}

/** Boost is a payout-only transform — it must never alter probability. */
export function applyBoost(combinedOdds: number, boostMultiplier: number): number {
  return combinedOdds * boostMultiplier;
}
