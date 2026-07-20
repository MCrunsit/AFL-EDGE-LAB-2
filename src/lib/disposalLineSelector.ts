import type { ModelledOddsRow } from './modelResolver';

export interface DisposalLineRecommendation {
  playerId: string;
  playerName: string;
  matchId: string;
  row: ModelledOddsRow;
  safeLine: ModelledOddsRow | null;
  balancedLine: ModelledOddsRow | null;
  valueLine: ModelledOddsRow | null;
  seasonHitRate: number;
  last10HitRate: number;
  last5HitRate: number;
  last10Hits: number;
  last5Hits: number;
  safetyScore: number;
  rejectionReasons: string[];
}

export interface SafeLineCriteria {
  minSample: number;
  minHits: number;
  minHitRate: number;
  minLast10HitRate: number;
  minLast5Hits: number;
  minAdjustedProb: number;
  maxOdds: number;
  minOdds: number;
  preferHitRate: number;
  preferLast10HitRate: number;
  preferLast5Hits: number;
  preferAdjustedProb: number;
  preferMaxLegOdds: number;
  preferMinLegOdds: number;
}

export const DEFAULT_SAFE_LINE_CRITERIA: SafeLineCriteria = {
  minSample: 15,
  minHits: 10,
  minHitRate: 0.75,
  minLast10HitRate: 0.70,
  minLast5Hits: 4,
  minAdjustedProb: 0.72,
  maxOdds: 1.40,
  minOdds: 1.07,
  preferHitRate: 0.80,
  preferLast10HitRate: 0.80,
  preferLast5Hits: 4,
  preferAdjustedProb: 0.78,
  preferMaxLegOdds: 1.25,
  preferMinLegOdds: 1.05,
};

export const CONSERVATIVE_LINE_CRITERIA: SafeLineCriteria = {
  minSample: 15,
  minHits: 10,
  minHitRate: 0.80,
  minLast10HitRate: 0.80,
  minLast5Hits: 4,
  minAdjustedProb: 0.78,
  maxOdds: 1.25,
  minOdds: 1.05,
  preferHitRate: 0.85,
  preferLast10HitRate: 0.85,
  preferLast5Hits: 5,
  preferAdjustedProb: 0.82,
  preferMaxLegOdds: 1.20,
  preferMinLegOdds: 1.05,
};

export type LineSafetyMode = 'conservative' | 'safe' | 'balanced';

export function getCriteriaForMode(mode: LineSafetyMode): SafeLineCriteria {
  if (mode === 'conservative') return CONSERVATIVE_LINE_CRITERIA;
  if (mode === 'balanced') {
    return {
      ...DEFAULT_SAFE_LINE_CRITERIA,
      minHitRate: 0.65,
      minLast10HitRate: 0.60,
      minLast5Hits: 3,
      minAdjustedProb: 0.62,
      maxOdds: 1.70,
    };
  }
  return DEFAULT_SAFE_LINE_CRITERIA;
}

function isDisposalRow(row: ModelledOddsRow): boolean {
  return row.statType === 'disposals' || row.resolvedStatType === 'disposals';
}

/**
 * Calculate last-N hits from the sample comparison data.
 * Ensures last5Hits <= 5 and last10Hits <= 10.
 * Historical values must be ordered newest to oldest.
 */
function getLast10Hits(row: ModelledOddsRow): number {
  const sc = row.modelProb.sampleComparison;
  if (sc?.last10 && typeof sc.last10.hit_count === 'number') {
    return Math.min(Math.max(0, sc.last10.hit_count), 10);
  }
  const hitRate = row.modelProb.hit_rate;
  return Math.min(Math.round(hitRate * Math.min(10, row.modelProb.sample_size)), 10);
}

function getLast10HitRate(row: ModelledOddsRow): number {
  const sc = row.modelProb.sampleComparison;
  if (sc?.last10 && typeof sc.last10.hit_rate === 'number') {
    return sc.last10.hit_rate;
  }
  return row.modelProb.hit_rate;
}

function getLast5Hits(row: ModelledOddsRow): number {
  const sc = row.modelProb.sampleComparison;
  if (sc?.last5 && typeof sc.last5.hit_count === 'number') {
    return Math.min(Math.max(0, sc.last5.hit_count), 5);
  }
  const last10 = getLast10Hits(row);
  return Math.min(Math.round(last10 * 0.5), 5);
}

function getLast5HitRate(row: ModelledOddsRow): number {
  return getLast5Hits(row) / 5;
}

function isExtremeLine(row: ModelledOddsRow): boolean {
  if (!row.modelProb.tags) return false;
  return row.modelProb.tags.some(t => t.toLowerCase().includes('extreme'));
}

function hasStrongSuppression(row: ModelledOddsRow): boolean {
  if (!row.positionEdge) return false;
  return row.positionEdge.edge_value < 0 && row.positionEdge.significance === 'very_significant';
}

