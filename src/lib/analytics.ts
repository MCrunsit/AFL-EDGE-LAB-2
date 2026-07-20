import type { PlayerGameStat, PropAnalysis, StatType, TrendPlayer, Player } from './types';

export function getStatValue(stat: PlayerGameStat, type: StatType): number {
  return stat[type] ?? 0;
}

export function average(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function stdDev(nums: number[]): number {
  if (nums.length < 2) return 0;
  const avg = average(nums);
  const variance = nums.reduce((sum, n) => sum + Math.pow(n - avg, 2), 0) / nums.length;
  return Math.sqrt(variance);
}

export function consistencyRating(nums: number[]): number {
  if (nums.length < 2) return 0;
  const avg = average(nums);
  if (avg === 0) return 0;
  const cv = stdDev(nums) / avg;
  return Math.max(0, Math.min(100, Math.round((1 - cv) * 100)));
}

export function sortStatsByDate(stats: PlayerGameStat[]): PlayerGameStat[] {
  return [...stats].sort((a, b) => new Date(b.match_date).getTime() - new Date(a.match_date).getTime());
}

export function getLastN(stats: PlayerGameStat[], n: number): PlayerGameStat[] {
  return sortStatsByDate(stats).slice(0, n);
}

export function calcAvgForStats(stats: PlayerGameStat[], type: StatType): number {
  if (stats.length === 0) return 0;
  return average(stats.map(s => getStatValue(s, type)));
}

export function analyzeProp(
  stats: PlayerGameStat[],
  statType: StatType,
  line: number
): PropAnalysis | null {
  if (stats.length === 0) return null;
  const sorted = sortStatsByDate(stats);
  const values = sorted.map(s => getStatValue(s, statType));

  const hitRate = values.filter(v => v > line).length / values.length;

  const last5 = values.slice(0, 5);
  const last5HitRate = last5.length > 0 ? last5.filter(v => v > line).length / last5.length : 0;

  const last10 = values.slice(0, 10);
  const last10HitRate = last10.length > 0 ? last10.filter(v => v > line).length / last10.length : 0;

  const avgStat = average(values);
  const avgVsLine = avgStat - line;

  // Confidence: weighted combination of hit rates, recency, sample size
  const sampleWeight = Math.min(1, stats.length / 10);
  const recencyWeight = last5.length >= 3 ? last5HitRate : hitRate;
  const rawConfidence = (hitRate * 0.3 + recencyWeight * 0.4 + (avgVsLine > 0 ? 0.3 : 0)) * sampleWeight;
  const confidenceScore = Math.round(Math.min(100, rawConfidence * 100));

  return {
    hitRate,
    last5HitRate,
    last10HitRate,
    avgVsLine,
    confidenceScore,
    recommendation: 'MARGINAL',
    gamesAnalyzed: stats.length,
    averageStat: avgStat,
    maxStat: Math.max(...values),
    minStat: Math.min(...values),
  };
}

export function detectTrend(
  player: Player,
  stats: PlayerGameStat[],
  statType: StatType
): TrendPlayer | null {
  if (stats.length < 4) return null;
  const sorted = sortStatsByDate(stats);
  const recent3 = sorted.slice(0, 3);
  const recent10 = sorted.slice(0, 10);

  const recent3Avg = calcAvgForStats(recent3, statType);
  const recent10Avg = calcAvgForStats(recent10, statType);
  const delta = recent3Avg - recent10Avg;
  const deltaPercent = recent10Avg > 0 ? (delta / recent10Avg) * 100 : 0;

  let trend: TrendPlayer['trend'];
  let trendScore: number;

  if (deltaPercent >= 25) {
    trend = 'breakout';
    trendScore = Math.min(100, Math.round(deltaPercent));
  } else if (deltaPercent >= 10) {
    trend = 'improving';
    trendScore = Math.round(deltaPercent);
  } else if (deltaPercent <= -15) {
    trend = 'declining';
    trendScore = Math.round(Math.abs(deltaPercent));
  } else {
    trend = 'stable';
    trendScore = Math.round(Math.abs(deltaPercent));
  }

  return {
    player,
    stats: sorted,
    trend,
    trendScore,
    recent3Avg,
    recent10Avg,
    delta,
    statType,
  };
}

export function getTopPerformers(
  playersWithStats: { player: Player; stats: PlayerGameStat[] }[],
  statType: StatType,
  n: number = 5
): { player: Player; stats: PlayerGameStat[]; avg: number }[] {
  return playersWithStats
    .filter(p => p.stats.length >= 3)
    .map(p => ({
      ...p,
      avg: calcAvgForStats(getLastN(p.stats, 5), statType),
    }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, n);
}

export function getMostConsistent(
  playersWithStats: { player: Player; stats: PlayerGameStat[] }[],
  statType: StatType,
  n: number = 5
): { player: Player; stats: PlayerGameStat[]; consistency: number; avg: number }[] {
  return playersWithStats
    .filter(p => p.stats.length >= 5)
    .map(p => {
      const vals = p.stats.map(s => getStatValue(s, statType));
      return {
        ...p,
        consistency: consistencyRating(vals),
        avg: average(vals),
      };
    })
    .sort((a, b) => b.consistency - a.consistency)
    .slice(0, n);
}
