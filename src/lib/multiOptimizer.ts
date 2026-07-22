import type { ModelledOddsRow } from './modelResolver';
import type { DisposalLineRecommendation } from './disposalLineSelector';
import { getSelectionReason, getLast10Hits, getLast5Hits, getLast10HitRate } from './disposalLineSelector';
import type { TeamEnvironmentMap } from './teamStatsService';
import type { RoleTrendMap } from './roleTrendService';

export type OptimizerPreset = 'gameMulti' | 'roundMulti' | 'sameGame';

export interface MultiOptimizerSettings {
  preset: OptimizerPreset;
  targetOdds: number;
  preferredMinOdds: number;
  preferredMaxOdds: number;
  hardMaxOdds: number;
  preferredLegs: number;
  fallbackLegs: number;
  maxLegsPerMatch: number;
  disposalsOnly: boolean;
  maxPoolSize: number;
}

export const GAME_MULTI_PRESET: MultiOptimizerSettings = {
  preset: 'gameMulti',
  targetOdds: 2.00,
  preferredMinOdds: 1.80,
  preferredMaxOdds: 2.20,
  hardMaxOdds: 2.50,
  preferredLegs: 4,
  fallbackLegs: 3,
  maxLegsPerMatch: 4,
  disposalsOnly: true,
  maxPoolSize: 40,
};

export const ROUND_MULTI_PRESET: MultiOptimizerSettings = {
  preset: 'roundMulti',
  targetOdds: 2.00,
  preferredMinOdds: 1.85,
  preferredMaxOdds: 2.15,
  hardMaxOdds: 2.50,
  preferredLegs: 4,
  fallbackLegs: 3,
  maxLegsPerMatch: 2,
  disposalsOnly: true,
  maxPoolSize: 30,
};

export const SAME_GAME_PRESET: MultiOptimizerSettings = {
  preset: 'sameGame',
  targetOdds: 2.00,
  preferredMinOdds: 1.70,
  preferredMaxOdds: 2.40,
  hardMaxOdds: 2.50,
  preferredLegs: 2,
  fallbackLegs: 2,
  maxLegsPerMatch: 2,
  disposalsOnly: true,
  maxPoolSize: 30,
};

export const DEFAULT_OPTIMIZER_SETTINGS: MultiOptimizerSettings = GAME_MULTI_PRESET;

export interface OptimizerLeg {
  row: ModelledOddsRow;
  odds: number;
  playerName: string;
  playerId: string;
  matchId: string;
  matchName: string;
  line: number;
  displayLabel: string | null;
  adjustedProb: number;
  conservativeProb: number | null;
  adjustedEV: number | null;
  riskLevel: string;
  positionGroup: string;
  positionEdgeLabel: string | null;
  seasonHits: number;
  seasonSample: number;
  last10Hits: number;
  last10HitRate: number;
  last5Hits: number;
  selectionReason: string;
  teamEnvironmentLabel: string | null;
  roleTrendLabel: string | null;
}

export interface OptimizedMulti {
  legs: OptimizerLeg[];
  legCount: number;
  combinedOdds: number;
  rawProbability: number;
  conservativeProbability: number;
  estimatedEV: number;
  weakestLegProb: number;
  avgSeasonHitRate: number;
  avgLast10HitRate: number;
  matchDiversity: number;
  score: number;
  scoreBreakdown: Record<string, number>;
  warnings: string[];
  labels: string[];
  hasSameMatchLegs: boolean;
}

export type MultiCandidate = OptimizedMulti;

export interface OptimizerDiagnostics {
  modelReadyDisposalRows: number;
  uniquePlayers: number;
  playersWithSafeLine: number;
  rejectedBySample: number;
  rejectedBySeasonHitRate: number;
  rejectedByLast10Form: number;
  rejectedByLastFiveForm: number;
  rejectedByOdds: number;
  rejectedByRisk: number;
  rejectedByPositionEdge: number;
  poolSize: number;
  fourLegCombinationsChecked: number;
  threeLegCombinationsChecked: number;
  twoLegCombinationsChecked: number;
  candidatesInPreferredRange: number;
  finalMultisReturned: number;
  stoppedByLimit: string | null;
  runtimeMs: number;
  validationErrors: string[];
}

