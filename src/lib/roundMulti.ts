/**
 * Round Multi — rebuilt as a combination of small, independently-safe
 * "Game Blocks", one per selected match, rather than one flat DFS across
 * every match's legs pooled together (the old ROUND_MULTI_PRESET behavior
 * in multiOptimizer.ts, kept intact and still used by nothing here — Game
 * Multi mode still uses it via runMultiOptimizerAsync).
 *
 * Each Game Block is graded independently (same Elite/Strong/Acceptable/
 * Best Available tiers as Game Get-Up, via multiQualityTiers.ts) and never
 * returns "no block" when a match has genuine lines. The overall Round
 * Multi's odds are the product of every leg across every block — expected
 * to run high because many small safe blocks are being combined, and that
 * is not something to cap or reject.
 *
 * Cross-game legs are treated as more independent than same-game legs: the
 * only correlation haircut applied is each block's own same-match haircut
 * (from multiOptimizer.ts's applyCorrelationHaircut) — no additional
 * cross-block adjustment is invented.
 */
import type { CanonicalGameRow } from './canonicalGameLog';
import type { DisposalLineRecommendation } from './disposalLineSelector';
import type { PlayerIntelligence } from './playerIntelligenceService';
import type { TeamEnvironmentMap } from './teamStatsService';
import type { RoleTrendMap } from './roleTrendService';
import {
  runCandidateSearchAsync,
  type MultiOptimizerSettings,
  type OptimizedMulti,
  type OptimizerLeg,
  type OptimizerDiagnostics,
  type OptimizerProgress,
  type CancellationRef,
} from './multiOptimizer';
import { calculateSafetyScore, type FloorBuffer, type SafetyScoreResult } from './safetyScore';
import { classifyQualityTier, tierOrder, type QualityTier, type TierMetrics } from './multiQualityTiers';

export interface GameBlockSettings {
  minLegsPerGame: number;
  preferredLegsPerGame: number;
  maxLegsPerGame: number;
  preferredMinOdds: number;
  preferredMaxOdds: number;
  hardMaxOdds: number;
  disposalsOnly: boolean;
}

export const FULL_ROUND_STANDARD: GameBlockSettings = {
  minLegsPerGame: 1,
  preferredLegsPerGame: 2,
  maxLegsPerGame: 3,
  preferredMinOdds: 1.30,
  preferredMaxOdds: 1.60,
  hardMaxOdds: 1.70,
  disposalsOnly: true,
};

export const FULL_ROUND_SAFEST: GameBlockSettings = {
  minLegsPerGame: 1,
  preferredLegsPerGame: 1,
  maxLegsPerGame: 2,
  preferredMinOdds: 1.15,
  preferredMaxOdds: 1.40,
  hardMaxOdds: 1.50,
  disposalsOnly: true,
};

export const ONE_LEG_PER_GAME: GameBlockSettings = {
  minLegsPerGame: 1,
  preferredLegsPerGame: 1,
  maxLegsPerGame: 1,
  preferredMinOdds: 1.05,
  preferredMaxOdds: 1.50,
  hardMaxOdds: 2.00,
  disposalsOnly: true,
};

export type RoundMultiPresetName = 'FULL_ROUND_STANDARD' | 'FULL_ROUND_SAFEST' | 'ONE_LEG_PER_GAME';

export const ROUND_MULTI_PRESETS: Record<RoundMultiPresetName, GameBlockSettings> = {
  FULL_ROUND_STANDARD,
  FULL_ROUND_SAFEST,
  ONE_LEG_PER_GAME,
};

export interface GameBlockLegView {
  leg: OptimizerLeg;
  safety: SafetyScoreResult;
  dataConfidence: number | null;
  intelligenceScore: number | null;
}

export interface GameBlock {
  matchId: string;
  matchName: string;
  legs: OptimizerLeg[];
  legViews: GameBlockLegView[];
  combinedOdds: number;
  rawProbability: number;
  correlationAdjustment: number;
  conservativeProbability: number;
  tier: QualityTier;
  tierGapReasons: string[];
  avgSafetyScore: number | null;
  minSafetyScore: number | null;
  avgDataConfidence: number | null;
  weakestLeg: OptimizerLeg;
  weakestFloorBuffer: FloorBuffer;
  warnings: string[];
  noGenuineLinesAvailable: boolean;
}

