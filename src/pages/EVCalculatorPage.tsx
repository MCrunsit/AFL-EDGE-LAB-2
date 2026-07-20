import { useState, useMemo, useEffect, useCallback, Fragment, useRef } from 'react';
import { Calculator, TrendingUp, ChevronDown, Search, BarChart3, Shield, Zap, Bookmark, Info, Target, Eye, Sparkles, ChevronRight, Star, DollarSign, Crosshair, AlertCircle, MapPin, Swords, Award, X, XCircle, Loader2, List, Link as LinkIcon } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { getAltLadderOddsForMatchWithDiagnostics, extractStatType, type NormalizedOddsRow, type OddsFetchDiagnostics } from '../lib/oddsNormalizer';
import { repairNoStatsOddsLinks, fetchPlayerModelCoverage, auditSelectedMatchOddsContamination, auditGlobalOddsContamination, type RepairNoStatsResult, type PlayerModelCoverageEntry, type SelectedMatchAuditResult, type GlobalAuditEntry } from '../lib/oddsRepair';
import { isSweetSpot, suggestStake, optimizeBestLines, filterBestBetTab, sortBestBets, computeSampleComparison, computeSampleWarningTags, confidenceFactorBySampleSize, SAMPLE_WINDOW_OPTIONS, SAMPLE_WINDOW_LABELS, type BestLineCandidate, type BestBetTab, type StakeSuggestion, type SampleWindow, type SampleComparison } from '../lib/betGrading';
import { loadPositionEdgeCache, getPositionEdge, formatPositionEdgeLabel, formatPositionEdgeShortLabel, getPositionEdgeColor, getPositionEdgeAdjustment, capAdjustment, computeFinalProbability, computeFinalEV, getPositionEdgeQualityAdjustment, getPositionEdgeCount, normalizeOpponentName, normalizeTeamName, computeTotalMatchupAdjustment, capVenueAdjustment, formatVenueEdgeLabel, getVenueEdgeColor, capOpponentAdjustment, formatOpponentEdgeLabel, getOpponentEdgeColor, type PositionEdgeCache, type PositionEdgeResult, type VenueEdgeResult, type OpponentEdgeResult, type StatType } from '../lib/positionEdge';
import { normalizeStatType, normalizeVenueKey } from '../lib/matchupEdge';
import { normalizePlayerName, buildPlayerMatchCache, resolvePlayer, searchPlayersWithAliases, type PlayerMatchCache } from '../lib/playerMatching';
import { loadHistoricalStatsForPlayers, getVenueEdgeFromCache, getOpponentEdgeFromCache, getValuesForPlayerStat, getSeasonValuesForPlayerStat, inferCurrentSeason, type HistoricalStatsCache, type HistoricalStatsDiagnostics } from '../lib/historicalStatsService';
import { getPlayerSpotCheck as getPlayerSpotCheckAudit, getLatestCompletedRound, type PlayerSpotCheck as PlayerSpotCheckAudit } from '../lib/dataFreshnessAudit';
import { getDataStatus, getPositionEdgeStaleness, recalculatePositionEdges } from '../lib/playerStatsSync';
import { getCanonicalPlayerGameLog, annotateGameLog, computeWindowCounts, type CanonicalGameRow, type CanonicalStat } from '../lib/canonicalGameLog';
import { expandSearchWithAliases } from '../lib/playerAliases';
import { MarketModeSelector, DisposalLineRecommendations, filterByMarketMode, getStoredMarketMode, storeMarketMode, type MarketMode } from '../components/EVMarketMode';
import type { Match } from '../lib/types';
import LoadingSpinner from '../components/LoadingSpinner';

// Tooltip component
function Tooltip({ text, children }: { text: string; children: React.ReactNode }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative inline-block">
      <div
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        className="cursor-help"
      >
        {children}
      </div>
      {show && (
        <div className="absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-xs text-gray-300 w-64 shadow-xl">
          {text}
        </div>
      )}
    </div>
  );
}

interface ContextStats {
  venue_name: string | null;
  venue_games: number;
  venue_hits: number;
  venue_hit_rate: number;
  venue_average: number;
  venue_max: number;
  opponent_team: string | null;
  opponent_games: number;
  opponent_hits: number;
  opponent_hit_rate: number;
  opponent_average: number;
  opponent_max: number;
  season_hit_rate: number;
}

interface ModelProb {
  probability: number | null;
  conservativeProb: number | null;
  adjustedProb: number | null;
  sample_size: number;
  confidence: 'none' | 'low' | 'medium' | 'high';
  hit_count: number;
  hit_rate: number;
  max_stat: number;
  avg_stat: number;
  venue_adjustment: number;
  opponent_adjustment: number;
  tags: string[];
  context: ContextStats | null;
  quality_score: number;
  risk_level: 'Low' | 'Medium' | 'High';
  sampleWindow: SampleWindow;
  sampleComparison: SampleComparison | null;
  sampleWarningTags: string[];
}

type ModelStatus =
  | 'MODEL_READY'
  | 'ODDS_ONLY'
  | 'PLAYER_UNRESOLVED'
  | 'NO_STATS'
  | 'INSUFFICIENT_MARKET_SAMPLE'
  | 'SAMPLE_AUDIT_FAILED'
  | 'POSITION_LOW_CONFIDENCE'
  | 'STALE_OR_LIMITED_SAMPLE';

type NoStatsReason =
  | 'PLAYER_ID_NULL'
  | 'PLAYER_ID_HAS_ZERO_STATS'
  | 'DUPLICATE_PLAYER_ID_HAS_STATS_ELSEWHERE'
  | 'INSUFFICIENT_MARKET_SAMPLE'
  | 'MARKET_NOT_SUPPORTED'
  | 'ODDS_QUERY_CAPPED'
  | 'UNKNOWN';

type ExclusionReason =
  | 'WRONG_MATCH_ID'
  | 'WRONG_TEAM'
  | 'PLAYER_ID_NULL'
  | 'PLAYER_TEAM_MISSING'
  | 'PLAYER_ID_HAS_ZERO_STATS'
  | 'INSUFFICIENT_MARKET_SAMPLE';

interface EVRow extends NormalizedOddsRow {
  modelProb: ModelProb;
  modelStatus: ModelStatus;
  noStatsReason: NoStatsReason | null;
  conservativeEV: number | null;
  adjustedEV: number | null;
  edge: number | null;
  impliedProb: number;
  isRealistic: boolean;
  isValid: boolean;
  positionGroup: string;
  positionEdge: PositionEdgeResult | null;
  positionEdgeAdjustment: number;
  venueEdge: VenueEdgeResult | null;
  venueEdgeAdjustment: number;
  opponentEdge: OpponentEdgeResult | null;
  opponentEdgeAdjustment: number;
  totalMatchupAdjustment: number;
  finalProbability: number | null;
  finalEV: number | null;
  warnings: string[];
  finalCardGrade: 'A' | 'B' | 'C' | null;
  resolvedPlayerId: string | null;
  playerTeam: string;
  opponent: string | null;
  latestStatRound: string | null;
  isStale: boolean;
  isWrongTeam: boolean;
  playerTeamNorm: string;
  exclusionReason: ExclusionReason | null;
  totalStatsRows: number;
  marketSampleCount: number;
}

// Warnings considered "major" — rows with these are excluded when Final Card mode is on
const MAJOR_WARNINGS = new Set([
  'UNKNOWN position',
  'No historical stats',
  'Missing player_id',
  'Player unresolved',
  'STALE DATA',
  'No current season data',
  'Team mismatch',
  'Wrong team',
  'Duplicate player/stat',
]);

// Compute warnings array for an EV row
function computeWarnings(row: EVRow, useVenueEdge: boolean, useOpponentEdge: boolean, duplicateKeys: Set<string>): string[] {
  const warnings: string[] = [];

  if (row.positionGroup === 'UNKNOWN') warnings.push('UNKNOWN position');
  if (row.positionEdge && row.positionEdge.confidence === 'low') warnings.push('Low-confidence position');
  if (!row.playerTeam) warnings.push('Missing team');
  if (!row.player_id) warnings.push('Missing player_id');
  if (row.modelProb.sample_size === 0) warnings.push('No historical stats');
  if (row.modelProb.sample_size > 0 && row.modelProb.sample_size < 10) warnings.push('Small sample');
  if (row.over_odds > 3.0) warnings.push('Longshot odds');
  if (row.venueEdge && row.venueEdge.sample_size < 3) warnings.push('Venue sample small');
  if (row.opponentEdge && row.opponentEdge.sample_size < 3) warnings.push('Opponent sample small');
  if (row.positionEdge && row.positionEdge.edge_value <= -1.5) warnings.push('Position suppress');
  if (useVenueEdge && !row.venueEdge) warnings.push('No venue data');
  if (useOpponentEdge && !row.opponentEdge) warnings.push('No opponent data');

  const dupKey = `${row.player_name}|${extractStatType(row.raw_market)}`;
  if (duplicateKeys.has(dupKey)) warnings.push('Duplicate player/stat');

  if (!row.resolvedPlayerId) warnings.push('Player unresolved');

  if (row.isStale) warnings.push('STALE DATA');
  if (row.isWrongTeam) warnings.push('Wrong team');

  return warnings;
}

// Compute Final Card grade for a row
function computeFinalCardGrade(row: EVRow, warnings: string[]): 'A' | 'B' | 'C' | null {
  const ev = row.finalEV ?? row.adjustedEV ?? 0;
  if (ev <= 0) return null;

  // Check for contradictions from position/venue/opponent
  const hasContradiction =
    (row.positionEdge && row.positionEdge.edge_value <= -1.5) ||
    (row.venueEdge && row.venueEdge.edge_value < 0) ||
    (row.opponentEdge && row.opponentEdge.edge_value < 0);

  const hasMajorWarning = warnings.some(w => MAJOR_WARNINGS.has(w));
  const warningCount = warnings.length;

  // A-grade: 30+ sample, strong hit rate (>= 0.6), positive EV, mapped position, no warnings, no contradiction
  if (
    row.modelProb.sample_size >= 30 &&
    row.modelProb.hit_rate >= 0.6 &&
    ev > 0 &&
    row.positionGroup !== 'UNKNOWN' &&
    warningCount === 0 &&
    !hasContradiction
  ) {
    return 'A';
  }

  // B-grade: positive EV but one warning
  if (ev > 0 && warningCount === 1 && !hasMajorWarning) {
    return 'B';
  }

  // C-grade: EV exists but too risky for main card
  if (ev > 0) {
    return 'C';
  }

  return null;
}

const STAT_COLUMNS: Record<string, string> = {
  disposals: 'disposals',
  goals: 'goals',
  tackles: 'tackles',
  marks: 'marks',
};

// Calculate quality score (0-100)
function calculateQualityScore(prob: ModelProb, ev: number | null, odds: number): number {
  if (!prob.adjustedProb) return 0;

  // 30% adjusted EV (capped contribution)
  const evScore = Math.min(30, Math.max(0, (ev || 0) * 300)); // 10% EV = 30 points max

  // 25% adjusted probability
  const probScore = (prob.adjustedProb * 25);

  // 20% confidence/sample
  const confScore = prob.sample_size >= 20 ? 20 : prob.sample_size >= 15 ? 16 : prob.sample_size >= 10 ? 12 : prob.sample_size >= 5 ? 8 : 4;

  // 15% hit count strength
  const hitScore = prob.hit_count >= 15 ? 15 : prob.hit_count >= 10 ? 12 : prob.hit_count >= 5 ? 9 : prob.hit_count >= 2 ? 5 : 2;

  // 10% context rating
  const contextScore = prob.tags.includes('Strong Venue') || prob.tags.includes('Strong Opponent') ? 10 :
    prob.tags.includes('Context Boost') ? 8 :
      prob.tags.includes('Weak Venue') || prob.tags.includes('Weak Opponent') ? 3 :
        prob.tags.includes('No Venue Sample') || prob.tags.includes('No Opponent Sample') ? 5 : 7;

  let total = evScore + probScore + confScore + hitScore + contextScore;

  // Penalties
  if (prob.tags.includes('Extreme Line')) total -= 15;
  if (prob.tags.includes('No Historical Hit')) total -= 20;
  if (prob.tags.includes('Weak Venue')) total -= 5;
  if (prob.tags.includes('Weak Opponent')) total -= 5;
  if (odds > 4.0) total -= 5;
  if (prob.hit_count <= 2) total -= 8;

  return Math.max(0, Math.min(100, total));
}

// Calculate risk level
function calculateRiskLevel(prob: ModelProb, odds: number): 'Low' | 'Medium' | 'High' {
  if (!prob.adjustedProb) return 'High';

  if (prob.adjustedProb >= 0.70 && odds <= 1.60 && prob.sample_size >= 20 && prob.hit_count >= 15) {
    return 'Low';
  }

  if (prob.adjustedProb >= 0.45 && odds <= 3.00 && prob.sample_size >= 10 && prob.hit_count >= 5) {
    return 'Medium';
  }

  return 'High';
}

async function getPlayerTeam(playerId: string): Promise<string | null> {
  const { data } = await supabase.from('players').select('team').eq('id', playerId).maybeSingle();
  return data?.team || null;
}

function calculateModelProb(
  values: number[],
  threshold: number,
  context?: ContextStats | null,
  sampleWindow: SampleWindow = 'weighted',
  seasonValues?: number[]
): ModelProb {
  const games = values.length;

  // Compute per-window comparison for all rows
  const sampleComparison: SampleComparison | null = games >= 5
    ? computeSampleComparison(values, threshold, seasonValues)
    : null;
  const sampleWarningTags: string[] = sampleComparison
    ? computeSampleWarningTags(sampleComparison)
    : [];

  if (games < 5) {
    return {
      probability: null, conservativeProb: null, adjustedProb: null,
      sample_size: games, confidence: 'none', hit_count: 0, hit_rate: 0,
      max_stat: games > 0 ? Math.max(...values) : 0, avg_stat: games > 0 ? values.reduce((a, b) => a + b, 0) / games : 0,
      venue_adjustment: 0, opponent_adjustment: 0,
      tags: ['Low Sample'], context: null,
      quality_score: 0, risk_level: 'High',
      sampleWindow, sampleComparison, sampleWarningTags,
    };
  }

  // Determine which values to use based on sample window
  let windowedValues: number[];
  let windowLabel: string;

  switch (sampleWindow) {
    case 'last5':
      windowedValues = values.slice(0, 5);
      windowLabel = 'Last 5';
      break;
    case 'last10':
      windowedValues = values.slice(0, 10);
      windowLabel = 'Last 10';
      break;
    case 'last15':
      windowedValues = values.slice(0, 15);
      windowLabel = 'Last 15';
      break;
    case 'last20':
      windowedValues = values.slice(0, 20);
      windowLabel = 'Last 20';
      break;
    case 'last30':
      windowedValues = values.slice(0, 30);
      windowLabel = 'Last 30';
      break;
    case 'season':
      // Use season-filtered values if provided; otherwise fall back to all values
      windowedValues = seasonValues && seasonValues.length > 0 ? seasonValues : values;
      windowLabel = 'Current Season';
      break;
    case 'custom':
      // Custom date range filtering is done by the caller;
      // here we use all values (caller pre-filters)
      windowedValues = values;
      windowLabel = 'Custom Date Range';
      break;
    case 'weighted':
    default:
      windowedValues = values;
      windowLabel = 'Weighted Model';
      break;
  }

  const windowGames = windowedValues.length;

  if (windowGames < 5 && sampleWindow !== 'weighted') {
    // Specific window has too few games
    return {
      probability: null, conservativeProb: null, adjustedProb: null,
      sample_size: windowGames, confidence: 'none', hit_count: 0, hit_rate: 0,
      max_stat: windowGames > 0 ? Math.max(...windowedValues) : 0,
      avg_stat: windowGames > 0 ? windowedValues.reduce((a, b) => a + b, 0) / windowGames : 0,
      venue_adjustment: 0, opponent_adjustment: 0,
      tags: ['Small Sample'], context: null,
      quality_score: 0, risk_level: 'High',
      sampleWindow, sampleComparison, sampleWarningTags,
    };
  }

  const hitCount = windowedValues.filter(v => v >= threshold).length;
  const windowHR = windowGames > 0 ? hitCount / windowGames : 0;

  let rawProb: number;

  if (sampleWindow === 'weighted') {
    // Weighted model: 0.40 * season + 0.25 * last10 + 0.25 * last5 + 0.10 * last3
    const seasonHR = hitCount / games; // all games = season
    const last10HR = values.slice(0, 10).filter(v => v >= threshold).length / Math.min(10, games);
    const last5HR = values.slice(0, 5).filter(v => v >= threshold).length / Math.min(5, games);
    const last3HR = values.slice(0, 3).filter(v => v >= threshold).length / Math.min(3, games);
    rawProb = seasonHR * 0.40 + last10HR * 0.25 + last5HR * 0.25 + last3HR * 0.10;
  } else {
    // Fixed window: use simple hit rate
    rawProb = windowHR;
  }

  // Confidence factor by sample size
  const { factor: confidenceFactor, confidence } = confidenceFactorBySampleSize(
    sampleWindow === 'weighted' ? games : windowGames
  );

  const conservativeProb = rawProb * confidenceFactor;
  const maxStat = Math.max(...windowedValues);
  const avgStat = windowedValues.reduce((a, b) => a + b, 0) / windowGames;

  let venueAdjustment = 0;
  let opponentAdjustment = 0;
  const tags: string[] = [];

  // Use windowHR as the baseline for context comparison
  const baselineHR = sampleWindow === 'weighted' ? hitCount / games : windowHR;

  if (context) {
    if (context.venue_games >= 3) {
      const venueWeight = context.venue_games >= 8 ? 0.60 : context.venue_games >= 5 ? 0.40 : 0.25;
      const rawVenueAdj = (context.venue_hit_rate - baselineHR) * venueWeight;
      venueAdjustment = Math.max(-0.075, Math.min(0.075, rawVenueAdj));

      if (venueAdjustment >= 0.03) tags.push('Strong Venue');
      else if (venueAdjustment <= -0.03) tags.push('Weak Venue');
    } else {
      tags.push('No Venue Sample');
    }

    if (context.opponent_games >= 3) {
      const oppWeight = context.opponent_games >= 8 ? 0.60 : context.opponent_games >= 5 ? 0.40 : 0.25;
      const rawOppAdj = (context.opponent_hit_rate - baselineHR) * oppWeight;
      opponentAdjustment = Math.max(-0.075, Math.min(0.075, rawOppAdj));

      if (opponentAdjustment >= 0.03) tags.push('Strong Opponent');
      else if (opponentAdjustment <= -0.03) tags.push('Weak Opponent');
    } else {
      tags.push('No Opponent Sample');
    }
  }

  const totalAdj = Math.max(-0.10, Math.min(0.10, venueAdjustment + opponentAdjustment));
  const adjustedProb = Math.max(0.01, Math.min(0.95, conservativeProb + totalAdj));

  if (totalAdj > 0.02) tags.push('Context Boost');
  else if (totalAdj < -0.02) tags.push('Context Downgrade');

  if (threshold > maxStat) tags.push('Extreme Line');
  else if (hitCount === 0) tags.push('No Historical Hit');
  else if (hitCount <= 2) tags.push('Low Hit Count');
  else tags.unshift('Realistic');

  // Add sample warning tags
  for (const tag of sampleWarningTags) {
    if (!tags.includes(tag)) tags.push(tag);
  }

  if (windowGames >= 15) tags.push('High Confidence');
  else if (windowGames < 10) tags.push('Small Sample');

  // Calculate quality score placeholder (will be calculated with EV)
  const quality_score = 0;
  const risk_level: 'Low' | 'Medium' | 'High' = 'Medium';

  return {
    probability: rawProb,
    conservativeProb,
    adjustedProb,
    sample_size: windowGames,
    confidence: windowGames >= 10 ? confidence : 'low',
    hit_count: hitCount,
    hit_rate: windowHR,
    max_stat: maxStat,
    avg_stat: avgStat,
    venue_adjustment: venueAdjustment,
    opponent_adjustment: opponentAdjustment,
    tags,
    context,
    quality_score,
    risk_level,
    sampleWindow,
    sampleComparison,
    sampleWarningTags,
  };
}

// handleViewGameLog defined inside component as a callback — see below

async function trackBet(row: EVRow, match: Match, sampleWindow: SampleWindow = 'weighted', usePositionEdge: boolean = false, useVenueEdge: boolean = false, useOpponentEdge: boolean = false) {
  // Check for duplicates first
  const { data: existing } = await supabase
    .from('tracked_bets')
    .select('id')
    .eq('result', 'pending')
    .eq('player_id', row.player_id)
    .eq('market', extractStatType(row.raw_market))
    .eq('odds_taken', row.over_odds)
    .maybeSingle();

  if (existing) {
    return { error: 'This bet is already tracked' };
  }

  const { data, error } = await supabase
    .from('tracked_bets')
    .insert({
      match_id: match.id,
      match_name: `${match.home_team} vs ${match.away_team}`,
      venue: match.venue,
      player_name: row.player_name,
      player_id: row.player_id,
      market: extractStatType(row.raw_market),
      line: row.line.toString(),
      display_label: row.display_label,
      odds_taken: row.over_odds,
      base_conservative_probability: row.modelProb.conservativeProb,
      venue_adjustment: row.modelProb.venue_adjustment,
      opponent_adjustment: row.modelProb.opponent_adjustment,
      adjusted_probability: row.modelProb.adjustedProb,
      fair_odds: row.modelProb.adjustedProb ? 1 / row.modelProb.adjustedProb : null,
      adjusted_ev: row.adjustedEV,
      confidence: row.modelProb.confidence,
      sample_size: row.modelProb.sample_size,
      hit_count: row.modelProb.hit_count,
      context_tags: row.modelProb.tags,
      selected_sample_window: sampleWindow,
      model_type: SAMPLE_WINDOW_LABELS[sampleWindow],
      position_group: row.positionGroup,
      position_edge_value: row.positionEdge?.edge_value ?? null,
      position_edge_significance: row.positionEdge?.significance ?? null,
      position_edge_adjustment: row.positionEdgeAdjustment,
      venue_edge_value: row.venueEdge?.edge_value ?? null,
      venue_edge_label: row.venueEdge?.label ?? null,
      venue_edge_adjustment: row.venueEdgeAdjustment,
      opponent_edge_value: row.opponentEdge?.edge_value ?? null,
      opponent_edge_label: row.opponentEdge?.label ?? null,
      opponent_edge_adjustment: row.opponentEdgeAdjustment,
      total_matchup_adjustment: row.totalMatchupAdjustment,
      final_probability: row.finalProbability,
      final_ev: row.finalEV,
      use_position_edge: usePositionEdge,
      use_venue_edge: useVenueEdge,
      use_opponent_edge: useOpponentEdge,
    })
    .select()
    .single();

  return { data, error };
}

// Preset filters
const PRESETS = {
  realistic: { minSample: 10, minHits: 2, maxOdds: 10, minEV: 3, minAdjProb: 8 },
  safeEdge: { minSample: 20, minHits: 15, maxOdds: 2.0, minEV: 3, minAdjProb: 60 },
  valueHunter: { minSample: 15, minHits: 5, maxOdds: 4.0, minEV: 8, minAdjProb: 35 },
};