function checkSafetyCriteria(row: ModelledOddsRow, criteria: SafeLineCriteria): { pass: boolean; reason: string } {
  if (row.modelStatus !== 'MODEL_READY') return { pass: false, reason: 'Not model ready' };
  if (row.modelProb.sample_size < criteria.minSample) return { pass: false, reason: `Sample ${row.modelProb.sample_size} < ${criteria.minSample}` };
  if (row.modelProb.hit_count < criteria.minHits) return { pass: false, reason: `Hits ${row.modelProb.hit_count} < ${criteria.minHits}` };
  if (row.modelProb.hit_rate < criteria.minHitRate) return { pass: false, reason: `Hit rate ${(row.modelProb.hit_rate * 100).toFixed(0)}% < ${(criteria.minHitRate * 100).toFixed(0)}%` };
  const last10 = getLast10HitRate(row);
  if (last10 < criteria.minLast10HitRate) return { pass: false, reason: `Last 10 ${(last10 * 100).toFixed(0)}% < ${(criteria.minLast10HitRate * 100).toFixed(0)}%` };
  const last5 = getLast5Hits(row);
  if (last5 < criteria.minLast5Hits) return { pass: false, reason: `Last 5 hits ${last5} < ${criteria.minLast5Hits}` };
  if (row.modelProb.adjustedProb === null || row.modelProb.adjustedProb < criteria.minAdjustedProb) return { pass: false, reason: 'Adjusted prob too low' };
  if (row.over_odds > criteria.maxOdds) return { pass: false, reason: `Odds ${row.over_odds.toFixed(2)} > ${criteria.maxOdds}` };
  if (row.over_odds < criteria.minOdds) return { pass: false, reason: `Odds ${row.over_odds.toFixed(2)} < ${criteria.minOdds}` };
  if (isExtremeLine(row)) return { pass: false, reason: 'Extreme line' };
  if (row.modelProb.risk_level === 'High') return { pass: false, reason: 'High risk' };
  if (hasStrongSuppression(row)) return { pass: false, reason: 'Strong position edge suppression' };
  return { pass: true, reason: '' };
}

function scorePreferredMatch(row: ModelledOddsRow, criteria: SafeLineCriteria): number {
  let score = 0;
  const hitRate = row.modelProb.hit_rate;
  const last10 = getLast10HitRate(row);
  const adjProb = row.modelProb.adjustedProb ?? 0;
  const last5 = getLast5Hits(row);

  if (hitRate >= criteria.preferHitRate) score += 25;
  else score += (hitRate / criteria.preferHitRate) * 25;

  if (last10 >= criteria.preferLast10HitRate) score += 25;
  else score += (last10 / criteria.preferLast10HitRate) * 25;

  if (adjProb >= criteria.preferAdjustedProb) score += 20;
  else score += (adjProb / criteria.preferAdjustedProb) * 20;

  if (last5 >= criteria.preferLast5Hits) score += 15;
  else score += (last5 / criteria.preferLast5Hits) * 15;

  if (row.over_odds >= criteria.preferMinLegOdds && row.over_odds <= criteria.preferMaxLegOdds) {
    score += 15;
  } else if (row.over_odds <= criteria.preferMaxLegOdds * 1.15) {
    score += 8;
  }

  return score;
}

/**
 * Select the highest disposal threshold that still meets strong reliability standards.
 * Does NOT simply pick the line with the highest EV.
 */
function selectSafeLine(rows: ModelledOddsRow[], criteria: SafeLineCriteria): ModelledOddsRow | null {
  const passing = rows.filter(r => checkSafetyCriteria(r, criteria).pass);
  if (passing.length === 0) return null;

  // Sort by line descending (highest threshold first)
  passing.sort((a, b) => b.line - a.line);

  // Walk from highest line down, find the first that also meets preferred criteria
  for (const row of passing) {
    const hitRate = row.modelProb.hit_rate;
    const last10 = getLast10HitRate(row);
    const adjProb = row.modelProb.adjustedProb ?? 0;
    const last5 = getLast5Hits(row);

    if (hitRate >= criteria.preferHitRate &&
        last10 >= criteria.preferLast10HitRate &&
        adjProb >= criteria.preferAdjustedProb &&
        last5 >= criteria.preferLast5Hits &&
        row.over_odds >= criteria.preferMinLegOdds &&
        row.over_odds <= criteria.preferMaxLegOdds) {
      return row;
    }
  }

  // No row meets all preferred criteria — pick the highest-line row that passes minimum criteria
  passing.sort((a, b) => scorePreferredMatch(b, criteria) - scorePreferredMatch(a, criteria));
  return passing[0] ?? null;
}

