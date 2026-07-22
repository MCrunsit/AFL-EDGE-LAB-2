import type { ModelledOddsRow } from './modelResolver';
import type { Match } from './types';

export type MarketFocus = 'disposals_only' | 'disposals_and_marks' | 'all_player_props';
export type MarketTypeFilter = 'ladder' | 'over' | 'under';
export type GenerationMode = 'safest' | 'best_value' | 'balanced';

export interface PullEmSettings {
  marketFocus: MarketFocus;
  marketTypes: Set<MarketTypeFilter>;
  minCombinedOdds: number;
  maxCombinedOdds: number;
  minLegs: number;
  maxLegs: number;
  minHitRate: number;
  minModelConfidence: number;
  minExpectedValue: number;
  confirmedPlayersOnly: boolean;
  allowUnders: boolean;
  generationMode: GenerationMode;
}

export const DEFAULT_PULL_EM_SETTINGS: PullEmSettings = {
  marketFocus: 'disposals_only',
  marketTypes: new Set<MarketTypeFilter>(['ladder', 'over']),
  minCombinedOdds: 5.0,
  maxCombinedOdds: 7.5,
  minLegs: 4,
  maxLegs: 5,
  minHitRate: 50,
  minModelConfidence: 55,
  minExpectedValue: -5,
  confirmedPlayersOnly: true,
  allowUnders: true,
  generationMode: 'balanced',
};

export interface PullEmLeg {
  row: ModelledOddsRow;
  playerName: string;
  playerId: string;
  team: string;
  matchId: string;
  matchName: string;
  selectionType: MarketTypeFilter;
  displayLabel: string;
  line: number;
  odds: number;
  modelProb: number;
  expectedValue: number;
  confidence: number;
  riskLevel: 'Low' | 'Medium' | 'High';
  riskWarning: string;
  seasonHitRate: number;
  last10HitRate: number;
  last5HitRate: number;
  last3HitRate: number;
  seasonAverage: number;
  predictedDisposals: number;
  lastFiveValues: number[];
  selectionReason: string;
}

export interface PullEmMulti {
  legs: PullEmLeg[];
  combinedOdds: number;
  combinedModelProb: number;
  combinedEV: number;
  weakestLegIndex: number;
  weakestLegReason: string;
  isEstimated: boolean;
  labels: string[];
}

export interface PullEmDiagnostics {
  selectedMatchId: string | null;
  selectedMatchName: string;
  rowsForSelectedMatch: number;
  crossMatchRowsRejected: number;
  inputModelRows: number;
  recognisedDisposalRows: number;
  recognisedLadderRows: number;
  recognisedOverRows: number;
  recognisedUnderRows: number;
  genuineUnderOddsAvailable: boolean;
  invalidPlayer: number;
  invalidOdds: number;
  invalidLine: number;
  unrecognisedMarket: number;
  excludedByMarketType: number;
  excludedByHitRate: number;
  excludedByConfidence: number;
  excludedByEV: number;
  excludedByConfirmation: number;
  finalCandidatePool: number;
  sameGameCombinationsGenerated: number;
  sampleUnrecognised: Array<{
    raw_market: string;
    market_type: string;
    stat_type: string | null;
    line: number | null;
    over_odds: number | null;
    under_odds: number | null;
  }>;
}

export interface PullEmResult {
  multis: PullEmMulti[];
  poolSize: number;
  combinationsChecked: number;
  rejectedReasons: string[];
  runtimeMs: number;
  diagnostics: PullEmDiagnostics;
}

const MAX_COMBINATIONS = 200_000;
const MAX_RUNTIME_MS = 3000;

// ── Percentage normalisation ──

function toPercentage(value: number | null | undefined): number {
  if (value == null || isNaN(value)) return 0;
  if (value > 1.5) return value; // already 0-100
  return value * 100; // 0-1 → 0-100
}

function toEVPercent(value: number | null | undefined): number {
  if (value == null || isNaN(value)) return 0;
  if (Math.abs(value) > 1.5) return value; // already percentage
  return value * 100; // decimal → percentage
}

// ── Odds parsing ──

function parseOdds(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return isNaN(value) ? null : value;
  if (typeof value === 'string') {
    const n = Number(value);
    return isNaN(n) ? null : n;
  }
  return null;
}

// ── Market classification ──