export interface OptimizerProgress {
  phase: 'preparing' | 'searching' | 'done';
  safePlayerLines: number;
  combinationsChecked: number;
  candidatesFound: number;
}

export interface CancellationRef {
  cancelled: boolean;
}

const MAX_COMBINATIONS = 100_000;
const MAX_RUNTIME_MS = 1500;
const MAX_RESULTS_KEPT = 50;
const YIELD_INTERVAL = 3000;

function getPositionEdgeLabel(row: ModelledOddsRow): string | null {
  if (!row.positionEdge) return null;
  const { edge_value, significance, opponent_team } = row.positionEdge;
  if (edge_value === 0) return 'Neutral';
  const sign = edge_value > 0 ? '+' : '';
  const val = `${sign}${edge_value.toFixed(1)}`;
  const sigLabel = significance === 'very_significant' ? 'Very Significant'
    : significance === 'significant' ? 'Significant'
    : 'Slight';
  const direction = edge_value > 0 ? 'Boost' : 'Suppression';
  const vs = opponent_team ? ` vs ${opponent_team}` : '';
  return `${val} ${sigLabel} ${direction}${vs}`;
}

export function rowToLeg(
  row: ModelledOddsRow,
  matchName: string,
  teamEnv?: TeamEnvironmentMap,
  roleTrends?: RoleTrendMap,
): OptimizerLeg {
  const playerId = row.resolvedPlayerId ?? row.player_id ?? row.player_name;
  const team = row.playerTeam ?? '';
  const env = teamEnv?.get(team);
  const role = roleTrends?.get(playerId);

  return {
    row,
    odds: row.over_odds,
    playerName: row.player_name,
    playerId,
    matchId: row.match_id,
    matchName,
    line: row.line,
    displayLabel: row.display_label,
    adjustedProb: row.modelProb.adjustedProb ?? 0,
    conservativeProb: row.modelProb.conservativeProb,
    adjustedEV: row.adjustedEV,
    riskLevel: row.modelProb.risk_level,
    positionGroup: row.positionGroup,
    positionEdgeLabel: getPositionEdgeLabel(row),
    seasonHits: row.modelProb.hit_count,
    seasonSample: row.modelProb.sample_size,
    last10Hits: getLast10Hits(row),
    last10HitRate: getLast10HitRate(row),
    last5Hits: getLast5Hits(row),
    selectionReason: getSelectionReason(row),
    teamEnvironmentLabel: env?.label ?? null,
    roleTrendLabel: role?.trendLabel ?? null,
  };
}

export function applyCorrelationHaircut(legs: OptimizerLeg[], rawProb: number): number {
  const matchCounts = new Map<string, number>();
  for (const leg of legs) matchCounts.set(leg.matchId, (matchCounts.get(leg.matchId) ?? 0) + 1);

  let haircut = 0;
  for (const count of matchCounts.values()) {
    if (count > 1) {
      const pairs = (count * (count - 1)) / 2;
      haircut += pairs * 0.05;
    }
  }
  return rawProb * (1 - Math.min(haircut, 0.15));
}

