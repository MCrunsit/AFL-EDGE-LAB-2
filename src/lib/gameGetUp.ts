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
  type MultiOptimizerSettings,
} from './multiOptimizer';
import { calculateSafetyScore, type FloorBuffer, type SafetyScoreResult } from './safetyScore';
import { classifyQualityTier, tierOrder, type QualityTier, type TierMetrics, type TierCheckResult } from './multiQualityTiers';
import { applyRealCorrelationAdjustment, type CorrelationMethod } from './correlationModel';
import type { TrackableMulti, TrackableMultiLeg } from './betTracking';
import type { TeamLineOption, TeamLineHistoryEntry } from './teamLine';
import {
  buildTeamLineLeg, computeTeamLineAttachment, type TeamLineLeg,
} from './teamLineAttach';

export type { QualityTier } from './multiQualityTiers';
export type { TeamLineLeg } from './teamLineAttach';

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

export interface GameGetUpTeamLineSettings {
  allowTeamLines: boolean;
  preferTeamLines: boolean;
  teamLinesOnly: boolean;
  minTeamLineSafetyScore: number | null;
  minTeamLineCoverProbability: number | null;
}

export const DEFAULT_TEAM_LINE_SETTINGS: GameGetUpTeamLineSettings = {
  allowTeamLines: false,
  preferTeamLines: false,
  teamLinesOnly: false,
  minTeamLineSafetyScore: null,
  minTeamLineCoverProbability: null,
};

