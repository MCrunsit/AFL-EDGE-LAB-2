/**
 * Post-round performance review — built on the same leakage-safe backfilled
 * predictions as probabilityCalibration.ts, since there is no persisted log
 * of live Game Get-Up/Round Multi recommendations (the user chose backfill
 * over forward logging).
 *
 * Scope simplification, stated plainly rather than hidden: this does NOT
 * call gameGetUp.ts's buildGameGetUp directly. That engine's leg type
 * requires a full ModelledOddsRow (position group, freshness, EV, matchup
 * adjustments, etc.) which cannot be honestly reconstructed for a past
 * match without rebuilding the entire live EV pipeline as-of a historical
 * date — a much larger undertaking than this phase. Instead, this module
 * reconstructs a simplified "safest small multi" per match directly from
 * BackfillPrediction (probability + odds + real outcome only), using the
 * same spirit as Game Get-Up (prefer 2 safe legs) so the review is still
 * genuinely grading safety-first behavior, just without the Safety Score /
 * Data Confidence dimensions Game Get-Up itself uses. Every number below is
 * still real — computed from genuine historical predictions and outcomes.
 */
import {
  backfillMatchPredictions,
  type BackfillPrediction,
  type CompletedMatchInput,
} from './probabilityCalibration';

const SAFE_PROB_THRESHOLD = 0.70;
const PREFERRED_LEGS = 2;

export type ReconstructedTier = 'ELITE' | 'STRONG' | 'ACCEPTABLE' | 'BEST_AVAILABLE';

function classifyLegTier(predictedProb: number): ReconstructedTier {
  if (predictedProb >= 0.92) return 'ELITE';
  if (predictedProb >= 0.88) return 'STRONG';
  if (predictedProb >= 0.84) return 'ACCEPTABLE';
  return 'BEST_AVAILABLE';
}

export interface ReconstructedMulti {
  matchId: string;
  matchDate: string;
  legs: BackfillPrediction[];
  combinedOdds: number;
  combinedProb: number; // independent approximation — no correlation model applied retroactively
  allLegsHit: boolean;
}

/**
 * Per completed match, backfills every genuine prediction, then reconstructs
 * a small "safest multi" from the legs at/above SAFE_PROB_THRESHOLD —
 * preferring PREFERRED_LEGS, never forcing more than were genuinely safe.
 */
export async function runPostRoundBackfill(matches: CompletedMatchInput[]): Promise<{
  allPredictions: BackfillPrediction[];
  multis: ReconstructedMulti[];
}> {
  const perMatch = await Promise.all(matches.map(async match => {
    const predictions = await backfillMatchPredictions(match);

    const safeLegs = predictions
      .filter(p => p.predictedProb >= SAFE_PROB_THRESHOLD)
      .sort((a, b) => b.predictedProb - a.predictedProb)
      .slice(0, PREFERRED_LEGS);

    const multi: ReconstructedMulti | null = safeLegs.length === 0 ? null : {
      matchId: match.matchId,
      matchDate: match.matchDate,
      legs: safeLegs,
      combinedOdds: safeLegs.reduce((p, l) => p * l.overOdds, 1),
      combinedProb: safeLegs.reduce((p, l) => p * l.predictedProb, 1),
      allLegsHit: safeLegs.every(l => l.actualHit),
    };

    return { predictions, multi };
  }));

  const allPredictions = perMatch.flatMap(r => r.predictions);
  const multis = perMatch.map(r => r.multi).filter((m): m is ReconstructedMulti => m !== null);

  return { allPredictions, multis };
}

export interface TierHitRate {
  tier: ReconstructedTier;
  legCount: number;
  hits: number;
  hitRate: number | null;
}

export interface BucketHitRate {
  label: string;
  legCount: number;
  hits: number;
  hitRate: number | null;
}

export interface FailureReason {
  reason: string;
  count: number;
}

export interface PlayerRatingFlag {
  playerId: string;
  playerName: string;
  appearances: number;
  avgPredictedProb: number;
  actualHitRate: number;
}

export interface PostRoundReport {
  matchesReviewed: number;
  gameGetUpMultisGenerated: number;
  gameGetUpMultisWon: number;
  overallLegHitRate: number | null;
  returnOnTurnover: number | null;
  maxLosingStreak: number;
  hitRateByTier: TierHitRate[];
  hitRateByProbabilityBucket: BucketHitRate[];
  hitRateByOddsRange: BucketHitRate[];
  mostCommonFailureReasons: FailureReason[];
  overratedPlayers: PlayerRatingFlag[];
  underratedPlayers: PlayerRatingFlag[];
}

const PROBABILITY_BUCKETS: { label: string; min: number; max: number }[] = [
  { label: '70-74%', min: 0.70, max: 0.75 },
  { label: '75-79%', min: 0.75, max: 0.80 },
  { label: '80-84%', min: 0.80, max: 0.85 },
  { label: '85-89%', min: 0.85, max: 0.90 },
  { label: '90-94%', min: 0.90, max: 0.95 },
  { label: '95%+', min: 0.95, max: 1.01 },
];

const ODDS_RANGES: { label: string; min: number; max: number }[] = [
  { label: '<$1.20', min: 0, max: 1.20 },
  { label: '$1.20-$1.40', min: 1.20, max: 1.40 },
  { label: '$1.40-$1.70', min: 1.40, max: 1.70 },
  { label: '$1.70+', min: 1.70, max: Infinity },
];

const MIN_PLAYER_APPEARANCES = 3;
const RATING_GAP_THRESHOLD = 0.15;