// Final Card strictness presets — used internally when Final Card is ON
const FINAL_CARD_PRESETS = {
  Conservative: { minSample: 30, minHits: 15, maxOdds: 3.0, minEV: 7, minAdjProb: 25, blockStale: true, allowMinorWarnings: false },
  Balanced: { minSample: 20, minHits: 10, maxOdds: 4.0, minEV: 5, minAdjProb: 25, blockStale: true, allowMinorWarnings: false },
  Loose: { minSample: 10, minHits: 5, maxOdds: 6.0, minEV: 3, minAdjProb: 15, blockStale: false, allowMinorWarnings: true },
};

export default function EVCalculatorPage() {
  const [matches, setMatches] = useState<Match[]>([]);
  const [selectedMatchId, setSelectedMatchId] = useState('');
  const [selectedMatch, setSelectedMatch] = useState<Match | null>(null);
  const [odds, setOdds] = useState<NormalizedOddsRow[]>([]);
  const [playerStatsData, setPlayerStatsData] = useState<Map<string, number[]>>(new Map());
  const [searchFilter, setSearchFilter] = useState('');
  const [statFilter, setStatFilter] = useState('all');
  const [marketMode, setMarketMode] = useState<MarketMode>(getStoredMarketMode());
  const [loading, setLoading] = useState(false);
  const [matchesLoading, setMatchesLoading] = useState(true);
  const [trackingBet, setTrackingBet] = useState<string | null>(null);
  const [watchingBet, setWatchingBet] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [bestBetTab, setBestBetTab] = useState<BestBetTab>('bestOverall');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [showModelExplainer, setShowModelExplainer] = useState(false);

  // Filters
  const [realisticOnly, setRealisticOnly] = useState(true);
  const [minSample, setMinSample] = useState(10);
  const [minHits, setMinHits] = useState(2);
  const [maxOdds, setMaxOdds] = useState(10.0);
  const [minEV, setMinEV] = useState(3.0);
  const [minAdjProb, setMinAdjProb] = useState(8);
  const [hideWeakVenue, setHideWeakVenue] = useState(false);
  const [hideWeakOpponent, setHideWeakOpponent] = useState(false);

  // Sample Window
  const [sampleWindow, setSampleWindow] = useState<SampleWindow>('weighted');
  const [customDateStart, setCustomDateStart] = useState('');
  const [customDateEnd, setCustomDateEnd] = useState('');
  const [showSampleComparison, setShowSampleComparison] = useState<string | null>(null);

  // Preset state
  const [currentPreset, setCurrentPreset] = useState<keyof typeof PRESETS>('realistic');

  // Position Edge
  const [positionEdgeCache, setPositionEdgeCache] = useState<PositionEdgeCache>({});
  const [playerPositionMap, setPlayerPositionMap] = useState<Map<string, string>>(new Map());
  const [playerTeamMap, setPlayerTeamMap] = useState<Map<string, string>>(new Map());
  const [playerMatchCache, setPlayerMatchCache] = useState<PlayerMatchCache>({ byId: new Map(), byNormalizedName: new Map() });
  const [resolvedPlayerIds, setResolvedPlayerIds] = useState<Map<string, string>>(new Map()); // bookmaker_name -> player_id
  const [showPositionBoostsOnly, setShowPositionBoostsOnly] = useState(false);
  const [hidePositionSuppressions, setHidePositionSuppressions] = useState(false);
  const [showVerySignificantOnly, setShowVerySignificantOnly] = useState(false);
  const [includeUnknownPosition, setIncludeUnknownPosition] = useState(true);
  const [usePositionEdgeInEV, setUsePositionEdgeInEV] = useState(false);
  // Shared Historical Stats Cache
  const [historicalStatsCache, setHistoricalStatsCache] = useState<HistoricalStatsCache | null>(null);
  const [historicalStatsDiagnostics, setHistoricalStatsDiagnostics] = useState<HistoricalStatsDiagnostics | null>(null);
  const [useVenueEdge, setUseVenueEdge] = useState(false);
  const [useOpponentEdge, setUseOpponentEdge] = useState(false);
  // Final Card mode — strict filters for high-confidence picks
  const [finalCardMode, setFinalCardMode] = useState(false);
  // Final Card strictness level
  const [finalCardStrictness, setFinalCardStrictness] = useState<'Conservative' | 'Balanced' | 'Loose'>('Balanced');
  // Final Card stale-data toggle (overrides preset default)
  const [blockStaleData, setBlockStaleData] = useState(true);
  // Final Card diagnostics
  const [showFinalCardDiagnostics, setShowFinalCardDiagnostics] = useState(false);
  const [showExcludedRows, setShowExcludedRows] = useState(false);
  const [finalCardDiagnostics, setFinalCardDiagnostics] = useState<{
    totalBefore: number;
    removedNoModel: number;
    removedStale: number;
    removedMissingTeam: number;
    removedUnresolved: number;
    removedMinSample: number;
    removedMinHits: number;
    removedMaxOdds: number;
    removedMinEV: number;
    removedMinConsProb: number;
    removedUnknownPos: number;
    removedLowConfPos: number;
    removedNoStats: number;
    removedDuplicate: number;
    removedTinySampleOnly: number;
    removedNoCurrentSeason: number;
    removedPositionSuppress: number;
    finalRows: number;
    topExclusionReason: string;
    topExclusionCount: number;
    isStaleBlocked: boolean;
    topExcluded: { player: string; stat: string | null; line: string; reason: string }[];
    excludedRows: { row: EVRow; reason: string }[];
    watchlist: { row: EVRow; reason: string }[];
  } | null>(null);
  const finalCardDiagRef = useRef<typeof finalCardDiagnostics>(null);
  // Player details drawer
  const [selectedPlayerDetail, setSelectedPlayerDetail] = useState<EVRow | null>(null);
  // Spot-check drawer (Verify Stats)
  const [spotCheckRow, setSpotCheckRow] = useState<EVRow | null>(null);
  const [spotCheckData, setSpotCheckData] = useState<PlayerSpotCheckAudit | null>(null);
  const [spotCheckLoading, setSpotCheckLoading] = useState(false);
  // Game Log modal — canonical rows for a specific player/stat/line
  const [gameLogRow, setGameLogRow] = useState<EVRow | null>(null);
  const [gameLogRows, setGameLogRows] = useState<ReturnType<typeof annotateGameLog>>([]);
  const [gameLogLoading, setGameLogLoading] = useState(false);
  // Latest completed round for stale data detection
  const [latestCompletedRound, setLatestCompletedRound] = useState<string | null>(null);
  // Data status readiness gate
  const [dataStatus, setDataStatus] = useState<{ status: 'READY' | 'WARNING' | 'BROKEN'; latestCompletedRound: string | null; latestStatRound: string | null; isStale: boolean; reasons: string[] } | null>(null);
  // Position Edge staleness
  const [posEdgeStaleness, setPosEdgeStaleness] = useState<{ isStale: boolean; reason: string | null } | null>(null);
  const [posEdgeRecalculating, setPosEdgeRecalculating] = useState(false);
  // Diagnostics counting
  const [venueEdgeStats, setVenueEdgeStats] = useState({ samplesCreated: 0, rowsWithSample3Plus: 0 });
  const [opponentEdgeStats, setOpponentEdgeStats] = useState({ samplesCreated: 0, rowsWithSample3Plus: 0 });
  const [oddsFetchDiag, setOddsFetchDiag] = useState<OddsFetchDiagnostics | null>(null);
  const [repairNoStatsRunning, setRepairNoStatsRunning] = useState(false);
  const [repairNoStatsResult, setRepairNoStatsResult] = useState<{
    oddsRowsChecked: number;
    noStatsRowsFound: number;
    relinked: number;
    stillNoStats: number;
    duplicateConflicts: number;
    errors: number;
  } | null>(null);
  const [showModelCoverage, setShowModelCoverage] = useState(false);
  const [modelCoverageData, setModelCoverageData] = useState<PlayerModelCoverageEntry[]>([]);
  const [modelCoverageLoading, setModelCoverageLoading] = useState(false);
  const [showWrongTeamDebug, setShowWrongTeamDebug] = useState(false);
  const [auditRunning, setAuditRunning] = useState(false);
  const [auditResult, setAuditResult] = useState<{
    totalOddsRows: number;
    uniqueBookmakerPlayers: number;
    nullPlayerIdRows: number;
    wrongTeamRows: number;
    missingTeamRows: number;
    eligibleRows: number;
  } | null>(null);
  const [globalAuditRunning, setGlobalAuditRunning] = useState(false);
  const [globalAuditData, setGlobalAuditData] = useState<Array<{
    matchName: string;
    matchId: string;
    totalOddsRows: number;
    validRows: number;
    wrongTeamRows: number;
    missingTeamRows: number;
    unresolvedRows: number;
  }>>([]);

  // Auto-adjust Min Sample when Sample Window changes
  useEffect(() => {
    const defaults: Record<SampleWindow, number> = {
      weighted: 10, last5: 3, last10: 5, last15: 8, last20: 10, last30: 10, season: 5, custom: 3,
    };
    setMinSample(defaults[sampleWindow]);
  }, [sampleWindow]);

  useEffect(() => {
    const today = new Date().toISOString().split('T')[0];
    supabase
      .from('matches')
      .select('*')
      .gte('match_date', today)
      .order('commence_time_utc', { ascending: true, nullsFirst: false })
      .limit(20)
      .then(({ data }) => {
        setMatches(data ?? []);
        if (data && data.length > 0) {
          setSelectedMatchId(data[0].id);
          setSelectedMatch(data[0]);
        }
        setMatchesLoading(false);
      });

    // Load position edge cache once on mount
    loadPositionEdgeCache().then(setPositionEdgeCache);
    // Load player match cache once on mount
    buildPlayerMatchCache().then(setPlayerMatchCache);
  }, []);

  // Load venue and opponent edge caches when match changes - NOW USES SHARED HISTORICAL STATS
  // Note: historical stats are loaded in loadOddsForMatch. This effect only resets diagnostics
  // when the match changes and recomputes venue/opponent sample counts from the shared cache.
  useEffect(() => {
    if (!selectedMatch) {
      setVenueEdgeStats({ samplesCreated: 0, rowsWithSample3Plus: 0 });
      setOpponentEdgeStats({ samplesCreated: 0, rowsWithSample3Plus: 0 });
      return;
    }

    // Recompute venue/opponent sample counts from the shared cache + player team map
    // This runs after loadOddsForMatch has populated historicalStatsCache and playerTeamMap
    if (!historicalStatsCache) return;

    const allPlayerIds = [...new Set([...resolvedPlayerIds.values()].filter(Boolean))] as string[];
    if (allPlayerIds.length === 0) return;

    let venueSamplesCreated = 0;
    let venueWith3Plus = 0;
    let oppSamplesCreated = 0;
    let oppWith3Plus = 0;

    const statTypes = ['disposals', 'marks', 'tackles', 'goals', 'hitouts'] as const;

    for (const playerId of allPlayerIds) {
      for (const statType of statTypes) {
        // Venue edge
        const venueResult = getVenueEdgeFromCache(historicalStatsCache, playerId, statType, selectedMatch.venue || '');
        if (venueResult.result) {
          venueSamplesCreated++;
          if (venueResult.result.sample_size >= 3) venueWith3Plus++;
        }

        // Opponent edge - player-specific
        const playerTeam = playerTeamMap.get(playerId) || null;
        const oppResult = getOpponentEdgeFromCache(historicalStatsCache, playerId, statType, playerTeam, selectedMatch.home_team || '', selectedMatch.away_team || '');
        if (oppResult.result) {
          oppSamplesCreated++;
          if (oppResult.result.sample_size >= 3) oppWith3Plus++;
        }
      }
    }

    setVenueEdgeStats({ samplesCreated: venueSamplesCreated, rowsWithSample3Plus: venueWith3Plus });
    setOpponentEdgeStats({ samplesCreated: oppSamplesCreated, rowsWithSample3Plus: oppWith3Plus });
  }, [selectedMatch, resolvedPlayerIds, playerTeamMap, historicalStatsCache]);

  useEffect(() => {
    if (selectedMatchId) {
      const m = matches.find(m => m.id === selectedMatchId);
      setSelectedMatch(m || null);
    }
  }, [selectedMatchId, matches]);

  // Fetch latest completed round for stale data detection
  useEffect(() => {
    if (!selectedMatch) {
      setLatestCompletedRound(null);
      return;
    }
    getLatestCompletedRound(selectedMatch.season).then(({ round }) => {
      setLatestCompletedRound(round);
    });
  }, [selectedMatch]);

  // Fetch data status readiness gate
  useEffect(() => {
    const season = selectedMatch?.season ?? new Date().getFullYear();
    getDataStatus(season).then(setDataStatus);
  }, [selectedMatch?.season]);

  // Fetch position edge staleness
  useEffect(() => {
    getPositionEdgeStaleness().then(setPosEdgeStaleness);
  }, []);

  const applyPreset = useCallback((preset: keyof typeof PRESETS) => {
    const p = PRESETS[preset];
    setMinSample(p.minSample);
    setMinHits(p.minHits);
    setMaxOdds(p.maxOdds);
    setMinEV(p.minEV);
    setMinAdjProb(p.minAdjProb);
    setCurrentPreset(preset);
    if (preset === 'safeEdge') {
      setHideWeakVenue(true);
      setHideWeakOpponent(true);
    } else {
      setHideWeakVenue(false);
      setHideWeakOpponent(false);
    }
  }, []);

  const handleViewGameLog = useCallback(async (row: EVRow) => {
    if (!row.resolvedPlayerId) return;
    const stat = normalizeStatType(extractStatType(row.raw_market)) as CanonicalStat | null;
    if (!stat) return;
    setGameLogRow(row);
    setGameLogRows([]);
    setGameLogLoading(true);
    const currentSeason = selectedMatch?.season ?? new Date().getFullYear();
    const result = await getCanonicalPlayerGameLog(row.resolvedPlayerId, stat, currentSeason, 40);
    setGameLogRows(annotateGameLog(result.rows, row.line));
    setGameLogLoading(false);
  }, [selectedMatch]);

  const handleLoadModelCoverage = useCallback(async () => {
    if (!selectedMatchId || odds.length === 0) return;
    setModelCoverageLoading(true);
    try {
      const coverage = await fetchPlayerModelCoverage(selectedMatchId, odds.map(r => ({
        player_id: r.player_id ?? null,
        bookmaker_player_name: r.player_name,
        player_name: r.player_name,
      })));
      setModelCoverageData(coverage);
    } finally {
      setModelCoverageLoading(false);
    }
  }, [selectedMatchId, odds]);

  const handleAuditSelectedMatch = useCallback(async () => {
    if (!selectedMatchId) return;
    setAuditRunning(true);
    try {
      const res = await auditSelectedMatchOddsContamination(selectedMatchId);
      setAuditResult(res);
    } finally {
      setAuditRunning(false);
    }
  }, [selectedMatchId]);

  const handleGlobalAudit = useCallback(async () => {
    setGlobalAuditRunning(true);
    try {
      const res = await auditGlobalOddsContamination();
      setGlobalAuditData(res);
    } finally {
      setGlobalAuditRunning(false);
    }
  }, []);

  const loadOddsForMatch = useCallback(async (matchId: string) => {
    if (!matchId) return;
    setLoading(true);
    setOdds([]);
    setPlayerStatsData(new Map());
    setHistoricalStatsCache(null);

    // Step 1: Fetch ALL bookmaker_odds rows for this match (paginated)
    const { rows, diagnostics: oddsDiag } = await getAltLadderOddsForMatchWithDiagnostics(matchId);
    console.log('[EVCalculator] bookmaker_odds rows fetched:', rows.length, 'pages:', oddsDiag.queryPages, 'capped:', oddsDiag.queryCapped);
    setOdds(rows);
    setOddsFetchDiag(oddsDiag);
    setLoading(false);

    if (rows.length === 0) {
      console.log('[EVCalculator] No odds rows found, aborting load');
      return;
    }

    // Step 2: Resolve ALL player names to player IDs (including name matching)
    const nameToIdMap = new Map<string, string>(); // normalized_name -> player_id
    const allPlayerIds = new Set<string>();

    for (const row of rows) {
      // Try player_id first
      if (row.player_id) {
        allPlayerIds.add(row.player_id);
      }
      // Try name match from cache
      const normalizedName = normalizePlayerName(row.player_name);
      const match = resolvePlayer(row.player_name, row.player_id, playerMatchCache);
      if (match.player_id) {
        allPlayerIds.add(match.player_id);
        nameToIdMap.set(normalizedName, match.player_id);
      }
    }

    // Also add any cached player IDs by normalized name
    for (const [normName, match] of playerMatchCache.byNormalizedName) {
      if (match.player_id) {
        nameToIdMap.set(normName, match.player_id);
      }
    }

    console.log('[EVCalculator] Resolved player IDs:', allPlayerIds.size);
    setResolvedPlayerIds(nameToIdMap);

    // Step 3: Fetch player positions and teams for all resolved IDs
    const playerIdList = [...allPlayerIds];
    const positionMap = new Map<string, string>();
    const teamMap = new Map<string, string>();

    if (playerIdList.length > 0) {
      const { data: playersData } = await supabase
        .from('players')
        .select('id, position_group, team')
        .in('id', playerIdList);

      for (const p of playersData ?? []) {
        positionMap.set(p.id, p.position_group ?? 'UNKNOWN');
        if (p.team) teamMap.set(p.id, p.team);
      }
    }

    // Fallback: for players without a team in players table, resolve from player_game_stats
    // Multi-stage team resolution: players.team → player_game_stats.team (most recent)
    const playersWithoutTeam = playerIdList.filter(id => !teamMap.has(id));
    if (playersWithoutTeam.length > 0) {
      const { data: statsTeams } = await supabase
        .from('player_game_stats')
        .select('player_id, team')
        .in('player_id', playersWithoutTeam)
        .order('match_date', { ascending: false })
        .limit(playersWithoutTeam.length * 5); // a few rows per player to find the latest non-null team

      for (const s of statsTeams ?? []) {
        if (s.team && !teamMap.has(s.player_id)) {
          teamMap.set(s.player_id, s.team);
        }
      }
    }

    setPlayerPositionMap(positionMap);
    setPlayerTeamMap(teamMap);

    // Step 4: Load shared historical stats cache for ALL resolved player IDs
    // This is the SINGLE source of truth for both EV stats and venue/opponent edge
    const { cache, diagnostics } = await loadHistoricalStatsForPlayers(playerIdList, true);
    setHistoricalStatsCache(cache);
    setHistoricalStatsDiagnostics(diagnostics);
    console.log('[EVCalculator] Shared historical stats loaded:', diagnostics);

    // Step 5: Use shared cache for player stats data (for EV probability calculation)
    // cache.byPlayerStat already has the format we need: ${playerId}|${statType} -> values[]
    setPlayerStatsData(cache.byPlayerStat);
    console.log('[EVCalculator] Player stats map built from shared cache:', cache.byPlayerStat.size, 'keys');
  }, [matches, playerMatchCache]);

  const handleRepairNoStatsLinks = useCallback(async () => {
    if (!selectedMatchId) return;
    setRepairNoStatsRunning(true);
    setRepairNoStatsResult(null);
    try {
      const res = await repairNoStatsOddsLinks(selectedMatchId);
      setRepairNoStatsResult(res);
      await loadOddsForMatch(selectedMatchId);
    } finally {
      setRepairNoStatsRunning(false);
    }
  }, [selectedMatchId, loadOddsForMatch]);

  useEffect(() => {
    if (selectedMatchId) loadOddsForMatch(selectedMatchId);
  }, [selectedMatchId, loadOddsForMatch]);

  const statTypes = useMemo(() => {
    const types = new Set(odds.map(o => extractStatType(o.raw_market) ?? 'other'));
    return ['all', ...Array.from(types).sort()];
  }, [odds]);

  const evRows = useMemo((): EVRow[] => {
    // Determine opponent for the selected match (normalized)
    const matchHome = selectedMatch?.home_team ?? null;
    const matchAway = selectedMatch?.away_team ?? null;
    const venue = selectedMatch?.venue ?? '';

    return odds.map(row => {
      // Extract and normalize stat type
      const rawStatType = extractStatType(row.raw_market);
      const statType = normalizeStatType(rawStatType) || rawStatType || 'other';

      // CRITICAL: Resolve player ID from either row.player_id OR name match
      let resolvedPlayerId = row.player_id;
      if (!resolvedPlayerId) {
        const normalizedName = normalizePlayerName(row.player_name);
        resolvedPlayerId = resolvedPlayerIds.get(normalizedName) ?? null;
      }

      // Player key for stats lookup - use normalized stat type
      const playerKey = resolvedPlayerId ? `${resolvedPlayerId}|${statType}` : null;

      // Get player position group - try resolved ID first
      const positionGroup = resolvedPlayerId
        ? (playerPositionMap.get(resolvedPlayerId) ?? 'UNKNOWN')
        : 'UNKNOWN';

      // Determine player team - try resolved ID first
      let playerTeam = '';
      if (resolvedPlayerId && playerTeamMap.has(resolvedPlayerId)) {
        playerTeam = playerTeamMap.get(resolvedPlayerId) ?? '';
      }

      const playerTeamNorm = normalizeOpponentName(playerTeam);
      const homeNorm = normalizeOpponentName(matchHome);
      const awayNorm = normalizeOpponentName(matchAway);

      // Hard selected-match participant validation
      // Player's team must normalize to home or away team of the selected match
      const isWrongTeam = playerTeam !== '' &&
        playerTeamNorm !== 'UNKNOWN' &&
        playerTeamNorm !== homeNorm &&
        playerTeamNorm !== awayNorm;

      // Calculate total stats rows BEFORE using in exclusionReason
      const totalStatsRows = resolvedPlayerId
        ? (historicalStatsCache?.rawByPlayerId.get(resolvedPlayerId)?.length ?? 0)
        : 0;

      // Calculate modelProb BEFORE using it in exclusionReason
      let modelProb: ModelProb = {
        probability: null, conservativeProb: null, adjustedProb: null,
        sample_size: 0, confidence: 'none', hit_count: 0, hit_rate: 0,
        max_stat: 0, avg_stat: 0, venue_adjustment: 0, opponent_adjustment: 0,
        tags: [], context: null, quality_score: 0, risk_level: 'High',
      };

      if (playerKey && playerStatsData.has(playerKey)) {
        const values = playerStatsData.get(playerKey)!;
        const currentSeason = inferCurrentSeason(selectedMatch?.season);
        const seasonVals = historicalStatsCache
          ? getSeasonValuesForPlayerStat(historicalStatsCache, resolvedPlayerId!, statType, currentSeason)
          : [];
        modelProb = calculateModelProb(values, row.line, null, sampleWindow, seasonVals);
      }

      // Compute exclusion reason for debug (now modelProb is available)
      let exclusionReason: ExclusionReason | null = null;
      if (row.match_id && selectedMatch && row.match_id !== selectedMatch.id) {
        exclusionReason = 'WRONG_MATCH_ID';
      } else if (!resolvedPlayerId) {
        exclusionReason = 'PLAYER_ID_NULL';
      } else if (playerTeam === '') {
        exclusionReason = 'PLAYER_TEAM_MISSING';
      } else if (isWrongTeam) {
        exclusionReason = 'WRONG_TEAM';
      } else if (totalStatsRows === 0) {
        exclusionReason = 'PLAYER_ID_HAS_ZERO_STATS';
      } else if (modelProb.sample_size === 0 || modelProb.adjustedProb === null) {
        exclusionReason = 'INSUFFICIENT_MARKET_SAMPLE';
      }

      // Determine opponent: if player is on home team, opponent = away team, and vice versa
      // If player team is unknown, default to away team as opponent (or home if away is null)
      let opponent: string | null = null;
      if (playerTeamNorm && playerTeamNorm === homeNorm) {
        opponent = matchAway;
      } else if (playerTeamNorm && playerTeamNorm === awayNorm) {
        opponent = matchHome;
      } else {
        // Team unknown - use matchAway as default opponent (or matchHome if away is null)
        opponent = matchAway ?? matchHome;
      }

      // Get position edge for this player's position vs opponent
      const positionEdge = opponent
        ? getPositionEdge(positionEdgeCache, positionGroup, opponent, statType)
        : null;

      const impliedProb = 1 / row.over_odds;

      const conservativeEV = modelProb.conservativeProb ? (modelProb.conservativeProb * row.over_odds) - 1 : null;
      const adjustedEV = modelProb.adjustedProb ? (modelProb.adjustedProb * row.over_odds) - 1 : null;
      const edge = modelProb.adjustedProb ? modelProb.adjustedProb - impliedProb : null;

      // Calculate quality score and risk after EV
      modelProb.quality_score = calculateQualityScore(modelProb, adjustedEV, row.over_odds);

      const isRealistic =
        modelProb.hit_count >= 2 &&
        modelProb.sample_size >= 10 &&
        row.line <= modelProb.max_stat &&
        row.over_odds <= 15 &&
        (modelProb.conservativeProb ?? 0) >= 0.08;

      const isValid = modelProb.conservativeProb !== null && modelProb.sample_size >= 5;

      // Apply Position Edge quality adjustment when toggle is ON
      if (usePositionEdgeInEV && isRealistic && isValid) {
        const qualityAdj = getPositionEdgeQualityAdjustment(positionEdge, positionGroup);
        modelProb.quality_score = Math.max(0, Math.min(100, modelProb.quality_score + qualityAdj));
      }

      modelProb.risk_level = calculateRiskLevel(modelProb, row.over_odds);

      // Position Edge adjustment: only for rows that already pass realistic filters AND toggle is ON
      const passesRealisticFilters = isRealistic && isValid;
      const rawPosAdj = (usePositionEdgeInEV && passesRealisticFilters)
        ? getPositionEdgeAdjustment(positionEdge, positionGroup)
        : 0;
      const positionEdgeAdjustment = capAdjustment(rawPosAdj);

      // Venue Edge - compute from shared historical stats cache (PER PLAYER, PER STAT TYPE)
      const venueEdge = (useVenueEdge && passesRealisticFilters && resolvedPlayerId && historicalStatsCache && statType)
        ? getVenueEdgeFromCache(historicalStatsCache, resolvedPlayerId, statType as StatType, venue).result
        : null;
      const rawVenueAdj = venueEdge ? venueEdge.edge_value : 0;
      const venueEdgeAdjustment = capVenueAdjustment(rawVenueAdj);

      // Opponent Edge - PLAYER-SPECIFIC: opponent is determined by player's team vs match teams
      // Compute from shared historical stats cache
      const opponentEdge = (useOpponentEdge && passesRealisticFilters && resolvedPlayerId && historicalStatsCache && statType)
        ? getOpponentEdgeFromCache(historicalStatsCache, resolvedPlayerId, statType as StatType, playerTeam, matchHome, matchAway).result
        : null;
      const rawOppAdj = opponentEdge ? opponentEdge.edge_value : 0;
      const opponentEdgeAdjustment = capOpponentAdjustment(rawOppAdj);

      // Combined matchup adjustment
      const anyMatchupToggleOn = usePositionEdgeInEV || useVenueEdge || useOpponentEdge;
      const totalMatchupAdjustment = anyMatchupToggleOn && passesRealisticFilters
        ? computeTotalMatchupAdjustment(positionEdgeAdjustment, venueEdgeAdjustment, opponentEdgeAdjustment)
        : 0;

      const finalProbability = anyMatchupToggleOn
        ? computeFinalProbability(modelProb.adjustedProb, totalMatchupAdjustment)
        : modelProb.adjustedProb;
      const finalEV = anyMatchupToggleOn
        ? computeFinalEV(finalProbability, row.over_odds)
        : adjustedEV;

      // Compute latest stat round and stale data status
      let latestStatRound: string | null = null;
      let isStale = false;
      if (resolvedPlayerId && historicalStatsCache) {
        const playerRows = historicalStatsCache.rawByPlayerId.get(resolvedPlayerId) || [];
        if (playerRows.length > 0) {
          latestStatRound = playerRows[0].match_round ?? null;
        }
        if (latestCompletedRound && latestStatRound) {
          const latestNum = parseInt(latestStatRound, 10);
          const expectedNum = parseInt(latestCompletedRound, 10);
          if (!isNaN(latestNum) && !isNaN(expectedNum) && latestNum < expectedNum) {
            if (expectedNum - latestNum > 1) {
              isStale = true;
            }
          }
        }
      }

      // Compute Model Status for odds-first visibility
      // MODEL_READY = probability was calculated from stats (regardless of quality/confidence)
      // INSUFFICIENT_MARKET_SAMPLE = player has game rows but not enough for this specific market
      // NO_STATS = player_id has 0 player_game_stats rows at all
      // PLAYER_UNRESOLVED = no resolved player_id
      let modelStatus: ModelStatus = 'MODEL_READY';
      let noStatsReason: NoStatsReason | null = null;

      const marketSampleCount = modelProb.sample_size;

      if (!resolvedPlayerId) {
        modelStatus = 'PLAYER_UNRESOLVED';
        noStatsReason = 'PLAYER_ID_NULL';
      } else if (totalStatsRows === 0) {
        modelStatus = 'NO_STATS';
        noStatsReason = 'PLAYER_ID_HAS_ZERO_STATS';
      } else if (modelProb.sample_size === 0 || modelProb.adjustedProb === null) {
        modelStatus = 'INSUFFICIENT_MARKET_SAMPLE';
        noStatsReason = 'INSUFFICIENT_MARKET_SAMPLE';
      }
      // Note: isStale, sample_size < 5, low position confidence are WARNINGS, not status changes.
      // If we have a calculated probability, the model IS ready (may just be low quality).

      return {
        ...row,
        player_id: resolvedPlayerId, // Update with resolved ID
        modelProb,
        modelStatus,
        noStatsReason,
        conservativeEV,
        adjustedEV,
        edge,
        impliedProb,
        isRealistic,
        isValid,
        positionGroup,
        positionEdge,
        positionEdgeAdjustment,
        venueEdge,
        venueEdgeAdjustment,
        opponentEdge,
        opponentEdgeAdjustment,
        totalMatchupAdjustment,
        finalProbability,
        finalEV,
        resolvedPlayerId,
        playerTeam,
        opponent,
        latestStatRound,
        isStale,
        isWrongTeam,
        playerTeamNorm,
        exclusionReason,
        totalStatsRows,
        marketSampleCount,
        warnings: [] as string[], // computed in second pass below
        finalCardGrade: null as 'A' | 'B' | 'C' | null,
      };
    });

    // Second pass: compute duplicate keys, then warnings and grades
    const dupKeys = new Set<string>();
    const seenKeys = new Set<string>();
    for (const r of evRows) {
      const key = `${r.player_name}|${extractStatType(r.raw_market)}`;
      if (seenKeys.has(key)) dupKeys.add(key);
      seenKeys.add(key);
    }
    for (const r of evRows) {
      r.warnings = computeWarnings(r, useVenueEdge, useOpponentEdge, dupKeys);
      r.finalCardGrade = computeFinalCardGrade(r, r.warnings);
    }

    return evRows;
  }, [odds, playerStatsData, sampleWindow, playerPositionMap, playerTeamMap, positionEdgeCache, historicalStatsCache, selectedMatch, usePositionEdgeInEV, useVenueEdge, useOpponentEdge, resolvedPlayerIds, latestCompletedRound]);

  // Apply market mode filter to evRows everywhere
  const marketFilteredEvRows = useMemo(() => {
    return filterByMarketMode(evRows as any, marketMode) as typeof evRows;
  }, [evRows, marketMode]);

  const matchupDiagnostics = useMemo(() => {
    const matchHome = selectedMatch?.home_team ?? null;
    const matchAway = selectedMatch?.away_team ?? null;
    const homeNorm = normalizeOpponentName(matchHome);
    const awayNorm = normalizeOpponentName(matchAway);

    let totalEdges = Object.keys(positionEdgeCache).length;
    // Use venue/opponent sample counts from state (computed when cache loads)
    const venueSamplesCreated = venueEdgeStats.samplesCreated;
    const oppSamplesCreated = opponentEdgeStats.samplesCreated;

    let mappedPlayers = 0;
    let unknownPlayers = 0;
    let rowsWithPosEdge = 0;
    let rowsWithVenueEdge = 0;
    let rowsWithOppEdge = 0;
    let rowsWithPosAdj = 0;
    let rowsWithVenueAdj = 0;
    let rowsWithOppAdj = 0;
    let rowsWithTotalAdj = 0;
    let homeRowsUsingOpponentAway = 0;
    let awayRowsUsingOpponentHome = 0;
    let missingPlayerTeam = 0;
    let missingVenue = 0;
    let rowsWithStats = 0;
    let rowsWithoutStats = 0;

    for (const row of evRows) {
      const pg = row.positionGroup;
      if (pg && pg !== 'UNKNOWN') mappedPlayers++;
      else unknownPlayers++;

      if (row.modelProb.sample_size > 0) rowsWithStats++;
      else rowsWithoutStats++;

      if (row.positionEdge) rowsWithPosEdge++;
      if (row.venueEdge) rowsWithVenueEdge++;
      if (row.opponentEdge) rowsWithOppEdge++;
      if (row.positionEdgeAdjustment !== 0) rowsWithPosAdj++;
      if (row.venueEdgeAdjustment !== 0) rowsWithVenueAdj++;
      if (row.opponentEdgeAdjustment !== 0) rowsWithOppAdj++;
      if (row.totalMatchupAdjustment !== 0) rowsWithTotalAdj++;

      // Check player team using resolved ID
      const resolvedId = row.player_id || resolvedPlayerIds.get(normalizePlayerName(row.player_name));
      const playerTeam = resolvedId ? (playerTeamMap.get(resolvedId) ?? '') : '';
      const playerTeamNorm = normalizeOpponentName(playerTeam);
      if (playerTeamNorm === homeNorm) homeRowsUsingOpponentAway++;
      else if (playerTeamNorm === awayNorm) awayRowsUsingOpponentHome++;
      else missingPlayerTeam++;

      if (!selectedMatch?.venue) missingVenue++;
    }

    return {
      totalEdges,
      venueSamplesCreated,
      oppSamplesCreated,
      venueSamples3Plus: venueEdgeStats.rowsWithSample3Plus,
      oppSamples3Plus: opponentEdgeStats.rowsWithSample3Plus,
      homeTeam: homeNorm, awayTeam: awayNorm,
      homeRowsUsingOpponentAway, awayRowsUsingOpponentHome,
      mappedPlayers, unknownPlayers,
      rowsWithPosEdge, rowsWithVenueEdge, rowsWithOppEdge,
      rowsWithPosAdj, rowsWithVenueAdj, rowsWithOppAdj, rowsWithTotalAdj,
      missingPlayerTeam, missingVenue,
      rowsWithStats, rowsWithoutStats,
      bookmakerOddsRows: odds.length,
      uniquePlayers: new Set(odds.map(o => o.player_name)).size,
      resolvedPlayerCount: resolvedPlayerIds.size,
      // From shared historical stats diagnostics
      historicalStatsRows: historicalStatsDiagnostics?.rowsFetched ?? 0,
      statsQueryPages: historicalStatsDiagnostics?.statsQueryPages ?? 1,
      historicalStatsWithVenue: historicalStatsDiagnostics?.rowsWithVenue ?? 0,
      historicalStatsWithOpponent: historicalStatsDiagnostics?.rowsWithOpponent ?? 0,
      uniqueHistoricalVenues: historicalStatsDiagnostics?.uniqueVenues ? [...historicalStatsDiagnostics.uniqueVenues] : [],
      uniqueHistoricalOpponents: historicalStatsDiagnostics?.uniqueOpponents ? [...historicalStatsDiagnostics.uniqueOpponents] : [],
    };
  }, [evRows, positionEdgeCache, selectedMatch, playerTeamMap, resolvedPlayerIds, odds, venueEdgeStats, opponentEdgeStats, historicalStatsDiagnostics]);

  const displayRows = useMemo(() => {
    // When Final Card is ON, use its own preset values and filter order
    // When Final Card is OFF, use manual filters
    if (finalCardMode) {
      const preset = FINAL_CARD_PRESETS[finalCardStrictness];
      const shouldBlockStale = blockStaleData;
      const allowsMinorWarnings = preset.allowMinorWarnings;

      // Start from ALL evRows — Final Card ignores manual filters entirely
      // (statFilter and searchFilter are the only UI filters that make sense to keep
      // since they are "view" filters, not "quality" filters)
      let pool = evRows.filter(row => {
        if (statFilter !== 'all' && (extractStatType(row.raw_market) ?? 'other') !== statFilter) return false;
        if (searchFilter.trim()) {
          const q = searchFilter.toLowerCase();
          return row.player_name.toLowerCase().includes(q) || row.raw_market.toLowerCase().includes(q);
        }
        return true;
      });

      const totalBefore = pool.length;
      const excluded: { row: EVRow; reason: string }[] = [];
      let removedNoModel = 0, removedStale = 0, removedMissingTeam = 0, removedUnresolved = 0;
      let removedMinSample = 0, removedMinHits = 0, removedMaxOdds = 0, removedMinEV = 0, removedMinConsProb = 0;
      let removedUnknownPos = 0, removedLowConfPos = 0, removedNoStats = 0, removedDuplicate = 0;
      let removedTinySampleOnly = 0, removedNoCurrentSeason = 0, removedPositionSuppress = 0;

      // Step 1: Remove rows with no model / no stats / insufficient market sample
      pool = pool.filter(r => {
        if (r.modelStatus !== 'MODEL_READY' || !r.isValid || r.modelProb.sample_size === 0) {
          removedNoModel++;
          excluded.push({ row: r, reason: r.noStatsReason ?? 'No model / no stats' });
          return false;
        }
        return true;
      });

      // Step 2: Remove stale data rows (only if stale blocking is ON)
      pool = pool.filter(r => {
        if (r.isStale && shouldBlockStale) {
          removedStale++;
          excluded.push({ row: r, reason: `Stale data — latest stat is Round ${r.latestStatRound} but expected Round ${latestCompletedRound}` });
          return false;
        }
        return true;
      });

      // Step 3: Remove missing team / wrong team / unresolved rows
      pool = pool.filter(r => {
        if (!r.playerTeam) {
          removedMissingTeam++;
          excluded.push({ row: r, reason: 'Missing team' });
          return false;
        }
        if (r.isWrongTeam) {
          removedMissingTeam++;
          excluded.push({ row: r, reason: `Wrong team — player team "${r.playerTeam}" not in this match` });
          return false;
        }
        if (!r.resolvedPlayerId) {
          removedUnresolved++;
          excluded.push({ row: r, reason: 'Player unresolved' });
          return false;
        }
        return true;
      });

      // Step 4: Apply sample/hit/odds/probability/EV filters
      pool = pool.filter(r => {
        if (r.modelProb.sample_size < preset.minSample) {
          removedMinSample++;
          excluded.push({ row: r, reason: `Sample ${r.modelProb.sample_size} < min ${preset.minSample}` });
          return false;
        }
        if (r.modelProb.hit_count < preset.minHits) {
          removedMinHits++;
          excluded.push({ row: r, reason: `Hits ${r.modelProb.hit_count} < min ${preset.minHits}` });
          return false;
        }
        if (r.over_odds > preset.maxOdds) {
          removedMaxOdds++;
          excluded.push({ row: r, reason: `Odds ${r.over_odds.toFixed(2)} > max ${preset.maxOdds}` });
          return false;
        }
        const ev = (r.finalEV ?? r.adjustedEV ?? 0) * 100;
        if (ev < preset.minEV) {
          removedMinEV++;
          excluded.push({ row: r, reason: `EV ${ev.toFixed(1)}% < min ${preset.minEV}%` });
          return false;
        }
        const consProb = (r.modelProb.adjustedProb ?? 0) * 100;
        if (consProb < preset.minAdjProb) {
          removedMinConsProb++;
          excluded.push({ row: r, reason: `Conservative prob ${consProb.toFixed(1)}% < min ${preset.minAdjProb}%` });
          return false;
        }
        return true;
      });

      // Step 5: Apply position confidence filters
      pool = pool.filter(r => {
        if (r.positionGroup === 'UNKNOWN') {
          removedUnknownPos++;
          excluded.push({ row: r, reason: 'UNKNOWN position' });
          return false;
        }
        if (r.positionEdge && r.positionEdge.confidence === 'low' && !allowsMinorWarnings) {
          removedLowConfPos++;
          excluded.push({ row: r, reason: 'Position Edge low confidence' });
          return false;
        }
        return true;
      });

      // Step 6: Apply warning filters (major warnings)
      // In Loose mode, allow minor warnings but still exclude major issues
      pool = pool.filter(r => {
        const majorWarnings = r.warnings.filter(w => MAJOR_WARNINGS.has(w));
        if (majorWarnings.length > 0) {
          if (majorWarnings.includes('No historical stats')) { removedNoStats++; excluded.push({ row: r, reason: 'No historical stats' }); }
          else if (majorWarnings.includes('Duplicate player/stat')) { removedDuplicate++; excluded.push({ row: r, reason: 'Duplicate player/stat' }); }
          else if (majorWarnings.includes('No current season data')) { removedNoCurrentSeason++; excluded.push({ row: r, reason: 'No current season data' }); }
          else if (majorWarnings.includes('Team mismatch')) { removedMissingTeam++; excluded.push({ row: r, reason: 'Team mismatch' }); }
          else if (majorWarnings.includes('Wrong team')) { removedMissingTeam++; excluded.push({ row: r, reason: 'Wrong team' }); }
          else { excluded.push({ row: r, reason: majorWarnings[0] }); }
          return false;
        }
        return true;
      });

      // Step 7: In non-Loose mode, exclude rows with position suppression
      if (!allowsMinorWarnings) {
        pool = pool.filter(r => {
          if (r.positionEdge && r.positionEdge.edge_value <= -1.5) {
            removedPositionSuppress++;
            excluded.push({ row: r, reason: 'Position suppression' });
            return false;
          }
          return true;
        });
      }

      // Step 8: In non-Loose mode, exclude rows where the only positive case is tiny venue/opponent sample
      // In Loose mode, allow neutral/no venue/opponent data as display-only
      if (!allowsMinorWarnings) {
        pool = pool.filter(r => {
          const venueSmall = r.venueEdge ? r.venueEdge.sample_size < 3 : true;
          const oppSmall = r.opponentEdge ? r.opponentEdge.sample_size < 3 : true;
          const hasPositionEdge = r.positionEdge && r.positionEdge.edge_value > 0;
          if (venueSmall && oppSmall && !hasPositionEdge) {
            removedTinySampleOnly++;
            excluded.push({ row: r, reason: 'Venue/opponent tiny-sample-only boost' });
            return false;
          }
          return true;
        });
      }

      // Step 9: Deduplicate to best line per player/stat (keep highest EV)
      const bestByPlayerStat = new Map<string, EVRow>();
      for (const r of pool) {
        const key = `${r.player_name}|${extractStatType(r.raw_market)}`;
        const existing = bestByPlayerStat.get(key);
        if (!existing) {
          bestByPlayerStat.set(key, r);
        } else {
          const rEv = r.finalEV ?? r.adjustedEV ?? 0;
          const exEv = existing.finalEV ?? existing.adjustedEV ?? 0;
          if (rEv > exEv) bestByPlayerStat.set(key, r);
        }
      }
      const finalRows = Array.from(bestByPlayerStat.values());

      // Determine top exclusion reason
      const reasonCounts: Record<string, number> = {};
      for (const e of excluded) {
        const key = e.reason.split(' — ')[0].split(' < ')[0].split(' > ')[0];
        reasonCounts[key] = (reasonCounts[key] || 0) + 1;
      }
      let topReason = '';
      let topCount = 0;
      for (const [reason, count] of Object.entries(reasonCounts)) {
        if (count > topCount) {
          topReason = reason;
          topCount = count;
        }
      }

      const isStaleBlocked = removedStale > 0 && finalRows.length === 0 && removedStale >= (totalBefore - removedNoModel) * 0.5;

      // Build Recommended Watchlist from rows that barely missed
      const watchlistCandidates = excluded
        .filter(e => {
          const r = e.row;
          if (!r.isValid || r.modelProb.sample_size === 0) return false;
          if (!r.playerTeam || !r.resolvedPlayerId) return false;
          if (r.positionGroup === 'UNKNOWN') return false;
          const ev = (r.finalEV ?? r.adjustedEV ?? 0) * 100;
          if (ev < 1) return false;
          // "Barely missed" — within 20% of the threshold
          const closeSample = r.modelProb.sample_size >= preset.minSample * 0.8;
          const closeHits = r.modelProb.hit_count >= preset.minHits * 0.8;
          const closeOdds = r.over_odds <= preset.maxOdds * 1.15;
          const closeEV = ev >= preset.minEV * 0.6;
          return closeSample && closeHits && closeOdds && closeEV;
        })
        .sort((a, b) => ((b.row.finalEV ?? b.row.adjustedEV ?? 0) - (a.row.finalEV ?? a.row.adjustedEV ?? 0)))
        .slice(0, 10);

      // Store diagnostics for the diagnostics panel (will be set via effect)
      finalCardDiagRef.current = {
        totalBefore,
        removedNoModel,
        removedStale,
        removedMissingTeam,
        removedUnresolved,
        removedMinSample,
        removedMinHits,
        removedMaxOdds,
        removedMinEV,
        removedMinConsProb,
        removedUnknownPos,
        removedLowConfPos,
        removedNoStats,
        removedDuplicate,
        removedTinySampleOnly,
        removedNoCurrentSeason,
        removedPositionSuppress,
        finalRows: finalRows.length,
        topExclusionReason: topReason,
        topExclusionCount: topCount,
        isStaleBlocked,
        topExcluded: excluded.slice(0, 10).map(e => ({
          player: e.row.player_name,
          stat: extractStatType(e.row.raw_market),
          line: e.row.display_label,
          reason: e.reason,
        })),
        excludedRows: excluded,
        watchlist: watchlistCandidates.map(e => ({
          row: e.row,
          reason: e.reason,
        })),
      };

      return finalRows.sort((a, b) => {
        if (b.modelProb.quality_score !== a.modelProb.quality_score) {
          return b.modelProb.quality_score - a.modelProb.quality_score;
        }
        return (b.finalEV ?? b.adjustedEV ?? 0) - (a.finalEV ?? a.adjustedEV ?? 0);
      });
    }

    // Normal (non-Final Card) filtering
    let filtered = evRows.filter(row => {
      if (statFilter !== 'all' && (extractStatType(row.raw_market) ?? 'other') !== statFilter) return false;
      if (searchFilter.trim()) {
        const expanded = expandSearchWithAliases(searchFilter);
        const matches = expanded.some(term => {
          const q = term.toLowerCase();
          return row.player_name.toLowerCase().includes(q) || row.raw_market.toLowerCase().includes(q);
        });
        if (!matches) return false;
      }
      return true;
    });

    // Exclude wrong-team players — players whose team doesn't match the selected match
    filtered = filtered.filter(r => !r.isWrongTeam);

    if (realisticOnly) {
      filtered = filtered.filter(r => r.isRealistic);
    }

    if (hideWeakVenue) filtered = filtered.filter(r => r.modelProb.venue_adjustment >= -0.03);
    if (hideWeakOpponent) filtered = filtered.filter(r => r.modelProb.opponent_adjustment >= -0.03);

    // Position Edge filters
    if (!includeUnknownPosition) {
      filtered = filtered.filter(r => r.positionGroup !== 'UNKNOWN');
    }
    if (showPositionBoostsOnly) {
      filtered = filtered.filter(r => r.positionEdge && r.positionEdge.edge_value > 0);
    }
    if (hidePositionSuppressions) {
      filtered = filtered.filter(r => !r.positionEdge || r.positionEdge.edge_value >= 0);
    }
    if (showVerySignificantOnly) {
      filtered = filtered.filter(r => r.positionEdge && r.positionEdge.significance === 'very_significant');
    }

    filtered = filtered.filter(r =>
      r.modelProb.sample_size >= minSample &&
      r.modelProb.hit_count >= minHits &&
      r.over_odds <= maxOdds &&
      (r.adjustedEV ?? 0) * 100 >= minEV &&
      (r.modelProb.adjustedProb ?? 0) * 100 >= minAdjProb
    );

    // Sort by quality score first, then by final EV when Position Edge is ON
    return filtered.sort((a, b) => {
      if (b.modelProb.quality_score !== a.modelProb.quality_score) {
        return b.modelProb.quality_score - a.modelProb.quality_score;
      }
      if (usePositionEdgeInEV || useVenueEdge || useOpponentEdge) {
        return (b.finalEV ?? b.adjustedEV ?? 0) - (a.finalEV ?? a.adjustedEV ?? 0);
      }
      return (b.adjustedEV ?? 0) - (a.adjustedEV ?? 0);
    });
  }, [evRows, statFilter, searchFilter, realisticOnly, minSample, minHits, maxOdds, minEV, minAdjProb, hideWeakVenue, hideWeakOpponent, usePositionEdgeInEV, useVenueEdge, useOpponentEdge, finalCardMode, finalCardStrictness, blockStaleData, latestCompletedRound]);

  // Odds-only rows — active markets without a model. Always visible outside Final Card.
  const oddsOnlyRows = useMemo(() => {
    if (finalCardMode) return []; // Don't show in Final Card mode
    return evRows.filter(r =>
      r.modelStatus !== 'MODEL_READY' &&
      !r.isWrongTeam
    ).filter(r => {
      if (statFilter !== 'all' && (extractStatType(r.raw_market) ?? 'other') !== statFilter) return false;
      if (searchFilter.trim()) {
        const expanded = expandSearchWithAliases(searchFilter);
        const matches = expanded.some(term => {
          const q = term.toLowerCase();
          return r.player_name.toLowerCase().includes(q) || r.raw_market.toLowerCase().includes(q);
        });
        if (!matches) return false;
      }
      return true;
    }).sort((a, b) => a.player_name.localeCompare(b.player_name));
  }, [evRows, finalCardMode, statFilter, searchFilter]);

  // Odds Coverage Summary — for "Why not showing?" diagnostics
  // Uses the same filtered odds array as the rest of the page
  const oddsCoverage = useMemo(() => {
    // All counts derived from the match-filtered odds array
    const totalOddsRows = odds.length;
    const uniqueBookmakerNames = new Set(odds.map(o => o.player_name)).size;

    // Count resolved vs unresolved rows
    const resolvedRows = evRows.filter(r => r.resolvedPlayerId).length;
    const unresolvedRows = evRows.filter(r => !r.resolvedPlayerId).length;

    // Unique player counts
    const resolvedIds = new Set(evRows.filter(r => r.resolvedPlayerId).map(r => r.resolvedPlayerId!));
    const unresolvedNames = new Set(evRows.filter(r => !r.resolvedPlayerId).map(r => r.player_name));

    // Wrong team only applies to resolved players with known team
    const wrongTeam = evRows.filter(r => r.isWrongTeam).length;
    const wrongMatchId = evRows.filter(r => r.exclusionReason === 'WRONG_MATCH_ID').length;
    const playerTeamMissing = evRows.filter(r => r.exclusionReason === 'PLAYER_TEAM_MISSING').length;
    const playerUnresolved = evRows.filter(r => !r.resolvedPlayerId).length;

    const withModel = evRows.filter(r => r.modelStatus === 'MODEL_READY').length;
    const oddsOnly = evRows.filter(r => r.modelStatus !== 'MODEL_READY' && r.resolvedPlayerId).length;
    const stale = evRows.filter(r => r.isStale).length;

    // Exclusion breakdown
    const byStatus: Record<ModelStatus, number> = {
      MODEL_READY: 0,
      ODDS_ONLY: 0,
      PLAYER_UNRESOLVED: 0,
      NO_STATS: 0,
      INSUFFICIENT_MARKET_SAMPLE: 0,
      SAMPLE_AUDIT_FAILED: 0,
      POSITION_LOW_CONFIDENCE: 0,
      STALE_OR_LIMITED_SAMPLE: 0,
    };
    for (const r of evRows) {
      byStatus[r.modelStatus] = (byStatus[r.modelStatus] ?? 0) + 1;
    }

    // No-stats reason breakdown
    const noStatsReasons: Record<string, number> = {};
    for (const r of evRows) {
      if (r.noStatsReason) {
        noStatsReasons[r.noStatsReason] = (noStatsReasons[r.noStatsReason] ?? 0) + 1;
      }
    }

    const noPlayerStats = evRows.filter(r => r.modelStatus === 'NO_STATS').length;
    const insufficientMarketSample = evRows.filter(r => r.modelStatus === 'INSUFFICIENT_MARKET_SAMPLE').length;

    const excludedFromEV = evRows.filter(r =>
      !r.isRealistic || !r.isValid
    ).length;

    const excludedFromFinalCard = finalCardDiagnostics?.totalBefore && finalCardDiagnostics.finalRows
      ? finalCardDiagnostics.totalBefore - finalCardDiagnostics.finalRows
      : 0;

    return {
      totalOddsRows,
      uniqueBookmakerNames,
      resolvedRows,
      unresolvedRows,
      resolvedPlayers: resolvedIds.size,
      unresolvedPlayers: unresolvedNames.size,
      withModel,
      oddsOnly,
      wrongTeam,
      wrongMatchId,
      playerTeamMissing,
      playerUnresolved,
      stale,
      excludedFromEV,
      excludedFromFinalCard,
      byStatus,
      noStatsReasons,
      noPlayerStats,
      insufficientMarketSample,
      unresolvedNamesList: [...unresolvedNames].slice(0, 20),
    };
  }, [odds, evRows, finalCardDiagnostics]);

  // Sync Final Card diagnostics from ref to state
  useEffect(() => {
    if (finalCardMode) {
      setFinalCardDiagnostics(finalCardDiagRef.current);
    } else {
      setFinalCardDiagnostics(null);
    }
  }, [finalCardMode, displayRows]);

  // Build BestLineCandidate[] from evRows for the Best Line Optimizer
  const bestLineCandidates = useMemo((): BestLineCandidate[] => {
    return evRows
      .filter(r => {
        if (r.modelStatus !== 'MODEL_READY') return false;
        if (!r.isRealistic || r.adjustedEV === null) return false;
        if (r.isWrongTeam) return false;
        if (r.exclusionReason === 'WRONG_MATCH_ID' || r.exclusionReason === 'PLAYER_TEAM_MISSING') return false;
        // Last 5 restriction: don't allow Best Bet unless Last 10 or Current Season also supports it
        if (sampleWindow === 'last5' && r.modelProb.sampleComparison) {
          const last10 = r.modelProb.sampleComparison.last10;
          const season = r.modelProb.sampleComparison.season;
          const last10Supports = last10 && last10.hit_rate >= 0.40;
          const seasonSupports = season && season.hit_rate >= 0.40;
          if (!last10Supports && !seasonSupports) return false;
        }
        // Sample < 5: never show as Best Bet
        if (r.modelProb.sample_size < 5) return false;
        return true;
      })
      .map(r => {
        const statKey = extractStatType(r.raw_market) || 'other';
        const playerKey = r.player_id || r.player_name;
        const gradeInput = {
          adjustedProb: r.modelProb.adjustedProb,
          adjustedEV: r.adjustedEV,
          qualityScore: r.modelProb.quality_score,
          odds: r.over_odds,
          sampleSize: r.modelProb.sample_size,
          hitCount: r.modelProb.hit_count,
          venueAdjustment: r.modelProb.venue_adjustment,
          opponentAdjustment: r.modelProb.opponent_adjustment,
          riskLevel: r.modelProb.risk_level,
          tags: r.modelProb.tags,
        };
        const sweet = isSweetSpot(gradeInput);
        const stake = suggestStake(gradeInput);
        return {
          id: r.id,
          playerKey,
          statKey,
          playerName: r.player_name,
          line: r.line,
          displayLabel: r.display_label,
          odds: r.over_odds,
          adjustedProb: r.modelProb.adjustedProb,
          adjustedEV: r.adjustedEV,
          qualityScore: r.modelProb.quality_score,
          riskLevel: r.modelProb.risk_level,
          hitCount: r.modelProb.hit_count,
          sampleSize: r.modelProb.sample_size,
          sweetSpot: sweet.isSweetSpot,
          stakeUnits: stake.units,
          row: r,
          positionGroup: r.positionGroup,
          positionEdge: r.positionEdge,
          positionEdgeAdjustment: r.positionEdgeAdjustment,
          finalProbability: r.finalProbability,
          finalEV: r.finalEV,
        } satisfies BestLineCandidate;
      });
  }, [evRows]);

  // Best Line Optimizer: one best line per player + stat, with tab filtering
  const bestBetGroups = useMemo(() => {
    const tabFiltered = filterBestBetTab(bestLineCandidates, bestBetTab);
    const groups = optimizeBestLines(tabFiltered);
    return groups;
  }, [bestLineCandidates, bestBetTab]);

  const bestBetsCount = useMemo(() => bestBetGroups.length, [bestBetGroups]);

  const statsSummary = useMemo(() => ({
    total: odds.length,
    withModel: evRows.filter(r => r.isValid).length,
    realistic: evRows.filter(r => r.isRealistic).length,
    positiveEV: evRows.filter(r => (r.adjustedEV ?? 0) > 0 && r.isRealistic).length,
  }), [odds, evRows]);

  const handleTrackBet = async (row: EVRow) => {
    if (!selectedMatch) return;
    setTrackingBet(row.id);
    const result = await trackBet(row, selectedMatch, sampleWindow, usePositionEdgeInEV, useVenueEdge, useOpponentEdge);
    setTrackingBet(null);
    if (result.error) {
      setMessage(result.error);
    } else {
      setMessage(`Tracked ${row.player_name}`);
    }
    setTimeout(() => setMessage(null), 4000);
  };

  const handleWatchBet = async (row: EVRow) => {
    if (!selectedMatch) return;
    setWatchingBet(row.id);
    const { data: existing } = await supabase
      .from('watchlist')
      .select('id')
      .eq('player_name', row.player_name)
      .eq('market', extractStatType(row.raw_market))
      .eq('line', row.line.toString())
      .maybeSingle();

    if (existing) {
      setMessage('Already on watchlist');
      setWatchingBet(null);
      setTimeout(() => setMessage(null), 4000);
      return;
    }

    await supabase.from('watchlist').insert({
      player_name: row.player_name,
      player_id: row.player_id,
      market: extractStatType(row.raw_market),
      line: row.line.toString(),
      display_label: row.display_label,
      match_id: selectedMatch.id,
      match_name: `${selectedMatch.home_team} vs ${selectedMatch.away_team}`,
      odds_at_watch: row.over_odds,
      latest_odds: row.over_odds,
      model_probability: row.modelProb.adjustedProb,
      adjusted_ev: row.adjustedEV,
      quality_score: row.modelProb.quality_score,
      risk_level: row.modelProb.risk_level,
      selected_sample_window: sampleWindow,
      model_type: SAMPLE_WINDOW_LABELS[sampleWindow],
      position_group: row.positionGroup,
      position_edge_value: row.positionEdge?.edge_value ?? null,
      position_edge_significance: row.positionEdge?.significance ?? null,
      position_edge_adjustment: row.positionEdgeAdjustment,
      venue_edge_value: row.venueEdge?.edge_value ?? null,
      venue_edge_label: row.venueEdge?.label ?? null,
      venue_edge_adjustment: row.venueEdgeAdjustment,
      opponent_edge_value: row.opponentEdge?.edge_value ?? null,
      opponent_edge_label: row.opponentEdge?.label ?? null,
      opponent_edge_adjustment: row.opponentEdgeAdjustment,
      total_matchup_adjustment: row.totalMatchupAdjustment,
      final_probability: row.finalProbability,
      final_ev: row.finalEV,
      use_position_edge: usePositionEdgeInEV,
      use_venue_edge: useVenueEdge,
      use_opponent_edge: useOpponentEdge,
    });
    setWatchingBet(null);
    setMessage(`Watching ${row.player_name}`);
    setTimeout(() => setMessage(null), 4000);
  };

  function toggleGroup(key: string) {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const handleSpotCheck = async (row: EVRow) => {
    setSpotCheckRow(row);
    setSpotCheckLoading(true);
    setSpotCheckData(null);
    if (!selectedMatch) {
      setSpotCheckLoading(false);
      return;
    }
    const { round: latestRound } = await getLatestCompletedRound(selectedMatch.season);
    const sc = await getPlayerSpotCheckAudit(
      row.player_name,
      row.resolvedPlayerId,
      selectedMatch.id,
      selectedMatch.season,
      latestRound,
      selectedMatch.venue,
      row.playerTeam || null,
      selectedMatch.home_team,
      selectedMatch.away_team
    );
    setSpotCheckData(sc);
    setSpotCheckLoading(false);
  };

  if (matchesLoading) return <LoadingSpinner message="Loading fixtures..." />;

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-center gap-3 flex-wrap">
        <Calculator className="w-5 h-5 text-emerald-400" />
        <h2 className="text-white font-bold text-lg">EV Calculator</h2>
        <span className="text-xs text-gray-600">Adjusted model with venue/opponent context</span>
        {dataStatus && (
          <span className={`text-xs px-2.5 py-1 rounded-full font-semibold border ${
            dataStatus.status === 'READY'
              ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400'
              : dataStatus.status === 'WARNING'
                ? 'bg-amber-500/15 border-amber-500/30 text-amber-400'
                : 'bg-red-500/15 border-red-500/30 text-red-400'
          }`} title={dataStatus.reasons.join('\n') || 'All data is up to date'}>
            {dataStatus.status === 'READY' ? 'Data Ready' : dataStatus.status === 'WARNING' ? 'Data Warning' : 'Data Stale'}
            {dataStatus.latestStatRound && dataStatus.latestCompletedRound && (
              <span className="opacity-70 ml-1">R{dataStatus.latestStatRound}/{dataStatus.latestCompletedRound}</span>
            )}
          </span>
        )}
        {statsSummary.positiveEV > 0 && (
          <span className="text-xs px-2.5 py-1 bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 rounded-full font-semibold">
            {statsSummary.positiveEV} realistic edges
          </span>
        )}
        {message && (
          <span className={`text-xs px-3 py-1 rounded-full ${message.includes('already') ? 'bg-amber-500/20 text-amber-400' : 'bg-blue-500/20 text-blue-400'}`}>
            {message}
          </span>
        )}
      </div>

      {/* Match Selector */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Match</label>
        <div className="relative">
          <select
            value={selectedMatchId}
            onChange={e => setSelectedMatchId(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-3 text-white text-sm focus:outline-none focus:border-emerald-500 appearance-none"
          >
            {matches.map(m => (
              <option key={m.id} value={m.id}>
                {m.home_team} vs {m.away_team} — {m.round || 'TBD'} {m.venue ? `@ ${m.venue}` : ''}
              </option>
            ))}
          </select>
          <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
        </div>
      </div>

      {/* Stats Summary */}
      {!loading && odds.length > 0 && (
        <div className="grid grid-cols-4 gap-3">
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-3 text-center">
            <p className="text-2xl font-bold text-white">{statsSummary.total}</p>
            <p className="text-xs text-gray-500">Odds Rows</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-3 text-center">
            <p className="text-2xl font-bold text-blue-400">{statsSummary.withModel}</p>
            <p className="text-xs text-gray-500">With Model</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-3 text-center">
            <p className="text-2xl font-bold text-emerald-400">{statsSummary.realistic}</p>
            <p className="text-xs text-gray-500">Realistic</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-3 text-center">
            <p className="text-2xl font-bold text-amber-400">{statsSummary.positiveEV}</p>
            <p className="text-xs text-gray-500">+EV Edges</p>
          </div>
        </div>
      )}

      {/* Matchup Diagnostics */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <Crosshair className="w-4 h-4 text-emerald-400" />
          <h3 className="text-white font-semibold text-sm">Matchup Diagnostics</h3>
          <span className={`text-xs px-2 py-0.5 rounded-full ${usePositionEdgeInEV || useVenueEdge || useOpponentEdge ? 'bg-emerald-500/20 text-emerald-400' : 'bg-gray-700 text-gray-400'}`}>
            {usePositionEdgeInEV || useVenueEdge || useOpponentEdge ? 'ON' : 'OFF'}
          </span>
        </div>

        {/* Odds Coverage */}
        <div className="mb-3">
          <p className="text-xs text-gray-500 mb-2">Selected Match Coverage</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Match Odds Rows</p>
              <p className="text-white font-bold">{matchupDiagnostics.bookmakerOddsRows}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Unique Players</p>
              <p className="text-emerald-400 font-bold">{matchupDiagnostics.uniquePlayers}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Stats Loaded</p>
              <p className="text-blue-400 font-bold">{matchupDiagnostics.historicalStatsRows}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Stats Query Pages</p>
              <p className="text-cyan-400 font-bold">{matchupDiagnostics.statsQueryPages ?? 1}</p>
            </div>
          </div>
        </div>

        {/* Edge Cache */}
        <div className="mb-3">
          <p className="text-xs text-gray-500 mb-2">Edge Cache</p>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Pos Edge Rows</p>
              <p className="text-white font-bold">{matchupDiagnostics.totalEdges}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Venue Samples</p>
              <p className="text-white font-bold">{matchupDiagnostics.venueSamplesCreated}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Opp Samples</p>
              <p className="text-white font-bold">{matchupDiagnostics.oppSamplesCreated}</p>
            </div>
          </div>
        </div>

        {/* Team Matching */}
        <div className="mb-3">
          <p className="text-xs text-gray-500 mb-2">Team Matching</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Home Team</p>
              <p className="text-white font-bold">{matchupDiagnostics.homeTeam}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Away Team</p>
              <p className="text-white font-bold">{matchupDiagnostics.awayTeam}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Home Rows (opp=Away)</p>
              <p className="text-blue-400 font-bold">{matchupDiagnostics.homeRowsUsingOpponentAway}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Away Rows (opp=Home)</p>
              <p className="text-blue-400 font-bold">{matchupDiagnostics.awayRowsUsingOpponentHome}</p>
            </div>
          </div>
        </div>

        {/* Edge Application */}
        <div>
          <p className="text-xs text-gray-500 mb-2">Edge Application</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Rows w/ Pos Edge</p>
              <p className="text-white font-bold">{matchupDiagnostics.rowsWithPosEdge}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Rows w/ Venue Edge</p>
              <p className="text-white font-bold">{matchupDiagnostics.rowsWithVenueEdge}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Rows w/ Opp Edge</p>
              <p className="text-white font-bold">{matchupDiagnostics.rowsWithOppEdge}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Rows w/ Total Adj</p>
              <p className={`font-bold ${matchupDiagnostics.rowsWithTotalAdj > 0 ? 'text-emerald-400' : 'text-amber-400'}`}>{matchupDiagnostics.rowsWithTotalAdj}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Missing Player Team</p>
              <p className="text-amber-400 font-bold">{matchupDiagnostics.missingPlayerTeam}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Pos Adj Active</p>
              <p className={`font-bold ${matchupDiagnostics.rowsWithPosAdj > 0 ? 'text-emerald-400' : 'text-gray-400'}`}>{matchupDiagnostics.rowsWithPosAdj}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Venue Adj Active</p>
              <p className={`font-bold ${matchupDiagnostics.rowsWithVenueAdj > 0 ? 'text-blue-400' : 'text-gray-400'}`}>{matchupDiagnostics.rowsWithVenueAdj}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Opp Adj Active</p>
              <p className={`font-bold ${matchupDiagnostics.rowsWithOppAdj > 0 ? 'text-emerald-400' : 'text-gray-400'}`}>{matchupDiagnostics.rowsWithOppAdj}</p>
            </div>
          </div>
        </div>

        {/* Venue Edge Sample Details — uses shared historical stats diagnostics */}
        <div className="mb-3">
          <p className="text-xs text-gray-500 mb-2 flex items-center gap-2">
            <MapPin className="w-3 h-3" />
            Venue Edge Samples
            {matchupDiagnostics.venueSamplesCreated === 0 && <span className="text-amber-400">(0 samples - see details below)</span>}
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Selected Venue</p>
              <p className="text-white font-bold text-[10px] truncate" title={selectedMatch?.venue ?? ''}>{selectedMatch?.venue || 'None'}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Normalized</p>
              <p className="text-blue-400 font-bold text-[10px] truncate">{normalizeVenueKey(selectedMatch?.venue || '') || 'None'}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Stats Rows Fetched</p>
              <p className="text-white font-bold">{historicalStatsDiagnostics?.rowsFetched ?? 0}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Rows w/ Venue</p>
              <p className="text-emerald-400 font-bold">{historicalStatsDiagnostics?.rowsWithVenue ?? 0}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Rows Missing Venue</p>
              <p className="text-amber-400 font-bold">{(historicalStatsDiagnostics?.rowsFetched ?? 0) - (historicalStatsDiagnostics?.rowsWithVenue ?? 0)}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Unique Venues Found</p>
              <p className="text-white font-bold">{historicalStatsDiagnostics?.uniqueVenues.size ?? 0}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Venue Samples Created</p>
              <p className={`font-bold ${matchupDiagnostics.venueSamplesCreated > 0 ? 'text-emerald-400' : 'text-amber-400'}`}>{matchupDiagnostics.venueSamplesCreated}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Samples w/ 3+</p>
              <p className={`font-bold ${matchupDiagnostics.venueSamples3Plus > 0 ? 'text-emerald-400' : 'text-amber-400'}`}>{matchupDiagnostics.venueSamples3Plus}</p>
            </div>
          </div>
          {matchupDiagnostics.venueSamplesCreated === 0 && (
            <div className="mt-2 text-xs text-gray-400">
              <p>Reason: {(historicalStatsDiagnostics?.rowsWithVenue ?? 0) === 0 ? 'No historical stats rows have venue data' : `Target venue "${normalizeVenueKey(selectedMatch?.venue || '')}" not found in historical venues: ${[...(historicalStatsDiagnostics?.uniqueVenues ?? new Set<string>())].slice(0, 5).join(', ')}`}</p>
            </div>
          )}
        </div>

        {/* Opponent Edge Sample Details — uses shared historical stats diagnostics */}
        <div className="mb-3">
          <p className="text-xs text-gray-500 mb-2 flex items-center gap-2">
            <Swords className="w-3 h-3" />
            Opponent Edge Samples
            {matchupDiagnostics.oppSamplesCreated === 0 && <span className="text-amber-400">(0 samples - see details below)</span>}
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Home Team</p>
              <p className="text-white font-bold text-[10px] truncate">{selectedMatch?.home_team || 'None'}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Away Team</p>
              <p className="text-white font-bold text-[10px] truncate">{selectedMatch?.away_team || 'None'}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Stats Rows Fetched</p>
              <p className="text-white font-bold">{historicalStatsDiagnostics?.rowsFetched ?? 0}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Rows w/ Opponent</p>
              <p className="text-emerald-400 font-bold">{historicalStatsDiagnostics?.rowsWithOpponent ?? 0}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Rows Missing Opponent</p>
              <p className="text-amber-400 font-bold">{(historicalStatsDiagnostics?.rowsFetched ?? 0) - (historicalStatsDiagnostics?.rowsWithOpponent ?? 0)}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Unique Opponents Found</p>
              <p className="text-white font-bold">{historicalStatsDiagnostics?.uniqueOpponents.size ?? 0}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Opp Samples Created</p>
              <p className={`font-bold ${matchupDiagnostics.oppSamplesCreated > 0 ? 'text-emerald-400' : 'text-amber-400'}`}>{matchupDiagnostics.oppSamplesCreated}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Samples w/ 3+</p>
              <p className={`font-bold ${matchupDiagnostics.oppSamples3Plus > 0 ? 'text-emerald-400' : 'text-amber-400'}`}>{matchupDiagnostics.oppSamples3Plus}</p>
            </div>
          </div>
          {matchupDiagnostics.oppSamplesCreated === 0 && (
            <div className="mt-2 text-xs text-gray-400">
              <p>Reason: {(historicalStatsDiagnostics?.rowsWithOpponent ?? 0) === 0 ? 'No historical stats rows have opponent data' : `Target opponent not found in historical opponents: ${[...(historicalStatsDiagnostics?.uniqueOpponents ?? new Set<string>())].slice(0, 5).join(', ')}`}</p>
            </div>
          )}
        </div>

        {((usePositionEdgeInEV && matchupDiagnostics.rowsWithPosAdj === 0) ||
          (useVenueEdge && matchupDiagnostics.rowsWithVenueAdj === 0) ||
          (useOpponentEdge && matchupDiagnostics.rowsWithOppAdj === 0)) &&
          (usePositionEdgeInEV || useVenueEdge || useOpponentEdge) && (
          <div className="mt-3 flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            Toggle is ON but no rows are receiving adjustment. Check data coverage and matching.
          </div>
        )}
      </div>

      {/* Selected Match Coverage: Why not showing? */}
      {selectedMatch && odds.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-blue-400" />
            <h3 className="text-white font-semibold text-sm">Selected Match Coverage</h3>
            <span className="text-xs text-emerald-400">{selectedMatch.home_team} vs {selectedMatch.away_team}</span>
          </div>
          <div className="p-3 space-y-2">
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-xs">
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Match Odds Rows</p>
                <p className="text-white font-bold">{odds.length}</p>
              </div>
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Unique Players</p>
                <p className="text-white font-bold">{oddsCoverage.uniqueBookmakerNames}</p>
              </div>
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Resolved Rows</p>
                <p className="text-emerald-400 font-bold">{oddsCoverage.resolvedRows}</p>
              </div>
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Unresolved Rows</p>
                <p className="text-red-400 font-bold">{oddsCoverage.unresolvedRows}</p>
              </div>
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Model Ready</p>
                <p className="text-emerald-400 font-bold">{oddsCoverage.withModel}</p>
              </div>
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Odds Only</p>
                <p className="text-amber-400 font-bold">{oddsCoverage.oddsOnly}</p>
              </div>
            </div>
            <div className="grid grid-cols-4 gap-2 text-xs">
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Player Unresolved</p>
                <p className="text-red-400 font-bold">{oddsCoverage.playerUnresolved}</p>
              </div>
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">No Player Stats</p>
                <p className="text-red-400 font-bold">{oddsCoverage.noPlayerStats}</p>
              </div>
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Insufficient Market Sample</p>
                <p className="text-amber-400 font-bold">{oddsCoverage.insufficientMarketSample}</p>
              </div>
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Wrong Team</p>
                <p className="text-red-400 font-bold">{oddsCoverage.wrongTeam}</p>
              </div>
            </div>
            {oddsFetchDiag && (
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="bg-gray-800/50 rounded p-2">
                  <p className="text-gray-500">Odds Rows Loaded</p>
                  <p className="text-white font-bold">{oddsFetchDiag.totalRowsLoaded}</p>
                </div>
                <div className="bg-gray-800/50 rounded p-2">
                  <p className="text-gray-500">Odds Query Pages</p>
                  <p className="text-white font-bold">{oddsFetchDiag.queryPages}</p>
                </div>
                <div className="bg-gray-800/50 rounded p-2">
                  <p className="text-gray-500">Odds Query Capped</p>
                  <p className={`font-bold ${oddsFetchDiag.queryCapped ? 'text-red-400' : 'text-emerald-400'}`}>
                    {oddsFetchDiag.queryCapped ? 'YES' : 'NO'}
                  </p>
                </div>
              </div>
            )}
            {oddsCoverage.noStatsReasons && Object.keys(oddsCoverage.noStatsReasons).length > 0 && (
              <div className="text-xs">
                <span className="text-gray-500 font-medium">No-Stats Reasons: </span>
                {Object.entries(oddsCoverage.noStatsReasons).map(([reason, count]) => (
                  <span key={reason} className="mr-3 text-orange-400 font-mono">{reason}: {count}</span>
                ))}
              </div>
            )}
            {/* Repair No-Stats Odds Links */}
            <div className="flex items-center gap-3 pt-2 border-t border-gray-800/50">
              <button
                onClick={handleRepairNoStatsLinks}
                disabled={repairNoStatsRunning || !selectedMatchId}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-medium rounded-lg flex items-center gap-1.5"
              >
                {repairNoStatsRunning ? <Loader2 className="w-3 h-3 animate-spin" /> : <LinkIcon className="w-3 h-3" />}
                Repair No-Stats Odds Links
              </button>
              {repairNoStatsResult && (
                <div className="text-xs text-gray-400 flex flex-wrap gap-3">
                  <span>Checked: <span className="text-white font-mono">{repairNoStatsResult.oddsRowsChecked}</span></span>
                  <span>No-stats found: <span className="text-orange-400 font-mono">{repairNoStatsResult.noStatsRowsFound}</span></span>
                  <span>Relinked: <span className="text-emerald-400 font-mono">{repairNoStatsResult.relinked}</span></span>
                  <span>Still no stats: <span className="text-red-400 font-mono">{repairNoStatsResult.stillNoStats}</span></span>
                  <span>Duplicate conflicts: <span className="text-amber-400 font-mono">{repairNoStatsResult.duplicateConflicts}</span></span>
                  <span>Errors: <span className="text-red-400 font-mono">{repairNoStatsResult.errors}</span></span>
                </div>
              )}
            </div>
            {/* Model Coverage Debug */}
            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={() => {
                  if (!showModelCoverage) handleLoadModelCoverage();
                  setShowModelCoverage(!showModelCoverage);
                }}
                disabled={modelCoverageLoading || odds.length === 0}
                className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-xs font-medium rounded-lg flex items-center gap-1.5"
              >
                {modelCoverageLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Eye className="w-3 h-3" />}
                {showModelCoverage ? 'Hide' : 'Show'} Model Coverage Debug
              </button>
            </div>
            {showModelCoverage && modelCoverageData.length > 0 && (
              <div className="max-h-[400px] overflow-y-auto border border-gray-800 rounded-lg">
                <table className="w-full text-[10px]">
                  <thead className="bg-gray-800/50 sticky top-0">
                    <tr>
                      <th className="px-2 py-1 text-left text-gray-500">Bookmaker Name</th>
                      <th className="px-2 py-1 text-left text-gray-500">Odds Player ID</th>
                      <th className="px-2 py-1 text-left text-gray-500">Player Name</th>
                      <th className="px-2 py-1 text-left text-gray-500">Team</th>
                      <th className="px-2 py-1 text-right text-gray-500">Total Stats</th>
                      <th className="px-2 py-1 text-right text-gray-500">Disp</th>
                      <th className="px-2 py-1 text-right text-gray-500">Marks</th>
                      <th className="px-2 py-1 text-right text-gray-500">Tack</th>
                      <th className="px-2 py-1 text-right text-gray-500">Goals</th>
                      <th className="px-2 py-1 text-right text-gray-500">HO</th>
                      <th className="px-2 py-1 text-right text-gray-500">W/Model</th>
                      <th className="px-2 py-1 text-right text-gray-500">No Model</th>
                      <th className="px-2 py-1 text-left text-gray-500">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {modelCoverageData.map((e, i) => (
                      <tr key={i} className="border-b border-gray-800/30">
                        <td className="px-2 py-1 text-gray-300">{e.bookmakerPlayerName}</td>
                        <td className="px-2 py-1 text-gray-500 font-mono">{e.oddsPlayerId ? e.oddsPlayerId.slice(0, 8) : 'NULL'}</td>
                        <td className="px-2 py-1 text-gray-300">{e.playerName ?? '—'}</td>
                        <td className="px-2 py-1 text-gray-400">{e.playerTeam ?? '—'}</td>
                        <td className="px-2 py-1 text-right text-white font-mono">{e.totalStatsRows}</td>
                        <td className="px-2 py-1 text-right text-gray-400 font-mono">{e.disposalsSample}</td>
                        <td className="px-2 py-1 text-right text-gray-400 font-mono">{e.marksSample}</td>
                        <td className="px-2 py-1 text-right text-gray-400 font-mono">{e.tacklesSample}</td>
                        <td className="px-2 py-1 text-right text-gray-400 font-mono">{e.goalsSample}</td>
                        <td className="px-2 py-1 text-right text-gray-400 font-mono">{e.hitoutsSample}</td>
                        <td className="px-2 py-1 text-right text-emerald-400 font-mono">{e.marketsWithModel}</td>
                        <td className="px-2 py-1 text-right text-orange-400 font-mono">{e.marketsWithoutModel}</td>
                        <td className="px-2 py-1">
                          <span className={`font-mono ${
                            e.reasonWithoutModel === 'PLAYER_ID_NULL' ? 'text-red-400' :
                            e.reasonWithoutModel === 'PLAYER_ID_HAS_ZERO_STATS' ? 'text-red-400' :
                            e.reasonWithoutModel === 'INSUFFICIENT_MARKET_SAMPLE' ? 'text-amber-400' :
                            e.reasonWithoutModel === 'DUPLICATE_PLAYER_ID_HAS_STATS_ELSEWHERE' ? 'text-blue-400' :
                            'text-gray-400'
                          }`}>{e.reasonWithoutModel}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {oddsCoverage.unresolvedNamesList.length > 0 && (
              <div className="text-xs text-gray-500">
                <span className="font-medium">Unresolved bookmaker names:</span>{' '}
                {oddsCoverage.unresolvedNamesList.map(n => <span key={n} className="mr-2 text-red-400">{n}</span>)}
              </div>
            )}
            {/* Wrong-Team Debug */}
            <div className="flex items-center gap-3 pt-2 border-t border-gray-800/50">
              <button
                onClick={() => setShowWrongTeamDebug(!showWrongTeamDebug)}
                className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs font-medium rounded-lg flex items-center gap-1.5"
              >
                <Shield className="w-3 h-3" />
                {showWrongTeamDebug ? 'Hide' : 'Show'} Excluded Wrong-Team Rows
              </button>
              <span className="text-xs text-gray-500">
                Wrong Team: <span className="text-red-400 font-mono">{oddsCoverage.wrongTeam}</span>
                {oddsCoverage.wrongMatchId > 0 && (
                  <span className="ml-2">Wrong Match ID: <span className="text-red-400 font-mono">{oddsCoverage.wrongMatchId}</span></span>
                )}
                {oddsCoverage.playerTeamMissing > 0 && (
                  <span className="ml-2">Missing Team: <span className="text-amber-400 font-mono">{oddsCoverage.playerTeamMissing}</span></span>
                )}
              </span>
            </div>
            {showWrongTeamDebug && (() => {
              const excludedRows = evRows.filter(r =>
                r.exclusionReason === 'WRONG_TEAM' ||
                r.exclusionReason === 'WRONG_MATCH_ID' ||
                r.exclusionReason === 'PLAYER_TEAM_MISSING'
              );
              const homeNorm = selectedMatch ? normalizeOpponentName(selectedMatch.home_team) : '';
              const awayNorm = selectedMatch ? normalizeOpponentName(selectedMatch.away_team) : '';
              return (
                <div className="max-h-[300px] overflow-y-auto border border-gray-800 rounded-lg">
                  <table className="w-full text-[10px]">
                    <thead className="bg-gray-800/50 sticky top-0">
                      <tr>
                        <th className="px-2 py-1 text-left text-gray-500">Bookmaker Name</th>
                        <th className="px-2 py-1 text-left text-gray-500">Player ID</th>
                        <th className="px-2 py-1 text-left text-gray-500">Player Name</th>
                        <th className="px-2 py-1 text-left text-gray-500">Player Team</th>
                        <th className="px-2 py-1 text-left text-gray-500">Norm Team</th>
                        <th className="px-2 py-1 text-left text-gray-500">Home</th>
                        <th className="px-2 py-1 text-left text-gray-500">Norm Home</th>
                        <th className="px-2 py-1 text-left text-gray-500">Away</th>
                        <th className="px-2 py-1 text-left text-gray-500">Norm Away</th>
                        <th className="px-2 py-1 text-left text-gray-500">Match ID</th>
                        <th className="px-2 py-1 text-left text-gray-500">Selected ID</th>
                        <th className="px-2 py-1 text-center text-gray-500">Included</th>
                        <th className="px-2 py-1 text-left text-gray-500">Exclusion Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {excludedRows.length === 0 ? (
                        <tr><td colSpan={13} className="px-2 py-3 text-center text-gray-500">No excluded rows — all players match the selected match teams.</td></tr>
                      ) : excludedRows.slice(0, 100).map((r, i) => (
                        <tr key={r.id || i} className="border-b border-gray-800/30">
                          <td className="px-2 py-1 text-gray-300">{r.player_name}</td>
                          <td className="px-2 py-1 text-gray-500 font-mono">{r.resolvedPlayerId ? r.resolvedPlayerId.slice(0, 8) : 'NULL'}</td>
                          <td className="px-2 py-1 text-gray-300">{r.player_name}</td>
                          <td className="px-2 py-1 text-gray-400">{r.playerTeam || '—'}</td>
                          <td className="px-2 py-1 text-gray-400 font-mono">{r.playerTeamNorm || '—'}</td>
                          <td className="px-2 py-1 text-gray-400">{selectedMatch?.home_team ?? '—'}</td>
                          <td className="px-2 py-1 text-gray-400 font-mono">{homeNorm}</td>
                          <td className="px-2 py-1 text-gray-400">{selectedMatch?.away_team ?? '—'}</td>
                          <td className="px-2 py-1 text-gray-400 font-mono">{awayNorm}</td>
                          <td className="px-2 py-1 text-gray-500 font-mono">{r.match_id ? String(r.match_id).slice(0, 8) : '—'}</td>
                          <td className="px-2 py-1 text-gray-500 font-mono">{selectedMatch?.id.slice(0, 8) ?? '—'}</td>
                          <td className="px-2 py-1 text-center">
                            <span className={r.exclusionReason ? 'text-red-400' : 'text-emerald-400'}>
                              {r.exclusionReason ? 'NO' : 'YES'}
                            </span>
                          </td>
                          <td className="px-2 py-1">
                            <span className="text-red-400 font-mono">{r.exclusionReason ?? '—'}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {excludedRows.length > 100 && (
                    <p className="text-[10px] text-gray-500 p-2">Showing 100 of {excludedRows.length} excluded rows</p>
                  )}
                </div>
              );
            })()}
            {/* Audit Selected Match Odds Contamination */}
            <div className="flex items-center gap-3 pt-2 border-t border-gray-800/50">
              <button
                onClick={handleAuditSelectedMatch}
                disabled={auditRunning || !selectedMatchId}
                className="px-3 py-1.5 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-xs font-medium rounded-lg flex items-center gap-1.5"
              >
                {auditRunning ? <Loader2 className="w-3 h-3 animate-spin" /> : <BarChart3 className="w-3 h-3" />}
                Audit Selected Match Odds Contamination
              </button>
              {auditResult && (
                <div className="text-xs text-gray-400 flex flex-wrap gap-3">
                  <span>Total odds: <span className="text-white font-mono">{auditResult.totalOddsRows}</span></span>
                  <span>Unique players: <span className="text-white font-mono">{auditResult.uniqueBookmakerPlayers}</span></span>
                  <span>Null player_id: <span className="text-red-400 font-mono">{auditResult.nullPlayerIdRows}</span></span>
                  <span>Wrong team: <span className="text-red-400 font-mono">{auditResult.wrongTeamRows}</span></span>
                  <span>Missing team: <span className="text-amber-400 font-mono">{auditResult.missingTeamRows}</span></span>
                  <span>Eligible: <span className="text-emerald-400 font-mono">{auditResult.eligibleRows}</span></span>
                </div>
              )}
            </div>
            {/* Global Audit */}
            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={handleGlobalAudit}
                disabled={globalAuditRunning}
                className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-xs font-medium rounded-lg flex items-center gap-1.5"
              >
                {globalAuditRunning ? <Loader2 className="w-3 h-3 animate-spin" /> : <BarChart3 className="w-3 h-3" />}
                Global Odds Contamination Audit
              </button>
            </div>
            {globalAuditData.length > 0 && (
              <div className="max-h-[300px] overflow-y-auto border border-gray-800 rounded-lg">
                <table className="w-full text-[10px]">
                  <thead className="bg-gray-800/50 sticky top-0">
                    <tr>
                      <th className="px-2 py-1 text-left text-gray-500">Match</th>
                      <th className="px-2 py-1 text-left text-gray-500">Match ID</th>
                      <th className="px-2 py-1 text-right text-gray-500">Total Odds</th>
                      <th className="px-2 py-1 text-right text-gray-500">Valid</th>
                      <th className="px-2 py-1 text-right text-gray-500">Wrong Team</th>
                      <th className="px-2 py-1 text-right text-gray-500">Missing Team</th>
                      <th className="px-2 py-1 text-right text-gray-500">Unresolved</th>
                    </tr>
                  </thead>
                  <tbody>
                    {globalAuditData.map((a, i) => (
                      <tr key={i} className="border-b border-gray-800/30">
                        <td className="px-2 py-1 text-gray-300">{a.matchName}</td>
                        <td className="px-2 py-1 text-gray-500 font-mono">{a.matchId.slice(0, 8)}</td>
                        <td className="px-2 py-1 text-right text-white font-mono">{a.totalOddsRows}</td>
                        <td className="px-2 py-1 text-right text-emerald-400 font-mono">{a.validRows}</td>
                        <td className="px-2 py-1 text-right text-red-400 font-mono">{a.wrongTeamRows}</td>
                        <td className="px-2 py-1 text-right text-amber-400 font-mono">{a.missingTeamRows}</td>
                        <td className="px-2 py-1 text-right text-gray-400 font-mono">{a.unresolvedRows}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Odds-Only Markets Section */}
      {oddsOnlyRows.length > 0 && !finalCardMode && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-amber-500/30 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-amber-400" />
            <h3 className="text-amber-400 font-semibold text-sm">Odds-Only Markets</h3>
            <span className="text-xs text-gray-500">— have bookmaker odds but no model ({oddsOnlyRows.length} rows)</span>
          </div>
          <div className="p-3 max-h-[300px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-800/30 border-b border-gray-800 sticky top-0">
                <tr>
                  <th className="px-2 py-1.5 text-left text-gray-500">Player</th>
                  <th className="px-2 py-1.5 text-left text-gray-500">Market</th>
                  <th className="px-2 py-1.5 text-right text-gray-500">Line</th>
                  <th className="px-2 py-1.5 text-right text-gray-500">Odds</th>
                  <th className="px-2 py-1.5 text-left text-gray-500">Status</th>
                  <th className="px-2 py-1.5 text-left text-gray-500">Reason</th>
                  <th className="px-2 py-1.5 text-right text-gray-500">Total Stats</th>
                  <th className="px-2 py-1.5 text-right text-gray-500">Market Sample</th>
                </tr>
              </thead>
              <tbody>
                {oddsOnlyRows.slice(0, 50).map((r, i) => (
                  <tr key={r.id || i} className="border-b border-gray-800/30">
                    <td className="px-2 py-1.5 text-gray-300">{r.player_name}</td>
                    <td className="px-2 py-1.5 text-gray-400">{r.display_label}</td>
                    <td className="px-2 py-1.5 text-right text-gray-300 font-mono">{r.line}</td>
                    <td className="px-2 py-1.5 text-right text-white font-mono">{r.over_odds.toFixed(2)}</td>
                    <td className="px-2 py-1.5">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                        r.modelStatus === 'PLAYER_UNRESOLVED' ? 'bg-red-500/20 text-red-400' :
                        r.modelStatus === 'NO_STATS' ? 'bg-orange-500/20 text-orange-400' :
                        r.modelStatus === 'INSUFFICIENT_MARKET_SAMPLE' ? 'bg-amber-500/20 text-amber-400' :
                        r.modelStatus === 'STALE_OR_LIMITED_SAMPLE' ? 'bg-yellow-500/20 text-yellow-400' :
                        'bg-gray-600/30 text-gray-400'
                      }`}>
                        {r.modelStatus.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="px-2 py-1.5">
                      <span className="text-[10px] text-gray-500 font-mono">
                        {r.noStatsReason ?? '—'}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-right text-[10px] text-gray-500 font-mono">
                      {r.totalStatsRows > 0 ? `${r.totalStatsRows} rows` : '—'}
                    </td>
                    <td className="px-2 py-1.5 text-right text-[10px] text-gray-500 font-mono">
                      {r.marketSampleCount > 0 ? `${r.marketSampleCount} sample` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {oddsOnlyRows.length > 50 && (
              <p className="text-[10px] text-gray-500 mt-2">Showing 50 of {oddsOnlyRows.length} odds-only rows</p>
            )}
          </div>
        </div>
      )}

      {/* Best Bets — Best Line Optimizer */}
      {bestBetsCount > 0 && (
        <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl overflow-hidden">
          <div className="px-4 py-3 bg-emerald-500/15 border-b border-emerald-500/30 flex items-center gap-2 flex-wrap">
            <Zap className="w-4 h-4 text-emerald-400" />
            <h3 className="text-emerald-400 font-semibold text-sm">Best Bets</h3>
            <span className="text-xs text-gray-500">One best line per player + stat — using {SAMPLE_WINDOW_LABELS[sampleWindow]}</span>
            <div className="flex items-center gap-1 ml-auto flex-wrap">
              {([
                ['bestOverall', 'Best Overall'],
                ['safeEdge', 'Safe Edge'],
                ['sweetSpots', 'Sweet Spots'],
                ['valueHunter', 'Value Hunter'],
                ['longshots', 'Longshots'],
              ] as [BestBetTab, string][]).map(([tab, label]) => (
                <button
                  key={tab}
                  onClick={() => setBestBetTab(tab)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium transition ${bestBetTab === tab ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="p-3 space-y-2">
            {bestBetGroups.map(({ bestLine, allLines }) => {
              const groupKey = `${bestLine.playerKey}|${bestLine.statKey}`;
              const expanded = expandedGroups.has(groupKey);
              const r = bestLine.row as EVRow;
              return (
                <div key={groupKey} className="bg-gray-900/50 rounded-lg border border-gray-700/50 overflow-hidden">
                  {/* Best Line row */}
                  <div className="p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-white font-medium text-sm truncate">{bestLine.playerName}</p>
                          {bestLine.sweetSpot && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-amber-500/20 text-amber-400 rounded text-xs font-bold">
                              <Sparkles className="w-3 h-3" /> Sweet Spot
                            </span>
                          )}
                        </div>
                        <p className="text-gray-400 text-xs">{bestLine.statKey} — Best Line: {bestLine.displayLabel} @ {bestLine.odds.toFixed(2)}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <span className="text-emerald-400 font-bold">{bestLine.odds.toFixed(2)}</span>
                        <p className="text-xs text-emerald-400">+{(((usePositionEdgeInEV || useVenueEdge || useOpponentEdge ? bestLine.finalEV : bestLine.adjustedEV) ?? 0) * 100).toFixed(1)}%</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 mt-2 text-xs text-gray-500 flex-wrap">
                      <Shield className="w-3 h-3" />
                      <span>{bestLine.hitCount}/{bestLine.sampleSize}</span>
                      <span className={`px-1.5 py-0.5 rounded ${bestLine.riskLevel === 'Low' ? 'bg-emerald-500/20 text-emerald-400' : bestLine.riskLevel === 'Medium' ? 'bg-amber-500/20 text-amber-400' : 'bg-red-500/20 text-red-400'}`}>
                        {bestLine.riskLevel}
                      </span>
                      <span className="text-blue-400">Q:{bestLine.qualityScore.toFixed(0)}</span>
                      {bestLine.stakeUnits > 0 && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-blue-500/15 text-blue-400 rounded font-semibold">
                          <DollarSign className="w-3 h-3" />{bestLine.stakeUnits}u
                        </span>
                      )}
                      <div className="flex items-center gap-1 ml-auto">
                        <button onClick={() => handleWatchBet(r)} disabled={watchingBet === r.id} className="p-1 bg-amber-500/20 text-amber-400 rounded hover:bg-amber-500/30 disabled:opacity-50" title="Watch">
                          <Eye className="w-3 h-3" />
                        </button>
                        <button onClick={() => handleTrackBet(r)} disabled={trackingBet === r.id} className="p-1 bg-blue-500/20 text-blue-400 rounded hover:bg-blue-500/30 disabled:opacity-50" title="Track Bet">
                          <Bookmark className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                    {allLines.length > 1 && (
                      <button onClick={() => toggleGroup(groupKey)} className="mt-2 flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition">
                        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                        {expanded ? 'Hide all lines' : `Show all lines (${allLines.length})`}
                      </button>
                    )}
                  </div>
                  {/* Expanded ladder */}
                  {expanded && allLines.length > 1 && (
                    <div className="border-t border-gray-700/40 bg-gray-900/30">
                      {allLines.map(line => {
                        const lr = line.row as EVRow;
                        const lGrade = {
                          adjustedProb: lr.modelProb.adjustedProb,
                          adjustedEV: lr.adjustedEV,
                          qualityScore: lr.modelProb.quality_score,
                          odds: lr.over_odds,
                          sampleSize: lr.modelProb.sample_size,
                          hitCount: lr.modelProb.hit_count,
                          venueAdjustment: lr.modelProb.venue_adjustment,
                          opponentAdjustment: lr.modelProb.opponent_adjustment,
                          riskLevel: lr.modelProb.risk_level,
                          tags: lr.modelProb.tags,
                        };
                        const lSweet = isSweetSpot(lGrade).isSweetSpot;
                        const lStake = suggestStake(lGrade);
                        return (
                          <div key={line.id} className="px-3 py-2 flex items-center gap-2 text-xs border-b border-gray-800/30 last:border-0">
                            <span className="text-amber-300 font-mono w-12">{line.displayLabel}</span>
                            <span className="text-emerald-400 font-mono">{line.odds.toFixed(2)}</span>
                            <span className="text-gray-400">+{(((usePositionEdgeInEV || useVenueEdge || useOpponentEdge ? line.finalEV : line.adjustedEV) ?? 0) * 100).toFixed(1)}%</span>
                            <span className="text-blue-400">Q:{line.qualityScore.toFixed(0)}</span>
                            {lSweet && <span className="text-amber-400"><Sparkles className="w-3 h-3" /></span>}
                            {lStake.units > 0 && <span className="text-blue-400 font-semibold">{lStake.units}u</span>}
                            <span className={`px-1 py-0.5 rounded ${line.riskLevel === 'Low' ? 'bg-emerald-500/20 text-emerald-400' : line.riskLevel === 'Medium' ? 'bg-amber-500/20 text-amber-400' : 'bg-red-500/20 text-red-400'}`}>{line.riskLevel}</span>
                            <div className="flex items-center gap-1 ml-auto">
                              <button onClick={() => handleWatchBet(lr)} disabled={watchingBet === lr.id} className="p-0.5 bg-amber-500/20 text-amber-400 rounded hover:bg-amber-500/30 disabled:opacity-50" title="Watch">
                                <Eye className="w-3 h-3" />
                              </button>
                              <button onClick={() => handleTrackBet(lr)} disabled={trackingBet === lr.id} className="p-0.5 bg-blue-500/20 text-blue-400 rounded hover:bg-blue-500/30 disabled:opacity-50" title="Track">
                                <Bookmark className="w-3 h-3" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )

      // Model Explanation Panel
      }
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <button onClick={() => setShowModelExplainer(!showModelExplainer)} className="w-full px-4 py-3 flex items-center gap-2 text-left">
          <Info className="w-4 h-4 text-blue-400" />
          <h3 className="text-blue-400 font-semibold text-sm">Model Explanation</h3>
          <ChevronDown className={`w-4 h-4 text-gray-500 ml-auto transition ${showModelExplainer ? 'rotate-180' : ''}`} />
        </button>
        {showModelExplainer && (
          <div className="px-4 pb-4 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            {[
              ['Model P', 'Historical hit-rate model.'],
              ['Conservative P', 'Safer version of model probability.'],
              ['Venue Adj', 'Small capped adjustment based on venue history.'],
              ['Opponent Adj', 'Small capped adjustment based on opponent history.'],
              ['Adjusted P', 'Final probability used by the model.'],
              ['Adjusted EV', 'Expected value using adjusted probability.'],
              ['Quality Score', 'Overall bet rating out of 100.'],
              ['Sweet Spot', 'Best balance of price, probability, and sample strength.'],
            ].map(([term, desc]) => (
              <div key={term} className="flex gap-2">
                <span className="text-white font-medium shrink-0 w-24">{term}</span>
                <span className="text-gray-400">{desc}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Preset Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-gray-500">Presets:</span>
        <button
          onClick={() => applyPreset('realistic')}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${currentPreset === 'realistic' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
        >
          <Eye className="w-3 h-3 inline mr-1" />Realistic
        </button>
        <button
          onClick={() => applyPreset('safeEdge')}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${currentPreset === 'safeEdge' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
        >
          <Shield className="w-3 h-3 inline mr-1" />Safe Edge
        </button>
        <button
          onClick={() => applyPreset('valueHunter')}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${currentPreset === 'valueHunter' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
        >
          <Target className="w-3 h-3 inline mr-1" />Value Hunter
        </button>
      </div>

      {/* Filters */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h4 className="text-xs font-medium text-gray-500 uppercase">Filters</h4>
          {/* Sample Window Selector */}
          <div className="flex items-center gap-2 flex-wrap">
            <label className="text-xs text-gray-400 font-medium">Sample Window:</label>
            <select
              value={sampleWindow}
              onChange={e => setSampleWindow(e.target.value as SampleWindow)}
              className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white"
            >
              {SAMPLE_WINDOW_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            {sampleWindow === 'custom' && (
              <div className="flex items-center gap-1">
                <input type="date" value={customDateStart} onChange={e => setCustomDateStart(e.target.value)} className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white" />
                <span className="text-gray-500 text-xs">to</span>
                <input type="date" value={customDateEnd} onChange={e => setCustomDateEnd(e.target.value)} className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-white" />
              </div>
            )}
            {sampleWindow !== 'weighted' && (
              <span className="text-xs text-amber-400 bg-amber-500/10 px-2 py-1 rounded">
                {SAMPLE_WINDOW_LABELS[sampleWindow]} — {sampleWindow === 'last5' ? 'Last 5 is a small sample. Use it for form/context, not as a full edge by itself.' : ''}
              </span>
            )}
          </div>
          <div className="flex items-center gap-4 flex-wrap">
            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
              <input type="checkbox" checked={realisticOnly} onChange={e => setRealisticOnly(e.target.checked)} className="accent-emerald-500" />
              <Shield className="w-3 h-3 text-emerald-400" />
              Realistic only
            </label>
            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
              <input type="checkbox" checked={hideWeakVenue} onChange={e => setHideWeakVenue(e.target.checked)} className="accent-amber-500" />
              Hide Weak Venue
            </label>
            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
              <input type="checkbox" checked={hideWeakOpponent} onChange={e => setHideWeakOpponent(e.target.checked)} className="accent-amber-500" />
              Hide Weak Opp
            </label>
          </div>
        </div>

        {/* Position Edge Filters */}
        <div className="border-t border-gray-800/50 pt-3">
          <div className="flex items-center gap-2 mb-2">
            <Crosshair className="w-3.5 h-3.5 text-blue-400" />
            <span className="text-xs text-gray-400 font-medium">Position Edge Filters</span>
            <span className="text-[10px] text-gray-600">(display-only)</span>
          </div>
          <div className="flex items-center gap-4 flex-wrap">
            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
              <input type="checkbox" checked={includeUnknownPosition} onChange={e => setIncludeUnknownPosition(e.target.checked)} className="accent-blue-500" />
              Include Unknown Position
            </label>
            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
              <input type="checkbox" checked={showPositionBoostsOnly} onChange={e => setShowPositionBoostsOnly(e.target.checked)} className="accent-emerald-500" />
              Boosts Only
            </label>
            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
              <input type="checkbox" checked={hidePositionSuppressions} onChange={e => setHidePositionSuppressions(e.target.checked)} className="accent-red-500" />
              Hide Suppressions
            </label>
            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
              <input type="checkbox" checked={showVerySignificantOnly} onChange={e => setShowVerySignificantOnly(e.target.checked)} className="accent-amber-500" />
              Very Significant Only
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-4 mt-2">
            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
              <input type="checkbox" checked={usePositionEdgeInEV} onChange={e => setUsePositionEdgeInEV(e.target.checked)} className="accent-emerald-500" />
              <Zap className="w-3 h-3 text-emerald-400" />
              Use Position Edge
              {posEdgeStaleness?.isStale && (
                <span className="text-[10px] text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/30 ml-1" title={posEdgeStaleness.reason ?? ''}>
                  Stale
                </span>
              )}
            </label>
            {posEdgeStaleness?.isStale && (
              <button
                type="button"
                onClick={async () => {
                  setPosEdgeRecalculating(true);
                  const result = await recalculatePositionEdges();
                  setPosEdgeRecalculating(false);
                  if (result.success) {
                    getPositionEdgeStaleness().then(setPosEdgeStaleness);
                  }
                }}
                disabled={posEdgeRecalculating}
                className="text-[10px] px-2 py-0.5 bg-amber-500/20 text-amber-400 rounded border border-amber-500/30 hover:bg-amber-500/30 disabled:opacity-50 flex items-center gap-1"
              >
                {posEdgeRecalculating ? (
                  <><Loader2 className="w-3 h-3 animate-spin" /> Recalculating...</>
                ) : (
                  <>Recalc Position Edge</>
                )}
              </button>
            )}
            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
              <input type="checkbox" checked={useVenueEdge} onChange={e => setUseVenueEdge(e.target.checked)} className="accent-blue-500" />
              <MapPin className="w-3 h-3 text-blue-400" />
              Use Venue Edge
              {dataStatus?.isStale && (
                <span className="text-[10px] text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/30 ml-1" title="Venue edge is based on stale player stats">
                  Stale
                </span>
              )}
            </label>
            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
              <input type="checkbox" checked={useOpponentEdge} onChange={e => setUseOpponentEdge(e.target.checked)} className="accent-amber-500" />
              <Swords className="w-3 h-3 text-amber-400" />
              Use Player vs Opponent Edge
              {dataStatus?.isStale && (
                <span className="text-[10px] text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/30 ml-1" title="Opponent edge is based on stale player stats">
                  Stale
                </span>
              )}
            </label>
            <button
              type="button"
              onClick={() => setFinalCardMode(!finalCardMode)}
              className={`flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                finalCardMode
                  ? 'bg-yellow-500/20 border-yellow-500 text-yellow-300'
                  : 'bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-500'
              }`}
              title="Strict filters for high-confidence picks. Uses its own preset values — does not combine with manual filters."
            >
              <Award className="w-3 h-3" />
              Final Card
            </button>
            {finalCardMode && finalCardDiagnostics && (
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${
                finalCardDiagnostics.finalRows > 0
                  ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-400'
                  : finalCardDiagnostics.isStaleBlocked
                    ? 'bg-red-500/15 border border-red-500/30 text-red-400'
                    : 'bg-amber-500/15 border border-amber-500/30 text-amber-400'
              }`}>
                {finalCardDiagnostics.finalRows > 0
                  ? `Ready: ${finalCardDiagnostics.finalRows} rows`
                  : finalCardDiagnostics.isStaleBlocked
                    ? 'Stale Blocked'
                    : 'Empty'
                }
              </span>
            )}
            {finalCardMode && (
              <>
                <select
                  value={finalCardStrictness}
                  onChange={e => {
                    const newStrict = e.target.value as 'Conservative' | 'Balanced' | 'Loose';
                    setFinalCardStrictness(newStrict);
                    setBlockStaleData(FINAL_CARD_PRESETS[newStrict].blockStale);
                  }}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-white"
                  title="Final Card strictness level"
                >
                  <option value="Conservative">Conservative</option>
                  <option value="Balanced">Balanced</option>
                  <option value="Loose">Loose</option>
                </select>
                <label className="flex items-center gap-1.5 text-xs text-gray-300 cursor-pointer" title="Block stale data from Final Card. Default ON for Conservative/Balanced, OFF for Loose.">
                  <input type="checkbox" checked={blockStaleData} onChange={e => setBlockStaleData(e.target.checked)} className="accent-yellow-500" />
                  Block Stale
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setFinalCardStrictness('Balanced');
                    setBlockStaleData(true);
                  }}
                  className="text-xs px-2 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-gray-400 hover:text-white hover:border-gray-500"
                  title="Reset Final Card to Balanced defaults"
                >
                  Reset
                </button>
                <button
                  type="button"
                  onClick={() => setShowFinalCardDiagnostics(!showFinalCardDiagnostics)}
                  className={`text-xs px-2 py-1.5 bg-gray-800 border rounded-lg hover:text-white hover:border-gray-500 ${showFinalCardDiagnostics ? 'text-yellow-400 border-yellow-500/50' : 'text-gray-400 border-gray-700'}`}
                >
                  Diagnostics
                </button>
                <button
                  type="button"
                  onClick={() => setShowExcludedRows(!showExcludedRows)}
                  className={`text-xs px-2 py-1.5 bg-gray-800 border rounded-lg hover:text-white hover:border-gray-500 ${showExcludedRows ? 'text-red-400 border-red-500/50' : 'text-gray-400 border-gray-700'}`}
                >
                  Excluded ({finalCardDiagnostics?.excludedRows.length ?? 0})
                </button>
              </>
            )}
          </div>
          {finalCardMode && (
            <p className="text-[10px] text-gray-600 mt-1">
              Final Card uses its own preset rules — manual quality filters (Min Sample, Min Hits, Max Odds, Min EV, Min Adj P, Realistic Only, Position filters) are ignored. Only Stat and Search filters apply.
            </p>
          )}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Min Sample</label>
            <select value={minSample} onChange={e => { setMinSample(Number(e.target.value)); setCurrentPreset('realistic'); }} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm">
              {[5, 8, 10, 12, 15, 20, 25].map(n => <option key={n} value={n}>{n}+ games</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Min Hits</label>
            <select value={minHits} onChange={e => { setMinHits(Number(e.target.value)); setCurrentPreset('realistic'); }} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm">
              {[0, 1, 2, 3, 5, 10, 15].map(n => <option key={n} value={n}>{n}+ hits</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Max Odds</label>
            <select value={maxOdds} onChange={e => { setMaxOdds(Number(e.target.value)); setCurrentPreset('realistic'); }} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm">
              {[1.5, 2, 2.5, 3, 4, 5, 7, 10, 15, 20].map(n => <option key={n} value={n}>{n.toFixed(1)}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Min EV %</label>
            <select value={minEV} onChange={e => { setMinEV(Number(e.target.value)); setCurrentPreset('realistic'); }} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm">
              {[0, 1, 2, 3, 5, 8, 10, 15].map(n => <option key={n} value={n}>{n}%+</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Min Adj P %</label>
            <select value={minAdjProb} onChange={e => { setMinAdjProb(Number(e.target.value)); setCurrentPreset('realistic'); }} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-sm">
              {[5, 8, 10, 15, 20, 25, 30, 35, 40, 50, 60].map(n => <option key={n} value={n}>{n}%+</option>)}
            </select>
          </div>
        </div>
        <div className="flex gap-3 flex-wrap">
          <div className="relative flex-1 min-w-48">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input type="text" value={searchFilter} onChange={e => setSearchFilter(e.target.value)} placeholder="Filter player..." className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500" />
          </div>
          <select value={statFilter} onChange={e => setStatFilter(e.target.value)} className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white">
            {statTypes.map(t => <option key={t} value={t}>{t === 'all' ? 'All Markets' : t}</option>)}
          </select>
        </div>
      </div>

      {/* Match Integrity Warning */}
      {evRows.length > 0 && evRows.some(r => r.isWrongTeam) && (
        <div className="bg-orange-500/10 border border-orange-500/30 rounded-xl p-3 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-orange-400 mt-0.5 shrink-0" />
          <div className="text-xs text-orange-300">
            <span className="font-semibold">Match integrity issue:</span>{' '}
            {evRows.filter(r => r.isWrongTeam).length} player{evRows.filter(r => r.isWrongTeam).length !== 1 ? 's' : ''} from teams not in this match are flagged and excluded from Final Card.
            {' '}
            {(() => {
              const wrongTeams = new Map<string, string[]>();
              evRows.filter(r => r.isWrongTeam).forEach(r => {
                const t = r.playerTeam || 'Unknown';
                if (!wrongTeams.has(t)) wrongTeams.set(t, []);
                wrongTeams.get(t)!.push(r.player_name);
              });
              const topTeam = [...wrongTeams.entries()].sort((a, b) => b[1].length - a[1].length)[0];
              if (topTeam) return `Top: ${topTeam[0]} (${topTeam[1].slice(0, 3).join(', ')}${topTeam[1].length > 3 ? '…' : ''}).`;
              return '';
            })()}
          </div>
        </div>
      )}

      {/* Results */}
      {loading ? (
        <LoadingSpinner message="Loading odds..." />
      ) : odds.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center">
          <Calculator className="w-10 h-10 text-gray-700 mx-auto mb-3" />
          <p className="text-gray-400 font-medium">No odds for this match</p>
        </div>
      ) : statsSummary.withModel === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center">
          <BarChart3 className="w-10 h-10 text-amber-500 mx-auto mb-3" />
          <p className="text-gray-400 font-medium">0 model rows — player stats not matched</p>
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="overflow-x-auto max-h-[600px]">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-gray-800">
                <tr className="text-xs text-gray-500 uppercase tracking-wider border-b border-gray-700/50">
                  <th className="text-left px-3 py-3 font-medium">Player</th>
                  <th className="text-left px-2 py-3 font-medium">Stat</th>
                  <th className="text-center px-2 py-3 font-medium">Line</th>
                  <th className="text-center px-2 py-3 font-medium">Odds</th>
                  <th className="text-center px-2 py-3 font-medium">Hits</th>
                  <th className="text-center px-2 py-3 font-medium">
                    <Tooltip text="Model P: Historical probability based on season, last 10, last 5, and last 3 hit rates.">
                      <Info className="w-3 h-3" />
                    </Tooltip> P
                  </th>
                  <th className="text-center px-2 py-3 font-medium">
                    <Tooltip text="Conservative P: Model P reduced by confidence factor based on sample size.">
                      <Info className="w-3 h-3" />
                    </Tooltip> Cons
                  </th>
                  <th className="text-center px-2 py-3 font-medium">
                    <Tooltip text="Venue Edge Adjustment from historical venue data">
                      <Info className="w-3 h-3" />
                    </Tooltip> Venue Adj
                  </th>
                  <th className="text-center px-2 py-3 font-medium">
                    <Tooltip text="Opponent Edge Adjustment from historical opponent data">
                      <Info className="w-3 h-3" />
                    </Tooltip> Opp Adj
                  </th>
                  <th className="text-center px-2 py-3 font-medium">
                    <Tooltip text="Adjusted P: Final probability = Conservative + Venue Adj + Opponent Adj.">
                      <Info className="w-3 h-3" />
                    </Tooltip> Adj P
                  </th>
                  <th className="text-center px-2 py-3 font-medium">
                    <Tooltip text="Adjusted EV: Expected Value = (Adjusted Prob × Odds) - 1">
                      <Info className="w-3 h-3" />
                    </Tooltip> EV%
                  </th>
                  {(usePositionEdgeInEV || useVenueEdge || useOpponentEdge) && (
                    <>
                      <th className="text-center px-2 py-3 font-medium">
                        <Tooltip text="Position Edge Adjustment: capped at ±5pp">
                          <Info className="w-3 h-3" />
                        </Tooltip> Pos Adj
                      </th>
                      <th className="text-center px-2 py-3 font-medium">
                        <Tooltip text="Venue Edge Adjustment: capped at ±2pp">
                          <Info className="w-3 h-3" />
                        </Tooltip> Venue Adj
                      </th>
                      <th className="text-center px-2 py-3 font-medium">
                        <Tooltip text="Opponent Edge Adjustment: capped at ±2pp">
                          <Info className="w-3 h-3" />
                        </Tooltip> Opp Adj
                      </th>
                      <th className="text-center px-2 py-3 font-medium">
                        <Tooltip text="Total Matchup Adjustment: sum of all edge adjustments, capped at ±7pp">
                          <Info className="w-3 h-3" />
                        </Tooltip> Total Adj
                      </th>
                      <th className="text-center px-2 py-3 font-medium">
                        <Tooltip text="Final Probability = Adjusted Prob + Total Matchup Adjustment">
                          <Info className="w-3 h-3" />
                        </Tooltip> Final P
                      </th>
                      <th className="text-center px-2 py-3 font-medium">
                        <Tooltip text="Final EV = (Final Probability × Odds) - 1">
                          <Info className="w-3 h-3" />
                        </Tooltip> Final EV%
                      </th>
                    </>
                  )}
                  <th className="text-center px-2 py-3 font-medium">Risk</th>
                  <th className="text-center px-2 py-3 font-medium">Q</th>
                  <th className="text-center px-2 py-3 font-medium">
                    <Tooltip text="Position Edge: Matchup analysis for player's position group vs opponent. Boost = favor, Suppress = unfavorable.">
                      <Info className="w-3 h-3" />
                    </Tooltip> Pos Edge
                  </th>
                  <th className="text-center px-2 py-3 font-medium">Tag</th>
                  <th className="text-center px-2 py-3 font-medium">Stake</th>
                  <th className="text-center px-2 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {displayRows.map(row => (
                  <Fragment key={row.id}>
                  <tr className={`border-b border-gray-800/30 hover:bg-gray-800/30 transition ${(row.adjustedEV ?? 0) > 0 && row.isRealistic ? 'bg-emerald-500/5' : ''}`}>
                    <td className="px-3 py-2 text-white font-medium text-xs max-w-[120px] truncate">
                      <button
                        type="button"
                        onClick={() => setSelectedPlayerDetail(row)}
                        className="text-left hover:text-emerald-400 hover:underline cursor-pointer"
                        title="View player details"
                      >
                        {row.player_name}
                      </button>
                      {finalCardMode && row.finalCardGrade && (
                        <span className={`ml-1 inline-flex items-center justify-center w-4 h-4 rounded text-[10px] font-bold ${
                          row.finalCardGrade === 'A' ? 'bg-emerald-500/30 text-emerald-300 border border-emerald-500/50' :
                          row.finalCardGrade === 'B' ? 'bg-blue-500/30 text-blue-300 border border-blue-500/50' :
                          'bg-gray-600/30 text-gray-300 border border-gray-500/50'
                        }`} title={`Final Card Grade ${row.finalCardGrade}`}>
                          {row.finalCardGrade}
                        </span>
                      )}
                      {row.warnings.length > 0 && (
                        <div className="flex flex-wrap gap-0.5 mt-0.5">
                          {row.warnings.map(w => (
                            <span
                              key={w}
                              className={`text-[9px] px-1 py-0.5 rounded leading-none ${
                                MAJOR_WARNINGS.has(w)
                                  ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                                  : w === 'Longshot odds' || w === 'Position suppress'
                                    ? 'bg-orange-500/15 text-orange-400 border border-orange-500/25'
                                    : 'bg-amber-500/15 text-amber-400 border border-amber-500/25'
                              }`}
                              title={w}
                            >
                              {w}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-2 py-2 text-gray-400 text-xs capitalize">{extractStatType(row.raw_market)}</td>
                    <td className="px-2 py-2 text-center font-bold tabular-nums"><span className="text-amber-300">{row.display_label}</span></td>
                    <td className="px-2 py-2 text-center text-emerald-400 font-semibold tabular-nums">{row.over_odds.toFixed(2)}</td>
                    <td className="px-2 py-2 text-center text-xs"><span className="text-white">{row.modelProb.hit_count}</span><span className="text-gray-600">/{row.modelProb.sample_size}</span></td>
                    <td className="px-2 py-2 text-center text-xs text-gray-400 tabular-nums">{row.modelProb.probability ? `${(row.modelProb.probability * 100).toFixed(1)}%` : '—'}</td>
                    <td className="px-2 py-2 text-center text-xs text-gray-400 tabular-nums">{row.modelProb.conservativeProb ? `${(row.modelProb.conservativeProb * 100).toFixed(1)}%` : '—'}</td>
                    <td className={`px-2 py-2 text-center text-xs tabular-nums ${row.venueEdgeAdjustment >= 0 ? 'text-blue-400' : 'text-red-400'}`}>
                      {row.venueEdgeAdjustment >= 0 ? '+' : ''}{(row.venueEdgeAdjustment * 100).toFixed(1)}%
                    </td>
                    <td className={`px-2 py-2 text-center text-xs tabular-nums ${row.opponentEdgeAdjustment >= 0 ? 'text-amber-400' : 'text-red-400'}`}>
                      {row.opponentEdgeAdjustment >= 0 ? '+' : ''}{(row.opponentEdgeAdjustment * 100).toFixed(1)}%
                    </td>
                    <td className="px-2 py-2 text-center text-xs text-white tabular-nums font-medium">{row.modelProb.adjustedProb ? `${(row.modelProb.adjustedProb * 100).toFixed(1)}%` : '—'}</td>
                    <td className="px-2 py-2 text-center">
                      {(row.adjustedEV ?? 0) > 0 ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 rounded text-xs font-bold">
                          <TrendingUp className="w-3 h-3" />+{((row.adjustedEV ?? 0) * 100).toFixed(1)}%
                        </span>
                      ) : (
                        <span className="text-gray-500 text-xs">{((row.adjustedEV ?? 0) * 100).toFixed(1)}%</span>
                      )}
                    </td>
                    {(usePositionEdgeInEV || useVenueEdge || useOpponentEdge) && (
                      <>
                        <td className="px-2 py-2 text-center">
                          {row.positionEdgeAdjustment !== 0 ? (
                            <span className={`text-xs font-bold ${row.positionEdgeAdjustment > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {row.positionEdgeAdjustment > 0 ? '+' : ''}{(row.positionEdgeAdjustment * 100).toFixed(1)}%
                            </span>
                          ) : (
                            <span className="text-gray-600 text-xs">—</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-center">
                          {row.venueEdgeAdjustment !== 0 ? (
                            <span className={`text-xs font-bold ${row.venueEdgeAdjustment > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {row.venueEdgeAdjustment > 0 ? '+' : ''}{(row.venueEdgeAdjustment * 100).toFixed(1)}%
                            </span>
                          ) : (
                            <span className="text-gray-600 text-xs">—</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-center">
                          {row.opponentEdgeAdjustment !== 0 ? (
                            <span className={`text-xs font-bold ${row.opponentEdgeAdjustment > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {row.opponentEdgeAdjustment > 0 ? '+' : ''}{(row.opponentEdgeAdjustment * 100).toFixed(1)}%
                            </span>
                          ) : (
                            <span className="text-gray-600 text-xs">—</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-center">
                          {row.totalMatchupAdjustment !== 0 ? (
                            <span className={`text-xs font-bold ${row.totalMatchupAdjustment > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {row.totalMatchupAdjustment > 0 ? '+' : ''}{(row.totalMatchupAdjustment * 100).toFixed(1)}%
                            </span>
                          ) : (
                            <span className="text-gray-600 text-xs">—</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-center">
                          {row.finalProbability !== null ? (
                            <span className="text-white text-xs font-medium">{(row.finalProbability * 100).toFixed(1)}%</span>
                          ) : (
                            <span className="text-gray-600 text-xs">—</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-center">
                          {row.finalEV !== null && row.finalEV > 0 ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 rounded text-xs font-bold">
                              <TrendingUp className="w-3 h-3" />+{(row.finalEV * 100).toFixed(1)}%
                            </span>
                          ) : row.finalEV !== null ? (
                            <span className="text-gray-500 text-xs">{(row.finalEV * 100).toFixed(1)}%</span>
                          ) : (
                            <span className="text-gray-600 text-xs">—</span>
                          )}
                        </td>
                      </>
                    )}
                    <td className="px-2 py-2 text-center">
                      <span className={`px-1.5 py-0.5 rounded text-xs ${row.modelProb.risk_level === 'Low' ? 'bg-emerald-500/20 text-emerald-400' : row.modelProb.risk_level === 'Medium' ? 'bg-amber-500/20 text-amber-400' : 'bg-red-500/20 text-red-400'}`}>
                        {row.modelProb.risk_level}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-center text-xs text-blue-400 font-mono">{row.modelProb.quality_score.toFixed(0)}</td>
                    <td className="px-2 py-2 text-center">
                      <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-medium ${getPositionEdgeColor(row.positionEdge)}`} title={formatPositionEdgeShortLabel(row.positionEdge, row.positionGroup)}>
                        {row.positionGroup === 'UNKNOWN' ? 'UNKNOWN' : formatPositionEdgeLabel(row.positionEdge)}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-center">
                      {(() => {
                        const grade = {
                          adjustedProb: row.modelProb.adjustedProb,
                          adjustedEV: row.adjustedEV,
                          qualityScore: row.modelProb.quality_score,
                          odds: row.over_odds,
                          sampleSize: row.modelProb.sample_size,
                          hitCount: row.modelProb.hit_count,
                          venueAdjustment: row.modelProb.venue_adjustment,
                          opponentAdjustment: row.modelProb.opponent_adjustment,
                          riskLevel: row.modelProb.risk_level,
                          tags: row.modelProb.tags,
                        };
                        return isSweetSpot(grade).isSweetSpot ? (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-amber-500/20 text-amber-400 rounded text-xs font-bold">
                            <Sparkles className="w-3 h-3" /> Sweet Spot
                          </span>
                        ) : null;
                      })()}
                    </td>
                    <td className="px-2 py-2 text-center">
                      {(() => {
                        const grade = {
                          adjustedProb: row.modelProb.adjustedProb,
                          adjustedEV: row.adjustedEV,
                          qualityScore: row.modelProb.quality_score,
                          odds: row.over_odds,
                          sampleSize: row.modelProb.sample_size,
                          hitCount: row.modelProb.hit_count,
                          venueAdjustment: row.modelProb.venue_adjustment,
                          opponentAdjustment: row.modelProb.opponent_adjustment,
                          riskLevel: row.modelProb.risk_level,
                          tags: row.modelProb.tags,
                        };
                        const stake = suggestStake(grade);
                        return stake.units > 0 ? (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-blue-500/15 text-blue-400 rounded text-xs font-semibold">
                            <DollarSign className="w-3 h-3" />{stake.units}u
                          </span>
                        ) : <span className="text-gray-600 text-xs">—</span>;
                      })()}
                    </td>
                    <td className="px-2 py-2 text-center">
                      <div className="flex items-center gap-1 justify-center">
                        <button onClick={() => handleWatchBet(row)} disabled={watchingBet === row.id || !row.isRealistic} className="p-1 bg-amber-500/20 text-amber-400 rounded hover:bg-amber-500/30 disabled:opacity-30 disabled:cursor-not-allowed" title="Watch">
                          <Eye className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => handleTrackBet(row)} disabled={trackingBet === row.id || !row.isRealistic} className="p-1 bg-blue-500/20 text-blue-400 rounded hover:bg-blue-500/30 disabled:opacity-30 disabled:cursor-not-allowed" title="Track Bet">
                          <Bookmark className="w-3.5 h-3.5" />
                        </button>
                        {row.modelProb.sampleComparison && (
                          <button onClick={() => setShowSampleComparison(showSampleComparison === row.id ? null : row.id)} className="p-1 bg-gray-500/20 text-gray-400 rounded hover:bg-gray-500/30" title="Sample Comparison">
                            <BarChart3 className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button onClick={() => handleSpotCheck(row)} className="p-1 bg-emerald-500/20 text-emerald-400 rounded hover:bg-emerald-500/30" title="Verify Stats">
                          <Crosshair className="w-3.5 h-3.5" />
                        </button>
                        {row.resolvedPlayerId && (
                          <button onClick={() => handleViewGameLog(row)} className="p-1 bg-violet-500/20 text-violet-400 rounded hover:bg-violet-500/30" title="View Game Log Used">
                            <List className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {showSampleComparison === row.id && row.modelProb.sampleComparison && (
                    <tr className="bg-gray-800/20">
                      <td colSpan={13} className="px-4 py-3">
                        <div className="flex items-center gap-2 mb-2">
                          <BarChart3 className="w-3.5 h-3.5 text-blue-400" />
                          <span className="text-xs text-gray-400 font-medium">Sample Comparison — {row.player_name} {row.display_label}</span>
                          {row.modelProb.sampleWarningTags.map(tag => (
                            <span key={tag} className={`text-xs px-1.5 py-0.5 rounded ${tag === 'Small Sample' ? 'bg-red-500/20 text-red-400' : tag === 'Recent Spike' ? 'bg-emerald-500/20 text-emerald-400' : tag === 'Recent Drop' ? 'bg-red-500/20 text-red-400' : tag === 'Stable' ? 'bg-blue-500/20 text-blue-400' : tag === 'Volatile' ? 'bg-amber-500/20 text-amber-400' : 'bg-gray-700 text-gray-400'}`}>{tag}</span>
                          ))}
                        </div>
                        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                          {([
                            ['last5', 'Last 5'],
                            ['last10', 'Last 10'],
                            ['last15', 'Last 15'],
                            ['last20', 'Last 20'],
                            ['last30', 'Last 30'],
                            ['season', 'Current Season'],
                          ] as [keyof SampleComparison, string][]).map(([key, label]) => {
                            const w = row.modelProb.sampleComparison![key];
                            return (
                              <div key={key} className="bg-gray-800/40 rounded-lg p-2 text-center">
                                <p className="text-xs text-gray-500">{label}</p>
                                {w ? (
                                  <>
                                    <p className="text-white font-mono font-bold text-sm">{w.hit_count}/{w.sample_size}</p>
                                    <p className="text-xs text-gray-400">{(w.hit_rate * 100).toFixed(0)}%</p>
                                  </>
                                ) : (
                                  <p className="text-gray-600 text-sm">—</p>
                                )}
                              </div>
                            );
                          })}
                        </div>
                        {row.modelProb.sampleWindow !== 'weighted' && row.modelProb.sample_size < 10 && (
                          <p className="text-xs text-amber-400 mt-2">Small sample. Use this as context, not a full model edge.</p>
                        )}
                      </td>
                    </tr>
                  )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-2 border-t border-gray-800/50 text-xs text-gray-600">
            {displayRows.length} rows · Sorted by Quality Score{(usePositionEdgeInEV || useVenueEdge || useOpponentEdge) ? ' · Final EV' : ' · EV'} = ({(usePositionEdgeInEV || useVenueEdge || useOpponentEdge) ? 'Final P' : 'Adj P'} × odds) - 1{finalCardMode ? ' · Final Card ON' : ''}
          </div>
        </div>
      )}

      {/* Final Card Diagnostics */}
      {finalCardMode && showFinalCardDiagnostics && finalCardDiagnostics && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-yellow-400" />
            <h3 className="text-white font-semibold text-sm">Final Card Diagnostics — {finalCardStrictness}</h3>
            {blockStaleData && <span className="text-[10px] text-yellow-400 bg-yellow-500/10 px-2 py-0.5 rounded">Stale blocking ON</span>}
          </div>
          {/* Top exclusion reason summary */}
          {finalCardDiagnostics.topExclusionCount > 0 && (
            <div className={`text-xs rounded p-2 ${finalCardDiagnostics.isStaleBlocked ? 'bg-red-500/10 border border-red-500/30 text-red-400' : 'bg-amber-500/10 border border-amber-500/30 text-amber-400'}`}>
              {finalCardDiagnostics.isStaleBlocked
                ? `Final Card is empty because current stats are stale. ${finalCardDiagnostics.removedStale}/${finalCardDiagnostics.totalBefore} rows were removed for stale data. Turn on Loose mode or update player_game_stats.`
                : `Top exclusion: ${finalCardDiagnostics.topExclusionReason} (${finalCardDiagnostics.topExclusionCount} rows).`
              }
            </div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Total Before</p>
              <p className="text-white font-bold">{finalCardDiagnostics.totalBefore}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">No Model/Stats</p>
              <p className="text-red-400 font-bold">{finalCardDiagnostics.removedNoModel}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Stale Data</p>
              <p className="text-red-400 font-bold">{finalCardDiagnostics.removedStale}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">No Current Season</p>
              <p className="text-orange-400 font-bold">{finalCardDiagnostics.removedNoCurrentSeason}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Missing Team</p>
              <p className="text-amber-400 font-bold">{finalCardDiagnostics.removedMissingTeam}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Unresolved</p>
              <p className="text-amber-400 font-bold">{finalCardDiagnostics.removedUnresolved}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Min Sample</p>
              <p className="text-amber-400 font-bold">{finalCardDiagnostics.removedMinSample}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Min Hits</p>
              <p className="text-amber-400 font-bold">{finalCardDiagnostics.removedMinHits}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Max Odds</p>
              <p className="text-amber-400 font-bold">{finalCardDiagnostics.removedMaxOdds}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Min EV</p>
              <p className="text-amber-400 font-bold">{finalCardDiagnostics.removedMinEV}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Min Cons Prob</p>
              <p className="text-amber-400 font-bold">{finalCardDiagnostics.removedMinConsProb}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">UNKNOWN Pos</p>
              <p className="text-red-400 font-bold">{finalCardDiagnostics.removedUnknownPos}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Low-Conf Pos</p>
              <p className="text-amber-400 font-bold">{finalCardDiagnostics.removedLowConfPos}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Pos Suppression</p>
              <p className="text-amber-400 font-bold">{finalCardDiagnostics.removedPositionSuppress}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">No Stats</p>
              <p className="text-red-400 font-bold">{finalCardDiagnostics.removedNoStats}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Duplicate</p>
              <p className="text-red-400 font-bold">{finalCardDiagnostics.removedDuplicate}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Tiny-Sample Only</p>
              <p className="text-amber-400 font-bold">{finalCardDiagnostics.removedTinySampleOnly}</p>
            </div>
            <div className="bg-emerald-500/10 border border-emerald-500/30 rounded p-2">
              <p className="text-emerald-400">Final Rows</p>
              <p className="text-emerald-400 font-bold text-lg">{finalCardDiagnostics.finalRows}</p>
            </div>
          </div>
          {finalCardDiagnostics.topExcluded.length > 0 && (
            <div>
              <p className="text-xs text-gray-500 mb-1">Top 10 Excluded Rows:</p>
              <div className="space-y-1 max-h-40 overflow-y-auto">
                {finalCardDiagnostics.topExcluded.map((e, i) => (
                  <div key={i} className="text-xs bg-gray-800/50 rounded p-1.5 flex items-center gap-2">
                    <span className="text-white font-medium">{e.player}</span>
                    <span className="text-gray-500">{e.stat} {e.line}</span>
                    <span className="text-amber-400 ml-auto">{e.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Final Card Excluded Rows Table */}
      {finalCardMode && showExcludedRows && finalCardDiagnostics && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-2">
            <XCircle className="w-4 h-4 text-red-400" />
            <h3 className="text-white font-semibold text-sm">Final Card Excluded Rows — {finalCardDiagnostics.excludedRows.length} rows</h3>
          </div>
          <div className="overflow-x-auto max-h-[400px]">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-gray-800">
                <tr className="text-gray-500 uppercase tracking-wider border-b border-gray-700/50">
                  <th className="text-left px-2 py-2 font-medium">Player</th>
                  <th className="text-left px-2 py-2 font-medium">Stat</th>
                  <th className="text-center px-2 py-2 font-medium">Line</th>
                  <th className="text-center px-2 py-2 font-medium">Odds</th>
                  <th className="text-center px-2 py-2 font-medium">Model P</th>
                  <th className="text-center px-2 py-2 font-medium">Cons P</th>
                  <th className="text-center px-2 py-2 font-medium">EV%</th>
                  <th className="text-center px-2 py-2 font-medium">Sample</th>
                  <th className="text-center px-2 py-2 font-medium">Hits</th>
                  <th className="text-center px-2 py-2 font-medium">Pos</th>
                  <th className="text-center px-2 py-2 font-medium">Warnings</th>
                  <th className="text-left px-2 py-2 font-medium">Exclusion Reason</th>
                </tr>
              </thead>
              <tbody>
                {finalCardDiagnostics.excludedRows.slice(0, 100).map((e, i) => {
                  const r = e.row;
                  return (
                    <tr key={i} className="border-b border-gray-800/30 hover:bg-gray-800/30">
                      <td className="px-2 py-1.5 text-white font-medium">{r.player_name}</td>
                      <td className="px-2 py-1.5 text-gray-400">{extractStatType(r.raw_market)}</td>
                      <td className="px-2 py-1.5 text-center text-gray-300">{r.display_label}</td>
                      <td className="px-2 py-1.5 text-center text-gray-300">{r.over_odds.toFixed(2)}</td>
                      <td className="px-2 py-1.5 text-center text-gray-300">{r.modelProb.probability !== null ? `${(r.modelProb.probability * 100).toFixed(0)}%` : '—'}</td>
                      <td className="px-2 py-1.5 text-center text-gray-300">{r.modelProb.conservativeProb !== null ? `${(r.modelProb.conservativeProb * 100).toFixed(0)}%` : '—'}</td>
                      <td className="px-2 py-1.5 text-center text-gray-300">{((r.finalEV ?? r.adjustedEV ?? 0) * 100).toFixed(1)}%</td>
                      <td className="px-2 py-1.5 text-center text-gray-300">{r.modelProb.sample_size}</td>
                      <td className="px-2 py-1.5 text-center text-gray-300">{r.modelProb.hit_count}</td>
                      <td className="px-2 py-1.5 text-center">
                        <span className={`text-[10px] px-1 py-0.5 rounded ${r.positionGroup === 'UNKNOWN' ? 'bg-red-500/20 text-red-400' : 'bg-gray-700 text-gray-300'}`}>
                          {r.positionGroup}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-center text-[10px] text-gray-500">
                        {r.warnings.length > 0 ? r.warnings.join(', ') : '—'}
                      </td>
                      <td className="px-2 py-1.5 text-amber-400">{e.reason}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {finalCardDiagnostics.excludedRows.length > 100 && (
            <div className="px-4 py-2 border-t border-gray-800/50 text-xs text-gray-600">
              Showing first 100 of {finalCardDiagnostics.excludedRows.length} excluded rows.
            </div>
          )}
        </div>
      )}

      {/* Final Card 0 rows message + Recommended Watchlist */}
      {finalCardMode && displayRows.length === 0 && finalCardDiagnostics && (
        <div className={`border rounded-xl p-4 space-y-3 ${finalCardDiagnostics.isStaleBlocked ? 'bg-red-500/10 border-red-500/30' : 'bg-amber-500/10 border-amber-500/30'}`}>
          <div className="flex items-center gap-2">
            <AlertCircle className={`w-4 h-4 ${finalCardDiagnostics.isStaleBlocked ? 'text-red-400' : 'text-amber-400'}`} />
            <h3 className={`font-semibold text-sm ${finalCardDiagnostics.isStaleBlocked ? 'text-red-400' : 'text-amber-400'}`}>
              {finalCardDiagnostics.isStaleBlocked
                ? 'Final Card blocked because latest player stats are stale.'
                : `No rows passed ${finalCardStrictness} strictness.`
              }
            </h3>
          </div>
          <p className="text-xs text-gray-400">
            {finalCardDiagnostics.isStaleBlocked
              ? `Final Card is empty because current stats are stale. ${finalCardDiagnostics.removedStale}/${finalCardDiagnostics.totalBefore} rows were removed for stale data. Latest player stats are mostly only updated to R${finalCardDiagnostics.topExcluded[0]?.reason.match(/Round (\d+)/)?.[1] ?? '?'} while expected latest round is R${latestCompletedRound ?? '?'}. Turn on Loose mode or update player_game_stats.`
              : `Top exclusion: ${finalCardDiagnostics.topExclusionReason} (${finalCardDiagnostics.topExclusionCount} rows). Try Loose mode or adjust the stale-data toggle.`
            }
          </p>
          {finalCardDiagnostics.watchlist.length > 0 && (
            <div>
              <p className="text-xs text-gray-500 mb-2">Recommended Watchlist — Not Final Card picks ({finalCardDiagnostics.watchlist.length} rows):</p>
              <div className="space-y-1.5">
                {finalCardDiagnostics.watchlist.map((w, i) => {
                  const r = w.row;
                  return (
                    <div key={i} className="bg-gray-800/50 rounded p-2 flex items-center gap-2 text-xs">
                      <span className="text-white font-medium">{r.player_name}</span>
                      <span className="text-gray-500">{extractStatType(r.raw_market)} {r.display_label}</span>
                      <span className="text-emerald-400">@ {r.over_odds.toFixed(2)}</span>
                      <span className="text-emerald-400">+{((r.finalEV ?? r.adjustedEV ?? 0) * 100).toFixed(1)}%</span>
                      <span className="text-gray-500">Q:{r.modelProb.quality_score.toFixed(0)}</span>
                      {r.isStale && <span className="text-red-400 text-[10px] bg-red-500/10 px-1 rounded">STALE</span>}
                      <span className="text-amber-400 ml-auto text-[10px]">{w.reason}</span>
                      <button onClick={() => handleWatchBet(r)} disabled={watchingBet === r.id} className="p-1 bg-amber-500/20 text-amber-400 rounded hover:bg-amber-500/30 disabled:opacity-50" title="Watch">
                        <Eye className="w-3 h-3" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Player Details Drawer */}
      {selectedPlayerDetail && (
        <div
          className="fixed inset-0 z-50 flex justify-end"
          onClick={() => setSelectedPlayerDetail(null)}
        >
          <div className="absolute inset-0 bg-black/60" />
          <div
            className="relative w-full max-w-md h-full bg-gray-900 border-l border-gray-700 shadow-2xl overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            <div className="sticky top-0 bg-gray-900 border-b border-gray-800 px-5 py-4 flex items-center justify-between">
              <h2 className="text-white font-bold text-sm flex items-center gap-2">
                <Eye className="w-4 h-4 text-emerald-400" />
                Player Details
              </h2>
              <button
                type="button"
                onClick={() => setSelectedPlayerDetail(null)}
                className="text-gray-400 hover:text-white p-1 rounded hover:bg-gray-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              {/* Player info */}
              <div className="space-y-1">
                <h3 className="text-white font-bold text-base">{selectedPlayerDetail.player_name}</h3>
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="px-2 py-0.5 rounded bg-gray-800 text-gray-300">Team: {selectedPlayerDetail.playerTeam || '—'}</span>
                  <span className="px-2 py-0.5 rounded bg-gray-800 text-gray-300">Pos: {selectedPlayerDetail.positionGroup}</span>
                  {selectedPlayerDetail.positionEdge && (
                    <span className="px-2 py-0.5 rounded bg-gray-800 text-gray-300">Conf: {selectedPlayerDetail.positionEdge.confidence}</span>
                  )}
                </div>
              </div>

              {/* Matchup info */}
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="bg-gray-800/50 rounded p-2">
                  <p className="text-gray-500">Opponent</p>
                  <p className="text-gray-200">{selectedPlayerDetail.opponent || '—'}</p>
                </div>
                <div className="bg-gray-800/50 rounded p-2">
                  <p className="text-gray-500">Venue</p>
                  <p className="text-gray-200">{selectedMatch?.venue || '—'}</p>
                </div>
              </div>

              {/* Historical stats */}
              <div className="bg-gray-800/50 rounded p-3 space-y-1.5 text-xs">
                <h4 className="text-gray-400 font-semibold text-xs uppercase tracking-wide">Historical Stats</h4>
                <div className="flex justify-between"><span className="text-gray-500">Total games</span><span className="text-gray-200">{selectedPlayerDetail.modelProb.sample_size}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Sample window</span><span className="text-gray-200">{SAMPLE_WINDOW_LABELS[selectedPlayerDetail.modelProb.sampleWindow] ?? selectedPlayerDetail.modelProb.sampleWindow}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Overall average</span><span className="text-gray-200">{selectedPlayerDetail.modelProb.avg_stat?.toFixed(2) ?? '—'}</span></div>
                <div className="flex justify-between"><span className="text-gray-500">Hit rate (line {selectedPlayerDetail.line})</span><span className="text-gray-200">{(selectedPlayerDetail.modelProb.hit_rate * 100).toFixed(1)}%</span></div>
              </div>

              {/* Venue section */}
              {selectedPlayerDetail.venueEdge ? (
                <div className="bg-gray-800/50 rounded p-3 space-y-1.5 text-xs">
                  <h4 className="text-gray-400 font-semibold text-xs uppercase tracking-wide">Venue Edge</h4>
                  <div className="flex justify-between"><span className="text-gray-500">Games at venue</span><span className="text-gray-200">{selectedPlayerDetail.venueEdge.sample_size}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Avg at venue</span><span className="text-gray-200">{selectedPlayerDetail.venueEdge.player_avg_at_venue.toFixed(2)}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Overall avg</span><span className="text-gray-200">{selectedPlayerDetail.venueEdge.player_overall_avg.toFixed(2)}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Difference</span><span className={selectedPlayerDetail.venueEdge.edge_value >= 0 ? 'text-emerald-400' : 'text-red-400'}>{selectedPlayerDetail.venueEdge.edge_value >= 0 ? '+' : ''}{selectedPlayerDetail.venueEdge.edge_value.toFixed(2)}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Label</span><span className="text-gray-200">{selectedPlayerDetail.venueEdge.label}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Adjustment</span><span className={selectedPlayerDetail.venueEdgeAdjustment >= 0 ? 'text-emerald-400' : 'text-red-400'}>{selectedPlayerDetail.venueEdgeAdjustment >= 0 ? '+' : ''}{(selectedPlayerDetail.venueEdgeAdjustment * 100).toFixed(1)}pp</span></div>
                </div>
              ) : (
                <div className="bg-gray-800/30 rounded p-3 text-xs text-gray-500">No venue data available</div>
              )}

              {/* Opponent section */}
              {selectedPlayerDetail.opponentEdge ? (
                <div className="bg-gray-800/50 rounded p-3 space-y-1.5 text-xs">
                  <h4 className="text-gray-400 font-semibold text-xs uppercase tracking-wide">Opponent Edge</h4>
                  <div className="flex justify-between"><span className="text-gray-500">Games vs opponent</span><span className="text-gray-200">{selectedPlayerDetail.opponentEdge.sample_size}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Avg vs opponent</span><span className="text-gray-200">{selectedPlayerDetail.opponentEdge.player_avg_vs_opponent.toFixed(2)}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Overall avg</span><span className="text-gray-200">{selectedPlayerDetail.opponentEdge.player_overall_avg.toFixed(2)}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Difference</span><span className={selectedPlayerDetail.opponentEdge.edge_value >= 0 ? 'text-emerald-400' : 'text-red-400'}>{selectedPlayerDetail.opponentEdge.edge_value >= 0 ? '+' : ''}{selectedPlayerDetail.opponentEdge.edge_value.toFixed(2)}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Label</span><span className="text-gray-200">{selectedPlayerDetail.opponentEdge.label}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Adjustment</span><span className={selectedPlayerDetail.opponentEdgeAdjustment >= 0 ? 'text-emerald-400' : 'text-red-400'}>{selectedPlayerDetail.opponentEdgeAdjustment >= 0 ? '+' : ''}{(selectedPlayerDetail.opponentEdgeAdjustment * 100).toFixed(1)}pp</span></div>
                </div>
              ) : (
                <div className="bg-gray-800/30 rounded p-3 text-xs text-gray-500">No opponent data available</div>
              )}

              {/* Position section */}
              {selectedPlayerDetail.positionEdge ? (
                <div className="bg-gray-800/50 rounded p-3 space-y-1.5 text-xs">
                  <h4 className="text-gray-400 font-semibold text-xs uppercase tracking-wide">Position Edge</h4>
                  <div className="flex justify-between"><span className="text-gray-500">Position group</span><span className="text-gray-200">{selectedPlayerDetail.positionEdge.position_group}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Opponent position edge</span><span className={selectedPlayerDetail.positionEdge.edge_value >= 0 ? 'text-emerald-400' : 'text-red-400'}>{selectedPlayerDetail.positionEdge.edge_value >= 0 ? '+' : ''}{selectedPlayerDetail.positionEdge.edge_value.toFixed(2)}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Sample size</span><span className="text-gray-200">{selectedPlayerDetail.positionEdge.games}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Consistency</span><span className="text-gray-200">{(selectedPlayerDetail.positionEdge.consistency * 100).toFixed(0)}%</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Label</span><span className="text-gray-200">{selectedPlayerDetail.positionEdge.significance}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Adjustment</span><span className={selectedPlayerDetail.positionEdgeAdjustment >= 0 ? 'text-emerald-400' : 'text-red-400'}>{selectedPlayerDetail.positionEdgeAdjustment >= 0 ? '+' : ''}{(selectedPlayerDetail.positionEdgeAdjustment * 100).toFixed(1)}pp</span></div>
                </div>
              ) : (
                <div className="bg-gray-800/30 rounded p-3 text-xs text-gray-500">No position edge data available</div>
              )}

              {/* Warnings */}
              {selectedPlayerDetail.warnings.length > 0 && (
                <div className="bg-red-500/10 border border-red-500/30 rounded p-3 space-y-1.5 text-xs">
                  <h4 className="text-red-400 font-semibold text-xs uppercase tracking-wide">Warnings ({selectedPlayerDetail.warnings.length})</h4>
                  <div className="flex flex-wrap gap-1">
                    {selectedPlayerDetail.warnings.map(w => (
                      <span key={w} className={`text-[10px] px-1.5 py-0.5 rounded ${
                        MAJOR_WARNINGS.has(w)
                          ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                          : 'bg-amber-500/15 text-amber-400 border border-amber-500/25'
                      }`}>{w}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Game Log Modal */}
      {gameLogRow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={() => setGameLogRow(null)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
              <div className="flex items-center gap-2">
                <List className="w-4 h-4 text-violet-400" />
                <span className="text-white font-semibold text-sm">
                  {gameLogRow.player_name} — {gameLogRow.display_label}
                </span>
                <span className="text-xs text-gray-500">Line: {gameLogRow.line}</span>
              </div>
              <button onClick={() => setGameLogRow(null)} className="p-1 text-gray-500 hover:text-white rounded">
                <X className="w-4 h-4" />
              </button>
            </div>
            {!gameLogLoading && gameLogRows.length > 0 && (() => {
              const currentSeason = selectedMatch?.season ?? new Date().getFullYear();
              const plainRows: CanonicalGameRow[] = gameLogRows.map(({ isHit: _h, index: _i, ...rest }) => rest);
              const windows = computeWindowCounts(plainRows, gameLogRow.line, currentSeason);
              return (
                <div className="px-4 pt-3 pb-2 border-b border-gray-800/50">
                  <p className="text-xs text-gray-500 mb-2">Hit/Miss by Window (line = {gameLogRow.line})</p>
                  <div className="grid grid-cols-4 sm:grid-cols-7 gap-1.5">
                    {([['L5', windows.last5], ['L10', windows.last10], ['L15', windows.last15], ['L20', windows.last20], ['L30', windows.last30], ['Season', windows.currentSeason]] as [string, typeof windows.last5][]).map(([label, w]) => (
                      <div key={label} className="bg-gray-800/60 rounded p-1.5 text-center">
                        <p className="text-[10px] text-gray-500">{label}</p>
                        {w ? (<><p className="text-white font-mono font-bold text-xs">{w.hits}/{w.sample}</p><p className={`text-[10px] font-semibold ${w.hitRate >= 0.6 ? 'text-emerald-400' : w.hitRate >= 0.4 ? 'text-amber-400' : 'text-red-400'}`}>{(w.hitRate * 100).toFixed(0)}%</p></>) : (<p className="text-gray-600 text-xs">—</p>)}
                      </div>
                    ))}
                    {windows.weighted && (
                      <div className="bg-violet-500/10 border border-violet-500/20 rounded p-1.5 text-center">
                        <p className="text-[10px] text-violet-400">Weighted</p>
                        <p className="text-white font-mono font-bold text-xs">{(windows.weighted.probability * 100).toFixed(0)}%</p>
                        <p className="text-[10px] text-gray-500">{windows.weighted.sample}g</p>
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}
            <div className="flex-1 overflow-y-auto">
              {gameLogLoading ? (
                <div className="flex items-center justify-center py-12 gap-2 text-gray-400">
                  <Loader2 className="w-4 h-4 animate-spin" /><span className="text-sm">Loading game log...</span>
                </div>
              ) : gameLogRows.length === 0 ? (
                <div className="text-center py-8 text-gray-500 text-sm">No game log data found.</div>
              ) : (
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-gray-900 border-b border-gray-800">
                    <tr>
                      {['#', 'Date', 'Rnd', 'Opponent', 'Venue', 'Value', 'Hit?'].map(h => (
                        <th key={h} className={`px-3 py-2 text-gray-500 font-medium ${h === 'Value' || h === 'Hit?' ? 'text-right' : 'text-left'}`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {gameLogRows.map(r => (
                      <tr key={r.index} className={`border-b border-gray-800/40 ${r.isHit ? 'bg-emerald-500/5' : 'bg-red-500/5'}`}>
                        <td className="px-3 py-1.5 text-gray-600">{r.index}</td>
                        <td className="px-3 py-1.5 text-gray-300 font-mono text-[11px]">{r.match_date}</td>
                        <td className="px-3 py-1.5 text-gray-400">{r.round ?? '—'}</td>
                        <td className="px-3 py-1.5 text-gray-300 max-w-[100px] truncate" title={r.opponent ?? ''}>{r.opponent ?? '—'}</td>
                        <td className="px-3 py-1.5 text-gray-400 max-w-[80px] truncate" title={r.venue ?? ''}>{r.venue ?? '—'}</td>
                        <td className={`px-3 py-1.5 text-right font-mono font-bold ${r.isHit ? 'text-emerald-400' : 'text-red-400'}`}>{r.statValue}</td>
                        <td className="px-3 py-1.5 text-right">{r.isHit ? <span className="text-emerald-400 font-bold text-[10px]">HIT</span> : <span className="text-red-400 text-[10px]">miss</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="px-4 py-2 border-t border-gray-800 text-[10px] text-gray-600">
              {gameLogRows.length} rows — ordered match_date DESC · deduplicated · canonical engine
            </div>
          </div>
        </div>
      )}

      {/* Spot Check Drawer (Verify Stats) */}
      {spotCheckRow && (
        <div
          className="fixed inset-0 z-50 flex justify-end"
          onClick={() => { setSpotCheckRow(null); setSpotCheckData(null); }}
        >
          <div className="absolute inset-0 bg-black/60" />
          <div
            className="relative w-full max-w-lg h-full bg-gray-900 border-l border-gray-700 shadow-2xl overflow-y-auto"
            onClick={e => e.stopPropagation()}
          >
            <div className="sticky top-0 bg-gray-900 border-b border-gray-800 px-5 py-4 flex items-center justify-between">
              <h2 className="text-white font-bold text-sm flex items-center gap-2">
                <Crosshair className="w-4 h-4 text-emerald-400" />
                Verify Stats — {spotCheckRow.player_name}
              </h2>
              <button
                type="button"
                onClick={() => { setSpotCheckRow(null); setSpotCheckData(null); }}
                className="text-gray-400 hover:text-white p-1 rounded hover:bg-gray-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              {spotCheckLoading ? (
                <LoadingSpinner message="Loading spot check..." />
              ) : spotCheckData ? (
                <>
                  <div className="flex flex-wrap gap-2 text-xs">
                    <span className="px-2 py-0.5 rounded bg-gray-800 text-gray-300">Team: {spotCheckData.team ?? '—'}</span>
                    <span className="px-2 py-0.5 rounded bg-gray-800 text-gray-300">Pos: {spotCheckData.positionGroup ?? 'UNKNOWN'}</span>
                    <span className={`px-2 py-0.5 rounded ${spotCheckData.latestGameIsFromLastCompletedRound ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                      {spotCheckData.latestGameIsFromLastCompletedRound ? 'Latest from last round' : 'NOT from last round'}
                    </span>
                  </div>

                  {/* Model Sample Summary */}
                  <div className="bg-blue-500/10 border border-blue-500/30 rounded p-3 space-y-1.5 text-xs">
                    <h4 className="text-blue-400 font-semibold uppercase tracking-wide">Model Sample Used</h4>
                    <div className="flex justify-between"><span className="text-gray-500">Sample size</span><span className="text-white">{spotCheckData.modelSample.sampleSize} games</span></div>
                    <div className="flex justify-between"><span className="text-gray-500">First game date</span><span className="text-white">{spotCheckData.modelSample.firstGameDate ?? '—'}</span></div>
                    <div className="flex justify-between"><span className="text-gray-500">Latest game date</span><span className="text-white">{spotCheckData.modelSample.latestGameDate ?? '—'}</span></div>
                    <div className="flex justify-between"><span className="text-gray-500">Latest round</span><span className="text-white">{spotCheckData.modelSample.latestRound ?? '—'}</span></div>
                    <div className="flex justify-between"><span className="text-gray-500">Latest opponent</span><span className="text-white">{spotCheckData.modelSample.latestOpponent ?? '—'}</span></div>
                    <div className="flex justify-between"><span className="text-gray-500">Latest disposals</span><span className="text-white">{spotCheckData.modelSample.latestDisposals ?? '—'}</span></div>
                  </div>

                  {/* Latest Game */}
                  <div className="bg-gray-800/50 rounded p-3 space-y-1.5 text-xs">
                    <h4 className="text-gray-400 font-semibold uppercase tracking-wide">Latest Game in Database</h4>
                    {spotCheckData.latestGame ? (
                      <>
                        <div className="flex justify-between"><span className="text-gray-500">Date</span><span className="text-white">{spotCheckData.latestGame.match_date}</span></div>
                        <div className="flex justify-between"><span className="text-gray-500">Round</span><span className="text-white">{spotCheckData.latestGame.round ?? '—'}</span></div>
                        <div className="flex justify-between"><span className="text-gray-500">Opponent</span><span className="text-white">{spotCheckData.latestGame.opponent ?? '—'}</span></div>
                        <div className="flex justify-between"><span className="text-gray-500">Venue</span><span className="text-white">{spotCheckData.latestGame.venue ?? '—'}</span></div>
                        <div className="flex justify-between"><span className="text-gray-500">D / M / T / G / HO</span><span className="text-white">{spotCheckData.latestGame.disposals} / {spotCheckData.latestGame.marks} / {spotCheckData.latestGame.tackles} / {spotCheckData.latestGame.goals} / {spotCheckData.latestGame.hitouts}</span></div>
                      </>
                    ) : (
                      <p className="text-red-400">No games found</p>
                    )}
                  </div>

                  {/* Games used in each model */}
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="bg-gray-800/50 rounded p-2">
                      <p className="text-gray-500">Last 5 (Model P)</p>
                      <p className="text-white font-bold">{spotCheckData.last5Games.length}</p>
                    </div>
                    <div className="bg-gray-800/50 rounded p-2">
                      <p className="text-gray-500">Last 10 (Model P)</p>
                      <p className="text-white font-bold">{spotCheckData.last10Games.length}</p>
                    </div>
                    <div className="bg-gray-800/50 rounded p-2">
                      <p className="text-gray-500">Current Season</p>
                      <p className="text-white font-bold">{spotCheckData.currentSeasonGames.length}</p>
                    </div>
                    <div className="bg-gray-800/50 rounded p-2">
                      <p className="text-gray-500">Venue Edge</p>
                      <p className="text-blue-400 font-bold">{spotCheckData.venueSampleGames.length}</p>
                    </div>
                    <div className="bg-gray-800/50 rounded p-2">
                      <p className="text-gray-500">Opponent Edge</p>
                      <p className="text-amber-400 font-bold">{spotCheckData.opponentSampleGames.length}</p>
                    </div>
                  </div>

                  {/* Last 5 Games */}
                  <div className="bg-gray-800/50 rounded p-3 space-y-1.5 text-xs">
                    <h4 className="text-gray-400 font-semibold uppercase tracking-wide">Last 5 Games</h4>
                    {spotCheckData.last5Games.length === 0 ? (
                      <p className="text-gray-500">No games</p>
                    ) : (
                      <div className="space-y-1">
                        {spotCheckData.last5Games.map((g, i) => (
                          <div key={i} className="flex justify-between text-[11px]">
                            <span className="text-gray-400">R{g.round ?? '?'} {g.match_date} vs {g.opponent ?? '?'}</span>
                            <span className="text-white">{g.disposals}D {g.marks}M {g.tackles}T {g.goals}G {g.hitouts}HO</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Current Season Games */}
                  <div className="bg-gray-800/50 rounded p-3 space-y-1.5 text-xs">
                    <h4 className="text-gray-400 font-semibold uppercase tracking-wide">Current Season Games</h4>
                    {spotCheckData.currentSeasonGames.length === 0 ? (
                      <p className="text-red-400">No current season games — Current Season will show "—"</p>
                    ) : (
                      <div className="space-y-1 max-h-40 overflow-y-auto">
                        {spotCheckData.currentSeasonGames.map((g, i) => (
                          <div key={i} className="flex justify-between text-[11px]">
                            <span className="text-gray-400">R{g.round ?? '?'} {g.match_date} vs {g.opponent ?? '?'}</span>
                            <span className="text-white">{g.disposals}D {g.marks}M {g.tackles}T {g.goals}G {g.hitouts}HO</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Venue Sample */}
                  <div className="bg-blue-500/10 border border-blue-500/30 rounded p-3 space-y-1.5 text-xs">
                    <h4 className="text-blue-400 font-semibold uppercase tracking-wide flex items-center gap-1">
                      <MapPin className="w-3 h-3" /> Venue Edge Sample ({spotCheckData.venueSampleGames.length})
                    </h4>
                    {spotCheckData.venueSampleGames.length === 0 ? (
                      <p className="text-gray-500">No games at {selectedMatch?.venue ?? 'this venue'}</p>
                    ) : (
                      <div className="space-y-1 max-h-40 overflow-y-auto">
                        {spotCheckData.venueSampleGames.map((g, i) => (
                          <div key={i} className="flex justify-between text-[11px]">
                            <span className="text-gray-400">R{g.round ?? '?'} {g.match_date}</span>
                            <span className="text-white">{g.disposals}D {g.marks}M {g.tackles}T {g.goals}G {g.hitouts}HO</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Opponent Sample */}
                  <div className="bg-amber-500/10 border border-amber-500/30 rounded p-3 space-y-1.5 text-xs">
                    <h4 className="text-amber-400 font-semibold uppercase tracking-wide flex items-center gap-1">
                      <Swords className="w-3 h-3" /> Opponent Edge Sample ({spotCheckData.opponentSampleGames.length})
                    </h4>
                    {spotCheckData.opponentSampleGames.length === 0 ? (
                      <p className="text-gray-500">No games vs {spotCheckRow.opponent ?? 'this opponent'}</p>
                    ) : (
                      <div className="space-y-1 max-h-40 overflow-y-auto">
                        {spotCheckData.opponentSampleGames.map((g, i) => (
                          <div key={i} className="flex justify-between text-[11px]">
                            <span className="text-gray-400">R{g.round ?? '?'} {g.match_date}</span>
                            <span className="text-white">{g.disposals}D {g.marks}M {g.tackles}T {g.goals}G {g.hitouts}HO</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="text-gray-400 text-sm">No data found.</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