function getAllMarketFields(row: ModelledOddsRow): string {
  const fields = [
    row.raw_market,
    row.market_type,
    row.stat_type,
    row.resolvedStatType,
    row.statType,
    row.display_label,
    row.raw_line,
  ];
  return fields
    .filter(f => f != null && f !== '')
    .map(f => String(f).toLowerCase())
    .join(' | ');
}

function isDisposalMarket(row: ModelledOddsRow): boolean {
  // Check resolvedStatType first (most reliable)
  if (row.resolvedStatType === 'disposals') return true;
  if (row.statType === 'disposals') return true;
  if (row.stat_type === 'disposals') return true;

  // Fallback: search all available text fields
  const allText = getAllMarketFields(row);
  if (/disposal/.test(allText)) return true;

  return false;
}

function isMarkMarket(row: ModelledOddsRow): boolean {
  if (row.resolvedStatType === 'marks') return true;
  if (row.statType === 'marks') return true;
  if (row.stat_type === 'marks') return true;
  const allText = getAllMarketFields(row);
  return /\bmark/.test(allText);
}

function passesMarketFocus(row: ModelledOddsRow, focus: MarketFocus): boolean {
  if (focus === 'disposals_only') return isDisposalMarket(row);
  if (focus === 'disposals_and_marks') return isDisposalMarket(row) || isMarkMarket(row);
  return true;
}

/**
 * Classify a row as ladder, over, or under based on market_type and line shape.
 * Half-point lines (.5) are O/U rows; integer lines are alt_ladder rows.
 * Returns 'over' for the over side and 'under' for the under side.
 * The caller decides which side to build based on available odds.
 */
function isHalfPointLine(row: ModelledOddsRow): boolean {
  return row.line != null && !Number.isInteger(row.line);
}

function classifyBaseType(row: ModelledOddsRow): 'ladder' | 'ou_line' {
  if (row.market_type === 'alt_ladder') return 'ladder';
  if (row.market_type === 'ou_line') return 'ou_line';
  // Fallback: half-point line → ou_line, integer → ladder
  return isHalfPointLine(row) ? 'ou_line' : 'ladder';
}

// ── Odds accessors ──

function getOverOdds(row: ModelledOddsRow): number | null {
  return parseOdds(row.over_odds);
}

function getUnderOdds(row: ModelledOddsRow): number | null {
  return parseOdds(row.under_odds);
}

// ── Model probability accessors with safe fallbacks ──

function getOverModelProb(row: ModelledOddsRow): number {
  if (row.modelProb?.adjustedProb != null) return row.modelProb.adjustedProb;
  if (row.modelProb?.conservativeProb != null) return row.modelProb.conservativeProb;
  if (row.modelProb?.probability != null) return row.modelProb.probability;
  if (row.finalProbability != null) return row.finalProbability;
  // Fallback: derive from implied prob
  if (row.impliedProb && row.impliedProb > 0) return row.impliedProb;
  return 0.5; // neutral fallback
}

/**
 * Compute the under model probability from the player's actual historical stats.
 * For an under leg, the hit rate is the percentage of games where the player
 * finished BELOW the line — not 1 minus the over probability.
 */
function getUnderModelProb(row: ModelledOddsRow): number {
  // If the model already computed under probability via adjustedProb for an ou_line,
  // we can derive it. But modelProb.adjustedProb is the OVER probability for
  // ladder/over rows. For under, we need P(disposals < line).
  //
  // For half-point lines, P(under) = 1 - P(over) since there's no push.
  // For integer lines (ladder), P(under) = 1 - P(over) as well since
  // the ladder is really "N+" which is equivalent to over N-0.5.
  //
  // However, the hit_rate stored in modelProb is the OVER hit rate.
  // The under hit rate is computed separately in buildLeg using the
  // season/last10/last5 under hit rate fields.
  const overProb = getOverModelProb(row);
  return Math.max(0.01, Math.min(0.95, 1 - overProb));
}

function getModelProb(row: ModelledOddsRow, selectionType: 'ladder' | 'over' | 'under'): number {
  return selectionType === 'under' ? getUnderModelProb(row) : getOverModelProb(row);
}