export interface GameGetUpMulti {
  legs: OptimizerLeg[];
  legViews: GameGetUpLegView[];
  /** At most one — Team Lines are capped to one per match by construction. */
  teamLineLeg: TeamLineLeg | null;
  combinedOdds: number;
  rawProbability: number;
  correlationAdjustment: number; // fraction removed — historical when enough shared-game data exists, else a conservative flat fallback per pair
  correlationMethod: CorrelationMethod;
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
  /** Every buildable Team Line option for this match, scored — always
   * populated regardless of allowTeamLines, so the manual "Team Markets"
   * picker always has data even when automatic recommendations don't use it. */
  teamLineOptions: TeamLineLeg[];
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
  /** Overrides GAME_GETUP_PRESET's leg counts/odds range — lets the UI expose
   * user-adjustable settings instead of a fixed constant. Any field left out
   * falls back to the default preset's value. */
  settings?: Partial<MultiOptimizerSettings>;
  /** Pre-fetched via getTeamLineOptionsForMatch — this module never fetches
   * match_odds itself, same convention as gameLogByPlayerId. */
  teamLineOptions?: TeamLineOption[];
  /** Pre-fetched via getTeamLineHistory, keyed by team name. */
  teamLineHistoryByTeam?: Map<string, TeamLineHistoryEntry[]>;
  teamLineSettings?: Partial<GameGetUpTeamLineSettings>;
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
 * Fold a Team Line leg into an already-built player-only multi. Always
 * callable (backs the manual-add path regardless of settings). Delegates
 * the odds/probability math to teamLineAttach.ts's shared core, which every
 * builder (Game Get-Up, Game Multi, Build Your Own) uses identically.
 */
export function attachManualTeamLine(base: GameGetUpMulti, teamLineLeg: TeamLineLeg): GameGetUpMulti {
  const attached = computeTeamLineAttachment({
    combinedOdds: base.combinedOdds,
    rawProbability: base.rawProbability,
    conservativeProbability: base.conservativeProbability,
    playerLegCount: base.legs.length,
  }, teamLineLeg);

  const estimatedEV = attached.conservativeProbability * attached.combinedOdds - 1;
  const cp = teamLineLeg.coverProbability.coverProbability;

  return {
    ...base,
    teamLineLeg,
    combinedOdds: attached.combinedOdds,
    rawProbability: attached.rawProbability,
    correlationAdjustment: attached.totalHaircut,
    correlationMethod: cp !== null && base.correlationMethod === 'historical' ? 'mixed' : base.correlationMethod,
    conservativeProbability: attached.conservativeProbability,
    estimatedEV,
    warnings: [...base.warnings, attached.warning],
  };
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
function compareGameGetUpCandidates(a: GameGetUpMulti, b: GameGetUpMulti, targetOdds: number): number {
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
  const aTarget = Math.abs(a.combinedOdds - targetOdds);
  const bTarget = Math.abs(b.combinedOdds - targetOdds);
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
  const realCorrelation = applyRealCorrelationAdjustment(multi.legs, rawProbability, gameLogByPlayerId);
  const conservativeProbability = realCorrelation.conservativeProbability;
  const estimatedEV = conservativeProbability * multi.combinedOdds - 1;

  const draft: GameGetUpMulti = {
    legs: multi.legs,
    legViews,
    teamLineLeg: null,
    combinedOdds: multi.combinedOdds,
    rawProbability,
    correlationAdjustment: realCorrelation.correlationAdjustment,
    correlationMethod: realCorrelation.method,
    conservativeProbability,
    estimatedEV,
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
  const settings: MultiOptimizerSettings = { ...GAME_GETUP_PRESET, ...inputs.settings };
  const teamLineSettings: GameGetUpTeamLineSettings = { ...DEFAULT_TEAM_LINE_SETTINGS, ...inputs.teamLineSettings };

  // Always score every Team Line option regardless of allowTeamLines, so
  // the manual "Team Markets" picker always has real numbers to offer.
  const teamLineOptions: TeamLineLeg[] = (inputs.teamLineOptions ?? []).map(
    option => buildTeamLineLeg(option, inputs.teamLineHistoryByTeam?.get(option.teamName) ?? []),
  );

  // The single best qualifying option (RATED, passes both minimums) — Game
  // Get-Up is single-match scoped, so "best" just means highest safety
  // score among the (at most two) sides of this match's line.
  const qualifyingTeamLine = teamLineSettings.allowTeamLines
    ? teamLineOptions
        .filter(tl => tl.coverProbability.coverProbability !== null && tl.safety.score !== null)
        .filter(tl => teamLineSettings.minTeamLineSafetyScore === null || (tl.safety.score ?? 0) >= teamLineSettings.minTeamLineSafetyScore)
        .filter(tl => teamLineSettings.minTeamLineCoverProbability === null || (tl.coverProbability.coverProbability ?? 0) >= teamLineSettings.minTeamLineCoverProbability)
        .sort((a, b) => (b.safety.score ?? 0) - (a.safety.score ?? 0))[0] ?? null
    : null;

  const { valid, diagnostics } = await runCandidateSearchAsync(
    recommendations, settings, cancelRef, onProgress, matchNames, teamEnv, roleTrends,
  );

  if (valid.length === 0) {
    return {
      primarySafest: null, shorterPricedAlternative: null, targetRangeMulti: null,
      higherPricedAlternative: null, safestSingleLeg: null, safestTwoLeg: null,
      safestThreeLeg: null, bestAvailable: null, teamLineOptions, diagnostics,
      noGenuineLinesAvailable: diagnostics.modelReadyDisposalRows === 0,
    };
  }

  const playerOnlyCandidates = valid.map(m => toGameGetUpMulti(m, intelligenceByPlayerId, gameLogByPlayerId));

  // Allow Team Lines is a permission gate only — Prefer/Only decide whether
  // automatic named outputs (primarySafest etc.) actually attach it. A plain
  // "Allow" with neither Prefer nor Only leaves automatic recommendations
  // player-only (byte-identical to today) while still surfacing the option
  // for manual add via result.teamLineOptions.
  let candidates = playerOnlyCandidates;
  if (qualifyingTeamLine) {
    const attached = playerOnlyCandidates.map(c => attachManualTeamLine(c, qualifyingTeamLine));
    if (teamLineSettings.teamLinesOnly) {
      candidates = attached;
    } else if (teamLineSettings.preferTeamLines) {
      candidates = [...attached, ...playerOnlyCandidates];
    }
  }

  candidates.sort((a, b) => compareGameGetUpCandidates(a, b, settings.targetOdds));

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

  const inTargetRange = candidates.filter(c => c.combinedOdds >= settings.preferredMinOdds && c.combinedOdds <= settings.preferredMaxOdds);
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
    teamLineOptions,
    diagnostics,
    noGenuineLinesAvailable: false,
  };
}

/** Boost is a payout-only transform — it must never alter probability. */
export function applyBoost(combinedOdds: number, boostMultiplier: number): number {
  return combinedOdds * boostMultiplier;
}

function legToTrackableLeg(leg: OptimizerLeg): TrackableMultiLeg {
  return {
    player_name: leg.playerName,
    player_id: leg.playerId,
    market: 'disposals',
    line: leg.line.toString(),
    display_label: leg.displayLabel,
    odds: leg.odds,
    adjusted_probability: leg.adjustedProb,
    adjusted_ev: leg.adjustedEV,
    match_id: leg.matchId,
    position_group: leg.positionGroup,
    position_edge_value: leg.row.positionEdge?.edge_value ?? null,
    position_edge_significance: leg.row.positionEdge?.significance ?? null,
    position_edge_adjustment: leg.row.positionEdgeAdjustment ?? null,
  };
}

function teamLineLegToTrackableLeg(teamLineLeg: TeamLineLeg): TrackableMultiLeg {
  const { option } = teamLineLeg;
  return {
    player_name: option.teamName,
    player_id: null,
    market: 'team_line',
    line: option.point.toString(),
    display_label: `${option.teamName} ${option.point > 0 ? '+' : ''}${option.point}`,
    odds: option.odds,
    adjusted_probability: teamLineLeg.coverProbability.coverProbability,
    adjusted_ev: null,
    match_id: option.matchId,
  };
}

export function gameGetUpMultiToTrackable(multi: GameGetUpMulti): TrackableMulti {
  return {
    source: 'game_getup',
    combined_odds: multi.combinedOdds,
    combined_model_prob: multi.conservativeProbability,
    combined_ev: multi.estimatedEV,
    use_position_edge: false,
    legs: [
      ...multi.legs.map(legToTrackableLeg),
      ...(multi.teamLineLeg ? [teamLineLegToTrackableLeg(multi.teamLineLeg)] : []),
    ],
  };
}