export interface RoundMultiResult {
  blocks: GameBlock[];
  excludedMatchIds: Set<string>;
  gamesRepresented: number;
  totalLegs: number;
  totalOdds: number;
  rawProbability: number;
  conservativeProbability: number;
  avgSafetyScore: number | null;
  minSafetyScore: number | null;
  avgDataConfidence: number | null;
  weakestLeg: OptimizerLeg | null;
  weakestGameBlock: GameBlock | null;
  gamesWithRelaxedRequirements: string[];
}

export interface GameBlockInputs {
  matchId: string;
  matchName: string;
  recommendations: DisposalLineRecommendation[];
  intelligenceByPlayerId: Map<string, PlayerIntelligence>;
  gameLogByPlayerId: Map<string, CanonicalGameRow[]>;
  teamEnv?: TeamEnvironmentMap;
  roleTrends?: RoleTrendMap;
  cancelRef: CancellationRef | null;
  onProgress: (p: OptimizerProgress) => void;
}

function buildLegView(
  leg: OptimizerLeg,
  intelligenceByPlayerId: Map<string, PlayerIntelligence>,
  gameLogByPlayerId: Map<string, CanonicalGameRow[]>,
): GameBlockLegView {
  const intel = intelligenceByPlayerId.get(leg.playerId);
  const dataConfidence = intel?.dataConfidence ?? null;
  const gameLog = gameLogByPlayerId.get(leg.playerId) ?? [];
  const safety = calculateSafetyScore(gameLog, leg.line, leg.row.modelProb, dataConfidence, {
    roleTrend: null,
    tagRiskDataAvailable: false,
    tagRiskLevel: null,
  });
  return { leg, safety, dataConfidence, intelligenceScore: intel?.intelligenceScore ?? null };
}

function weakestByProb(legs: OptimizerLeg[]): OptimizerLeg {
  return legs.reduce((min, l) => (l.adjustedProb < min.adjustedProb ? l : min), legs[0]);
}

function classifyBlockTier(legViews: GameBlockLegView[], conservativeProbability: number, minSafetyScore: number | null): { tier: QualityTier; gapReasons: string[] } {
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
    conservativeProbability,
    weakestSafetyScore: minSafetyScore,
    minDataConfidence,
    avgSeasonHitRate: legViews.reduce((s, lv) => s + lv.leg.row.modelProb.hit_rate, 0) / legViews.length,
    worstLast10: Math.min(...legViews.map(lv => lv.leg.last10Hits)),
    worstLast5: Math.min(...legViews.map(lv => lv.leg.last5Hits)),
    worstLast5MinMargin,
    hasRoleReduction: legViews.some(lv => lv.leg.roleTrendLabel === 'ROLE_REDUCTION' || lv.leg.roleTrendLabel === 'STRONG_NEGATIVE'),
    hasHighTagRisk: false,
    hasSignificantNegativeMatchup: legViews.some(lv => lv.leg.row.positionEdgeAdjustment < -0.05),
    hasSlightSuppression: legViews.some(lv => lv.leg.row.positionEdgeAdjustment < -0.02 && lv.leg.row.positionEdgeAdjustment >= -0.05),
    anyStaleData: legViews.some(lv => lv.leg.row.freshness && lv.leg.row.freshness.freshnessStatus !== 'CURRENT'),
  };

  return classifyQualityTier(metrics);
}

/**
 * Build the safest Game Block for one match: searches leg counts ascending
 * from minLegsPerGame to maxLegsPerGame (never forcing more legs than
 * needed), picks the best-tiered candidate at/under hardMaxOdds without
 * padding toward the preferred max — a block that safely prices at $1.28
 * stays at $1.28 rather than being inflated toward $1.70.
 */