function calculateMultiScore(
  legs: OptimizerLeg[],
  combinedOdds: number,
  conservativeProb: number,
  settings: MultiOptimizerSettings,
): { score: number; breakdown: Record<string, number>; warnings: string[] } {
  const rawProb = legs.reduce((acc, l) => acc * l.adjustedProb, 1);
  const estimatedEV = conservativeProb * combinedOdds - 1;
  const weakestLegProb = Math.min(...legs.map(l => l.adjustedProb));
  const avgSeasonHitRate = legs.reduce((acc, l) => acc + (l.seasonHits / Math.max(1, l.seasonSample)), 0) / legs.length;
  const avgLast10HitRate = legs.reduce((acc, l) => acc + l.last10HitRate, 0) / legs.length;
  const matchSet = new Set(legs.map(l => l.matchId));
  const matchDiversity = matchSet.size / legs.length;

  const targetCloseness = Math.max(0, 1 - Math.abs(combinedOdds - settings.targetOdds) / settings.targetOdds);
  const combinedSafety = conservativeProb;
  const weakestLegScore = weakestLegProb;
  const recentConsistency = avgLast10HitRate;
  const seasonConsistency = avgSeasonHitRate;
  const combinedEVScore = Math.max(0, estimatedEV);

  const breakdown: Record<string, number> = {
    targetCloseness: Math.round(targetCloseness * 30 * 100) / 100,
    combinedSafety: Math.round(combinedSafety * 25 * 100) / 100,
    weakestLeg: Math.round(weakestLegScore * 15 * 100) / 100,
    recentConsistency: Math.round(recentConsistency * 15 * 100) / 100,
    seasonConsistency: Math.round(seasonConsistency * 10 * 100) / 100,
    matchDiversity: settings.preset === 'gameMulti' ? 0 : Math.round(matchDiversity * 5 * 100) / 100,
    ev: Math.round(combinedEVScore * 5 * 100) / 100,
  };

  let score = Object.values(breakdown).reduce((a, b) => a + b, 0);
  const warnings: string[] = [];

  if (combinedOdds > 2.20) {
    score -= (combinedOdds - 2.20) * 30;
    warnings.push(`Combined odds ${combinedOdds.toFixed(2)} above $2.20`);
  }

  for (const leg of legs) {
    if (leg.odds > 1.50) {
      score -= 5;
      warnings.push(`${leg.playerName} leg odds ${leg.odds.toFixed(2)} above $1.50`);
    }
  }

  const matchCounts = new Map<string, number>();
  for (const leg of legs) matchCounts.set(leg.matchId, (matchCounts.get(leg.matchId) ?? 0) + 1);
  const hasSameMatch = Array.from(matchCounts.values()).some(c => c > 1);
  if (hasSameMatch && (settings.preset === 'roundMulti')) {
    score -= 10;
    for (const [match, count] of matchCounts) {
      if (count > 1) warnings.push(`${count} legs from same match: ${legs.find(l => l.matchId === match)?.matchName}`);
    }
  }
  // For gameMulti, all legs are from the same match by design — no same-match penalty
  // but add a correlation warning
  if (hasSameMatch && settings.preset === 'gameMulti') {
    warnings.push('All legs from same match — probability may be overstated due to correlation');
  }

  for (const leg of legs) {
    if (leg.riskLevel === 'Medium') score -= 2;
  }

  for (const leg of legs) {
    if (leg.last5Hits < 3) {
      score -= 5;
      warnings.push(`${leg.playerName} weak last-5 form (${leg.last5Hits}/5)`);
    }
  }

  for (const leg of legs) {
    if (leg.row.positionEdgeAdjustment < -0.03) {
      score -= 3;
      warnings.push(`${leg.playerName} position edge suppression`);
    }
  }

  const maxLegOdds = Math.max(...legs.map(l => l.odds));
  if (maxLegOdds > 0.6 * combinedOdds && legs.length > 2) {
    score -= 5;
    warnings.push('One leg carries most of the total odds');
  }

  return { score: Math.round(score * 100) / 100, breakdown, warnings };
}

/**
 * Finalize a multi from its legs array.
 * Copies the input array to prevent mutation by the caller.
 * All aggregates are calculated from the exact legs passed in.
 */
function finalizeMulti(
  inputLegs: OptimizerLeg[],
  settings: MultiOptimizerSettings,
): OptimizedMulti | null {
  const legs = [...inputLegs];

  if (settings.preset === 'gameMulti' || settings.preset === 'roundMulti') {
    if (legs.length !== 4 && legs.length !== 3) return null;
  }
  if (settings.preset === 'sameGame') {
    if (legs.length !== 2) return null;
  }

  const combinedOdds = legs.reduce((product, leg) => product * leg.odds, 1);
  const rawProbability = legs.reduce((product, leg) => product * leg.adjustedProb, 1);
  const conservativeProbability = applyCorrelationHaircut(legs, rawProbability);
  const estimatedEV = conservativeProbability * combinedOdds - 1;
  const weakestLegProb = Math.min(...legs.map(l => l.adjustedProb));
  const avgSeasonHitRate = legs.reduce((acc, l) => acc + (l.seasonHits / Math.max(1, l.seasonSample)), 0) / legs.length;
  const avgLast10HitRate = legs.reduce((acc, l) => acc + l.last10HitRate, 0) / legs.length;
  const matchSet = new Set(legs.map(l => l.matchId));
  const matchCounts = new Map<string, number>();
  for (const leg of legs) matchCounts.set(leg.matchId, (matchCounts.get(leg.matchId) ?? 0) + 1);
  const hasSameMatch = matchCounts.size < legs.length;

  const { score, breakdown, warnings } = calculateMultiScore(legs, combinedOdds, conservativeProbability, settings);

  return {
    legs,
    legCount: legs.length,
    combinedOdds,
    rawProbability,
    conservativeProbability,
    estimatedEV,
    weakestLegProb,
    avgSeasonHitRate,
    avgLast10HitRate,
    matchDiversity: matchSet.size / legs.length,
    score,
    scoreBreakdown: breakdown,
    warnings,
    labels: [],
    hasSameMatchLegs: hasSameMatch,
  };
}

