/**
 * LAYER 3 — EV Engine (Analytics Service)
 *
 * All intelligence lives here. ONLY reads from Layer 2 (normalized odds).
 * NEVER touches the raw table directly. NEVER modifies odds data.
 *
 * Market type separation (CRITICAL):
 *   ou_line    → standard O/U: user supplies a subjective probability
 *   alt_ladder → Sportsbet player-total thresholds (21+, 22+…)
 *                MUST use Poisson CDF: P(X ≥ n | λ = player_mean)
 *                Never reuse O/U probability approximations for ladder markets.
 */

import type { NormalizedOddsRow } from './oddsNormalizer';
import type { PlayerGameStat, StatType } from './types';

// ── Poisson Ladder Distribution ───────────────────────────────────────────────

/**
 * Log-factorial using exact summation for n ≤ 25, Stirling's for n > 25.
 * Stays in log-space to avoid integer overflow for large k values.
 */
function logFactorial(n: number): number {
  if (n <= 1) return 0;
  if (n <= 25) {
    let s = 0;
    for (let i = 2; i <= n; i++) s += Math.log(i);
    return s;
  }
  // Stirling: ln(n!) ≈ n·ln(n) − n + 0.5·ln(2πn)
  return n * Math.log(n) - n + 0.5 * Math.log(2 * Math.PI * n);
}

/** P(X = k) for Poisson(λ). Computed in log-space. */
function poissonPMF(k: number, lambda: number): number {
  if (lambda <= 0 || k < 0 || !Number.isFinite(lambda)) return 0;
  const logP = -lambda + k * Math.log(Math.max(lambda, 1e-10)) - logFactorial(k);
  return Math.exp(logP);
}

/** P(X ≤ maxK) for Poisson(λ). */
function poissonCDF(maxK: number, lambda: number): number {
  let cdf = 0;
  for (let k = 0; k <= Math.floor(maxK); k++) {
    cdf += poissonPMF(k, lambda);
  }
  return Math.min(1, cdf);
}

export interface LadderProbResult {
  threshold: number;
  player_mean: number;
  adjusted_mean: number;
  opponent_adjustment: number;
  probability: number;
  implied_prob_from_odds: number | null;
  ev: number | null;
}

/**
 * Compute P(X ≥ threshold) using a Poisson distribution.
 *
 * This is structurally correct for alt_ladder markets:
 *   P(21+) = P(X ≥ 21) > P(X ≥ 22) > P(X ≥ 23) — always monotone decreasing.
 *
 * DO NOT use this for ou_line markets, which use user-supplied probability.
 *
 * @param threshold  The integer threshold n (e.g. 21 for "21+")
 * @param playerMean Player's expected stat (e.g. season average disposals)
 * @param opponentAdjustment Fractional adjustment: positive = opponent gives up more stats
 */
// DISABLED — Poisson ladder probability engine disabled per session 4 rules.
// Do NOT call from UI. Re-enable when model-driven EV is restored.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function ladderProbability(
  threshold: number,
  playerMean: number,
  opponentAdjustment = 0
): LadderProbResult {
  const n = Math.floor(threshold);
  const adjustedMean = Math.max(0.5, playerMean * (1 + opponentAdjustment));

  // P(X ≥ n) = 1 − P(X ≤ n − 1)
  const cdf = poissonCDF(n - 1, adjustedMean);
  const probability = Math.max(0.01, Math.min(0.99, 1 - cdf));

  console.log(
    `[ladderProbability] threshold=${n} player_mean=${playerMean.toFixed(2)}` +
    ` adj=${opponentAdjustment > 0 ? '+' : ''}${(opponentAdjustment * 100).toFixed(1)}%` +
    ` adjusted_mean=${adjustedMean.toFixed(2)} P(X≥${n})=${(probability * 100).toFixed(2)}%`
  );

  return {
    threshold: n,
    player_mean: playerMean,
    adjusted_mean: adjustedMean,
    opponent_adjustment: opponentAdjustment,
    probability,
    implied_prob_from_odds: null,
    ev: null,
  };
}

/**
 * Validate that ladder probabilities are strictly decreasing.
 * Logs an error and returns false if monotonicity is violated.
 */