export async function buildGameBlock(settings: GameBlockSettings, inputs: GameBlockInputs): Promise<GameBlock> {
  const { matchId, matchName, recommendations, intelligenceByPlayerId, gameLogByPlayerId, teamEnv, roleTrends, cancelRef, onProgress } = inputs;

  const searchSettings: MultiOptimizerSettings = {
    preset: 'gameBlock',
    targetOdds: (settings.preferredMinOdds + settings.preferredMaxOdds) / 2,
    preferredMinOdds: settings.preferredMinOdds,
    preferredMaxOdds: settings.preferredMaxOdds,
    hardMaxOdds: settings.hardMaxOdds,
    preferredLegs: settings.preferredLegsPerGame,
    fallbackLegs: settings.minLegsPerGame,
    maxLegsPerMatch: settings.maxLegsPerGame,
    disposalsOnly: settings.disposalsOnly,
    maxPoolSize: 40,
    minLegs: settings.minLegsPerGame,
    maxLegs: settings.maxLegsPerGame,
  };

  const matchRecommendations = recommendations.filter(r => r.matchId === matchId);
  const matchNames = { [matchId]: matchName };

  const { valid, diagnostics } = await runCandidateSearchAsync(
    matchRecommendations, searchSettings, cancelRef, onProgress, matchNames, teamEnv, roleTrends,
  );

  if (valid.length === 0) {
    return {
      matchId, matchName, legs: [], legViews: [], combinedOdds: 0, rawProbability: 0,
      correlationAdjustment: 0, conservativeProbability: 0, tier: 'BEST_AVAILABLE',
      tierGapReasons: [], avgSafetyScore: null, minSafetyScore: null, avgDataConfidence: null,
      weakestLeg: null as unknown as OptimizerLeg, weakestFloorBuffer: {
        last5MinMargin: null, last10MinMargin: null, medianMargin: null, avgMargin: null,
        p10Margin: null, timesExactlyOnLine: 0, timesOneAboveLine: 0, stdDev: null,
        coefficientOfVariation: null, sampleSize: 0,
      },
      warnings: [], noGenuineLinesAvailable: diagnostics.modelReadyDisposalRows === 0,
    };
  }

  const scored = valid.map((multi: OptimizedMulti) => {
    const legViews = multi.legs.map(l => buildLegView(l, intelligenceByPlayerId, gameLogByPlayerId));
    const safetyScores = legViews.map(lv => lv.safety.score).filter((s): s is number => s !== null);
    const avgSafetyScore = safetyScores.length > 0 ? Math.round(safetyScores.reduce((a, b) => a + b, 0) / safetyScores.length) : null;
    const minSafetyScore = safetyScores.length > 0 ? Math.min(...safetyScores) : null;
    const confs = legViews.map(lv => lv.dataConfidence).filter((c): c is number => c !== null);
    const avgDataConfidence = confs.length > 0 ? Math.round(confs.reduce((a, b) => a + b, 0) / confs.length) : null;
    const { tier, gapReasons } = classifyBlockTier(legViews, multi.conservativeProbability, minSafetyScore);
    return { multi, legViews, avgSafetyScore, minSafetyScore, avgDataConfidence, tier, gapReasons };
  });

  // Prefer the best tier, then fewest legs (never pad), then highest
  // conservative probability, then closest to the odds cap from below —
  // i.e. don't artificially inflate a safe $1.28 block toward $1.70.
  scored.sort((a, b) => {
    if (tierOrder(a.tier) !== tierOrder(b.tier)) return tierOrder(a.tier) - tierOrder(b.tier);
    if (a.multi.legs.length !== b.multi.legs.length) return a.multi.legs.length - b.multi.legs.length;
    if (a.multi.conservativeProbability !== b.multi.conservativeProbability) return b.multi.conservativeProbability - a.multi.conservativeProbability;
    return a.multi.combinedOdds - b.multi.combinedOdds;
  });

  const best = scored[0];
  const weakestLeg = weakestByProb(best.multi.legs);
  const weakestLegView = best.legViews.find(lv => lv.leg === weakestLeg) ?? best.legViews[0];
  const correlationAdjustment = best.multi.rawProbability > 0 ? 1 - best.multi.conservativeProbability / best.multi.rawProbability : 0;

  return {
    matchId, matchName,
    legs: best.multi.legs,
    legViews: best.legViews,
    combinedOdds: best.multi.combinedOdds,
    rawProbability: best.multi.rawProbability,
    correlationAdjustment,
    conservativeProbability: best.multi.conservativeProbability,
    tier: best.tier,
    tierGapReasons: best.gapReasons,
    avgSafetyScore: best.avgSafetyScore,
    minSafetyScore: best.minSafetyScore,
    avgDataConfidence: best.avgDataConfidence,
    weakestLeg,
    weakestFloorBuffer: weakestLegView.safety.floorBuffer,
    warnings: best.multi.warnings,
    noGenuineLinesAvailable: false,
  };
}

