/**
 * Shared quality-tier classification for small "safest available" multis —
 * used by Game Get-Up (one match) and Round Multi's Game Blocks (one match
 * each, combined into a round). Both are the same underlying problem: grade
 * a small combo of legs against Elite/Strong/Acceptable/Best Available
 * thresholds and always return a grade rather than "no qualifying multi".
 *
 * Extracted from gameGetUp.ts so both callers grade identically instead of
 * maintaining two copies of the same thresholds.
 */

export type QualityTier = 'ELITE' | 'STRONG' | 'ACCEPTABLE' | 'BEST_AVAILABLE';

export interface TierMetrics {
  conservativeProbability: number;
  weakestSafetyScore: number | null;
  minDataConfidence: number | null;
  avgSeasonHitRate: number;
  worstLast10: number;
  worstLast5: number;
  worstLast5MinMargin: number | null;
  hasRoleReduction: boolean;
  hasHighTagRisk: boolean;
  hasSignificantNegativeMatchup: boolean;
  hasSlightSuppression: boolean;
  anyStaleData: boolean;
}

export interface TierCheckResult {
  tier: QualityTier;
  gapReasons: string[];
}

/**
 * Classify against the four quality tiers, evaluated in order (Elite ->
 * Strong -> Acceptable -> Best Available). Falls through to Best Available
 * rather than ever signaling "no qualifying multi" — every match/game with
 * genuine lines must return a graded recommendation.
 */
export function classifyQualityTier(m: TierMetrics): TierCheckResult {
  const gaps: string[] = [];

  const elitePass =
    m.conservativeProbability >= 0.92 &&
    m.weakestSafetyScore !== null && m.weakestSafetyScore >= 88 &&
    m.minDataConfidence !== null && m.minDataConfidence >= 85 &&
    m.avgSeasonHitRate >= 0.90 &&
    m.worstLast10 >= 9 &&
    m.worstLast5 >= 5 &&
    m.worstLast5MinMargin !== null && m.worstLast5MinMargin >= 2 &&
    !m.hasRoleReduction && !m.hasHighTagRisk && !m.hasSignificantNegativeMatchup && !m.anyStaleData;

  if (elitePass) return { tier: 'ELITE', gapReasons: [] };
  if (m.conservativeProbability < 0.92) gaps.push(`Conservative probability ${(m.conservativeProbability * 100).toFixed(1)}% below Elite's 92%`);
  if (m.weakestSafetyScore === null || m.weakestSafetyScore < 88) gaps.push('Weakest-leg Safety Score below Elite threshold (88)');

  const strongPass =
    m.conservativeProbability >= 0.88 &&
    m.weakestSafetyScore !== null && m.weakestSafetyScore >= 82 &&
    m.minDataConfidence !== null && m.minDataConfidence >= 80 &&
    m.avgSeasonHitRate >= 0.85 &&
    m.worstLast10 >= 8 &&
    m.worstLast5 >= 4 &&
    (m.worstLast5MinMargin === null || m.worstLast5MinMargin >= 0) &&
    !m.hasRoleReduction && !m.hasHighTagRisk && !m.hasSignificantNegativeMatchup;

  if (strongPass) return { tier: 'STRONG', gapReasons: gaps };
  if (m.conservativeProbability < 0.88) gaps.push(`Conservative probability ${(m.conservativeProbability * 100).toFixed(1)}% below Strong's 88%`);
  if (m.weakestSafetyScore === null || m.weakestSafetyScore < 82) gaps.push('Weakest-leg Safety Score below Strong threshold (82)');

  const acceptablePass =
    m.conservativeProbability >= 0.84 &&
    m.weakestSafetyScore !== null && m.weakestSafetyScore >= 75 &&
    m.minDataConfidence !== null && m.minDataConfidence >= 70 &&
    !m.hasHighTagRisk && !m.hasRoleReduction;

  if (acceptablePass) return { tier: 'ACCEPTABLE', gapReasons: gaps };
  if (m.conservativeProbability < 0.84) gaps.push(`Conservative probability ${(m.conservativeProbability * 100).toFixed(1)}% below Acceptable's 84%`);
  if (m.weakestSafetyScore === null || m.weakestSafetyScore < 75) gaps.push('Weakest-leg Safety Score below Acceptable threshold (75)');
  if (m.hasSlightSuppression) gaps.push('Contains a slight matchup suppression');

  return { tier: 'BEST_AVAILABLE', gapReasons: gaps };
}

export function tierOrder(tier: QualityTier): number {
  switch (tier) {
    case 'ELITE': return 0;
    case 'STRONG': return 1;
    case 'ACCEPTABLE': return 2;
    case 'BEST_AVAILABLE': return 3;
  }
}
