import { useState, useMemo, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Layers, TrendingUp, X, AlertTriangle, AlertCircle, CheckCircle, Shield, Info, Users, Zap, Crosshair, MapPin, Swords, UserX, Ban, Filter, RotateCcw, RefreshCw, Activity, Wrench, Calendar, Target, Link as LinkIcon } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { extractStatType } from '../lib/oddsNormalizer';
import { getPositionEdgeColor, type PositionEdgeResult, type VenueEdgeResult, type OpponentEdgeResult } from '../lib/positionEdge';
import { checkDuplicateMulti } from '../lib/betTracking';
import { getDataStatus } from '../lib/playerStatsSync';
import { getActiveBettingSlate, getRoundInfo, getMatchesForRound, type RoundInfo } from '../lib/roundManager';
import { relinkRoundOddsToCanonicalPlayers, type RelinkResult } from '../lib/playerMatching';
import { buildDisposalLineRecommendations, getSelectionReason, getCriteriaForMode, type DisposalLineRecommendation, type LineSafetyMode } from '../lib/disposalLineSelector';
import { getExcludedPlayerIds } from '../lib/playerExclusions';
import type { Match } from '../lib/types';
import LoadingSpinner from '../components/LoadingSpinner';
import ErrorBoundary from '../components/ErrorBoundary';
import MultiOptimizerPanel from '../components/MultiOptimizerPanel';
import PullEmDisposalMultiPanel from '../components/PullEmDisposalMultiPanel';
import {
  getModelledBookmakerOddsForMatch,
  calculateRiskLevel as sharedCalculateRiskLevel,
  type ModelledOddsRow,
  type ModelCoverage,
} from '../lib/modelResolver';
import {
  fixAllNoStatsFromDb,
  type NoStatsFixResult,
} from '../lib/missingStatsRepair';
import { buildTeamEnvironmentMap, type TeamEnvironmentMap, type TeamMatchupEnvironment, type TeamDisposalStats } from '../lib/teamStatsService';
import { loadRoleTrends, type RoleTrendMap } from '../lib/roleTrendService';
import { getRoundStatsCompleteness, type RoundCompletenessResult } from '../lib/roundCompleteness';

type EVRow = ModelledOddsRow;

interface MultiLeg {
  row: EVRow;
  odds: number;
  evPercent: number;
  modelProb: number;
  playerKey: string;
  statKey: string;
  matchId: string;
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
}

interface MultiCandidate {
  legs: MultiLeg[];
  combined_odds: number;
  combined_model_prob: number;
  combined_ev: number;
  warnings: string[];
  quality_score: number;
}

// Exclusion types
type ExclusionType = 'player' | 'stat' | 'match';
type ExclusionSource = 'manual' | 'tag_risk';

interface ExcludedItem {
  id: string;
  type: ExclusionType;
  source: ExclusionSource;
  reason: string;
  playerName?: string;
  team?: string;
  statType?: string;
  matchId?: string;
  matchName?: string;
  tagRiskLevel?: 'moderate' | 'high' | 'very_high';
  taggedBy?: string;
  tagType?: string;
  allowAnyway: boolean;
  createdAt: Date;
}