export function buildPostRoundReport(backfill: { allPredictions: BackfillPrediction[]; multis: ReconstructedMulti[] }): PostRoundReport {
  const { allPredictions, multis } = backfill;

  // Every hit-rate/tier/bucket breakdown below is scored over the legs that
  // were actually part of a reconstructed recommendation — NOT every
  // backfilled bookmaker line. bookmaker_odds carries every alt-line a book
  // offers (e.g. a "40+ disposals" line a player has ~2% chance of clearing);
  // including those would silently drag the "leg hit rate" down to look like
  // the model performs badly, when in reality those lines were never
  // recommended by anything.
  const recommendedLegs = multis.flatMap(m => m.legs);

  const overallLegHitRate = recommendedLegs.length > 0
    ? recommendedLegs.filter(p => p.actualHit).length / recommendedLegs.length
    : null;

  const gameGetUpMultisWon = multis.filter(m => m.allLegsHit).length;
  const returnOnTurnover = multis.length > 0
    ? multis.reduce((sum, m) => sum + (m.allLegsHit ? m.combinedOdds - 1 : -1), 0) / multis.length
    : null;

  const sortedMultis = [...multis].sort((a, b) => a.matchDate.localeCompare(b.matchDate));
  let maxLosingStreak = 0;
  let currentStreak = 0;
  for (const m of sortedMultis) {
    if (!m.allLegsHit) {
      currentStreak++;
      maxLosingStreak = Math.max(maxLosingStreak, currentStreak);
    } else {
      currentStreak = 0;
    }
  }

  const tiers: ReconstructedTier[] = ['ELITE', 'STRONG', 'ACCEPTABLE', 'BEST_AVAILABLE'];
  const hitRateByTier: TierHitRate[] = tiers.map(tier => {
    const legs = recommendedLegs.filter(p => classifyLegTier(p.predictedProb) === tier);
    const hits = legs.filter(p => p.actualHit).length;
    return { tier, legCount: legs.length, hits, hitRate: legs.length > 0 ? hits / legs.length : null };
  });

  const hitRateByProbabilityBucket: BucketHitRate[] = PROBABILITY_BUCKETS.map(range => {
    const legs = recommendedLegs.filter(p => p.predictedProb >= range.min && p.predictedProb < range.max);
    const hits = legs.filter(p => p.actualHit).length;
    return { label: range.label, legCount: legs.length, hits, hitRate: legs.length > 0 ? hits / legs.length : null };
  });

  const hitRateByOddsRange: BucketHitRate[] = ODDS_RANGES.map(range => {
    const legs = recommendedLegs.filter(p => p.overOdds >= range.min && p.overOdds < range.max);
    const hits = legs.filter(p => p.actualHit).length;
    return { label: range.label, legCount: legs.length, hits, hitRate: legs.length > 0 ? hits / legs.length : null };
  });

  // Failure reasons — for multis that lost, attribute to the specific leg(s)
  // that missed.
  const failureCounts = new Map<string, number>();
  for (const m of sortedMultis) {
    if (m.allLegsHit) continue;
    const missedLegs = m.legs.filter(l => !l.actualHit);
    for (const leg of missedLegs) {
      const reason = missedLegs.length < m.legs.length
        ? `Weakest leg missed its line (${leg.playerName})`
        : 'Missed line despite high predicted probability';
      failureCounts.set(reason, (failureCounts.get(reason) ?? 0) + 1);
    }
  }
  const mostCommonFailureReasons = Array.from(failureCounts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // Over/underrated players — need repeated appearances to flag, not a
  // single bad result. Scoped to recommended legs, same reasoning as above.
  const byPlayer = new Map<string, BackfillPrediction[]>();
  for (const p of recommendedLegs) {
    if (!byPlayer.has(p.playerId)) byPlayer.set(p.playerId, []);
    byPlayer.get(p.playerId)!.push(p);
  }
  const overratedPlayers: PlayerRatingFlag[] = [];
  const underratedPlayers: PlayerRatingFlag[] = [];
  for (const [playerId, legs] of byPlayer) {
    if (legs.length < MIN_PLAYER_APPEARANCES) continue;
    const avgPredictedProb = legs.reduce((s, l) => s + l.predictedProb, 0) / legs.length;
    const actualHitRate = legs.filter(l => l.actualHit).length / legs.length;
    const flag: PlayerRatingFlag = { playerId, playerName: legs[0].playerName, appearances: legs.length, avgPredictedProb, actualHitRate };
    if (avgPredictedProb - actualHitRate > RATING_GAP_THRESHOLD) overratedPlayers.push(flag);
    else if (actualHitRate - avgPredictedProb > RATING_GAP_THRESHOLD) underratedPlayers.push(flag);
  }
  overratedPlayers.sort((a, b) => (b.avgPredictedProb - b.actualHitRate) - (a.avgPredictedProb - a.actualHitRate));
  underratedPlayers.sort((a, b) => (b.actualHitRate - b.avgPredictedProb) - (a.actualHitRate - a.avgPredictedProb));

  return {
    matchesReviewed: new Set(allPredictions.map(p => p.matchId)).size,
    gameGetUpMultisGenerated: multis.length,
    gameGetUpMultisWon,
    overallLegHitRate,
    returnOnTurnover,
    maxLosingStreak,
    hitRateByTier,
    hitRateByProbabilityBucket,
    hitRateByOddsRange,
    mostCommonFailureReasons,
    overratedPlayers: overratedPlayers.slice(0, 5),
    underratedPlayers: underratedPlayers.slice(0, 5),
  };
}
