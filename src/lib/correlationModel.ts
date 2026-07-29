/**
 * Real pairwise correlation modeling — replaces the flat 5%-per-pair/15%-cap
 * same-game haircut (multiOptimizer.ts's applyCorrelationHaircut, still used
 * internally by the DFS search for fast synchronous ranking) with a
 * data-driven adjustment for the final graded/displayed numbers.
 *
 * Uses each player's own historical game log (already fetched for Safety
 * Score by gameGetUp.ts/roundMulti.ts) — no new DB calls. When two players
 * don't have enough shared games to trust a computed correlation, falls
 * back to the same conservative flat contribution as before, per pair,
 * rather than fabricating a number from too little data.
 */
import type { CanonicalGameRow } from './canonicalGameLog';
import type { OptimizerLeg } from './multiOptimizer';

const MIN_SHARED_GAMES = 8;
const MAX_TOTAL_HAIRCUT = 0.30;
const FLAT_PAIR_HAIRCUT = 0.05;
/** Historical correlation coefficient -> haircut-per-pair scaling factor.
 * A perfectly correlated pair (coefficient 1) contributes at most 20% —
 * still capped well below "certain double-counting". */
const CORRELATION_TO_HAIRCUT_SCALE = 0.20;

export function pearsonCorrelation(a: number[], b: number[]): number {
  const n = a.length;
  if (n === 0) return 0;
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;
  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return 0;
  return cov / Math.sqrt(varA * varB);
}

export interface PairwiseCorrelationResult {
  correlation: number | null;
  sharedGames: number;
}

/**
 * Aligns two players' game logs by match_id and computes the Pearson
 * correlation of their disposal counts across shared games. Returns null
 * (not a fabricated 0) when fewer than MIN_SHARED_GAMES shared games exist.
 */
export function computePairwiseCorrelation(
  gameLogA: CanonicalGameRow[],
  gameLogB: CanonicalGameRow[],
): PairwiseCorrelationResult {
  const byMatchB = new Map<string, number>();
  for (const row of gameLogB) {
    if (row.match_id) byMatchB.set(row.match_id, row.statValue);
  }

  const alignedA: number[] = [];
  const alignedB: number[] = [];
  for (const row of gameLogA) {
    if (!row.match_id) continue;
    const valueB = byMatchB.get(row.match_id);
    if (valueB !== undefined) {
      alignedA.push(row.statValue);
      alignedB.push(valueB);
    }
  }

  const sharedGames = alignedA.length;
  if (sharedGames < MIN_SHARED_GAMES) return { correlation: null, sharedGames };
  return { correlation: pearsonCorrelation(alignedA, alignedB), sharedGames };
}

export interface PairCorrelation {
  a: string;
  b: string;
  correlation: number | null;
  sharedGames: number;
  haircutContribution: number;
}

export type CorrelationMethod = 'historical' | 'flat_fallback' | 'mixed';

export interface CorrelationAdjustmentResult {
  conservativeProbability: number;
  correlationAdjustment: number;
  method: CorrelationMethod;
  pairs: PairCorrelation[];
}

/**
 * Apply a real, historically-grounded correlation adjustment to a set of
 * same-match legs. Every pair is checked independently: pairs with enough
 * shared-game history use their actual historical correlation (positive
 * correlation increases the haircut, negative/near-zero shrinks it toward
 * zero); pairs without enough history fall back to the previous flat 5%
 * contribution, exactly as multiOptimizer.ts's DFS-time haircut already did.
 */
export function applyRealCorrelationAdjustment(
  legs: OptimizerLeg[],
  rawProbability: number,
  gameLogByPlayerId: Map<string, CanonicalGameRow[]>,
): CorrelationAdjustmentResult {
  if (legs.length < 2) {
    return { conservativeProbability: rawProbability, correlationAdjustment: 0, method: 'historical', pairs: [] };
  }

  const pairs: PairCorrelation[] = [];
  let haircut = 0;
  let anyHistorical = false;
  let anyFallback = false;

  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      const logA = gameLogByPlayerId.get(legs[i].playerId) ?? [];
      const logB = gameLogByPlayerId.get(legs[j].playerId) ?? [];
      const { correlation, sharedGames } = computePairwiseCorrelation(logA, logB);

      let contribution: number;
      if (correlation !== null) {
        anyHistorical = true;
        contribution = Math.max(0, Math.min(CORRELATION_TO_HAIRCUT_SCALE, correlation * CORRELATION_TO_HAIRCUT_SCALE));
      } else {
        anyFallback = true;
        contribution = FLAT_PAIR_HAIRCUT;
      }

      haircut += contribution;
      pairs.push({ a: legs[i].playerName, b: legs[j].playerName, correlation, sharedGames, haircutContribution: contribution });
    }
  }

  haircut = Math.min(haircut, MAX_TOTAL_HAIRCUT);
  const method: CorrelationMethod = anyHistorical && anyFallback ? 'mixed' : anyHistorical ? 'historical' : 'flat_fallback';

  return {
    conservativeProbability: rawProbability * (1 - haircut),
    correlationAdjustment: haircut,
    method,
    pairs,
  };
}