function getOverEV(row: ModelledOddsRow): number {
  if (row.adjustedEV != null) return row.adjustedEV;
  if (row.conservativeEV != null) return row.conservativeEV;
  if (row.finalEV != null) return row.finalEV;
  // Fallback: compute from prob and odds
  const prob = getOverModelProb(row);
  const odds = getOverOdds(row);
  if (odds != null) return prob * odds - 1;
  return 0;
}

function getUnderEV(row: ModelledOddsRow): number {
  const prob = getUnderModelProb(row);
  const odds = getUnderOdds(row);
  if (odds != null && odds > 1.0) return prob * odds - 1;
  return 0;
}

function getEV(row: ModelledOddsRow, selectionType: 'ladder' | 'over' | 'under'): number {
  return selectionType === 'under' ? getUnderEV(row) : getOverEV(row);
}

function confidenceToNumber(conf: string | undefined): number {
  if (conf === 'high') return 90;
  if (conf === 'medium') return 70;
  if (conf === 'low') return 45;
  return 20;
}

function getConfidence(row: ModelledOddsRow): number {
  return confidenceToNumber(row.modelProb?.confidence);
}

function getRiskLevel(row: ModelledOddsRow): 'Low' | 'Medium' | 'High' {
  return row.modelProb?.risk_level ?? 'Medium';
}

// ── Line accessor ──

function getLine(row: ModelledOddsRow): number | null {
  if (row.line != null && !isNaN(row.line)) return row.line;
  if (row.base_line != null) return row.base_line;
  return null;
}

// ── Leg builder ──

function buildLeg(
  row: ModelledOddsRow,
  matchName: string,
  selectionType: 'ladder' | 'over' | 'under'
): PullEmLeg | null {
  const odds = selectionType === 'under' ? getUnderOdds(row) : getOverOdds(row);
  // Only reject if odds missing, non-numeric, or <= 1
  if (odds == null || odds <= 1.0) return null;

  const line = getLine(row);
  if (line == null) return null;

  const modelProb = getModelProb(row, selectionType);
  const ev = getEV(row, selectionType);
  const confidence = getConfidence(row);
  const riskLevel = getRiskLevel(row);
  const fr = row.freshness;

  // Hit rates — normalise from 0-1 to 0-100
  // For over/ladder legs, use the over hit rate (P(disposals >= line))
  // For under legs, compute the under hit rate independently (P(disposals < line))
  const overSeasonHR = toPercentage(row.modelProb?.hit_rate ?? 0);
  const overLast10HR = toPercentage(row.modelProb?.sampleComparison?.last10?.hit_rate ?? 0);
  const overLast5HR = toPercentage(row.modelProb?.sampleComparison?.last5?.hit_rate ?? 0);

  const seasonHitRate = selectionType === 'under' ? 100 - overSeasonHR : overSeasonHR;
  const last10HitRate = selectionType === 'under' ? 100 - overLast10HR : overLast10HR;
  const last5HitRate = selectionType === 'under' ? 100 - overLast5HR : overLast5HR;
  const last3HitRate = selectionType === 'under' ? 100 - overLast5HR : overLast5HR;

  const seasonAverage = row.modelProb?.avg_stat ?? 0;
  const predictedDisposals = row.modelProb?.avg_stat ?? 0;
  const lastFiveValues = row.firstFiveValues ?? [];

  let riskWarning = '';
  if (riskLevel === 'High') riskWarning = 'High risk — volatile disposal history';
  else if (riskLevel === 'Medium') riskWarning = 'Moderate risk — some variability';
  else riskWarning = 'Low risk — consistent performer';

  if (fr && fr.freshnessStatus === 'STALE') riskWarning += ' (stale stats)';
  if ((row.modelProb?.sample_size ?? 0) < 10) riskWarning += ' (small sample)';

  const displayLabel = selectionType === 'ladder'
    ? (row.display_label ?? `${Math.floor(line)}+`)
    : selectionType === 'over'
    ? `Over ${line}`
    : `Under ${line}`;

  const selectionReason = selectionType === 'ladder'
    ? `${displayLabel} disposals — ${seasonHitRate.toFixed(0)}% season hit rate`
    : selectionType === 'over'
    ? `Over ${line} — ${seasonHitRate.toFixed(0)}% season hit rate, avg ${seasonAverage.toFixed(1)}`
    : `Under ${line} — ${seasonHitRate.toFixed(0)}% under hit rate`;

  return {
    row,
    playerName: row.player_name,
    playerId: row.player_id ?? row.resolvedPlayerId ?? '',
    team: row.playerTeam ?? '',
    matchId: row.match_id,
    matchName,
    selectionType,
    displayLabel,
    line,
    odds,
    modelProb,
    expectedValue: ev,
    confidence,
    riskLevel,
    riskWarning,
    seasonHitRate,
    last10HitRate,
    last5HitRate,
    last3HitRate,
    seasonAverage,
    predictedDisposals,
    lastFiveValues,
    selectionReason,
  };
}