/**
 * Validate a multi by recalculating from its legs array.
 * Returns array of error codes (empty = valid).
 */
function validateMulti(multi: OptimizedMulti): string[] {
  const errors: string[] = [];

  const odds = multi.legs.reduce((total, leg) => total * leg.odds, 1);
  const probability = multi.legs.reduce((total, leg) => total * leg.adjustedProb, 1);

  if (multi.legCount !== multi.legs.length) {
    errors.push('LEG_COUNT_MISMATCH');
  }

  if (Math.abs(multi.combinedOdds - odds) > 0.01) {
    errors.push('COMBINED_ODDS_MISMATCH');
  }

  if (Math.abs(multi.rawProbability - probability) > 0.001) {
    errors.push('COMBINED_PROBABILITY_MISMATCH');
  }

  const expectedEV = multi.conservativeProbability * odds - 1;
  if (Math.abs(multi.estimatedEV - expectedEV) > 0.01) {
    errors.push('COMBINED_EV_MISMATCH');
  }

  return errors;
}

function isDuplicateMulti(a: OptimizedMulti, b: OptimizedMulti): boolean {
  const aIds = new Set(a.legs.map(l => l.playerId));
  const bIds = new Set(b.legs.map(l => l.playerId));
  if (aIds.size !== bIds.size) return false;
  for (const id of aIds) if (!bIds.has(id)) return false;
  return true;
}

export interface CustomMultiResult {
  legs: OptimizerLeg[];
  legCount: number;
  combinedOdds: number;
  rawProbability: number;
  conservativeProbability: number;
  estimatedEV: number;
  weakestLegProb: number;
  hasSameMatchLegs: boolean;
  warnings: string[];
}

/**
 * Combine an arbitrary, user-picked set of legs into a multi.
 * Unlike buildCandidate/finalizeMulti, this has no fixed leg-count or
 * preset-driven constraints — it just prices whatever the user selected.
 */
export function buildCustomMulti(legs: OptimizerLeg[]): CustomMultiResult | null {
  if (legs.length === 0) return null;

  const playerIds = new Set(legs.map(l => l.playerId));
  if (playerIds.size !== legs.length) return null;

  const combinedOdds = legs.reduce((product, leg) => product * leg.odds, 1);
  const rawProbability = legs.reduce((product, leg) => product * leg.adjustedProb, 1);
  const conservativeProbability = applyCorrelationHaircut(legs, rawProbability);
  const estimatedEV = conservativeProbability * combinedOdds - 1;
  const weakestLegProb = Math.min(...legs.map(l => l.adjustedProb));

  const matchCounts = new Map<string, number>();
  for (const leg of legs) matchCounts.set(leg.matchId, (matchCounts.get(leg.matchId) ?? 0) + 1);
  const hasSameMatchLegs = matchCounts.size < legs.length;

  const warnings: string[] = [];
  if (hasSameMatchLegs) {
    warnings.push('Legs from the same match are not fully independent — this probability may be overstated.');
  }
  for (const leg of legs) {
    if (leg.riskLevel === 'High') warnings.push(`${leg.playerName} is flagged High risk`);
  }

  return {
    legs,
    legCount: legs.length,
    combinedOdds,
    rawProbability,
    conservativeProbability,
    estimatedEV,
    weakestLegProb,
    hasSameMatchLegs,
    warnings,
  };
}