// DISABLED — see ladderProbability above.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function validateLadderMonotonicity(
  thresholds: number[],
  playerMean: number
): boolean {
  const sorted = [...thresholds].sort((a, b) => a - b);
  let prev = Infinity;
  let valid = true;
  for (const t of sorted) {
    const { probability } = ladderProbability(t, playerMean);
    if (probability >= prev) {
      console.error(`[LADDER VALIDATION] FAIL: P(X≥${t})=${probability.toFixed(4)} >= P(X≥${t - 1})=${prev.toFixed(4)} — monotonicity violated`);
      valid = false;
    }
    prev = probability;
  }
  if (valid) {
    console.log(`[LADDER VALIDATION] PASS: all ${sorted.length} thresholds monotone decreasing for mean=${playerMean.toFixed(2)}`);
  }
  return valid;
}

// ── Implied Probability & Vig ─────────────────────────────────────────────────

export function calculateImpliedProbability(decimalOdds: number): number {
  if (decimalOdds <= 1) return 0;
  return 1 / decimalOdds;
}

export function calculateVig(overOdds: number, underOdds: number): number {
  const overProb = calculateImpliedProbability(overOdds);
  const underProb = calculateImpliedProbability(underOdds);
  return overProb + underProb - 1;
}

export function removedVigProbability(
  overOdds: number,
  underOdds: number
): { over: number; under: number } {
  const rawOver = calculateImpliedProbability(overOdds);
  const rawUnder = calculateImpliedProbability(underOdds);
  const total = rawOver + rawUnder;
  return { over: rawOver / total, under: rawUnder / total };
}

// ── EV Calculation ────────────────────────────────────────────────────────────

export interface EVResult {
  ev: number;
  edge: 'positive' | 'negative' | 'neutral';
  implied_prob: number;
  user_prob: number;
  odds: number;
  label: string;
}

/** EV = (probability × decimal_odds) − 1. Works for both ou_line and alt_ladder. */
export function calculateExpectedValue(
  userProbability: number,
  decimalOdds: number
): EVResult {
  if (userProbability < 0 || userProbability > 1) {
    return {
      ev: 0,
      edge: 'neutral',
      implied_prob: 0,
      user_prob: userProbability,
      odds: decimalOdds,
      label: 'Invalid probability',
    };
  }

  const impliedProb = calculateImpliedProbability(decimalOdds);
  const ev = userProbability * decimalOdds - 1;
  const edge: EVResult['edge'] = ev > 0.01 ? 'positive' : ev < -0.01 ? 'negative' : 'neutral';

  return {
    ev,
    edge,
    implied_prob: impliedProb,
    user_prob: userProbability,
    odds: decimalOdds,
    label: `${(ev * 100).toFixed(1)}% EV`,
  };
}

export function calculateEVFromOddsRow(
  row: NormalizedOddsRow,
  userProbOver: number
): { over: EVResult; under: EVResult } {
  return {
    over: calculateExpectedValue(userProbOver, row.over_odds),
    under: calculateExpectedValue(1 - userProbOver, row.under_odds),
  };
}

// ── Player Model Stats ────────────────────────────────────────────────────────

export interface PlayerModelStats {
  player_id: string;
  avg_disposals: number;
  avg_goals: number;
  avg_tackles: number;
  avg_marks: number;
  avg_hitouts: number;
  games_played: number;
  stddev_disposals: number | null;
  stddev_goals: number | null;
  stddev_tackles: number | null;
}

const STAT_MEAN_FIELD: Record<string, keyof PlayerModelStats> = {
  disposals: 'avg_disposals',
  goals: 'avg_goals',
  tackles: 'avg_tackles',
  marks: 'avg_marks',
  hitouts: 'avg_hitouts',
};

/**
 * Given a NormalizedOddsRow (alt_ladder) and player model stats, compute P(X ≥ base_line).
 * Returns null if required data is missing (no player_id, no stats, no base_line).
 */