export default function MultiBuilderPage() {
  const [matches, setMatches] = useState<Match[]>([]);
  const [selectedMatchIds, setSelectedMatchIds] = useState<string[]>([]);
  const [modelledRows, setModelledRows] = useState<ModelledOddsRow[]>([]);
  const [coverage, setCoverage] = useState<ModelCoverage | null>(null);
  const [loading, setLoading] = useState(false);
  const [noStatsFixResult, setNoStatsFixResult] = useState<NoStatsFixResult | null>(null);
  const [noStatsFixLoading, setNoStatsFixLoading] = useState(false);
  const [matchesLoading, setMatchesLoading] = useState(true);
  // Round selector: 'auto' = next betting round, or specific round number
  const [roundSelector, setRoundSelector] = useState<string>('auto');
  const [slateInfo, setSlateInfo] = useState<{
    activeRound: string | null;
    statsRound: string | null;
    fixturesReady: boolean;
    oddsReady: boolean;
    oddsCount: number;
  } | null>(null);
  const [targetOdds, setTargetOdds] = useState('2.00');
  const [manualLegs, setManualLegs] = useState<MultiLeg[]>([]);
  // Live counts reported up by MultiOptimizerPanel — the single source of truth for
  // "how many recommended multis / eligible legs are actually on screen right now".
  // Diagnostics below reads this instead of a separate, disconnected calculation.
  const [panelResult, setPanelResult] = useState({ poolSize: 0, multiCount: 0, customLegsAvailable: 0 });
  const handlePanelResultsChange = useCallback((info: { poolSize: number; multiCount: number; customLegsAvailable: number }) => {
    setPanelResult(info);
  }, []);
  const [showAdvancedDiagnostics, setShowAdvancedDiagnostics] = useState(false);
  const [lineSafety, setLineSafety] = useState<LineSafetyMode>('safe');
  const [selectedGameMatchId, setSelectedGameMatchId] = useState<string | null>(null);
  const [teamEnvMap, setTeamEnvMap] = useState<TeamEnvironmentMap | undefined>(undefined);
  const [teamMatchups, setTeamMatchups] = useState<TeamMatchupEnvironment[]>([]);
  const [teamStats, setTeamStats] = useState<TeamDisposalStats[]>([]);
  const [roleTrends, setRoleTrends] = useState<RoleTrendMap | undefined>(undefined);
  const [roundCompleteness, setRoundCompleteness] = useState<RoundCompletenessResult | null>(null);
  const [modelRefreshedAt, setModelRefreshedAt] = useState<Date | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [dataStatus, setDataStatus] = useState<{ status: 'READY' | 'WARNING' | 'BROKEN'; latestCompletedRound: string | null; latestStatRound: string | null; isStale: boolean; reasons: string[] } | null>(null);
  const [usePositionEdge, setUsePositionEdge] = useState(false);
  const [preferPositionBoosts, setPreferPositionBoosts] = useState(false);
  const [hidePositionSuppressions, setHidePositionSuppressions] = useState(false);
  const [verySignificantOnly, setVerySignificantOnly] = useState(false);
  const [includeUnknownPosition, setIncludeUnknownPosition] = useState(true);
  const [useVenueEdge, setUseVenueEdge] = useState(false);
  const [useOpponentEdge, setUseOpponentEdge] = useState(false);
  const [preferMatchupBoosts, setPreferMatchupBoosts] = useState(false);
  const [hideMatchupSuppressions, setHideMatchupSuppressions] = useState(false);
  const [hideSmallSampleMatchup, setHideSmallSampleMatchup] = useState(false);
  const [includeUnknownMatchup, setIncludeUnknownMatchup] = useState(true);

  // Exclusion system state
  const [exclusions, setExclusions] = useState<ExcludedItem[]>([]);
  const [avoidHighTagRisk, setAvoidHighTagRisk] = useState(true);
  const [avoidModerateTagRisk, setAvoidModerateTagRisk] = useState(false);

  // Market filter - default to disposals only
  const [selectedMarkets, setSelectedMarkets] = useState({
    disposals: true,
    marks: false,
    tackles: false,
    goals: false,
    hitouts: false,
  });

  // Normalize market name to standard key
  const normalizeMarket = useCallback((market: string): string => {
    const m = market.toLowerCase();
    if (m.includes('disposal')) return 'disposals';
    if (m.includes('mark')) return 'marks';
    if (m.includes('tackle')) return 'tackles';
    if (m.includes('goal')) return 'goals';
    if (m.includes('hitout')) return 'hitouts';
    return m;
  }, []);

  // Multi Builder filters
  const [minSample, setMinSample] = useState(15);
  const [minHits, setMinHits] = useState(5);
  const [maxOdds, setMaxOdds] = useState(3.0);
  const [minAdjustedProb, setMinAdjustedProb] = useState(25);
  const [minAdjustedEV, setMinAdjustedEV] = useState(5);
  const [avoidWeakVenue, setAvoidWeakVenue] = useState(true);
  const [avoidWeakOpponent, setAvoidWeakOpponent] = useState(true);

  // DB Truth Check state
  const [dbTruthLoading, setDbTruthLoading] = useState(false);
  const [dbTruth, setDbTruth] = useState<{
    totalOddsRows: number;
    uniqueBookmakerPlayerIds: number;
    playerIdsWithZeroStats: string[];
    playerIdsWith1to14Stats: string[];
    playerIdsWith15PlusStats: string[];
    nullPlayerIdRows: number;
    brokenPlayerIdRows: number;
    resolverBugRows: Array<{ player_name: string; player_id: string | null; directDbCount: number; modelStatus: string }>;
  } | null>(null);
  // Relink state
  const [relinkLoading, setRelinkLoading] = useState(false);
  const [relinkResult, setRelinkResult] = useState<RelinkResult | null>(null);

  // Multi mode: 'safe' (default), 'sameGame', or 'pullEm'
  const [multiMode, setMultiMode] = useState<'safe' | 'sameGame' | 'pullEm'>('safe');

  // Correlation controls (derived from mode, but maxLegsPerMatch is user-adjustable in sameGame)
  const [maxLegsPerMatch, setMaxLegsPerMatch] = useState(1);

  // Derived settings from mode
  const allowSamePlayer = false; // always off — max 1 leg per player
  const preferDifferentMatches = multiMode === 'safe';
  const allowSameMatch = multiMode === 'sameGame';
  const effectiveMaxLegsPerMatch = multiMode === 'safe' ? 1 : maxLegsPerMatch;
  const allowedRiskLevels = multiMode === 'safe'
    ? new Set(['Low', 'Medium'])
    : new Set(['Low', 'Medium', 'High']);

  function switchMode(mode: 'safe' | 'sameGame' | 'pullEm') {
    setMultiMode(mode);
    if (mode === 'safe') {
      setMaxLegsPerMatch(1);
    } else {
      setMaxLegsPerMatch(2);
    }
    setManualLegs([]);
  }

  // Exclusion helper functions
  function excludePlayer(playerId: string, playerName: string, team: string, reason: string = 'Manual Exclusion') {
    const existing = exclusions.find(e => e.type === 'player' && e.id === playerId && e.source === 'manual');
    if (existing) return;
    setExclusions(prev => [...prev, {
      id: playerId,
      type: 'player',
      source: 'manual',
      reason,
      playerName,
      team,
      allowAnyway: false,
      createdAt: new Date(),
    }]);
  }

  function excludePlayerStat(playerId: string, playerName: string, team: string, statType: string, reason: string = 'Manual Exclusion') {
    const key = `${playerId}|${statType}`;
    const existing = exclusions.find(e => e.type === 'stat' && e.id === key && e.source === 'manual');
    if (existing) return;
    setExclusions(prev => [...prev, {
      id: key,
      type: 'stat',
      source: 'manual',
      reason,
      playerName,
      team,
      statType,
      allowAnyway: false,
      createdAt: new Date(),
    }]);
  }

  function excludeMatch(matchId: string, matchName: string, reason: string = 'Manual Exclusion') {
    const existing = exclusions.find(e => e.type === 'match' && e.id === matchId && e.source === 'manual');
    if (existing) return;
    setExclusions(prev => [...prev, {
      id: matchId,
      type: 'match',
      source: 'manual',
      reason,
      matchId,
      matchName,
      allowAnyway: false,
      createdAt: new Date(),
    }]);
  }

  function removeExclusion(id: string) {
    setExclusions(prev => prev.filter(e => e.id !== id));
  }

  function allowExclusion(id: string) {
    setExclusions(prev => prev.map(e => e.id === id ? { ...e, allowAnyway: true } : e));
  }

  function clearAllExclusions() {
    setExclusions([]);
  }

  function isPlayerExcluded(playerId: string): boolean {
    return exclusions.some(e =>
      e.type === 'player' &&
      e.id === playerId &&
      !e.allowAnyway
    );
  }

  function isPlayerStatExcluded(playerId: string, statType: string): boolean {
    if (isPlayerExcluded(playerId)) return true;
    const key = `${playerId}|${statType}`;
    return exclusions.some(e =>
      e.type === 'stat' &&
      e.id === key &&
      !e.allowAnyway
    );
  }

  function isMatchExcluded(matchId: string): boolean {
    return exclusions.some(e =>
      e.type === 'match' &&
      e.id === matchId &&
      !e.allowAnyway
    );
  }

  function getTagRiskExclusion(_playerId: string): { excluded: boolean; reason?: string; tagRiskLevel?: string; taggedBy?: string; tagType?: string } {
    return { excluded: false };
  }

  useEffect(() => {
    console.log('MultiBuilder loading slate for round selector:', roundSelector);
    setMatchesLoading(true);
    (async () => {
      try {
        if (roundSelector === 'auto') {
          const slate = await getActiveBettingSlate(2026);
          setSlateInfo({
            activeRound: slate.round,
            statsRound: slate.statsRound,
            fixturesReady: slate.fixturesReady,
            oddsReady: slate.oddsReady,
            oddsCount: slate.oddsCount,
          });
          setMatches(slate.matches);
          setSelectedMatchIds(slate.matches.length > 0 ? slate.matches.map(m => m.id) : []);
          setSelectedGameMatchId(slate.matches.length > 0 ? slate.matches[0].id : null);
        } else {
          const roundMatches = await getMatchesForRound(roundSelector, 2026);
          const info = await getRoundInfo(2026);
          setSlateInfo({
            activeRound: roundSelector,
            statsRound: info.latestCompletedStatsRound,
            fixturesReady: roundMatches.length > 0,
            oddsReady: false,
            oddsCount: 0,
          });
          setMatches(roundMatches);
          setSelectedMatchIds(roundMatches.length > 0 ? roundMatches.map(m => m.id) : []);
          setSelectedGameMatchId(roundMatches.length > 0 ? roundMatches[0].id : null);
          if (roundMatches.length > 0) {
            const { count } = await supabase
              .from('bookmaker_odds')
              .select('id', { count: 'exact', head: true })
              .in('match_id', roundMatches.map(m => m.id));
            setSlateInfo(prev => prev ? { ...prev, oddsReady: (count ?? 0) > 0, oddsCount: count ?? 0 } : prev);
          }
        }
      } catch (e) {
        console.error('MultiBuilder slate load error:', e);
      } finally {
        setMatchesLoading(false);
      }
    })();
  }, [roundSelector]);

  useEffect(() => {
    getDataStatus(new Date().getFullYear()).then(setDataStatus);
  }, []);

  useEffect(() => {
    if (matches.length === 0) return;
    buildTeamEnvironmentMap(matches, 2026).then(({ map, matchups, stats }) => {
      setTeamEnvMap(map);
      setTeamMatchups(matchups);
      setTeamStats(stats);
    }).catch(e => console.error('Team environment load error:', e));
    loadRoleTrends(2026).then(setRoleTrends).catch(e => console.error('Role trends load error:', e));
    if (slateInfo?.statsRound) {
      getRoundStatsCompleteness(2026, slateInfo.statsRound).then(setRoundCompleteness).catch(e => console.error('Round completeness error:', e));
    }
  }, [matches]);

  const loadModelledRows = useCallback(async (matchIds: string[]) => {
    if (matchIds.length === 0) {
      setModelledRows([]);
      setCoverage(null);
      return;
    }
    setLoading(true);
    try {
      const results = await Promise.all(
        matchIds.map(id => getModelledBookmakerOddsForMatch(id, {
          usePositionEdge,
          useVenueEdge,
          useOpponentEdge,
        }))
      );
      const allRows = results.flatMap(r => r.rows);
      const totalCoverage: ModelCoverage = {
        totalOddsRows: allRows.length,
        modelReady: allRows.filter(r => r.modelStatus === 'MODEL_READY').length,
        oddsOnly: allRows.filter(r => r.modelStatus === 'ODDS_ONLY').length,
        noStats: allRows.filter(r => r.modelStatus === 'NO_STATS').length,
        insufficientSample: allRows.filter(r => r.modelStatus === 'INSUFFICIENT_MARKET_SAMPLE').length,
        wrongTeam: allRows.filter(r => r.modelStatus === 'WRONG_TEAM').length,
        unresolvedPlayer: allRows.filter(r => r.modelStatus === 'PLAYER_UNRESOLVED').length,
        modelReadyPlayers: new Set(allRows.filter(r => r.modelStatus === 'MODEL_READY' && r.resolvedPlayerId).map(r => r.resolvedPlayerId!)).size,
        lastRefreshed: new Date(),
      };
      setModelledRows(allRows);
      setCoverage(totalCoverage);
      console.log('[MultiBuilder] Modelled rows loaded:', allRows.length, 'model ready:', totalCoverage.modelReady);
    } catch (err) {
      console.error('[MultiBuilder] Failed to load modelled rows', err);
      setMessage('Failed to load model data: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setLoading(false);
    }
  }, [usePositionEdge, useVenueEdge, useOpponentEdge]);

  const handleFixAllNoStats = useCallback(async () => {
    if (selectedMatchIds.length === 0) {
      setMessage('Select matches first.');
      return;
    }

    console.log('MULTI fixAllNoStats: querying DB for ALL selected matches', selectedMatchIds.length);
    setNoStatsFixLoading(true);
    setNoStatsFixResult(null);
    try {
      const result = await fixAllNoStatsFromDb(selectedMatchIds);
      setNoStatsFixResult(result);
      console.log('MULTI fixAllNoStats result:', result);

      // Force full slate refresh — clear cache and reload ALL matches
      setModelledRows([]);
      setCoverage(null);
      await loadModelledRows(selectedMatchIds);
    } catch (err) {
      console.error('MULTI fixAllNoStats error:', err);
      setMessage('Fix NO STATS failed: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setNoStatsFixLoading(false);
    }
  }, [selectedMatchIds, loadModelledRows]);

  useEffect(() => {
    if (selectedMatchIds.length > 0) loadModelledRows(selectedMatchIds);
  }, [selectedMatchIds, loadModelledRows]);

  const evRows: EVRow[] = modelledRows;

  const validLegs = useMemo(() => {
    const filtered = evRows.filter(r => {
      if (r.modelStatus !== 'MODEL_READY') return false;
      if (r.isWrongTeam) return false;
      if (!r.isRealistic || r.adjustedEV === null || r.adjustedEV * 100 < minAdjustedEV) return false;
      if (r.modelProb.sample_size < minSample) return false;
      if (r.modelProb.hit_count < minHits) return false;
      if (r.over_odds > maxOdds) return false;
      if (r.modelProb.adjustedProb === null || r.modelProb.adjustedProb * 100 < minAdjustedProb) return false;
      if (avoidWeakVenue && r.modelProb.venue_adjustment < -0.03) return false;
      if (avoidWeakOpponent && r.modelProb.opponent_adjustment < -0.03) return false;
      // Safe Multi Mode: Low/Medium risk only
      if (!allowedRiskLevels.has(r.modelProb.risk_level)) return false;
      // Position Edge filters
      if (!includeUnknownPosition && r.positionGroup === 'UNKNOWN') return false;
      if (hidePositionSuppressions && r.positionEdge && r.positionEdge.edge_value < 0) return false;
      if (verySignificantOnly && (!r.positionEdge || r.positionEdge.significance !== 'very_significant')) return false;
      // Matchup filters
      if (!includeUnknownMatchup && !r.positionEdge && !r.venueEdge && !r.opponentEdge) return false;
      if (hideMatchupSuppressions && r.totalMatchupAdjustment < 0) return false;
      if (hideSmallSampleMatchup && r.venueEdge?.label === 'small_sample' && r.opponentEdge?.label === 'small_sample') return false;

      // Exclusion filters
      const playerId = r.player_id;
      const statType = extractStatType(r.raw_market) || 'other';
      if (playerId && isPlayerExcluded(playerId)) return false;
      if (playerId && isPlayerStatExcluded(playerId, statType)) return false;
      if (isMatchExcluded(r.match_id)) return false;

      // Tag risk exclusion
      if (playerId) {
        const tagRisk = getTagRiskExclusion(playerId);
        if (tagRisk.excluded) return false;
      }

      // Market filter - only include selected markets
      const marketKey = normalizeMarket(statType);
      if (!selectedMarkets[marketKey as keyof typeof selectedMarkets]) return false;

      return true;
    }).sort((a, b) => {
      // Sort by risk level first (Low > Medium > High), then by EV
      const riskOrder = { 'Low': 0, 'Medium': 1, 'High': 2 };
      if (riskOrder[a.modelProb.risk_level] !== riskOrder[b.modelProb.risk_level]) {
        return riskOrder[a.modelProb.risk_level] - riskOrder[b.modelProb.risk_level];
      }
      return (b.adjustedEV ?? 0) - (a.adjustedEV ?? 0);
    });
    if (preferPositionBoosts) {
      filtered.sort((a, b) => {
        const aBoost = a.positionEdge && a.positionEdge.edge_value > 0 ? 1 : 0;
        const bBoost = b.positionEdge && b.positionEdge.edge_value > 0 ? 1 : 0;
        return bBoost - aBoost;
      });
    }
    if (preferMatchupBoosts) {
      filtered.sort((a, b) => {
        const aBoost = a.totalMatchupAdjustment > 0 ? 1 : 0;
        const bBoost = b.totalMatchupAdjustment > 0 ? 1 : 0;
        return bBoost - aBoost;
      });
    }
    return filtered;
  }, [evRows, minSample, minHits, maxOdds, minAdjustedProb, minAdjustedEV, avoidWeakVenue, avoidWeakOpponent, allowedRiskLevels, includeUnknownPosition, hidePositionSuppressions, verySignificantOnly, preferPositionBoosts, includeUnknownMatchup, hideMatchupSuppressions, hideSmallSampleMatchup, preferMatchupBoosts, exclusions, avoidHighTagRisk, avoidModerateTagRisk, selectedMarkets, normalizeMarket]);

  // Disposal line recommendations feed Best Individual Legs, Recommended Multis and
  // Build Your Own Multi (via MultiOptimizerPanel below). They are built from validLegs —
  // the SAME fully-filtered pool the top settings panel and diagnostics use — so every
  // top-level filter (sample/hits/odds/prob/EV/venue/opponent/risk/position/matchup/market/
  // exclusions/tag-risk) actually controls what shows up below. Do not source this from raw
  // modelledRows again — that reintroduces the two-pipeline bug this was fixed for.
  const disposalRecommendations = useMemo(() => {
    const excludedIds = selectedGameMatchId
      ? getExcludedPlayerIds(selectedGameMatchId)
      : new Set<string>();
    const filteredRows = excludedIds.size > 0
      ? validLegs.filter(r => {
          const pid = r.player_id ?? r.resolvedPlayerId ?? '';
          return !excludedIds.has(pid);
        })
      : validLegs;
    return buildDisposalLineRecommendations(filteredRows, getCriteriaForMode(lineSafety));
  }, [validLegs, lineSafety, selectedGameMatchId]);

  // Match names map for the optimizer panel
  const matchNames = useMemo(() => {
    const names: Record<string, string> = {};
    for (const m of matches) {
      names[m.id] = `${m.home_team ?? ''} vs ${m.away_team ?? ''}`;
    }
    return names;
  }, [matches]);

  // Runtime debug logs (must be after validLegs declaration)
  const selectedMatches = matches.filter(m => selectedMatchIds.includes(m.id));
  console.log('MULTI selectedMatches', selectedMatches.length, selectedMatches.map(m => `${m.home_team} vs ${m.away_team}`));
  console.log('MULTI modelledRows count', modelledRows.length);
  console.log('MULTI coverage', coverage);
  console.log('MULTI validLegs count', validLegs.length);
  if (modelledRows.length > 0) console.log('MULTI first modelled row', modelledRows[0]);

  // Exclusion diagnostics
  const exclusionDiagnostics = useMemo(() => {
    let excludedByUser = 0;
    let excludedByTagRisk = 0;
    let availableAfterExclusions = validLegs.length;

    evRows.forEach(r => {
      const playerId = r.player_id ?? '';
      const statType = extractStatType(r.raw_market) || 'other';

      // Check manual exclusions
      const isManuallyExcluded = isPlayerExcluded(playerId) || isPlayerStatExcluded(playerId, statType) || isMatchExcluded(r.match_id ?? '');
      if (isManuallyExcluded) excludedByUser++;

      // Check tag risk exclusions
      if (playerId && !isManuallyExcluded) {
        const tagRisk = getTagRiskExclusion(playerId);
        if (tagRisk.excluded) excludedByTagRisk++;
      }
    });

    return {
      excludedByUser,
      excludedByTagRisk,
      availableAfterExclusions,
      // Real count of multis currently rendered by the builder below — reported up via
      // onResultsChange — not a separate, never-triggered calculation.
      totalCandidates: panelResult.multiCount,
    };
  }, [evRows, exclusions, avoidHighTagRisk, avoidModerateTagRisk, validLegs.length, panelResult.multiCount]);

  const statsSummary = useMemo(() => ({
    total: modelledRows.length,
    withModel: evRows.filter(r => r.isValid).length,
    realistic: evRows.filter(r => r.isRealistic).length,
    validLegs: validLegs.length,
  }), [modelledRows, evRows, validLegs]);

  // Debug log — runs whenever key data changes (safe, no side effects)
  useEffect(() => {
    const safeEvRows = Array.isArray(evRows) ? evRows : [];
    const safeValidLegs = Array.isArray(validLegs) ? validLegs : [];
    const safeMatches = Array.isArray(matches) ? matches : [];
    console.log('[MultiBuilder] data snapshot', {
      matches: safeMatches.length,
      evRows: safeEvRows.length,
      validLegs: safeValidLegs.length,
    });
  }, [evRows, validLegs, matches]);

  // Odds-only rows — markets without a model
  const oddsOnlyRows = useMemo(() => {
    return evRows.filter(r =>
      r.modelStatus !== 'MODEL_READY' &&
      !r.isWrongTeam
    ).sort((a, b) => (a.player_name ?? '').localeCompare(b.player_name ?? ''));
  }, [evRows]);

  // Valid Leg Funnel computation
  const legFunnel = useMemo(() => {
    const total = evRows.length;
    let cur = evRows;

    const notModelReady = cur.filter(r => r.modelStatus !== 'MODEL_READY' || r.isWrongTeam).length;
    cur = cur.filter(r => r.modelStatus === 'MODEL_READY' && !r.isWrongTeam);
    const afterModelReady = cur.length;

    const removedSample = cur.filter(r => r.modelProb.sample_size < minSample).length;
    cur = cur.filter(r => r.modelProb.sample_size >= minSample);

    const removedHits = cur.filter(r => r.modelProb.hit_count < minHits).length;
    cur = cur.filter(r => r.modelProb.hit_count >= minHits);

    const removedMaxOdds = cur.filter(r => r.over_odds > maxOdds).length;
    cur = cur.filter(r => r.over_odds <= maxOdds);

    const removedMinProb = cur.filter(r => r.modelProb.adjustedProb === null || r.modelProb.adjustedProb * 100 < minAdjustedProb).length;
    cur = cur.filter(r => r.modelProb.adjustedProb !== null && r.modelProb.adjustedProb * 100 >= minAdjustedProb);

    const removedEV = cur.filter(r => !r.isRealistic || r.adjustedEV === null || r.adjustedEV * 100 < minAdjustedEV).length;
    cur = cur.filter(r => r.isRealistic && r.adjustedEV !== null && r.adjustedEV * 100 >= minAdjustedEV);

    const removedRisk = cur.filter(r => !allowedRiskLevels.has(r.modelProb.risk_level)).length;
    cur = cur.filter(r => allowedRiskLevels.has(r.modelProb.risk_level));

    const removedVenue = avoidWeakVenue ? cur.filter(r => r.modelProb.venue_adjustment < -0.03).length : 0;
    if (avoidWeakVenue) cur = cur.filter(r => r.modelProb.venue_adjustment >= -0.03);

    const removedOpponent = avoidWeakOpponent ? cur.filter(r => r.modelProb.opponent_adjustment < -0.03).length : 0;
    if (avoidWeakOpponent) cur = cur.filter(r => r.modelProb.opponent_adjustment >= -0.03);

    const removedMarket = cur.filter(r => {
      if (!includeUnknownPosition && r.positionGroup === 'UNKNOWN') return true;
      if (hidePositionSuppressions && r.positionEdge && r.positionEdge.edge_value < 0) return true;
      const statType = extractStatType(r.raw_market) || 'other';
      const marketKey = normalizeMarket(statType);
      if (!selectedMarkets[marketKey as keyof typeof selectedMarkets]) return true;
      return false;
    }).length;
    cur = cur.filter(r => {
      if (!includeUnknownPosition && r.positionGroup === 'UNKNOWN') return false;
      if (hidePositionSuppressions && r.positionEdge && r.positionEdge.edge_value < 0) return false;
      const statType = extractStatType(r.raw_market) || 'other';
      const marketKey = normalizeMarket(statType);
      if (!selectedMarkets[marketKey as keyof typeof selectedMarkets]) return false;
      return true;
    });

    const removedExclusions = cur.filter(r => {
      const playerId = r.player_id;
      const statType = extractStatType(r.raw_market) || 'other';
      if (playerId && isPlayerExcluded(playerId)) return true;
      if (playerId && isPlayerStatExcluded(playerId, statType)) return true;
      if (isMatchExcluded(r.match_id)) return true;
      if (playerId) { const tagRisk = getTagRiskExclusion(playerId); if (tagRisk.excluded) return true; }
      return false;
    }).length;
    const finalValidLegs = cur.filter(r => {
      const playerId = r.player_id;
      const statType = extractStatType(r.raw_market) || 'other';
      if (playerId && isPlayerExcluded(playerId)) return false;
      if (playerId && isPlayerStatExcluded(playerId, statType)) return false;
      if (isMatchExcluded(r.match_id)) return false;
      if (playerId) { const tagRisk = getTagRiskExclusion(playerId); if (tagRisk.excluded) return false; }
      return true;
    }).length;

    return {
      total, notModelReady, afterModelReady,
      removedSample, removedHits, removedMaxOdds, removedMinProb, removedEV,
      removedRisk, removedVenue, removedOpponent, removedMarket, removedExclusions,
      finalValidLegs,
    };
  }, [evRows, minSample, minHits, maxOdds, minAdjustedProb, minAdjustedEV, avoidWeakVenue, avoidWeakOpponent, allowedRiskLevels, includeUnknownPosition, hidePositionSuppressions, exclusions, selectedMarkets, normalizeMarket, avoidHighTagRisk, avoidModerateTagRisk]);

  // Build Multis blocking reason
  const buildBlockingReason = useMemo(() => {
    if (validLegs.length === 0) return 'No valid legs — all rows removed by filters';
    if (validLegs.length === 1) return 'Only 1 valid leg — need at least 2';
    if (validLegs.length >= 2) {
      const target = parseFloat(targetOdds) || 2.5;
      const uniqueMatches = new Set(validLegs.map(l => l.match_id)).size;
      const uniquePlayers = new Set(validLegs.map(l => l.player_id || l.player_name)).size;
      const maxOddsInLegs = Math.max(...validLegs.map(l => l.over_odds));
      const minOddsInLegs = Math.min(...validLegs.map(l => l.over_odds));
      const lowestCombo = minOddsInLegs * Math.min(...validLegs.filter(l => l.over_odds !== minOddsInLegs).map(l => l.over_odds), [minOddsInLegs])[0];
      const reasons: string[] = [];
      if (!allowSameMatch && uniqueMatches < 2) reasons.push('All valid legs are from the same match (same-match blocked)');
      if (!allowSamePlayer && uniquePlayers < 2) reasons.push('All valid legs are for the same player (same-player blocked)');
      const minPossibleOdds = validLegs.slice(0, 2).map(l => l.over_odds).reduce((a, b) => a * b, 1);
      const maxPossibleOdds = validLegs.slice(0, 5).map(l => l.over_odds).reduce((a, b) => a * b, 1);
      if (maxPossibleOdds < target * 0.75) reasons.push(`All combinations fall below target odds (best 5-leg combo ~${maxPossibleOdds.toFixed(2)}, target ${target})`);
      if (minPossibleOdds > target * 1.5) reasons.push(`All combinations exceed target odds (min 2-leg combo ~${minPossibleOdds.toFixed(2)}, target ${target})`);
      return reasons.length > 0 ? reasons.join('; ') : null;
    }
    return null;
  }, [validLegs, targetOdds, allowSameMatch, allowSamePlayer]);

  // DB Truth Check function
  async function runDbTruthCheck() {
    if (selectedMatchIds.length === 0) return;
    setDbTruthLoading(true);
    setDbTruth(null);
    try {
      // Paginate bookmaker_odds for selected matches
      const allOddsRows: any[] = [];
      const PAGE = 1000;
      let page = 0;
      let hasMoreOdds = true;
      while (hasMoreOdds) {
        const { data: oddsPage } = await supabase
          .from('bookmaker_odds')
          .select('id, player_id, bookmaker_player_name, match_id')
          .in('match_id', selectedMatchIds)
          .range(page * PAGE, (page + 1) * PAGE - 1);
        if (oddsPage && oddsPage.length > 0) {
          allOddsRows.push(...oddsPage);
          hasMoreOdds = oddsPage.length === PAGE;
          page++;
        } else hasMoreOdds = false;
      }
      const rows = allOddsRows;
      const totalOddsRows = rows.length;
      const nullPidRows = rows.filter(r => !r.player_id).length;
      const uniquePids = [...new Set(rows.filter(r => r.player_id).map(r => r.player_id as string))];
      const uniqueBookmakerPlayerIds = uniquePids.length;

      // Check which player IDs exist in players table
      const { data: validPlayers } = await supabase.from('players').select('id').in('id', uniquePids);
      const validPlayerIds = new Set((validPlayers ?? []).map((p: { id: string }) => p.id));
      const brokenPids = uniquePids.filter(id => !validPlayerIds.has(id));
      const brokenPlayerIdRows = rows.filter(r => r.player_id && brokenPids.includes(r.player_id)).length;

      // Count stats per player_id
      const statsCountMap = new Map<string, number>();
      const STATS_PAGE = 1000;
      let statsPage = 0;
      let hasMoreStats = true;
      while (hasMoreStats) {
        const { data: sc } = await supabase
          .from('player_game_stats')
          .select('player_id')
          .in('player_id', uniquePids)
          .range(statsPage * STATS_PAGE, (statsPage + 1) * STATS_PAGE - 1);
        if (sc && sc.length > 0) {
          for (const r of sc) statsCountMap.set(r.player_id, (statsCountMap.get(r.player_id) ?? 0) + 1);
          hasMoreStats = sc.length === STATS_PAGE;
          statsPage++;
        } else hasMoreStats = false;
      }

      const zeroStats = uniquePids.filter(id => (statsCountMap.get(id) ?? 0) === 0);
      const lowStats = uniquePids.filter(id => { const c = statsCountMap.get(id) ?? 0; return c >= 1 && c < 15; });
      const goodStats = uniquePids.filter(id => (statsCountMap.get(id) ?? 0) >= 15);

      // Find resolver bugs: directDbStatsCount > 0 but modelStatus = NO_STATS
      const resolverBugs = modelledRows.filter(r =>
        r.modelStatus === 'NO_STATS' && r.directDbStatsCount > 0
      ).map(r => ({
        player_name: r.player_name,
        player_id: r.player_id,
        directDbCount: r.directDbStatsCount,
        modelStatus: r.modelStatus,
      }));

      setDbTruth({
        totalOddsRows,
        uniqueBookmakerPlayerIds,
        playerIdsWithZeroStats: zeroStats,
        playerIdsWith1to14Stats: lowStats,
        playerIdsWith15PlusStats: goodStats,
        nullPlayerIdRows: nullPidRows,
        brokenPlayerIdRows,
        resolverBugRows: resolverBugs,
      });
    } finally {
      setDbTruthLoading(false);
    }
  }

  async function handleRelink() {
    if (selectedMatchIds.length === 0) return;
    setRelinkLoading(true);
    setRelinkResult(null);
    try {
      const result = await relinkRoundOddsToCanonicalPlayers(selectedMatchIds);
      setRelinkResult(result);
      // Reload models after relinking
      setModelledRows([]);
      setCoverage(null);
      await loadModelledRows(selectedMatchIds);
    } finally {
      setRelinkLoading(false);
    }
  }

  const manualCombinedOdds = manualLegs.reduce((acc, l) => acc * l.odds, 1);
  const manualCombinedProb = manualLegs.reduce((acc, l) => acc * l.modelProb, 1);
  const manualCombinedEV = manualCombinedProb * manualCombinedOdds - 1;

  const manualWarnings: string[] = [];
  const manualPlayers = new Set<string>();
  for (const leg of manualLegs) manualPlayers.add(leg.playerKey);
  if (!allowSamePlayer && manualLegs.length !== manualPlayers.size) {
    manualWarnings.push('Duplicate player legs');
  }

  const manualMatches = new Map<string, number>();
  for (const leg of manualLegs) {
    manualMatches.set(leg.matchId, (manualMatches.get(leg.matchId) || 0) + 1);
  }
  for (const [, count] of manualMatches) {
    if (count > 1) manualWarnings.push(`${count} legs from same match`);
  }

  function addLeg(row: EVRow) {
    if (!row.isRealistic || row.adjustedEV === null || row.adjustedEV * 100 < minAdjustedEV) return;
    const playerKey = row.player_id || row.player_name;
    const statKey = extractStatType(row.raw_market) || 'other';

    // Always block same player duplicate legs (max 1 leg per player)
    if (manualLegs.some(l => l.playerKey === playerKey)) return;

    // Block same player + same stat ladder duplicates (e.g. Gulden 20+ disposals + Gulden 23+ disposals)
    if (manualLegs.some(l => l.playerKey === playerKey && l.statKey === statKey)) return;

    // Safe Multi Mode: block same match entirely (maxLegsPerMatch = 1, allowSameMatch = false)
    if (!allowSameMatch && manualLegs.some(l => l.matchId === row.match_id)) return;

    // Same Game Multi Mode: enforce max legs per match
    if (allowSameMatch) {
      const matchCount = manualLegs.filter(l => l.matchId === row.match_id).length;
      if (matchCount >= effectiveMaxLegsPerMatch) return;
    }

    setManualLegs(legs => [...legs, {
      row, odds: row.over_odds, evPercent: row.adjustedEV || 0,
      modelProb: row.modelProb.adjustedProb || 0.5, playerKey, statKey,
      matchId: row.match_id,
    }]);
  }

  async function trackMulti(candidate: MultiCandidate) {
    // Check duplicate
    const isDuplicate = await checkDuplicateMulti(
      candidate.legs.map(l => ({
        player_name: l.row.player_name,
        market: extractStatType(l.row.raw_market),
        display_label: l.row.display_label,
        odds: l.odds
      })),
      candidate.combined_odds
    );

    if (isDuplicate) {
      setMessage('This multi is already tracked');
      setTimeout(() => setMessage(null), 4000);
      return;
    }

    const { data: multi, error } = await supabase
      .from('tracked_multis')
      .insert({
        combined_odds: candidate.combined_odds,
        estimated_adjusted_probability: candidate.combined_model_prob,
        estimated_adjusted_ev: candidate.combined_ev,
        match_ids: [...new Set(candidate.legs.map(l => l.matchId))] as string[],
        use_position_edge: usePositionEdge,
        estimated_final_probability: usePositionEdge ? candidate.combined_model_prob : null,
        estimated_final_ev: usePositionEdge ? candidate.combined_ev : null,
      })
      .select()
      .single();

    if (multi && !error) {
      const legsData = candidate.legs.map(leg => ({
        multi_id: multi.id,
        player_name: leg.row.player_name,
        player_id: leg.row.player_id,
        market: leg.statKey,
        line: leg.row.line.toString(),
        display_label: leg.row.display_label,
        odds: leg.odds,
        adjusted_probability: leg.modelProb,
        adjusted_ev: leg.evPercent,
        match_id: leg.matchId,
        position_group: leg.positionGroup,
        position_edge_value: leg.positionEdge?.edge_value ?? null,
        position_edge_significance: leg.positionEdge?.significance ?? null,
        position_edge_adjustment: leg.positionEdgeAdjustment,
        final_probability: leg.finalProbability,
        final_ev: leg.finalEV,
      }));

      await supabase.from('tracked_multi_legs').insert(legsData);
      setMessage('Multi tracked');
      setTimeout(() => setMessage(null), 4000);
    }
  }

  if (matchesLoading) return <LoadingSpinner message="Loading fixtures..." />;

  const latestCompletedStatsRound =
    slateInfo?.statsRound ??
    dataStatus?.latestCompletedRound ??
    null;

  const statsRoundLabel = latestCompletedStatsRound
    ? `Round ${latestCompletedStatsRound}${roundCompleteness ? ` (${roundCompleteness.completeMatches}/${roundCompleteness.completedMatches} complete)` : ''}`
    : 'Unknown';

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-center gap-3">
        <Layers className="w-5 h-5 text-emerald-400" />
        <h2 className="text-white font-bold text-lg">Multi Builder</h2>
        <span className="text-xs text-gray-600">Adjusted EV · Risk-aware</span>
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
        {statsSummary.validLegs > 0 && (
          <span className="text-xs px-2.5 py-1 bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 rounded-full font-semibold">
            {statsSummary.validLegs} valid legs
          </span>
        )}
        {message && (
          <span className={`text-xs px-3 py-1 rounded-full ${message.includes('already') ? 'bg-amber-500/20 text-amber-400' : 'bg-blue-500/20 text-blue-400'}`}>
            {message}
          </span>
        )}
      </div>

      {/* Stats Summary */}
      {!loading && modelledRows.length > 0 && (
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
            <p className="text-2xl font-bold text-amber-400">{statsSummary.validLegs}</p>
            <p className="text-xs text-gray-500">Multi-Ready</p>
          </div>
        </div>
      )}

      {/* Config */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-medium text-gray-500 uppercase">Multi Builder Settings</h4>
          <Shield className="w-4 h-4 text-emerald-400" />
        </div>

        {/* Multi Mode Toggle */}
        <div className="bg-gray-800/40 rounded-lg p-3 space-y-3">
          <h5 className="text-xs font-medium text-gray-400 flex items-center gap-2">
            <Users className="w-3 h-3" />
            Multi Mode
          </h5>
          <div className="flex items-center gap-2">
            <button
              onClick={() => switchMode('safe')}
              className={`flex-1 px-3 py-2 rounded-lg text-xs font-medium transition ${multiMode === 'safe' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
            >
              <Shield className="w-3.5 h-3.5 inline mr-1" />
              Safe Multi
            </button>
            <button
              onClick={() => switchMode('sameGame')}
              className={`flex-1 px-3 py-2 rounded-lg text-xs font-medium transition ${multiMode === 'sameGame' ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
            >
              <Zap className="w-3.5 h-3.5 inline mr-1" />
              Same Game Multi
            </button>
            <button
              onClick={() => switchMode('pullEm')}
              className={`flex-1 px-3 py-2 rounded-lg text-xs font-medium transition ${multiMode === 'pullEm' ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
            >
              <Target className="w-3.5 h-3.5 inline mr-1" />
              Pull 'Em
            </button>
          </div>
          <div className="text-xs text-gray-500 space-y-1">
            {multiMode === 'safe' ? (
              <ul className="space-y-0.5">
                <li>• Prefer different matches: ON</li>
                <li>• Allow same match: OFF</li>
                <li>• Max legs per match: 1</li>
                <li>• Max 1 leg per player</li>
                <li>• Low/Medium risk only</li>
              </ul>
            ) : multiMode === 'sameGame' ? (
              <ul className="space-y-0.5">
                <li>• Allow same match: ON</li>
                <li>• Prefer different matches: OFF</li>
                <li>• Max 1 leg per player (still enforced)</li>
                <li>• Same player + same stat ladder duplicates blocked</li>
              </ul>
            ) : (
              <ul className="space-y-0.5">
                <li>• Disposal-focused Same Game Multis</li>
                <li>• Minimum combined odds $5.00</li>
                <li>• Ladders, overs, and unders</li>
                <li>• Safest, Best Value, or Balanced modes</li>
                <li>• Weakest leg identified as Pull 'Em Leg</li>
              </ul>
            )}
          </div>
          {multiMode === 'sameGame' && (
            <>
              <div className="flex items-center gap-2 text-xs text-gray-300">
                <span>Max legs per selected match:</span>
                <select value={maxLegsPerMatch} onChange={e => setMaxLegsPerMatch(Number(e.target.value))} className="bg-gray-700 border border-gray-600 rounded px-2 py-1 text-white">
                  {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
              <div className="flex items-start gap-2 text-xs text-amber-400 bg-amber-500/10 rounded-lg px-3 py-2">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>Same-game multis are correlated. Estimated EV may be overstated.</span>
              </div>
            </>
          )}
        </div>

        {/* Refresh + Coverage Panel */}
        <div className="flex items-center justify-between gap-3">
          <button
            onClick={() => loadModelledRows(selectedMatchIds)}
            disabled={loading || selectedMatchIds.length === 0}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white font-medium rounded-lg text-sm transition"
          >
            {loading ? <LoadingSpinner /> : <RefreshCw className="w-4 h-4" />}
            Refresh Multi Builder Models
          </button>
          <button
            onClick={handleFixAllNoStats}
            disabled={noStatsFixLoading || modelledRows.length === 0}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-medium rounded-lg text-sm transition"
          >
            {noStatsFixLoading ? <LoadingSpinner /> : <Wrench className="w-4 h-4" />}
            Fix All Multi Builder NO STATS Players
          </button>
          {coverage && (
            <span className="text-xs text-gray-500">
              Last refreshed: {coverage.lastRefreshed.toLocaleTimeString()}
            </span>
          )}
        </div>

        {coverage && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <h3 className="text-white font-semibold text-sm flex items-center gap-2 mb-3">
              <Activity className="w-4 h-4 text-blue-400" />
              Model Coverage
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div className="bg-gray-800/50 rounded-lg p-2 text-center">
                <p className="text-lg font-bold text-white">{coverage.totalOddsRows}</p>
                <p className="text-[10px] text-gray-500">Total Odds Rows</p>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-2 text-center">
                <p className="text-lg font-bold text-emerald-400">{coverage.modelReady}</p>
                <p className="text-[10px] text-gray-500">With Model</p>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-2 text-center">
                <p className="text-lg font-bold text-blue-400">{coverage.modelReadyPlayers}</p>
                <p className="text-[10px] text-gray-500">Model Ready Players</p>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-2 text-center">
                <p className="text-lg font-bold text-gray-400">{coverage.oddsOnly}</p>
                <p className="text-[10px] text-gray-500">Odds Only</p>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-2 text-center">
                <p className="text-lg font-bold text-red-400">{coverage.noStats}</p>
                <p className="text-[10px] text-gray-500">No Stats</p>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-2 text-center">
                <p className="text-lg font-bold text-amber-400">{coverage.insufficientSample}</p>
                <p className="text-[10px] text-gray-500">Insufficient Sample</p>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-2 text-center">
                <p className="text-lg font-bold text-orange-400">{coverage.wrongTeam}</p>
                <p className="text-[10px] text-gray-500">Wrong Team</p>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-2 text-center">
                <p className="text-lg font-bold text-purple-400">{coverage.unresolvedPlayer}</p>
                <p className="text-[10px] text-gray-500">Unresolved Player</p>
              </div>
            </div>
          </div>
        )}

        {noStatsFixResult && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
            <h3 className="text-white font-semibold text-sm flex items-center gap-2">
              <Wrench className="w-4 h-4 text-emerald-400" />
              Fix All NO STATS Players — Result
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              <div className="bg-gray-800/50 rounded-lg p-2">
                <p className="text-xs text-gray-500">Total NO STATS Players</p>
                <p className="text-lg font-bold text-white">{noStatsFixResult.totalNoStatsPlayers}</p>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-2">
                <p className="text-xs text-gray-500">Already Has Stats</p>
                <p className="text-lg font-bold text-blue-400">{noStatsFixResult.alreadyHasStats}</p>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-2">
                <p className="text-xs text-gray-500">Relinked to Stats Player</p>
                <p className="text-lg font-bold text-cyan-400">{noStatsFixResult.relinkedToStatsPlayer}</p>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-2">
                <p className="text-xs text-gray-500">Fixed (Stats Inserted)</p>
                <p className="text-lg font-bold text-emerald-400">{noStatsFixResult.backfilled}</p>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-2">
                <p className="text-xs text-gray-500">Failed</p>
                <p className="text-lg font-bold text-red-400">{noStatsFixResult.failed}</p>
              </div>
            </div>

            {/* Before / After Coverage */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-gray-800/30 rounded-lg p-2">
                <p className="text-xs text-gray-500 font-semibold mb-1">Before</p>
                <div className="grid grid-cols-3 gap-1 text-xs">
                  <div><span className="text-gray-500">Odds Rows:</span> <span className="text-white font-mono">{noStatsFixResult.beforeCoverage.totalOddsRows}</span></div>
                  <div><span className="text-gray-500">With Model:</span> <span className="text-emerald-400 font-mono">{noStatsFixResult.beforeCoverage.withModel}</span></div>
                  <div><span className="text-gray-500">Multi-Ready:</span> <span className="text-emerald-400 font-mono">{noStatsFixResult.beforeCoverage.multiReadyLegs}</span></div>
                  <div><span className="text-gray-500">NO STATS rows:</span> <span className="text-orange-400 font-mono">{noStatsFixResult.beforeCoverage.noStatsOddsRows}</span></div>
                  <div><span className="text-gray-500">NO STATS players:</span> <span className="text-orange-400 font-mono">{noStatsFixResult.beforeCoverage.noStatsUniquePlayers}</span></div>
                  <div><span className="text-gray-500">Insuff. rows:</span> <span className="text-amber-400 font-mono">{noStatsFixResult.beforeCoverage.insufficientSampleOddsRows}</span></div>
                  <div><span className="text-gray-500">Insuff. players:</span> <span className="text-amber-400 font-mono">{noStatsFixResult.beforeCoverage.insufficientSampleUniquePlayers}</span></div>
                </div>
              </div>
              <div className="bg-gray-800/30 rounded-lg p-2">
                <p className="text-xs text-gray-500 font-semibold mb-1">After</p>
                <div className="grid grid-cols-3 gap-1 text-xs">
                  <div><span className="text-gray-500">Odds Rows:</span> <span className="text-white font-mono">{noStatsFixResult.afterCoverage.totalOddsRows}</span></div>
                  <div><span className="text-gray-500">With Model:</span> <span className="text-emerald-400 font-mono">{noStatsFixResult.afterCoverage.withModel}</span></div>
                  <div><span className="text-gray-500">Multi-Ready:</span> <span className="text-emerald-400 font-mono">{noStatsFixResult.afterCoverage.multiReadyLegs}</span></div>
                  <div><span className="text-gray-500">NO STATS rows:</span> <span className="text-orange-400 font-mono">{noStatsFixResult.afterCoverage.noStatsOddsRows}</span></div>
                  <div><span className="text-gray-500">NO STATS players:</span> <span className="text-orange-400 font-mono">{noStatsFixResult.afterCoverage.noStatsUniquePlayers}</span></div>
                  <div><span className="text-gray-500">Insuff. rows:</span> <span className="text-amber-400 font-mono">{noStatsFixResult.afterCoverage.insufficientSampleOddsRows}</span></div>
                  <div><span className="text-gray-500">Insuff. players:</span> <span className="text-amber-400 font-mono">{noStatsFixResult.afterCoverage.insufficientSampleUniquePlayers}</span></div>
                </div>
              </div>
            </div>

            {/* Per-Match Coverage */}
            {noStatsFixResult.perMatchCoverage.length > 0 && (
              <div>
                <p className="text-xs text-gray-500 font-semibold mb-1">Per-Match Coverage (all {noStatsFixResult.perMatchCoverage.length} selected matches)</p>
                <div className="max-h-[200px] overflow-y-auto border border-gray-800 rounded-lg">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-800/30 border-b border-gray-800 sticky top-0">
                      <tr>
                        <th className="px-2 py-1.5 text-left text-gray-500">Match</th>
                        <th className="px-2 py-1.5 text-right text-gray-500">Odds Rows</th>
                        <th className="px-2 py-1.5 text-right text-gray-500">With Model</th>
                        <th className="px-2 py-1.5 text-right text-gray-500">NO STATS rows</th>
                        <th className="px-2 py-1.5 text-right text-gray-500">NO STATS players</th>
                        <th className="px-2 py-1.5 text-right text-gray-500">Insuff. rows</th>
                        <th className="px-2 py-1.5 text-right text-gray-500">Multi-Ready</th>
                      </tr>
                    </thead>
                    <tbody>
                      {noStatsFixResult.perMatchCoverage.map((m, i) => (
                        <tr key={i} className="border-b border-gray-800/30">
                          <td className="px-2 py-1.5 text-gray-300">{m.matchName}</td>
                          <td className="px-2 py-1.5 text-right text-gray-400 font-mono">{m.totalOddsRows}</td>
                          <td className="px-2 py-1.5 text-right text-emerald-400 font-mono">{m.withModel}</td>
                          <td className="px-2 py-1.5 text-right text-orange-400 font-mono">{m.noStatsOddsRows}</td>
                          <td className="px-2 py-1.5 text-right text-orange-400 font-mono">{m.noStatsUniquePlayers}</td>
                          <td className="px-2 py-1.5 text-right text-amber-400 font-mono">{m.insufficientSampleOddsRows}</td>
                          <td className="px-2 py-1.5 text-right text-emerald-400 font-mono">{m.multiReadyLegs}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Player-level details */}
            {noStatsFixResult.details.length > 0 && (
              <div>
                <p className="text-xs text-gray-500 font-semibold mb-1">Player-Level Results ({noStatsFixResult.details.length} players)</p>
                <div className="max-h-[400px] overflow-y-auto border border-gray-800 rounded-lg">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-800/30 border-b border-gray-800 sticky top-0">
                      <tr>
                        <th className="px-2 py-1.5 text-left text-gray-500">Player</th>
                        <th className="px-2 py-1.5 text-left text-gray-500">Team</th>
                        <th className="px-2 py-1.5 text-right text-gray-500">Curr ID Stats</th>
                        <th className="px-2 py-1.5 text-right text-gray-500">Matches</th>
                        <th className="px-2 py-1.5 text-left text-gray-500">Match Names</th>
                        <th className="px-2 py-1.5 text-right text-gray-500">Odds Rows</th>
                        <th className="px-2 py-1.5 text-left text-gray-500">Dup Stats ID</th>
                        <th className="px-2 py-1.5 text-right text-gray-500">Dup Stats</th>
                        <th className="px-2 py-1.5 text-center text-gray-500">Kali Found</th>
                        <th className="px-2 py-1.5 text-right text-gray-500">Stats Fetched</th>
                        <th className="px-2 py-1.5 text-right text-gray-500">Rows Inserted</th>
                        <th className="px-2 py-1.5 text-right text-gray-500">Odds Relinked</th>
                        <th className="px-2 py-1.5 text-left text-gray-500">Final Status</th>
                        <th className="px-2 py-1.5 text-left text-gray-500">Message</th>
                      </tr>
                    </thead>
                    <tbody>
                      {noStatsFixResult.details.map((d, i) => (
                        <tr key={i} className="border-b border-gray-800/30">
                          <td className="px-2 py-1.5 text-gray-300">{d.player_name}</td>
                          <td className="px-2 py-1.5 text-gray-400">{d.team ?? '—'}</td>
                          <td className="px-2 py-1.5 text-right text-gray-400 font-mono">{d.current_odds_player_id_stats_count}</td>
                          <td className="px-2 py-1.5 text-right text-gray-400">{d.matches_affected}</td>
                          <td className="px-2 py-1.5 text-[10px] text-gray-500 max-w-[150px] truncate">{d.match_names_affected.join(', ')}</td>
                          <td className="px-2 py-1.5 text-right text-gray-400 font-mono">{d.odds_rows_affected}</td>
                          <td className="px-2 py-1.5 text-[10px] text-gray-500 font-mono">{d.duplicate_stats_player_id ? d.duplicate_stats_player_id.slice(0, 8) : '—'}</td>
                          <td className="px-2 py-1.5 text-right text-gray-400 font-mono">{d.duplicate_stats_count || '—'}</td>
                          <td className="px-2 py-1.5 text-center">
                            {d.kali_player_found
                              ? <CheckCircle className="w-3.5 h-3.5 text-emerald-400 inline" />
                              : <X className="w-3.5 h-3.5 text-red-400 inline" />}
                          </td>
                          <td className="px-2 py-1.5 text-right text-gray-400 font-mono">{d.stats_fetched}</td>
                          <td className="px-2 py-1.5 text-right text-gray-400 font-mono">{d.valid_rows_inserted}</td>
                          <td className="px-2 py-1.5 text-right text-gray-400 font-mono">{d.odds_relinked}</td>
                          <td className="px-2 py-1.5">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                              d.final_status === 'FIXED_STATS_INSERTED' ? 'bg-emerald-500/20 text-emerald-400' :
                              d.final_status === 'ALREADY_HAS_STATS' ? 'bg-blue-500/20 text-blue-400' :
                              d.final_status === 'RELINKED_TO_STATS_PLAYER_ID' ? 'bg-cyan-500/20 text-cyan-400' :
                              d.final_status === 'INSUFFICIENT_SAMPLE_AFTER_INSERT' ? 'bg-amber-500/20 text-amber-400' :
                              d.final_status === 'NO_KALI_PLAYER_FOUND' ? 'bg-orange-500/20 text-orange-400' :
                              d.final_status === 'ERROR' ? 'bg-red-500/20 text-red-400' :
                              'bg-amber-500/20 text-amber-400'
                            }`}>
                              {d.final_status.replace(/_/g, ' ')}
                            </span>
                          </td>
                          <td className="px-2 py-1.5 text-[10px] text-gray-500 max-w-[200px] truncate">{d.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {noStatsFixResult.errors.length > 0 && (
              <div className="bg-red-950/30 border border-red-900 rounded-lg p-2 max-h-32 overflow-y-auto">
                <p className="text-xs text-red-400 font-semibold mb-1">Errors ({noStatsFixResult.errors.length})</p>
                {noStatsFixResult.errors.slice(0, 10).map((e, i) => (
                  <p key={i} className="text-xs text-red-300">{e}</p>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Standard Filters */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Target Odds</label>
            <input type="number" value={targetOdds} onChange={e => setTargetOdds(e.target.value)} step="0.1" min="1.5" max="10" className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-white text-sm" />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Min Sample</label>
            <select value={minSample} onChange={e => setMinSample(Number(e.target.value))} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-white text-sm">
              {[10, 12, 15, 18, 20, 25].map(n => <option key={n} value={n}>{n}+</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Min Hits</label>
            <select value={minHits} onChange={e => setMinHits(Number(e.target.value))} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-white text-sm">
              {[3, 4, 5, 6, 8, 10].map(n => <option key={n} value={n}>{n}+</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Max Odds</label>
            <select value={maxOdds} onChange={e => setMaxOdds(Number(e.target.value))} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-white text-sm">
              {[2, 2.5, 3, 3.5, 4, 5].map(n => <option key={n} value={n}>{n.toFixed(1)}</option>)}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Min Adj. Prob %</label>
            <select value={minAdjustedProb} onChange={e => setMinAdjustedProb(Number(e.target.value))} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-white text-sm">
              {[15, 20, 25, 30, 40, 50].map(n => <option key={n} value={n}>{n}%+</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Min Adj. EV %</label>
            <select value={minAdjustedEV} onChange={e => setMinAdjustedEV(Number(e.target.value))} className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-white text-sm">
              {[3, 5, 8, 10, 15].map(n => <option key={n} value={n}>{n}%+</option>)}
            </select>
          </div>
          <div className="col-span-2 flex items-center gap-4">
            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
              <input type="checkbox" checked={avoidWeakVenue} onChange={e => setAvoidWeakVenue(e.target.checked)} className="accent-amber-500" />
              Avoid Weak Venue
            </label>
            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
              <input type="checkbox" checked={avoidWeakOpponent} onChange={e => setAvoidWeakOpponent(e.target.checked)} className="accent-amber-500" />
              Avoid Weak Opp
            </label>
          </div>
        </div>

        {/* Market Filter */}
        <div className="border-t border-gray-800 pt-3 mt-3 space-y-2">
          <h5 className="text-xs font-medium text-gray-400 uppercase flex items-center gap-2">
            <Filter className="w-3 h-3" />
            Market Filter
          </h5>
          <p className="text-[10px] text-gray-600">Select which stat markets to include in multi generation</p>
          <div className="flex flex-wrap gap-3">
            {(['disposals', 'marks', 'tackles', 'goals', 'hitouts'] as const).map(market => (
              <label key={market} className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedMarkets[market]}
                  onChange={e => setSelectedMarkets(prev => ({ ...prev, [market]: e.target.checked }))}
                  className={market === 'disposals' ? 'accent-emerald-500' : 'accent-blue-500'}
                />
                <span className={selectedMarkets[market] ? 'text-white font-medium' : ''}>
                  {market.charAt(0).toUpperCase() + market.slice(1)}
                </span>
              </label>
            ))}
          </div>
        </div>

        {/* Position Edge Controls */}
        <div className="border-t border-gray-800 pt-3 mt-3 space-y-2">
          <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
            <input type="checkbox" checked={usePositionEdge} onChange={e => setUsePositionEdge(e.target.checked)} className="accent-emerald-500" />
            <Crosshair className="w-3 h-3 text-emerald-400" />
            Use Position Edge
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
            <input type="checkbox" checked={useVenueEdge} onChange={e => setUseVenueEdge(e.target.checked)} className="accent-blue-500" />
            <MapPin className="w-3 h-3 text-blue-400" />
            Use Venue Edge
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
            <input type="checkbox" checked={useOpponentEdge} onChange={e => setUseOpponentEdge(e.target.checked)} className="accent-amber-500" />
            <Swords className="w-3 h-3 text-amber-400" />
            Use Player vs Opponent Edge
          </label>
          <span className="text-[10px] text-gray-600 italic block">OFF by default — uses final_probability and final_ev from Position Edge-adjusted model</span>
          <div className="flex flex-wrap gap-3 mt-1">
            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
              <input type="checkbox" checked={preferPositionBoosts} onChange={e => setPreferPositionBoosts(e.target.checked)} className="accent-emerald-500" />
              Prefer Position Boosts
            </label>
            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
              <input type="checkbox" checked={hidePositionSuppressions} onChange={e => setHidePositionSuppressions(e.target.checked)} className="accent-red-500" />
              Hide Position Suppressions
            </label>
            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
              <input type="checkbox" checked={verySignificantOnly} onChange={e => setVerySignificantOnly(e.target.checked)} className="accent-amber-500" />
              Very Significant only
            </label>
            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
              <input type="checkbox" checked={includeUnknownPosition} onChange={e => setIncludeUnknownPosition(e.target.checked)} className="accent-blue-500" />
              Include UNKNOWN position groups
            </label>
          </div>
          <div className="flex flex-wrap gap-3 mt-1">
            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
              <input type="checkbox" checked={preferMatchupBoosts} onChange={e => setPreferMatchupBoosts(e.target.checked)} className="accent-emerald-500" />
              Prefer Matchup Boosts
            </label>
            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
              <input type="checkbox" checked={hideMatchupSuppressions} onChange={e => setHideMatchupSuppressions(e.target.checked)} className="accent-red-500" />
              Hide Matchup Suppressions
            </label>
            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
              <input type="checkbox" checked={hideSmallSampleMatchup} onChange={e => setHideSmallSampleMatchup(e.target.checked)} className="accent-amber-500" />
              Hide Small Sample Venue/Opp
            </label>
            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
              <input type="checkbox" checked={includeUnknownMatchup} onChange={e => setIncludeUnknownMatchup(e.target.checked)} className="accent-blue-500" />
              Include Unknown Matchup Data
            </label>
          </div>
        </div>

        {/* Tag Risk Settings */}
        <div className="border-t border-gray-800 pt-3 mt-3 space-y-2">
          <h5 className="text-xs font-medium text-gray-400 flex items-center gap-2">
            <Shield className="w-3 h-3" />
            Tag Risk Exclusions
          </h5>
          <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
            <input type="checkbox" checked={avoidHighTagRisk} onChange={e => setAvoidHighTagRisk(e.target.checked)} className="accent-red-500" />
            <Shield className="w-3 h-3 text-red-400" />
            Avoid High Tag Risk Players
            <span className="text-gray-600">(default: ON)</span>
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
            <input type="checkbox" checked={avoidModerateTagRisk} onChange={e => setAvoidModerateTagRisk(e.target.checked)} className="accent-amber-500" />
            <AlertTriangle className="w-3 h-3 text-amber-400" />
            Avoid Moderate Tag Risk Players
            <span className="text-gray-600">(default: OFF)</span>
          </label>
        </div>
      </div>

      {/* Smart Multi Builder — single unified builder */}
      {multiMode === 'pullEm' ? (
        <PullEmDisposalMultiPanel
          matchNames={matchNames}
          matches={matches}
          selectedMatchIds={selectedMatchIds}
          modelledRows={modelledRows}
          coverage={coverage}
        />
      ) : (
        <MultiOptimizerPanel
          recommendations={disposalRecommendations}
          matchNames={matchNames}
          matches={matches}
          selectedMatchId={selectedGameMatchId}
          onSelectMatch={setSelectedGameMatchId}
          statsRoundLabel={statsRoundLabel}
          lineSafety={lineSafety}
          onLineSafetyChange={setLineSafety}
          teamEnvMap={teamEnvMap}
          teamMatchups={teamMatchups}
          teamStats={teamStats}
          roleTrends={roleTrends}
          onResultsChange={handlePanelResultsChange}
        />
      )}

      {/* Excluded Players Panel */}
      {exclusions.length > 0 && (
        <div className="bg-gray-900 border border-red-500/30 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-medium text-red-400 uppercase flex items-center gap-2">
              <UserX className="w-3.5 h-3.5" />
              Excluded Players ({exclusions.length})
            </h4>
            <button
              onClick={clearAllExclusions}
              className="flex items-center gap-1.5 px-2 py-1 text-xs text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 rounded transition"
            >
              <RotateCcw className="w-3 h-3" />
              Clear All
            </button>
          </div>
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {exclusions.map(e => (
              <div key={e.id} className="flex items-center justify-between p-2 bg-gray-800/50 rounded-lg border border-gray-700/50">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-white text-xs font-medium truncate">{e.playerName || e.matchName || e.id}</span>
                    {e.team && <span className="text-gray-500 text-xs">({e.team})</span>}
                    {e.statType && <span className="text-amber-400 text-xs">{e.statType}</span>}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                      e.source === 'tag_risk' ? 'bg-amber-500/20 text-amber-400' : 'bg-gray-700 text-gray-400'
                    }`}>
                      {e.reason}
                    </span>
                    {e.source === 'tag_risk' && e.taggedBy && (
                      <span className="text-[10px] text-gray-500">Tagged by: {e.taggedBy}</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {e.source === 'tag_risk' && !e.allowAnyway && (
                    <button
                      onClick={() => allowExclusion(e.id)}
                      className="px-2 py-1 text-xs text-emerald-400 hover:text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/20 rounded transition"
                      title="Allow this player anyway"
                    >
                      Allow Anyway
                    </button>
                  )}
                  <button
                    onClick={() => removeExclusion(e.id)}
                    className="p-1 text-gray-500 hover:text-red-400 transition"
                    title="Remove exclusion"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Exclusion Diagnostics */}
      <div className="grid grid-cols-4 gap-3">
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-3 text-center">
          <p className="text-lg font-bold text-amber-400">{exclusionDiagnostics.excludedByUser}</p>
          <p className="text-xs text-gray-500">Excluded by User</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-3 text-center">
          <p className="text-lg font-bold text-red-400">{exclusionDiagnostics.excludedByTagRisk}</p>
          <p className="text-xs text-gray-500">Excluded by Tag Risk</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-3 text-center">
          <p className="text-lg font-bold text-emerald-400">{exclusionDiagnostics.availableAfterExclusions}</p>
          <p className="text-xs text-gray-500">Available Legs</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-3 text-center">
          <p className="text-lg font-bold text-blue-400">{exclusionDiagnostics.totalCandidates}</p>
          <p className="text-xs text-gray-500">Suggested Multis</p>
        </div>
      </div>

      {/* Advanced Diagnostics — collapsed by default */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <button
          onClick={() => setShowAdvancedDiagnostics(!showAdvancedDiagnostics)}
          className="w-full flex items-center justify-between p-3 hover:bg-gray-800/50 transition"
        >
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Advanced Diagnostics</span>
          <span className="text-xs text-gray-600">{showAdvancedDiagnostics ? 'Hide' : 'Show'}</span>
        </button>
      </div>
      {showAdvancedDiagnostics && (
      <div className="space-y-4">

      {/* Valid Leg Funnel */}
      <div className="bg-gray-900 border border-cyan-500/20 rounded-xl p-4">
        <h4 className="text-xs font-semibold text-cyan-400 uppercase tracking-wide mb-3 flex items-center gap-2">
          <Filter className="w-3.5 h-3.5" />
          Valid Leg Funnel
        </h4>
        <div className="space-y-1.5 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-gray-400">Total odds rows</span>
            <span className="text-white font-bold">{legFunnel.total}</span>
          </div>
          {legFunnel.notModelReady > 0 && (
            <div className="flex items-center justify-between text-red-400">
              <span>- Not MODEL_READY (NO_STATS / UNRESOLVED / WRONG_TEAM / INSUFFICIENT)</span>
              <span className="font-bold">-{legFunnel.notModelReady}</span>
            </div>
          )}
          <div className="flex items-center justify-between border-t border-gray-800 pt-1.5">
            <span className="text-gray-300">After MODEL_READY filter</span>
            <span className="text-white font-bold">{legFunnel.afterModelReady}</span>
          </div>
          {legFunnel.removedSample > 0 && (
            <div className="flex items-center justify-between text-amber-400">
              <span>- Sample &lt; {minSample}</span>
              <span className="font-bold">-{legFunnel.removedSample}</span>
            </div>
          )}
          {legFunnel.removedHits > 0 && (
            <div className="flex items-center justify-between text-amber-400">
              <span>- Hits &lt; {minHits}</span>
              <span className="font-bold">-{legFunnel.removedHits}</span>
            </div>
          )}
          {legFunnel.removedMaxOdds > 0 && (
            <div className="flex items-center justify-between text-amber-400">
              <span>- Odds &gt; {maxOdds}</span>
              <span className="font-bold">-{legFunnel.removedMaxOdds}</span>
            </div>
          )}
          {legFunnel.removedMinProb > 0 && (
            <div className="flex items-center justify-between text-amber-400">
              <span>- Adj Prob &lt; {minAdjustedProb}%</span>
              <span className="font-bold">-{legFunnel.removedMinProb}</span>
            </div>
          )}
          {legFunnel.removedEV > 0 && (
            <div className="flex items-center justify-between text-amber-400">
              <span>- Adj EV &lt; {minAdjustedEV}%</span>
              <span className="font-bold">-{legFunnel.removedEV}</span>
            </div>
          )}
          {legFunnel.removedRisk > 0 && (
            <div className="flex items-center justify-between text-amber-400">
              <span>- Risk level excluded by mode</span>
              <span className="font-bold">-{legFunnel.removedRisk}</span>
            </div>
          )}
          {legFunnel.removedVenue > 0 && (
            <div className="flex items-center justify-between text-amber-400">
              <span>- Weak venue (avoid enabled)</span>
              <span className="font-bold">-{legFunnel.removedVenue}</span>
            </div>
          )}
          {legFunnel.removedOpponent > 0 && (
            <div className="flex items-center justify-between text-amber-400">
              <span>- Weak opponent (avoid enabled)</span>
              <span className="font-bold">-{legFunnel.removedOpponent}</span>
            </div>
          )}
          {legFunnel.removedMarket > 0 && (
            <div className="flex items-center justify-between text-amber-400">
              <span>- Market filter / position exclusion</span>
              <span className="font-bold">-{legFunnel.removedMarket}</span>
            </div>
          )}
          {legFunnel.removedExclusions > 0 && (
            <div className="flex items-center justify-between text-red-400">
              <span>- Manual / tag-risk exclusions</span>
              <span className="font-bold">-{legFunnel.removedExclusions}</span>
            </div>
          )}
          <div className="flex items-center justify-between border-t-2 border-emerald-500/30 pt-2 mt-1">
            <span className="text-emerald-400 font-semibold">Final Valid Legs</span>
            <span className={`font-bold text-lg ${legFunnel.finalValidLegs >= 2 ? 'text-emerald-400' : 'text-red-400'}`}>{legFunnel.finalValidLegs}</span>
          </div>
          {legFunnel.finalValidLegs < 2 && (
            <p className="text-red-400 text-[10px] mt-1">Need at least 2 valid legs to build multis.</p>
          )}
        </div>
      </div>

      {/* Active Betting Slate Banner */}
      {slateInfo && (
        <div className="bg-gray-900 border border-cyan-500/20 rounded-xl p-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-cyan-400" />
                <span className="text-xs text-gray-500 uppercase tracking-wider">Active betting slate</span>
                <span className="text-cyan-400 font-bold text-sm">
                  {slateInfo.activeRound ? `Round ${slateInfo.activeRound}` : '—'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 uppercase tracking-wider">Stats used through</span>
                <span className="text-emerald-400 font-bold text-sm">
                  {slateInfo.statsRound ? `Round ${slateInfo.statsRound}` : '—'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500 uppercase tracking-wider">Selected matches</span>
                <span className="text-white font-bold text-sm">{selectedMatchIds.length} of {matches.length}</span>
              </div>
            </div>
            {/* Round Selector */}
            <div className="flex items-center gap-2">
              <label className="text-xs text-gray-500 uppercase tracking-wider">Round</label>
              <select
                value={roundSelector}
                onChange={e => setRoundSelector(e.target.value)}
                className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-1.5 focus:outline-none focus:border-cyan-500"
              >
                <option value="auto">Auto / Next Betting Round</option>
                <option value="19">Round 19</option>
                <option value="18">Round 18</option>
                <option value="17">Round 17</option>
                <option value="16">Round 16</option>
              </select>
            </div>
          </div>
        </div>
      )}

      {/* Missing Fixtures Warning */}
      {slateInfo && !slateInfo.fixturesReady && slateInfo.activeRound && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-amber-400" />
            <div>
              <p className="text-amber-400 font-semibold text-sm">
                Round {slateInfo.activeRound} fixtures missing.
              </p>
              <p className="text-gray-500 text-xs mt-0.5">
                Go to Import Data to import or sync Round {slateInfo.activeRound} fixtures.
              </p>
            </div>
          </div>
          <Link to="/import" className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium rounded-lg transition whitespace-nowrap">
            Import Fixtures
          </Link>
        </div>
      )}

      {/* Missing Odds Warning */}
      {slateInfo && slateInfo.fixturesReady && !slateInfo.oddsReady && slateInfo.activeRound && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-amber-400" />
            <div>
              <p className="text-amber-400 font-semibold text-sm">
                Round {slateInfo.activeRound} fixtures found, but player prop odds are missing.
              </p>
              <p className="text-gray-500 text-xs mt-0.5">
                Run Sync Player Props on the Import Data page.
              </p>
            </div>
          </div>
          <Link to="/import" className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-medium rounded-lg transition whitespace-nowrap">
            Sync Round {slateInfo.activeRound} Player Props
          </Link>
        </div>
      )}

      {/* Match Selection */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <div className="flex items-center justify-between mb-2">
          <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider">Matches</label>
          <div className="flex items-center gap-2">
            <span className="text-xs text-emerald-400 font-medium">
              Selected: {selectedMatchIds.length} of {matches.length}
            </span>
            <button
              onClick={() => setSelectedMatchIds(matches.map(m => m.id))}
              className="text-[10px] px-2 py-0.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 rounded hover:bg-emerald-500/20 transition"
            >
              Select All
            </button>
            <button
              onClick={() => setSelectedMatchIds([])}
              className="text-[10px] px-2 py-0.5 bg-gray-700 text-gray-400 border border-gray-600 rounded hover:bg-gray-600 transition"
            >
              Clear
            </button>
          </div>
        </div>
        {selectedMatchIds.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-2">
            {matches.filter(m => selectedMatchIds.includes(m.id)).map(m => (
              <span key={m.id} className="text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded px-1.5 py-0.5">
                {m.home_team} vs {m.away_team}
              </span>
            ))}
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {matches.map(m => {
            const selected = selectedMatchIds.includes(m.id);
            return (
              <label key={m.id} className={`flex items-center gap-2 p-2 rounded-lg border cursor-pointer transition text-xs ${selected ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-gray-800/40 border-gray-700 hover:border-gray-600'}`}>
                <input type="checkbox" checked={selected} onChange={e => { if (e.target.checked) setSelectedMatchIds(ids => [...ids, m.id]); else setSelectedMatchIds(ids => ids.filter(id => id !== m.id)); }} className="accent-emerald-500" />
                <span className="text-white font-medium truncate">{m.home_team} vs {m.away_team}</span>
                <span className="text-gray-500">{m.round || 'TBD'}</span>
              </label>
            );
          })}
        </div>

        {/* DB Truth Check */}
        <div className="mt-3 pt-3 border-t border-gray-800">
          <button
            onClick={runDbTruthCheck}
            disabled={dbTruthLoading || selectedMatchIds.length === 0}
            className="flex items-center gap-2 px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white font-medium rounded-lg text-xs transition"
          >
            {dbTruthLoading ? <LoadingSpinner /> : <Activity className="w-3.5 h-3.5" />}
            DB Truth Check Multi Builder
          </button>
          {dbTruth && (
            <div className="mt-3 p-3 bg-gray-800/60 border border-gray-700 rounded-lg space-y-2">
              <p className="text-xs font-semibold text-cyan-400 uppercase tracking-wide">DB Truth Check Results</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                <div className="bg-gray-900 rounded p-2">
                  <p className="text-white font-bold text-base">{dbTruth.totalOddsRows}</p>
                  <p className="text-gray-500">Total Bookmaker Odds Rows</p>
                </div>
                <div className="bg-gray-900 rounded p-2">
                  <p className="text-white font-bold text-base">{dbTruth.uniqueBookmakerPlayerIds}</p>
                  <p className="text-gray-500">Unique Player IDs in Odds</p>
                </div>
                <div className="bg-gray-900 rounded p-2">
                  <p className={`font-bold text-base ${dbTruth.nullPlayerIdRows > 0 ? 'text-red-400' : 'text-emerald-400'}`}>{dbTruth.nullPlayerIdRows}</p>
                  <p className="text-gray-500">Null Player ID Rows</p>
                </div>
                <div className="bg-gray-900 rounded p-2">
                  <p className={`font-bold text-base ${dbTruth.brokenPlayerIdRows > 0 ? 'text-red-400' : 'text-emerald-400'}`}>{dbTruth.brokenPlayerIdRows}</p>
                  <p className="text-gray-500">Broken Player ID Rows</p>
                </div>
                <div className="bg-gray-900 rounded p-2">
                  <p className={`font-bold text-base ${dbTruth.playerIdsWithZeroStats.length > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>{dbTruth.playerIdsWithZeroStats.length}</p>
                  <p className="text-gray-500">Player IDs with 0 Stats</p>
                </div>
                <div className="bg-gray-900 rounded p-2">
                  <p className="text-amber-400 font-bold text-base">{dbTruth.playerIdsWith1to14Stats.length}</p>
                  <p className="text-gray-500">Player IDs with 1–14 Stats</p>
                </div>
                <div className="bg-gray-900 rounded p-2">
                  <p className="text-emerald-400 font-bold text-base">{dbTruth.playerIdsWith15PlusStats.length}</p>
                  <p className="text-gray-500">Player IDs with 15+ Stats</p>
                </div>
                <div className={`bg-gray-900 rounded p-2 ${dbTruth.resolverBugRows.length > 0 ? 'border border-red-500' : ''}`}>
                  <p className={`font-bold text-base ${dbTruth.resolverBugRows.length > 0 ? 'text-red-400' : 'text-emerald-400'}`}>{dbTruth.resolverBugRows.length}</p>
                  <p className="text-gray-500">Resolver Bug Rows (DB has stats but NO_STATS)</p>
                </div>
              </div>
              {dbTruth.resolverBugRows.length > 0 && (
                <div className="mt-2 p-2 bg-red-950/40 border border-red-700 rounded text-xs space-y-1">
                  <p className="text-red-400 font-semibold">RESOLVER BUG — modelResolver says NO_STATS but DB has stats:</p>
                  {dbTruth.resolverBugRows.slice(0, 10).map((r, i) => (
                    <div key={i} className="flex items-center gap-2 text-red-300">
                      <span>{r.player_name}</span>
                      <span className="text-gray-500 font-mono text-[10px]">{r.player_id}</span>
                      <span className="text-emerald-400">{r.directDbCount} stats in DB</span>
                      <span className="text-red-400 font-bold">→ {r.modelStatus}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Relink Round Odds to Canonical Players */}
      <div className="mt-6 bg-gray-900 border border-cyan-500/20 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-cyan-400 font-semibold text-sm flex items-center gap-2">
            <LinkIcon className="w-4 h-4" />
            Relink Round Odds to Canonical Players
          </h3>
          <button
            onClick={handleRelink}
            disabled={relinkLoading || selectedMatchIds.length === 0}
            className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white text-xs font-medium rounded-lg transition flex items-center gap-1.5"
          >
            {relinkLoading ? <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <LinkIcon className="w-3.5 h-3.5" />}
            Relink Selected Matches
          </button>
        </div>
        {relinkResult && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
              <div className="bg-gray-800 rounded p-2">
                <p className="text-[10px] text-gray-500 uppercase">Total Odds Rows</p>
                <p className="text-white font-bold text-sm">{relinkResult.totalOddsRows}</p>
              </div>
              <div className="bg-gray-800 rounded p-2">
                <p className="text-[10px] text-gray-500 uppercase">Unique Players</p>
                <p className="text-white font-bold text-sm">{relinkResult.uniqueBookmakerPlayers}</p>
              </div>
              <div className="bg-gray-800 rounded p-2">
                <p className="text-[10px] text-gray-500 uppercase">Resolved</p>
                <p className="text-emerald-400 font-bold text-sm">{relinkResult.uniqueResolvedPlayers}</p>
              </div>
              <div className="bg-gray-800 rounded p-2">
                <p className="text-[10px] text-gray-500 uppercase">Unresolved</p>
                <p className="text-red-400 font-bold text-sm">{relinkResult.uniqueUnresolvedPlayers}</p>
              </div>
              <div className="bg-gray-800 rounded p-2">
                <p className="text-[10px] text-gray-500 uppercase">Rows Relinked</p>
                <p className="text-cyan-400 font-bold text-sm">{relinkResult.oddsRowsRelinked}</p>
              </div>
              <div className="bg-gray-800 rounded p-2">
                <p className="text-[10px] text-gray-500 uppercase">Still Unresolved</p>
                <p className="text-amber-400 font-bold text-sm">{relinkResult.oddsRowsStillUnresolved}</p>
              </div>
            </div>

            {relinkResult.resolvedPlayers.length > 0 && (
              <div>
                <p className="text-xs text-emerald-400 font-medium mb-1">Resolved Players ({relinkResult.resolvedPlayers.length})</p>
                <div className="max-h-40 overflow-y-auto bg-gray-800/50 rounded border border-gray-700/50">
                  {relinkResult.resolvedPlayers.slice(0, 30).map((p, i) => (
                    <div key={i} className="flex items-center justify-between px-2 py-1 text-xs border-b border-gray-800/30">
                      <span className="text-gray-300">{p.bookmakerName}</span>
                      <span className="text-gray-500">{p.match}</span>
                      <span className="text-emerald-400 font-mono text-[10px]">{p.resolvedPlayerId.slice(0, 8)}</span>
                      <span className="text-gray-500 text-[10px]">{p.resolvedTeam}</span>
                      <span className="text-cyan-400 text-[10px]">{p.oddsRowsRelinked} rows</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {relinkResult.unresolvedPlayers.length > 0 && (
              <div>
                <p className="text-xs text-red-400 font-medium mb-1">Unresolved Players ({relinkResult.unresolvedPlayers.length})</p>
                <div className="max-h-60 overflow-y-auto bg-gray-800/50 rounded border border-gray-700/50">
                  {relinkResult.unresolvedPlayers.map((p, i) => (
                    <div key={i} className="px-2 py-2 text-xs border-b border-gray-800/30">
                      <div className="flex items-center justify-between">
                        <span className="text-red-300 font-medium">{p.bookmakerName}</span>
                        <span className="text-gray-500">{p.match}</span>
                      </div>
                      <div className="text-gray-500 text-[10px] mt-1">
                        Candidates: {p.exactNameCandidateCount} | IDs: {p.candidatePlayerIds.map(id => id.slice(0, 8)).join(', ')} | Teams: {p.candidateTeams.join(', ')} | Stats Teams: {p.latestStatsTeams.join(', ')}
                      </div>
                      <div className="text-amber-400 text-[10px] mt-0.5">Reason: {p.reasonNotLinked}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6">
        {/* Manual Picker — cross-match manual builder, separate from the per-match
            Build Your Own Multi inside the Game/Round Multi Builder above. Kept as-is
            for tonight; candidate for consolidation in a future pass. */}
        <div className="space-y-4">
          <h3 className="text-white font-semibold text-sm">Manual Multi (cross-match)</h3>
          {manualLegs.length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 bg-gray-800/40 flex items-center justify-between">
                <span className="text-white font-bold font-mono">{manualCombinedOdds.toFixed(2)}x</span>
                <span className={`text-xs font-bold ${manualCombinedEV > 0 ? 'text-emerald-400' : 'text-gray-500'}`}>
                  {manualCombinedEV >= 0 ? '+' : ''}{(manualCombinedEV * 100).toFixed(1)}% EV
                </span>
              </div>
              <div className="p-3 space-y-2">
                {manualLegs.map((leg, i) => (
                  <div key={i} className="flex items-center gap-3 p-2 bg-gray-800/40 rounded-lg">
                    <div className="flex-1 min-w-0">
                      <p className="text-white text-xs font-medium">{leg.row.player_name}</p>
                      <p className="text-gray-500 text-xs">{leg.statKey} {leg.row.display_label}</p>
                    </div>
                    <span className={`px-1 py-0.5 rounded text-xs ${leg.row.modelProb.risk_level === 'Low' ? 'bg-emerald-500/20 text-emerald-400' : leg.row.modelProb.risk_level === 'Medium' ? 'bg-amber-500/20 text-amber-400' : 'bg-red-500/20 text-red-400'}`}>
                      {leg.row.modelProb.risk_level}
                    </span>
                    <span className="text-xs text-emerald-400">+{(leg.evPercent * 100).toFixed(1)}%</span>
                    <button onClick={() => setManualLegs(legs => legs.filter((_, li) => li !== i))} className="text-gray-600 hover:text-red-400">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
              {manualWarnings.length > 0 && (
                <div className="px-4 py-2 border-t border-amber-500/30 flex items-center gap-2 text-xs text-amber-400 bg-amber-500/5">
                  <AlertTriangle className="w-3 h-3" />
                  {manualWarnings.join(', ')}
                </div>
              )}
            </div>
          )}

          {/* Odds-Only Markets */}
          {oddsOnlyRows.length > 0 && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-amber-500/30 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-amber-400" />
                <h3 className="text-amber-400 font-semibold text-sm">Not Model Ready Markets</h3>
                <span className="text-xs text-gray-500">— not enough non-null stat values or player unresolved ({oddsOnlyRows.length} rows)</span>
              </div>
              <div className="px-4 py-2 bg-amber-500/5 border-b border-amber-500/20">
                <p className="text-[11px] text-gray-400">
                  Some odds rows have no model because player stats are missing or sample is too small.{' '}
                  <a href="/missing-stats-repair" className="text-blue-400 hover:text-blue-300 underline">Fix in Data → Missing Stats Repair</a>
                </p>
              </div>
              <div className="p-3 max-h-[300px] overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-gray-800/30 border-b border-gray-800 sticky top-0">
                    <tr>
                      <th className="px-2 py-1.5 text-left text-gray-500">Player</th>
                      <th className="px-2 py-1.5 text-left text-gray-500">rawMarket</th>
                      <th className="px-2 py-1.5 text-left text-gray-500">statType</th>
                      <th className="px-2 py-1.5 text-left text-gray-500">resolvedStat</th>
                      <th className="px-2 py-1.5 text-right text-gray-500">line</th>
                      <th className="px-2 py-1.5 text-right text-gray-500">Odds</th>
                      <th className="px-2 py-1.5 text-left text-gray-500">Status</th>
                      <th className="px-2 py-1.5 text-right text-gray-500">DB Rows</th>
                      <th className="px-2 py-1.5 text-right text-gray-500">NonNull</th>
                      <th className="px-2 py-1.5 text-right text-gray-500">Sample</th>
                      <th className="px-2 py-1.5 text-right text-gray-500">Hits</th>
                      <th className="px-2 py-1.5 text-left text-gray-500">First 5</th>
                      <th className="px-2 py-1.5 text-left text-gray-500">PID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {oddsOnlyRows.slice(0, 50).map((r, i) => (
                      <tr key={r.id || i} className="border-b border-gray-800/30">
                        <td className="px-2 py-1.5 text-gray-300 font-medium">{r.player_name ?? 'Unknown'}</td>
                        <td className="px-2 py-1.5 text-gray-500 font-mono text-[10px]">{r.raw_market ?? '—'}</td>
                        <td className="px-2 py-1.5 text-blue-300 font-mono text-[10px]">{r.rawStatType ?? 'null'}</td>
                        <td className="px-2 py-1.5 text-cyan-300 font-mono text-[10px]">{r.resolvedStatType ?? '—'}</td>
                        <td className="px-2 py-1.5 text-right text-gray-400 font-mono">{r.line ?? '—'}</td>
                        <td className="px-2 py-1.5 text-right text-white font-mono">{typeof r.over_odds === 'number' ? r.over_odds.toFixed(2) : '—'}</td>
                        <td className="px-2 py-1.5">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                            r.modelStatus === 'PLAYER_UNRESOLVED' ? 'bg-red-500/20 text-red-400' :
                            r.modelStatus === 'NO_STATS' ? 'bg-orange-500/20 text-orange-400' :
                            r.modelStatus === 'INSUFFICIENT_MARKET_SAMPLE' ? 'bg-amber-500/20 text-amber-400' :
                            r.modelStatus === 'WRONG_TEAM' ? 'bg-orange-500/20 text-orange-400' :
                            'bg-gray-600/30 text-gray-400'
                          }`}>
                            {(r.modelStatus ?? 'UNKNOWN').replace(/_/g, ' ')}
                          </span>
                        </td>
                        <td className={`px-2 py-1.5 text-right font-mono ${
                          r.directDbStatsCount === 0 ? 'text-red-400' :
                          r.directDbStatsCount < 15 ? 'text-amber-400' : 'text-emerald-400'
                        }`}>{r.directDbStatsCount ?? 0}</td>
                        <td className={`px-2 py-1.5 text-right font-mono ${
                          (r.nonNullStatValues ?? 0) === 0 ? 'text-red-400' :
                          (r.nonNullStatValues ?? 0) < 5 ? 'text-amber-400' : 'text-emerald-400'
                        }`}>{r.nonNullStatValues ?? 0}</td>
                        <td className={`px-2 py-1.5 text-right font-mono ${
                          (r.marketSampleCount ?? 0) === 0 ? 'text-red-400' :
                          (r.marketSampleCount ?? 0) < 15 ? 'text-amber-400' : 'text-emerald-400'
                        }`}>{r.marketSampleCount ?? 0}</td>
                        <td className="px-2 py-1.5 text-right text-gray-400 font-mono">{r.modelProb?.hit_count ?? 0}</td>
                        <td className="px-2 py-1.5 text-gray-500 font-mono text-[10px]">
                          {r.firstFiveValues && r.firstFiveValues.length > 0
                            ? '[' + r.firstFiveValues.join(', ') + ']'
                            : '[]'}
                        </td>
                        <td className="px-2 py-1.5 text-gray-500 font-mono text-[10px]">{r.player_id ? r.player_id.slice(0, 8) : 'null'}</td>
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

          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden max-h-[400px] overflow-y-auto">
            <div className="px-4 py-3 border-b border-gray-700/40 sticky top-0 bg-gray-800">
              <p className="text-xs text-gray-500">{validLegs.length} realistic legs</p>
            </div>
            <div className="divide-y divide-gray-800/30">
              {validLegs.slice(0, 50).map(row => {
                const playerKey = row.player_id || row.player_name;
                const statKey = extractStatType(row.raw_market) || 'other';
                const isAdded = manualLegs.some(l => l.playerKey === playerKey);

                return (
                  <div key={row.id} className={`group relative w-full px-4 py-2 hover:bg-gray-800/30 transition ${isAdded ? 'bg-gray-800/40' : ''}`}>
                    <button
                      onClick={() => addLeg(row)}
                      disabled={isAdded || manualLegs.some(l => l.playerKey === playerKey) || manualLegs.some(l => l.playerKey === playerKey && l.statKey === statKey) || (!allowSameMatch && manualLegs.some(l => l.matchId === row.match_id)) || (allowSameMatch && manualLegs.filter(l => l.matchId === row.match_id).length >= effectiveMaxLegsPerMatch)}
                      className="w-full text-left disabled:opacity-50"
                    >
                      <div className="flex items-center gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-white text-xs font-medium truncate">{row.player_name}</p>
                            {isAdded && <CheckCircle className="w-3 h-3 text-emerald-400" />}
                          </div>
                          <p className="text-gray-500 text-xs">{statKey} {row.display_label}</p>
                        </div>
                        <span className="text-xs text-gray-400">{row.over_odds.toFixed(2)}</span>
                        <span className="text-xs font-bold text-emerald-400">+{((row.adjustedEV || 0) * 100).toFixed(1)}%</span>
                        <span className={`px-1 py-0.5 rounded text-xs ${row.modelProb.risk_level === 'Low' ? 'bg-emerald-500/20 text-emerald-400' : row.modelProb.risk_level === 'Medium' ? 'bg-amber-500/20 text-amber-400' : 'bg-red-500/20 text-red-400'}`}>
                          {row.modelProb.risk_level}
                        </span>
                        {usePositionEdge && (
                          <span className={`inline-block px-1 py-0.5 rounded border text-[9px] ${getPositionEdgeColor(row.positionEdge)}`}>
                            {row.positionGroup === 'UNKNOWN' ? 'UNK' : row.positionGroup}
                          </span>
                        )}
                      </div>
                    </button>
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 flex items-center gap-1 transition">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const team = row.playerTeam || '';
                          excludePlayer(row.player_id || playerKey, row.player_name, team);
                        }}
                        className="p-1.5 text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded transition"
                        title="Exclude Player"
                      >
                        <UserX className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const team = row.playerTeam || '';
                          excludePlayerStat(row.player_id || playerKey, row.player_name, team, statKey);
                        }}
                        className="p-1.5 text-amber-400 hover:text-amber-300 hover:bg-amber-500/10 rounded transition"
                        title="Exclude This Stat"
                      >
                        <Ban className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const match = matches.find(m => m.id === row.match_id);
                          const matchName = match ? `${match.home_team} vs ${match.away_team}` : row.match_id;
                          excludeMatch(row.match_id, matchName);
                        }}
                        className="p-1.5 text-gray-400 hover:text-gray-300 hover:bg-gray-500/10 rounded transition"
                        title="Exclude This Match"
                      >
                        <Filter className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      </div>
      )}

    </div>
  );
}