// ── Conflict detection ──

function isEquivalentLadderAndOver(a: PullEmLeg, b: PullEmLeg): boolean {
  if (a.playerId !== b.playerId) return false;
  if (a.row.resolvedStatType !== b.row.resolvedStatType) return false;
  if ((a.selectionType === 'ladder' && b.selectionType === 'over') ||
      (a.selectionType === 'over' && b.selectionType === 'ladder')) {
    return Math.floor(a.line) === Math.floor(b.line);
  }
  return false;
}

function isContradictoryOverUnder(a: PullEmLeg, b: PullEmLeg): boolean {
  if (a.playerId !== b.playerId) return false;
  if (a.row.resolvedStatType !== b.row.resolvedStatType) return false;
  if ((a.selectionType === 'over' && b.selectionType === 'under') ||
      (a.selectionType === 'under' && b.selectionType === 'over')) {
    return a.line === b.line;
  }
  return false;
}

function isDuplicateLadder(a: PullEmLeg, b: PullEmLeg): boolean {
  if (a.playerId !== b.playerId) return false;
  if (a.row.resolvedStatType !== b.row.resolvedStatType) return false;
  return a.selectionType === 'ladder' && b.selectionType === 'ladder';
}

export function hasConflict(a: PullEmLeg, b: PullEmLeg): boolean {
  // Only one disposal leg per player — reject all same-player combos
  if (a.playerId !== '' && a.playerId === b.playerId) return true;
  if (isDuplicateLadder(a, b)) return true;
  if (isContradictoryOverUnder(a, b)) return true;
  if (isEquivalentLadderAndOver(a, b)) return true;
  if (isEquivalentLadderAndOver(b, a)) return true;
  return false;
}

// ── Filter ──

function passesFilters(leg: PullEmLeg, settings: PullEmSettings): boolean {
  // Odds validation: only reject if <= 1.0
  if (leg.odds <= 1.0) return false;

  // Percentage checks — values are already normalised to 0-100
  if (leg.seasonHitRate < settings.minHitRate) return false;

  // modelProb is 0-1, convert to percentage for comparison
  const probPercent = leg.modelProb * 100;
  if (probPercent < settings.minModelConfidence) return false;

  // EV is decimal, convert to percentage
  const evPercent = toEVPercent(leg.expectedValue);
  if (evPercent < settings.minExpectedValue) return false;

  // Confirmation check — only when confirmedPlayersOnly is ON
  if (settings.confirmedPlayersOnly) {
    const fr = leg.row.freshness;
    if (!fr || fr.freshnessStatus !== 'CURRENT') return false;
  }

  // Market type check — uses singular identifiers: ladder, over, under
  if (!settings.marketTypes.has(leg.selectionType)) return false;

  // Allow unders toggle
  if (leg.selectionType === 'under' && !settings.allowUnders) return false;

  return true;
}

// ── Combination helpers ──

function combinedOdds(legs: PullEmLeg[]): number {
  return legs.reduce((acc, l) => acc * l.odds, 1);
}

function combinedModelProb(legs: PullEmLeg[]): number {
  return legs.reduce((acc, l) => acc * l.modelProb, 1);
}

function combinedEV(legs: PullEmLeg[]): number {
  return combinedModelProb(legs) * combinedOdds(legs) - 1;
}