// DISABLED — see ladderProbability above.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function computeLadderEV(
  row: NormalizedOddsRow,
  statsMap: Map<string, PlayerModelStats>,
  opponentAdjustment = 0
): { overEV: EVResult; underEV: EVResult; ladderProb: LadderProbResult } | null {
  if (row.market_type !== 'alt_ladder' || row.base_line == null || !row.player_id) return null;

  const stats = statsMap.get(row.player_id);
  if (!stats) return null;

  const statType = row.stat_type;
  if (!statType || !(statType in STAT_MEAN_FIELD)) return null;

  const meanField = STAT_MEAN_FIELD[statType];
  const playerMean = Number(stats[meanField]);
  if (!playerMean || playerMean <= 0) return null;

  const ladderProb = ladderProbability(row.base_line, playerMean, opponentAdjustment);

  console.log(
    `[computeLadderEV] player=${row.player_name} stat=${statType}` +
    ` threshold=${row.base_line}(${row.display_label})` +
    ` mean=${playerMean.toFixed(2)} P=${(ladderProb.probability * 100).toFixed(2)}%` +
    ` over_odds=${row.over_odds} EV=${((ladderProb.probability * row.over_odds - 1) * 100).toFixed(2)}%`
  );

  const overEV = calculateExpectedValue(ladderProb.probability, row.over_odds);
  const underEV = calculateExpectedValue(1 - ladderProb.probability, row.under_odds);

  ladderProb.implied_prob_from_odds = calculateImpliedProbability(row.over_odds);
  ladderProb.ev = overEV.ev;

  return { overEV, underEV, ladderProb };
}

/**
 * Extract the player mean for a given row's stat type from the stats map.
 * Returns null if not available.
 */
// DISABLED — used only by Poisson engine.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function getPlayerMeanForRow(
  row: NormalizedOddsRow,
  statsMap: Map<string, PlayerModelStats>
): number | null {
  if (!row.player_id) return null;
  const stats = statsMap.get(row.player_id);
  if (!stats) return null;
  const statType = row.stat_type;
  if (!statType || !(statType in STAT_MEAN_FIELD)) return null;
  const mean = Number(stats[STAT_MEAN_FIELD[statType]]);
  return mean > 0 ? mean : null;
}

// ── Player Form ───────────────────────────────────────────────────────────────

export interface FormAnalysis {
  last5_avg: number;
  last5_games: number[];
  season_avg: number;
  opponent_avg: number | null;
  opponent_games: number;
  venue_avg: number | null;
  venue_games: number;
  form_score: number;
  adjusted_prob_over: (line: number) => number;
}

export function comparePlayerForm(
  stats: PlayerGameStat[],
  statType: StatType,
  options?: {
    opponentStats?: PlayerGameStat[];
    venueStats?: PlayerGameStat[];
  }
): FormAnalysis {
  if (stats.length === 0) {
    return {
      last5_avg: 0,
      last5_games: [],
      season_avg: 0,
      opponent_avg: null,
      opponent_games: 0,
      venue_avg: null,
      venue_games: 0,
      form_score: 0,
      adjusted_prob_over: () => 0.5,
    };
  }

  const sorted = [...stats].sort(
    (a, b) => new Date(b.match_date).getTime() - new Date(a.match_date).getTime()
  );
  const values = sorted.map(s => Number((s as Record<string, unknown>)[statType]) || 0);
  const last5 = values.slice(0, 5);
  const last5Avg = last5.length > 0 ? last5.reduce((a, b) => a + b, 0) / last5.length : 0;
  const seasonAvg = values.reduce((a, b) => a + b, 0) / values.length;

  let opponentAvg: number | null = null;
  let opponentGames = 0;
  if (options?.opponentStats && options.opponentStats.length > 0) {
    const vals = options.opponentStats.map(s => Number((s as Record<string, unknown>)[statType]) || 0);
    opponentAvg = vals.reduce((a, b) => a + b, 0) / vals.length;
    opponentGames = vals.length;
  }

  let venueAvg: number | null = null;
  let venueGames = 0;
  if (options?.venueStats && options.venueStats.length > 0) {
    const vals = options.venueStats.map(s => Number((s as Record<string, unknown>)[statType]) || 0);
    venueAvg = vals.reduce((a, b) => a + b, 0) / vals.length;
    venueGames = vals.length;
  }

  const stdDev =
    values.length > 1
      ? Math.sqrt(values.reduce((sum, v) => sum + Math.pow(v - seasonAvg, 2), 0) / values.length)
      : 0;
  const consistency = seasonAvg > 0 ? Math.max(0, 1 - stdDev / seasonAvg) : 0;
  const formScore = Math.round((last5Avg / Math.max(seasonAvg, 0.1)) * 50 + consistency * 50);

  const adjusted_prob_over = (line: number): number => {
    const baseline = values.filter(v => v > line).length / values.length;
    let adjustment = 0;
    if (opponentAvg !== null && opponentGames >= 2) {
      adjustment += ((opponentAvg - seasonAvg) / Math.max(seasonAvg, 1)) * 0.1;
    }
    if (venueAvg !== null && venueGames >= 2) {
      adjustment += ((venueAvg - seasonAvg) / Math.max(seasonAvg, 1)) * 0.05;
    }
    return Math.max(0.05, Math.min(0.95, baseline + adjustment));
  };

  return {
    last5_avg: last5Avg,
    last5_games: last5,
    season_avg: seasonAvg,
    opponent_avg: opponentAvg,
    opponent_games: opponentGames,
    venue_avg: venueAvg,
    venue_games: venueGames,
    form_score: Math.min(100, Math.max(0, formScore)),
    adjusted_prob_over,
  };
}