function yieldToBrowser(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Build and validate a candidate from a combo.
 * Returns null if the combo fails hard constraints or validation.
 */
function buildCandidate(
  combo: OptimizerLeg[],
  settings: MultiOptimizerSettings,
): OptimizedMulti | null {
  // Ban incorrect leg counts
  if (settings.preset === 'gameMulti' || settings.preset === 'roundMulti') {
    if (combo.length !== 4 && combo.length !== 3) return null;
  }
  if (settings.preset === 'sameGame') {
    if (combo.length !== 2) return null;
  }

  // Hard constraints
  const combinedOdds = combo.reduce((acc, l) => acc * l.odds, 1);
  if (combinedOdds > settings.hardMaxOdds) return null;

  const playerSet = new Set(combo.map(l => l.playerId));
  if (playerSet.size !== combo.length) return null;

  const matchCounts = new Map<string, number>();
  for (const leg of combo) matchCounts.set(leg.matchId, (matchCounts.get(leg.matchId) ?? 0) + 1);
  for (const count of matchCounts.values()) {
    if (count > settings.maxLegsPerMatch) return null;
  }

  // Copy the array to prevent mutation by the DFS caller
  const completedLegs = [...combo];
  const multi = finalizeMulti(completedLegs, settings);
  if (!multi) return null;

  const errors = validateMulti(multi);
  if (errors.length > 0) return null;

  return multi;
}

async function searchCombinations(
  pool: OptimizerLeg[],
  k: number,
  settings: MultiOptimizerSettings,
  cancelRef: CancellationRef | null,
  onProgress: (checked: number, found: number) => void,
  startTime: number,
): Promise<{ candidates: OptimizedMulti[]; checked: number; stoppedBy: string | null }> {
  const candidates: OptimizedMulti[] = [];
  let checked = 0;
  let stoppedBy: string | null = null;

  const sorted = [...pool].sort((a, b) => a.odds - b.odds);

  function dfs(start: number, current: OptimizerLeg[], currentOdds: number, usedPlayers: Set<string>, matchCounts: Map<string, number>) {
    if (stoppedBy) return;

    if (current.length === k) {
      checked++;
      const candidate = buildCandidate(current, settings);
      if (candidate) {
        if (candidates.length < 5) {
          console.log('[SMART MULTI CANDIDATE]', {
            legCount: candidate.legs.length,
            players: candidate.legs.map(l => l.playerName),
            odds: candidate.legs.map(l => l.odds),
            calculatedOdds: candidate.legs.reduce((p, l) => p * l.odds, 1),
          });
        }
        candidates.push(candidate);
        if (candidates.length > MAX_RESULTS_KEPT) {
          candidates.sort((a, b) => b.score - a.score);
          candidates.length = MAX_RESULTS_KEPT;
        }
      }
      return;
    }

    for (let i = start; i < sorted.length; i++) {
      if (checked >= MAX_COMBINATIONS) { stoppedBy = 'Max combinations reached'; return; }
      if (Date.now() - startTime > MAX_RUNTIME_MS) { stoppedBy = 'Max runtime reached'; return; }

      const leg = sorted[i];

      if (usedPlayers.has(leg.playerId)) continue;

      const matchCount = matchCounts.get(leg.matchId) ?? 0;
      if (matchCount >= settings.maxLegsPerMatch) continue;

      const newOdds = currentOdds * leg.odds;
      if (newOdds > settings.hardMaxOdds) continue;

      const remaining = k - current.length - 1;
      if (remaining > 0) {
        let maxProduct = 1;
        let count = 0;
        for (let j = i + 1; j < sorted.length && count < remaining; j++) {
          if (!usedPlayers.has(sorted[j].playerId)) {
            maxProduct *= sorted[j].odds;
            count++;
          }
        }
        if (count < remaining) continue;
        if (newOdds * maxProduct < settings.preferredMinOdds * 0.85) continue;
      }

      current.push(leg);
      usedPlayers.add(leg.playerId);
      matchCounts.set(leg.matchId, matchCount + 1);

      dfs(i + 1, current, newOdds, usedPlayers, matchCounts);

      current.pop();
      usedPlayers.delete(leg.playerId);
      matchCounts.set(leg.matchId, matchCount);
    }
  }

  for (let i = 0; i < sorted.length; i++) {
    if (stoppedBy) break;
    if (cancelRef?.cancelled) { stoppedBy = 'Cancelled'; break; }

    const leg = sorted[i];
    dfs(i + 1, [leg], leg.odds, new Set([leg.playerId]), new Map([[leg.matchId, 1]]));

    if (i % 5 === 0 || checked % YIELD_INTERVAL < 50) {
      onProgress(checked, candidates.length);
      await yieldToBrowser();
    }
  }

  return { candidates, checked, stoppedBy };
}

export async function runMultiOptimizerAsync(
  recommendations: DisposalLineRecommendation[],
  settings: MultiOptimizerSettings,
  cancelRef: CancellationRef | null,
  onProgress: (p: OptimizerProgress) => void,
  matchNames: Record<string, string> = {},
  teamEnv?: TeamEnvironmentMap,
  roleTrends?: RoleTrendMap,
): Promise<{ multis: OptimizedMulti[]; diagnostics: OptimizerDiagnostics }> {
  const startTime = Date.now();
  const validationErrors: string[] = [];

  const diagnostics: OptimizerDiagnostics = {
    modelReadyDisposalRows: 0,
    uniquePlayers: recommendations.length,
    playersWithSafeLine: 0,
    rejectedBySample: 0,
    rejectedBySeasonHitRate: 0,
    rejectedByLast10Form: 0,
    rejectedByLastFiveForm: 0,
    rejectedByOdds: 0,
    rejectedByRisk: 0,
    rejectedByPositionEdge: 0,
    poolSize: 0,
    fourLegCombinationsChecked: 0,
    threeLegCombinationsChecked: 0,
    twoLegCombinationsChecked: 0,
    candidatesInPreferredRange: 0,
    finalMultisReturned: 0,
    stoppedByLimit: null,
    runtimeMs: 0,
    validationErrors,
  };

  onProgress({ phase: 'preparing', safePlayerLines: 0, combinationsChecked: 0, candidatesFound: 0 });

  for (const rec of recommendations) {
    if (rec.safeLine) {
      diagnostics.playersWithSafeLine++;
    } else {
      for (const reason of rec.rejectionReasons) {
        if (reason.includes('Sample')) diagnostics.rejectedBySample++;
        else if (reason.includes('Hit rate')) diagnostics.rejectedBySeasonHitRate++;
        else if (reason.includes('Last 10')) diagnostics.rejectedByLast10Form++;
        else if (reason.includes('Last 5')) diagnostics.rejectedByLastFiveForm++;
        else if (reason.includes('Odds')) diagnostics.rejectedByOdds++;
        else if (reason.includes('risk') || reason.includes('High')) diagnostics.rejectedByRisk++;
        else if (reason.includes('suppression') || reason.includes('Position')) diagnostics.rejectedByPositionEdge++;
      }
    }
  }

  const poolLegs: OptimizerLeg[] = [];
  for (const rec of recommendations) {
    const sourceLine = settings.preset === 'sameGame' ? (rec.balancedLine ?? rec.safeLine) : rec.safeLine;
    if (sourceLine) {
      const matchName = matchNames[rec.matchId] ?? rec.matchId;
      poolLegs.push(rowToLeg(sourceLine, matchName, teamEnv, roleTrends));
      diagnostics.modelReadyDisposalRows++;
    }
  }

  if (poolLegs.length === 0) {
    diagnostics.runtimeMs = Date.now() - startTime;
    onProgress({ phase: 'done', safePlayerLines: 0, combinationsChecked: 0, candidatesFound: 0 });
    return { multis: [], diagnostics };
  }

  const pool = poolLegs.slice(0, settings.maxPoolSize);
  diagnostics.poolSize = pool.length;

  onProgress({ phase: 'preparing', safePlayerLines: pool.length, combinationsChecked: 0, candidatesFound: 0 });
  await yieldToBrowser();

  const allCandidates: OptimizedMulti[] = [];
  let stoppedBy: string | null = null;

  const searchSizes = settings.preset === 'sameGame'
    ? [2]
    : [settings.preferredLegs, settings.fallbackLegs];

  for (const k of searchSizes) {
    if (stoppedBy || cancelRef?.cancelled) break;
    if (pool.length < k) continue;

    onProgress({ phase: 'searching', safePlayerLines: pool.length, combinationsChecked: 0, candidatesFound: allCandidates.length });

    const result = await searchCombinations(
      pool, k, settings, cancelRef,
      (checked, found) => onProgress({ phase: 'searching', safePlayerLines: pool.length, combinationsChecked: checked, candidatesFound: found }),
      startTime,
    );

    if (k === 4) diagnostics.fourLegCombinationsChecked = result.checked;
    else if (k === 3) diagnostics.threeLegCombinationsChecked = result.checked;
    else if (k === 2) diagnostics.twoLegCombinationsChecked = result.checked;

    allCandidates.push(...result.candidates);
    if (result.stoppedBy) stoppedBy = result.stoppedBy;

    if ((settings.preset === 'gameMulti' || settings.preset === 'roundMulti') && k === 4 && allCandidates.length >= 5) break;
  }

  allCandidates.sort((a, b) => b.score - a.score);

  const unique: OptimizedMulti[] = [];
  for (const candidate of allCandidates) {
    let isDup = false;
    for (const existing of unique) {
      if (isDuplicateMulti(candidate, existing)) { isDup = true; break; }
    }
    if (!isDup) unique.push(candidate);
  }

  // Validate every candidate
  const valid: OptimizedMulti[] = [];
  for (const m of unique) {
    const errors = validateMulti(m);
    if (errors.length > 0) {
      validationErrors.push(...errors.map(e => `${e}: ${m.legs.map(l => l.playerName).join(', ')}`));
    } else {
      valid.push(m);
    }
  }

  diagnostics.candidatesInPreferredRange = valid.filter(m =>
    m.combinedOdds >= settings.preferredMinOdds && m.combinedOdds <= settings.preferredMaxOdds
  ).length;

  const fourLegs = valid.filter(m => m.legs.length === 4);
  const threeLegs = valid.filter(m => m.legs.length === 3);
  const twoLegs = valid.filter(m => m.legs.length === 2);
  const inPreferred = valid.filter(m =>
    m.combinedOdds >= settings.preferredMinOdds && m.combinedOdds <= settings.preferredMaxOdds
  );

  const finalMultis: OptimizedMulti[] = [];

  if (settings.preset === 'gameMulti' || settings.preset === 'roundMulti') {
    const topSafe = inPreferred.filter(m => m.legs.length === 4)[0] ?? fourLegs[0];
    if (topSafe) finalMultis.push({ ...topSafe, labels: ['Safest Four-Leg Multi'] });

    for (const m of fourLegs) {
      if (finalMultis.some(fm => isDuplicateMulti(fm, m))) continue;
      finalMultis.push({ ...m, labels: ['Alternative Four-Leg Multi'] });
      break;
    }

    for (const m of threeLegs) {
      if (finalMultis.some(fm => isDuplicateMulti(fm, m))) continue;
      finalMultis.push({ ...m, labels: ['Best Three-Leg Multi'] });
      break;
    }

    const byProb = [...valid].sort((a, b) => b.conservativeProbability - a.conservativeProbability);
    for (const m of byProb) {
      if (finalMultis.some(fm => isDuplicateMulti(fm, m))) continue;
      finalMultis.push({ ...m, labels: ['Highest Probability Multi'] });
      break;
    }

    const byEV = [...valid].filter(m => m.combinedOdds <= settings.hardMaxOdds).sort((a, b) => b.estimatedEV - a.estimatedEV);
    for (const m of byEV) {
      if (finalMultis.some(fm => isDuplicateMulti(fm, m))) continue;
      finalMultis.push({ ...m, labels: ['Best Value Under $2.50'] });
      break;
    }
  } else {
    for (const m of twoLegs.slice(0, 5)) {
      finalMultis.push({ ...m, labels: ['Same Game Double'] });
    }
  }

  // Merge labels for duplicates
  const merged: OptimizedMulti[] = [];
  for (const m of finalMultis) {
    const existing = merged.find(x => isDuplicateMulti(x, m));
    if (existing) {
      existing.labels.push(...m.labels);
    } else {
      merged.push({ ...m });
    }
  }

  diagnostics.finalMultisReturned = merged.length;
  diagnostics.stoppedByLimit = stoppedBy;
  diagnostics.runtimeMs = Date.now() - startTime;

  onProgress({ phase: 'done', safePlayerLines: pool.length, combinationsChecked: diagnostics.fourLegCombinationsChecked + diagnostics.threeLegCombinationsChecked + diagnostics.twoLegCombinationsChecked, candidatesFound: merged.length });

  return { multis: merged, diagnostics };
}