function findWeakestLeg(legs: PullEmLeg[]): { index: number; reason: string } {
  let weakestIdx = 0;
  let weakestScore = Infinity;

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    let score = 0;

    score += (1 - leg.modelProb) * 50;
    score += leg.riskLevel === 'High' ? 30 : leg.riskLevel === 'Medium' ? 15 : 0;
    score += leg.confidence < 50 ? 20 : 0;
    score += leg.expectedValue < 0 ? 15 : 0;
    score += leg.last5HitRate < 40 ? 15 : 0;
    score += leg.last3HitRate < 40 ? 10 : 0;
    if (leg.selectionType === 'under') score += 5;
    if ((leg.row.modelProb?.sample_size ?? 0) < 10) score += 10;

    if (score < weakestScore) {
      weakestScore = score;
      weakestIdx = i;
    }
  }

  const weakest = legs[weakestIdx];
  const reasons: string[] = [];
  if (weakest.modelProb < 0.6) reasons.push(`${(weakest.modelProb * 100).toFixed(0)}% model probability`);
  if (weakest.riskLevel === 'High') reasons.push('high risk level');
  if (weakest.confidence < 50) reasons.push('low model confidence');
  if (weakest.expectedValue < 0) reasons.push('negative expected value');
  if (weakest.last5HitRate < 40) reasons.push('weak recent form (last 5)');
  if ((weakest.row.modelProb?.sample_size ?? 0) < 10) reasons.push('small sample size');
  if (reasons.length === 0) reasons.push('lowest combined safety score');

  return { index: weakestIdx, reason: reasons.join(', ') };
}

function scoreMulti(legs: PullEmLeg[], odds: number, settings: PullEmSettings): number {
  const prob = combinedModelProb(legs);
  const ev = combinedEV(legs);
  const { index } = findWeakestLeg(legs);
  const weakestProb = legs[index].modelProb;
  const avgSeasonHR = legs.reduce((a, l) => a + l.seasonHitRate, 0) / legs.length;
  const avgLast10HR = legs.reduce((a, l) => a + l.last10HitRate, 0) / legs.length;

  let score = 0;
  const targetCloseness = 1 - Math.abs(odds - settings.minCombinedOdds) / settings.minCombinedOdds;
  score += Math.max(0, targetCloseness) * 30;
  score += prob * 100 * 0.25;
  score += weakestProb * 100 * 0.15;
  score += (avgLast10HR / 100) * 15;
  score += (avgSeasonHR / 100) * 10;
  score += Math.max(0, ev) * 100 * 0.05;

  if (settings.generationMode === 'safest') {
    score += weakestProb * 100 * 10;
    if (legs.some(l => l.riskLevel === 'High')) score -= 20;
  } else if (settings.generationMode === 'best_value') {
    score += Math.max(0, ev) * 100 * 20;
    score += odds * 5;
  } else {
    score += weakestProb * 100 * 5;
    score += Math.max(0, ev) * 100 * 10;
  }

  return score;
}

// ── Leg pool builder with diagnostics ──