// ── Multi Builder ─────────────────────────────────────────────────────────────

export interface MultiLeg {
  row: NormalizedOddsRow;
  side: 'over' | 'under';
  odds: number;
  ev: EVResult;
  user_prob: number;
  correlation_key: string;
}

export interface MultiCandidate {
  legs: MultiLeg[];
  combined_odds: number;
  combined_ev: number;
  leg_count: number;
}

export function buildMultiCandidates(
  rows: NormalizedOddsRow[],
  probabilities: Map<string, { over: number; under: number }>,
  options: {
    targetOdds: number;
    maxLegs?: number;
    maxSameMatchLegs?: number;
  }
): MultiCandidate[] {
  const maxLegs = options.maxLegs ?? 6;
  const maxSameMatch = options.maxSameMatchLegs ?? 2;

  const scoredLegs: MultiLeg[] = [];
  for (const row of rows) {
    const probs = probabilities.get(row.id);
    if (!probs) continue;

    const overEV = calculateExpectedValue(probs.over, row.over_odds);
    const underEV = calculateExpectedValue(probs.under, row.under_odds);

    if (overEV.edge === 'positive') {
      scoredLegs.push({
        row,
        side: 'over',
        odds: row.over_odds,
        ev: overEV,
        user_prob: probs.over,
        correlation_key: row.match_id,
      });
    }
    if (underEV.edge === 'positive') {
      scoredLegs.push({
        row,
        side: 'under',
        odds: row.under_odds,
        ev: underEV,
        user_prob: probs.under,
        correlation_key: row.match_id,
      });
    }
  }

  scoredLegs.sort((a, b) => b.ev.ev - a.ev.ev);

  const candidates: MultiCandidate[] = [];
  const selected: MultiLeg[] = [];
  const matchCounts = new Map<string, number>();

  for (const leg of scoredLegs) {
    if (selected.length >= maxLegs) break;

    const matchCount = matchCounts.get(leg.correlation_key) ?? 0;
    if (matchCount >= maxSameMatch) continue;

    const alreadyHasMarket = selected.some(
      s => s.row.match_id === leg.row.match_id && s.row.raw_market === leg.row.raw_market
    );
    if (alreadyHasMarket) continue;

    selected.push(leg);
    matchCounts.set(leg.correlation_key, matchCount + 1);

    const combinedOdds = selected.reduce((acc, l) => acc * l.odds, 1);
    const combinedEV = selected.reduce((acc, l) => acc * l.user_prob, 1) * combinedOdds - 1;

    if (combinedOdds >= options.targetOdds) {
      candidates.push({
        legs: [...selected],
        combined_odds: combinedOdds,
        combined_ev: combinedEV,
        leg_count: selected.length,
      });
    }
  }

  return candidates;
}