export interface RoundMultiGameInput {
  matchId: string;
  matchName: string;
}

export interface BuildRoundMultiInputs {
  games: RoundMultiGameInput[];
  excludedMatchIds: Set<string>;
  recommendations: DisposalLineRecommendation[];
  intelligenceByPlayerId: Map<string, PlayerIntelligence>;
  gameLogByPlayerId: Map<string, CanonicalGameRow[]>;
  teamEnv?: TeamEnvironmentMap;
  roleTrends?: RoleTrendMap;
  cancelRef: CancellationRef | null;
  onProgress: (p: OptimizerProgress) => void;
}

/**
 * Combine an already-built set of Game Blocks into the overall Round Multi
 * aggregates. Pure and synchronous — used both after a full build and after
 * regenerating/excluding a single game, so changing one game never requires
 * rebuilding the others.
 */
export function combineGameBlocks(blocks: GameBlock[], excludedMatchIds: Set<string>): RoundMultiResult {
  const usableBlocks = blocks.filter(b => !excludedMatchIds.has(b.matchId) && b.legs.length > 0);
  const allLegs = usableBlocks.flatMap(b => b.legs);

  const totalOdds = usableBlocks.reduce((product, b) => product * b.combinedOdds, 1);
  const rawProbability = usableBlocks.reduce((product, b) => product * b.rawProbability, 1);
  const conservativeProbability = usableBlocks.reduce((product, b) => product * b.conservativeProbability, 1);

  const allLegViews = usableBlocks.flatMap(b => b.legViews);
  const safetyScores = allLegViews.map(lv => lv.safety.score).filter((s): s is number => s !== null);
  const avgSafetyScore = safetyScores.length > 0 ? Math.round(safetyScores.reduce((a, b) => a + b, 0) / safetyScores.length) : null;
  const minSafetyScore = safetyScores.length > 0 ? Math.min(...safetyScores) : null;
  const confs = allLegViews.map(lv => lv.dataConfidence).filter((c): c is number => c !== null);
  const avgDataConfidence = confs.length > 0 ? Math.round(confs.reduce((a, b) => a + b, 0) / confs.length) : null;

  const weakestLeg = allLegs.length > 0 ? weakestByProb(allLegs) : null;
  const weakestGameBlock = usableBlocks.length > 0
    ? [...usableBlocks].sort((a, b) => {
        if (tierOrder(b.tier) !== tierOrder(a.tier)) return tierOrder(b.tier) - tierOrder(a.tier);
        return a.conservativeProbability - b.conservativeProbability;
      })[0]
    : null;

  const gamesWithRelaxedRequirements = usableBlocks
    .filter(b => b.tier !== 'ELITE' && b.tierGapReasons.length > 0)
    .map(b => b.matchName);

  return {
    blocks,
    excludedMatchIds,
    gamesRepresented: usableBlocks.length,
    totalLegs: allLegs.length,
    totalOdds,
    rawProbability,
    conservativeProbability,
    avgSafetyScore,
    minSafetyScore,
    avgDataConfidence,
    weakestLeg,
    weakestGameBlock,
    gamesWithRelaxedRequirements,
  };
}

/**
 * Build one Game Block per selected (non-excluded) match, then combine them
 * into a single Round Multi. Total odds may legitimately be high — that is
 * expected, not an error, when many small safe blocks are combined.
 */
export async function buildRoundMulti(settings: GameBlockSettings, inputs: BuildRoundMultiInputs): Promise<RoundMultiResult> {
  const { games, excludedMatchIds, recommendations, intelligenceByPlayerId, gameLogByPlayerId, teamEnv, roleTrends, cancelRef, onProgress } = inputs;

  const blocks: GameBlock[] = [];
  for (const game of games) {
    const block = await buildGameBlock(settings, {
      matchId: game.matchId,
      matchName: game.matchName,
      recommendations,
      intelligenceByPlayerId,
      gameLogByPlayerId,
      teamEnv,
      roleTrends,
      cancelRef,
      onProgress,
    });
    blocks.push(block);
  }

  return combineGameBlocks(blocks, excludedMatchIds);
}