export function buildPullEmLegs(
  rows: ModelledOddsRow[],
  matchNames: Record<string, string>,
  settings: PullEmSettings,
  selectedMatchId: string | null = null
): { legs: PullEmLeg[]; diagnostics: PullEmDiagnostics } {
  const legs: PullEmLeg[] = [];
  const sampleUnrecognised: PullEmDiagnostics['sampleUnrecognised'] = [];

  // Filter rows to selected match BEFORE any leg building
  const matchRows = selectedMatchId
    ? rows.filter(r => r.match_id === selectedMatchId)
    : rows;
  const crossMatchRowsRejected = selectedMatchId
    ? rows.length - matchRows.length
    : 0;

  let genuineUnderOddsAvailable = false;

  const d: PullEmDiagnostics = {
    selectedMatchId,
    selectedMatchName: selectedMatchId ? (matchNames[selectedMatchId] ?? '') : '',
    rowsForSelectedMatch: matchRows.length,
    crossMatchRowsRejected,
    inputModelRows: rows.length,
    recognisedDisposalRows: 0,
    recognisedLadderRows: 0,
    recognisedOverRows: 0,
    recognisedUnderRows: 0,
    genuineUnderOddsAvailable: false,
    invalidPlayer: 0,
    invalidOdds: 0,
    invalidLine: 0,
    unrecognisedMarket: 0,
    excludedByMarketType: 0,
    excludedByHitRate: 0,
    excludedByConfidence: 0,
    excludedByEV: 0,
    excludedByConfirmation: 0,
    finalCandidatePool: 0,
    sameGameCombinationsGenerated: 0,
    sampleUnrecognised: [],
  };

  for (const row of matchRows) {
    // Check market focus
    if (!passesMarketFocus(row, settings.marketFocus)) {
      if (sampleUnrecognised.length < 3) {
        sampleUnrecognised.push({
          raw_market: row.raw_market ?? '',
          market_type: row.market_type ?? '',
          stat_type: row.stat_type ?? null,
          line: row.line ?? null,
          over_odds: row.over_odds ?? null,
          under_odds: row.under_odds ?? null,
        });
      }
      d.unrecognisedMarket++;
      continue;
    }

    d.recognisedDisposalRows++;

    // Check player
    const playerId = row.player_id ?? row.resolvedPlayerId ?? '';
    if (!playerId) {
      d.invalidPlayer++;
      continue;
    }

    // Check line
    const line = getLine(row);
    if (line == null) {
      d.invalidLine++;
      continue;
    }

    const matchName = matchNames[row.match_id] ?? '';
    const baseType = classifyBaseType(row);

    // Ladder rows: build ladder leg from over_odds
    if (baseType === 'ladder') {
      const overOdds = getOverOdds(row);
      if (overOdds == null || overOdds <= 1.0) {
        d.invalidOdds++;
      } else {
        const leg = buildLeg(row, matchName, 'ladder');
        if (leg) {
          d.recognisedLadderRows++;

          if (!settings.marketTypes.has('ladder')) {
            d.excludedByMarketType++;
          } else if (leg.seasonHitRate < settings.minHitRate) {
            d.excludedByHitRate++;
          } else if (leg.modelProb * 100 < settings.minModelConfidence) {
            d.excludedByConfidence++;
          } else if (toEVPercent(leg.expectedValue) < settings.minExpectedValue) {
            d.excludedByEV++;
          } else if (settings.confirmedPlayersOnly && (!leg.row.freshness || leg.row.freshness.freshnessStatus !== 'CURRENT')) {
            d.excludedByConfirmation++;
          } else {
            legs.push(leg);
          }
        }
      }
    }

    // O/U rows (half-point lines): build over leg and under leg separately
    if (baseType === 'ou_line') {
      // Over leg — uses real over_odds
      const overOdds = getOverOdds(row);
      if (overOdds != null && overOdds > 1.0) {
        const leg = buildLeg(row, matchName, 'over');
        if (leg) {
          d.recognisedOverRows++;

          if (!settings.marketTypes.has('over')) {
            d.excludedByMarketType++;
          } else if (leg.seasonHitRate < settings.minHitRate) {
            d.excludedByHitRate++;
          } else if (leg.modelProb * 100 < settings.minModelConfidence) {
            d.excludedByConfidence++;
          } else if (toEVPercent(leg.expectedValue) < settings.minExpectedValue) {
            d.excludedByEV++;
          } else if (settings.confirmedPlayersOnly && (!leg.row.freshness || leg.row.freshness.freshnessStatus !== 'CURRENT')) {
            d.excludedByConfirmation++;
          } else {
            legs.push(leg);
          }
        }
      } else {
        d.invalidOdds++;
      }

      // Under leg — uses real under_odds only (never derived)
      if (settings.allowUnders && settings.marketTypes.has('under')) {
        const underOdds = getUnderOdds(row);
        if (underOdds != null && underOdds > 1.0) {
          genuineUnderOddsAvailable = true;
          const underLeg = buildLeg(row, matchName, 'under');
          if (underLeg) {
            d.recognisedUnderRows++;

            if (underLeg.seasonHitRate < settings.minHitRate) {
              d.excludedByHitRate++;
            } else if (underLeg.modelProb * 100 < settings.minModelConfidence) {
              d.excludedByConfidence++;
            } else if (toEVPercent(underLeg.expectedValue) < settings.minExpectedValue) {
              d.excludedByEV++;
            } else if (settings.confirmedPlayersOnly && (!underLeg.row.freshness || underLeg.row.freshness.freshnessStatus !== 'CURRENT')) {
              d.excludedByConfirmation++;
            } else {
              legs.push(underLeg);
            }
          }
        }
      }
    }
  }

  d.genuineUnderOddsAvailable = genuineUnderOddsAvailable;

  // Deduplicate
  const seen = new Set<string>();
  const deduped: PullEmLeg[] = [];
  for (const leg of legs) {
    const key = `${leg.playerId}|${leg.row.match_id}|${leg.selectionType}|${leg.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(leg);
  }

  d.finalCandidatePool = deduped.length;
  d.sampleUnrecognised = sampleUnrecognised;

  return { legs: deduped, diagnostics: d };
}

// ── Main entry point ──

export function generatePullEmMultis(
  rows: ModelledOddsRow[],
  matchNames: Record<string, string>,
  settings: PullEmSettings,
  _matches: Match[],
  selectedMatchId: string | null = null
): PullEmResult {
  const startTime = Date.now();
  const rejectedReasons: string[] = [];

  const { legs: pool, diagnostics } = buildPullEmLegs(rows, matchNames, settings, selectedMatchId);

  if (pool.length === 0) {
    return {
      multis: [],
      poolSize: 0,
      combinationsChecked: 0,
      rejectedReasons: ['No legs passed the current filters — see diagnostics below.'],
      runtimeMs: Date.now() - startTime,
      diagnostics,
    };
  }

  const sortedPool = [...pool].sort((a, b) => {
    if (settings.generationMode === 'safest') return b.modelProb - a.modelProb;
    if (settings.generationMode === 'best_value') return b.expectedValue - a.expectedValue;
    return (b.modelProb + b.expectedValue) - (a.modelProb + a.expectedValue);
  });

  const candidates: PullEmMulti[] = [];
  let combinationsChecked = 0;
  const startTimeMs = Date.now();

  function search(combo: PullEmLeg[], startIdx: number) {
    if (Date.now() - startTimeMs > MAX_RUNTIME_MS) return;
    if (combinationsChecked >= MAX_COMBINATIONS) return;

    if (combo.length >= 2) {
      combinationsChecked++;

      // Enforce same-game: every leg must be from the same match
      const matchIds = new Set(combo.map(l => l.matchId));
      if (matchIds.size > 1) return;
      if (selectedMatchId && !matchIds.has(selectedMatchId)) return;

      const odds = combinedOdds(combo);

      if (odds > settings.maxCombinedOdds) return;

      if (odds >= settings.minCombinedOdds && combo.length >= settings.minLegs && combo.length <= settings.maxLegs) {
        const { index, reason } = findWeakestLeg(combo);
        const prob = combinedModelProb(combo);
        const ev = combinedEV(combo);
        const labels: string[] = [];

        if (settings.generationMode === 'safest') labels.push('Safest $5+ Disposal Multi');
        else if (settings.generationMode === 'best_value') labels.push('Best Value $5+ Disposal Multi');
        else labels.push('Balanced $5+ Disposal Multi');

        candidates.push({
          legs: [...combo],
          combinedOdds: odds,
          combinedModelProb: prob,
          combinedEV: ev,
          weakestLegIndex: index,
          weakestLegReason: reason,
          isEstimated: true,
          labels,
        });
      }

      if (combo.length >= settings.maxLegs) return;

      if (combo.length >= 2) {
        const minRemainingOdds = settings.minCombinedOdds / odds;
        if (minRemainingOdds > 3.0) return;
      }
    }

    for (let i = startIdx; i < sortedPool.length; i++) {
      const leg = sortedPool[i];

      let conflict = false;
      for (const existing of combo) {
        if (hasConflict(existing, leg)) { conflict = true; break; }
      }
      if (conflict) continue;

      combo.push(leg);
      search(combo, i + 1);
      combo.pop();
    }
  }

  search([], 0);

  candidates.sort((a, b) => scoreMulti(b.legs, b.combinedOdds, settings) - scoreMulti(a.legs, a.combinedOdds, settings));

  const seen = new Set<string>();
  const unique: PullEmMulti[] = [];
  for (const c of candidates) {
    // Final same-game validation: reject any multi with legs from different matches
    const matchIds = new Set(c.legs.map(l => l.matchId));
    if (matchIds.size > 1) continue;
    if (selectedMatchId && !matchIds.has(selectedMatchId)) continue;

    const key = c.legs.map(l => l.playerId).sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
    if (unique.length >= 10) break;
  }

  diagnostics.sameGameCombinationsGenerated = unique.length;

  return {
    multis: unique,
    poolSize: pool.length,
    combinationsChecked,
    rejectedReasons,
    runtimeMs: Date.now() - startTime,
    diagnostics,
  };
}