function selectBalancedLine(rows: ModelledOddsRow[], safeLine: ModelledOddsRow | null): ModelledOddsRow | null {
  const eligible = rows.filter(r => {
    if (r.modelStatus !== 'MODEL_READY') return false;
    if (r.modelProb.sample_size < 12) return false;
    if (r.modelProb.hit_count < 8) return false;
    if (r.modelProb.hit_rate < 0.58) return false;
    const last10 = getLast10HitRate(r);
    if (last10 < 0.50) return false;
    if (r.over_odds > 2.50) return false;
    if (r.modelProb.risk_level === 'High') return false;
    return true;
  });
  if (eligible.length === 0) return null;

  const safeLineValue = safeLine?.line ?? 0;
  const higher = eligible.filter(r => r.line > safeLineValue);
  if (higher.length > 0) {
    higher.sort((a, b) => b.line - a.line);
    for (const row of higher) {
      if (row.modelProb.hit_rate >= 0.55 && getLast10HitRate(row) >= 0.50) return row;
    }
    return higher[0];
  }
  return eligible[0];
}

function selectValueLine(rows: ModelledOddsRow[]): ModelledOddsRow | null {
  const eligible = rows.filter(r => {
    if (r.modelStatus !== 'MODEL_READY') return false;
    if (r.modelProb.sample_size < 10) return false;
    if (r.adjustedEV === null) return false;
    return true;
  });
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => (b.adjustedEV ?? 0) - (a.adjustedEV ?? 0));
  return eligible[0];
}

export function buildDisposalLineRecommendations(
  modelledRows: ModelledOddsRow[],
  criteria: SafeLineCriteria = DEFAULT_SAFE_LINE_CRITERIA
): DisposalLineRecommendation[] {
  const disposalRows = modelledRows.filter(isDisposalRow);
  if (disposalRows.length === 0) return [];

  const playerGroups = new Map<string, ModelledOddsRow[]>();
  for (const row of disposalRows) {
    const key = row.resolvedPlayerId ?? row.player_id ?? row.player_name;
    if (!playerGroups.has(key)) playerGroups.set(key, []);
    playerGroups.get(key)!.push(row);
  }

  const recommendations: DisposalLineRecommendation[] = [];

  for (const [playerKey, rows] of playerGroups) {
    const firstRow = rows[0];
    const playerId = firstRow.resolvedPlayerId ?? firstRow.player_id ?? playerKey;
    const playerName = firstRow.player_name;
    const matchId = firstRow.match_id;

    rows.sort((a, b) => a.line - b.line);

    const safeLine = selectSafeLine(rows, criteria);
    const balancedLine = selectBalancedLine(rows, safeLine);
    const valueLine = selectValueLine(rows);

    const rejectionReasons: string[] = [];
    if (!safeLine) {
      for (const row of rows) {
        const check = checkSafetyCriteria(row, criteria);
        if (!check.pass && !rejectionReasons.includes(check.reason)) {
          rejectionReasons.push(check.reason);
        }
      }
    }

    const sourceRow = safeLine ?? rows[0];
    const seasonHitRate = sourceRow.modelProb.hit_rate;
    const last10HitRate = getLast10HitRate(sourceRow);
    const last5HitRate = getLast5HitRate(sourceRow);
    const last10Hits = getLast10Hits(sourceRow);
    const last5Hits = getLast5Hits(sourceRow);

    let safetyScore = 0;
    if (safeLine) {
      safetyScore = scorePreferredMatch(safeLine, criteria);
    }

    recommendations.push({
      playerId,
      playerName,
      matchId,
      row: sourceRow,
      safeLine,
      balancedLine,
      valueLine,
      seasonHitRate,
      last10HitRate,
      last5HitRate,
      last10Hits,
      last5Hits,
      safetyScore,
      rejectionReasons,
    });
  }

  recommendations.sort((a, b) => {
    if (a.safeLine && !b.safeLine) return -1;
    if (!a.safeLine && b.safeLine) return 1;
    return b.safetyScore - a.safetyScore;
  });

  const validRecommendations = recommendations.filter(
    (
      recommendation
    ): recommendation is DisposalLineRecommendation =>
      Boolean(
        recommendation &&
        recommendation.row &&
        recommendation.playerName
      )
  );

  const rejectedCount =
    recommendations.length -
    validRecommendations.length;

  if (rejectedCount > 0) {
    console.warn('[DISPOSAL_SELECTOR_INVALID_RESULTS]', {
      rejectedCount,
    });
  }

  return validRecommendations;
}

export function getSelectionReason(row: ModelledOddsRow): string {
  const hits = row.modelProb.hit_count;
  const sample = row.modelProb.sample_size;
  const last10Hits = getLast10Hits(row);
  const last5Hits = getLast5Hits(row);
  const adjProb = row.modelProb.adjustedProb !== null
    ? (row.modelProb.adjustedProb * 100).toFixed(0)
    : '—';
  const suppression = hasStrongSuppression(row) ? ', strong suppression' : '';

  return `Selected as highest safe line: ${hits}/${sample} season hits, ${last10Hits}/10 last 10, ${last5Hits}/5 last five, ${adjProb}% adjusted probability${suppression}.`;
}

export { getLast10Hits, getLast5Hits, getLast10HitRate, getLast5HitRate };
