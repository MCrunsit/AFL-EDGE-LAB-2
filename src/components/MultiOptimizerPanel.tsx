import { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import { Target, Award, AlertCircle, Loader2, X, RefreshCw, ChevronDown, ChevronRight, Zap, AlertTriangle, Wrench, Check, UserX, Search, ArrowUpDown, ListPlus, Info, Plus, Wand2 } from 'lucide-react';
import type { MultiCandidate, OptimizerDiagnostics, OptimizerProgress, MultiOptimizerSettings, CancellationRef } from '../lib/multiOptimizer';
import { runMultiOptimizerAsync, GAME_MULTI_PRESET, ROUND_MULTI_PRESET, applyCorrelationHaircut } from '../lib/multiOptimizer';
import type { DisposalLineRecommendation } from '../lib/disposalLineSelector';
import type { LineSafetyMode } from '../lib/disposalLineSelector';
import type { TeamEnvironmentMap, TeamMatchupEnvironment } from '../lib/teamStatsService';
import { getLabelDisplay } from '../lib/teamStatsService';
import type { RoleTrendMap } from '../lib/roleTrendService';
import { getTrendDisplay } from '../lib/roleTrendService';
import type { Match } from '../lib/types';
import type { ModelledOddsRow } from '../lib/modelResolver';
import { getModelledBookmakerOddsForMatch } from '../lib/modelResolver';
import { buildPullEmLegs, hasConflict, type PullEmLeg, type PullEmSettings } from '../lib/pullEmMultiOptimizer';
import {
  getExcludedPlayers, excludePlayer, unexcludePlayer, clearExcludedPlayers,
  type ExcludedPlayer,
} from '../lib/playerExclusions';

const ALL_LINES_SETTINGS: PullEmSettings = {
  marketFocus: 'disposals_only',
  marketTypes: new Set(['ladder', 'over', 'under']),
  minCombinedOdds: 0,
  maxCombinedOdds: 1000,
  minLegs: 1,
  maxLegs: 20,
  minHitRate: 0,
  minModelConfidence: 0,
  minExpectedValue: -1000,
  confirmedPlayersOnly: false,
  allowUnders: true,
  generationMode: 'balanced',
};

type AltSortKey = 'safest' | 'ev' | 'prob' | 'odds' | 'season' | 'last5';
type CompletionMode = 'safest' | 'bestValue' | 'closestTarget' | 'bestMatchup' | 'lowestCorrelation';

function legKey(leg: PullEmLeg): string {
  return `${leg.playerId}|${leg.selectionType}|${leg.line}`;
}

interface Props {
  recommendations: DisposalLineRecommendation[];
  matchNames: Record<string, string>;
  matches: Match[];
  selectedMatchId: string | null;
  onSelectMatch: (matchId: string) => void;
  statsRoundLabel: string;
  lineSafety: LineSafetyMode;
  onLineSafetyChange: (mode: LineSafetyMode) => void;
  teamEnvMap?: TeamEnvironmentMap;
  teamMatchups?: TeamMatchupEnvironment[];
  roleTrends?: RoleTrendMap;
  /** Reports this panel's live counts up so the page-level diagnostics can show real, reconciled totals instead of a separate stale pipeline. */
  onResultsChange?: (info: { poolSize: number; multiCount: number; customLegsAvailable: number }) => void;
}

function LegRow({ leg, index }: { leg: MultiCandidate['legs'][number]; index: number }) {
  const row = leg?.row;

  if (!leg || !row) {
    console.warn('[MULTI_INVALID_LEG]', {
      index,
      leg,
    });

    return null;
  }

  const fr = row.freshness;
  return (
    <div className="p-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="text-gray-600 text-xs font-mono">#{index + 1}</span>
          <span className="text-white font-medium text-sm">{leg.playerName}</span>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="text-cyan-400">Disposals {leg.displayLabel ?? `${leg.line}+`}</span>
          <span className="text-white font-bold">${leg.odds.toFixed(2)}</span>
          <span className={`font-medium ${leg.riskLevel === 'Low' ? 'text-emerald-400' : 'text-amber-400'}`}>{leg.riskLevel}</span>
        </div>
      </div>
      <div className="mt-1.5 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[10px] text-gray-500">
        <span>Season: {leg.seasonHits}/{leg.seasonSample}</span>
        <span>Last 10: {leg.last10Hits}/10</span>
        <span>Last 5: {leg.last5Hits}/5</span>
        <span>Adj prob: {(leg.adjustedProb * 100).toFixed(0)}%</span>
      </div>
      {fr && (
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[10px] text-gray-600">
          <span>Last 5 values: {fr.latestFiveDisposals.join(', ')}</span>
          <span>Stats latest: {fr.latestRound ? `Round ${fr.latestRound}` : 'Unknown'}</span>
          <span className={fr.freshnessStatus === 'CURRENT' ? 'text-emerald-500' : fr.freshnessStatus === 'STALE' ? 'text-amber-500' : 'text-red-500'}>
            Freshness: {fr.freshnessStatus.charAt(0) + fr.freshnessStatus.slice(1).toLowerCase()}
          </span>
        </div>
      )}
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[10px] text-gray-600">
        {leg.positionEdgeLabel && <span>Position: {leg.positionEdgeLabel}</span>}
        {leg.teamEnvironmentLabel && <span>Team env: {getLabelDisplay(leg.teamEnvironmentLabel as any)}</span>}
        {leg.roleTrendLabel && <span>Role: {getTrendDisplay(leg.roleTrendLabel as any)}</span>}
      </div>
    </div>
  );
}

export default function MultiOptimizerPanel({
  recommendations, matchNames, matches, selectedMatchId, onSelectMatch,
  statsRoundLabel, lineSafety, onLineSafetyChange, teamEnvMap, teamMatchups, roleTrends,
  onResultsChange,
}: Props) {
  const [mode, setMode] = useState<'gameMulti' | 'roundMulti'>('gameMulti');
  const [settings, setSettings] = useState<MultiOptimizerSettings>(GAME_MULTI_PRESET);
  const [expandedMulti, setExpandedMulti] = useState<number | null>(0);
  const [multis, setMultis] = useState<MultiCandidate[]>([]);
  const [diagnostics, setDiagnostics] = useState<OptimizerDiagnostics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<OptimizerProgress | null>(null);
  const [staleResults, setStaleResults] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [excludedPlayers, setExcludedPlayers] = useState<ExcludedPlayer[]>([]);
  const [exclusionSearch, setExclusionSearch] = useState('');
  const [showExclusionPanel, setShowExclusionPanel] = useState(false);
  const cancelRef = useRef<CancellationRef>({ cancelled: false });

  // Load saved exclusions when the selected match changes
  useEffect(() => {
    if (selectedMatchId && mode === 'gameMulti') {
      setExcludedPlayers(getExcludedPlayers(selectedMatchId));
    } else {
      setExcludedPlayers([]);
    }
    setAltSelectedKeys([]);
    setAltConflictMsg(null);
    setAltSearch('');
    setAltTeamFilter('');
    setCompletionNotes({});
    setCompletionMsg(null);
    setSwapCandidates(null);
  }, [selectedMatchId, mode]);

  function switchMode(newMode: 'gameMulti' | 'roundMulti') {
    setMode(newMode);
    setSettings(newMode === 'gameMulti' ? GAME_MULTI_PRESET : ROUND_MULTI_PRESET);
    setStaleResults(multis.length > 0);
  }

  // Filter recommendations for the selected match in gameMulti mode
  const validRecommendations = useMemo(() => {
    const input = Array.isArray(recommendations)
      ? recommendations
      : [];

    const invalidRecommendations = input.filter(
      recommendation =>
        !recommendation ||
        !recommendation.row
    );

    if (invalidRecommendations.length > 0) {
      console.warn('[MULTI_INVALID_RECOMMENDATIONS]', {
        count: invalidRecommendations.length,
        examples: invalidRecommendations.slice(0, 5),
      });
    }

    return input.filter(
      recommendation =>
        Boolean(
          recommendation &&
          recommendation.row
        )
    );
  }, [recommendations]);

  const gameRecommendationsRaw =
    mode === 'gameMulti' && selectedMatchId
      ? validRecommendations.filter(
          recommendation =>
            recommendation.matchId === selectedMatchId
        )
      : validRecommendations;

  // Apply per-match player exclusions to the game multi recommendations
  const excludedPlayerIds = useMemo(() => {
    return new Set(excludedPlayers.map(p => p.playerId));
  }, [excludedPlayers]);

  const gameRecommendations = useMemo(() => {
    if (excludedPlayerIds.size === 0) {
      return gameRecommendationsRaw;
    }

    return gameRecommendationsRaw.filter(recommendation => {
      const row = recommendation?.row;

      if (!row) {
        return false;
      }

      const playerId =
        row.player_id ??
        row.resolvedPlayerId ??
        '';

      return (
        !playerId ||
        !excludedPlayerIds.has(playerId)
      );
    });
  }, [gameRecommendationsRaw, excludedPlayerIds]);

  // Unique players from the recommendations for the selected match — for the exclusion UI
  const matchPlayers = useMemo(() => {
    if (mode !== 'gameMulti' || !selectedMatchId) return [];
    const seen = new Map<string, { playerId: string; playerName: string; team: string }>();
    for (const recommendation of gameRecommendationsRaw) {
      const row = recommendation?.row;

      if (!row) {
        continue;
      }

      const playerId =
        row.player_id ??
        row.resolvedPlayerId ??
        '';

      if (!playerId || seen.has(playerId)) {
        continue;
      }

      seen.set(playerId, {
        playerId,
        playerName:
          row.player_name ??
          recommendation.playerName ??
          'Unknown player',
        team:
          row.playerTeam ??
          '',
      });
    }
    return [...seen.values()].sort((a, b) => a.playerName.localeCompare(b.playerName));
  }, [gameRecommendationsRaw, mode, selectedMatchId]);

  const filteredMatchPlayers = useMemo(() => {
    if (!exclusionSearch.trim()) return matchPlayers;
    const q = exclusionSearch.toLowerCase();
    return matchPlayers.filter(p =>
      p.playerName.toLowerCase().includes(q) ||
      p.team.toLowerCase().includes(q)
    );
  }, [matchPlayers, exclusionSearch]);

  const handleExcludePlayer = useCallback((player: { playerId: string; playerName: string; team: string }) => {
    if (!selectedMatchId) return;
    excludePlayer(selectedMatchId, player);
    setExcludedPlayers(getExcludedPlayers(selectedMatchId));
  }, [selectedMatchId]);

  const handleUnexcludePlayer = useCallback((playerId: string) => {
    if (!selectedMatchId) return;
    unexcludePlayer(selectedMatchId, playerId);
    setExcludedPlayers(getExcludedPlayers(selectedMatchId));
  }, [selectedMatchId]);

  const handleClearExclusions = useCallback(() => {
    if (!selectedMatchId) return;
    clearExcludedPlayers(selectedMatchId);
    setExcludedPlayers([]);
  }, [selectedMatchId]);

  const selectedMatch = matches.find(m => m.id === selectedMatchId);
  const selectedMatchName = selectedMatch
    ? `${selectedMatch.home_team} vs ${selectedMatch.away_team}`
    : 'No match selected';

  async function handleBuild() {
    if (loading) return;
    cancelRef.current = { cancelled: false };
    setLoading(true);
    setError(null);
    setStaleResults(false);
    setProgress({ phase: 'preparing', safePlayerLines: 0, combinationsChecked: 0, candidatesFound: 0 });

    try {
      // Exclude stale/uncertain players from automatic multis
      const freshRecommendations = gameRecommendations.filter(rec => {
        const sourceLine = settings.preset === 'sameGame' ? (rec.balancedLine ?? rec.safeLine) : rec.safeLine;
        if (!sourceLine) return false;
        const fr = sourceLine.freshness;
        return fr && fr.freshnessStatus === 'CURRENT';
      });
      const result = await runMultiOptimizerAsync(
        freshRecommendations,
        settings,
        cancelRef.current,
        (p) => setProgress(p),
        matchNames,
        teamEnvMap,
        roleTrends,
      );
      setMultis(result.multis);
      setDiagnostics(result.diagnostics);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }

  function handleCancel() {
    cancelRef.current.cancelled = true;
  }

  const safeLineCount = gameRecommendations.filter(r => r.safeLine).length;

  // ── Alternate-line custom builder ──────────────────────────────────────
  // Fetch every genuine bookmaker_odds row for the selected match (ladder + O/U),
  // same call PullEmDisposalMultiPanel already uses. Never derives Under odds
  // from Over odds — buildPullEmLegs only builds an under leg from a real
  // under_odds value.
  const [altLinesRows, setAltLinesRows] = useState<ModelledOddsRow[]>([]);
  const [altLinesLoading, setAltLinesLoading] = useState(false);

  useEffect(() => {
    if (mode !== 'gameMulti' || !selectedMatchId) {
      setAltLinesRows([]);
      return;
    }
    let cancelled = false;
    setAltLinesLoading(true);
    getModelledBookmakerOddsForMatch(selectedMatchId, { includeOULines: true })
      .then(res => { if (!cancelled) setAltLinesRows(res.rows); })
      .catch(() => { if (!cancelled) setAltLinesRows([]); })
      .finally(() => { if (!cancelled) setAltLinesLoading(false); });
    return () => { cancelled = true; };
  }, [mode, selectedMatchId]);

  // Expand every fetched row into its selectable lines (ladder / over / under).
  // No safety thresholds here — eligibility is decided at the player level
  // below (must already be in the shared, top-filtered gameRecommendations
  // pool), not re-filtered per line, so the user can see a player's full
  // genuine ladder even if only one rung passed the top panel's filters.
  const allLinesResult = useMemo(() => {
    if (altLinesRows.length === 0) return null;
    return buildPullEmLegs(altLinesRows, matchNames, ALL_LINES_SETTINGS, selectedMatchId);
  }, [altLinesRows, matchNames, selectedMatchId]);

  const eligiblePlayerIds = useMemo(() => {
    const ids = new Set<string>();
    for (const r of gameRecommendations) {
      if (!r.safeLine) continue;
      const pid = r.safeLine.player_id ?? r.safeLine.resolvedPlayerId ?? '';
      if (pid) ids.add(pid);
    }
    return ids;
  }, [gameRecommendations]);

  const pickableLegs = useMemo(() => {
    if (!allLinesResult) return [];
    return allLinesResult.legs.filter(leg => {
      if (!eligiblePlayerIds.has(leg.playerId)) return false;
      if (excludedPlayerIds.has(leg.playerId)) return false;
      return true;
    });
  }, [allLinesResult, eligiblePlayerIds, excludedPlayerIds]);

  const [altSearch, setAltSearch] = useState('');
  const [altTeamFilter, setAltTeamFilter] = useState('');
  const [altSort, setAltSort] = useState<AltSortKey>('safest');
  const [altSelectedKeys, setAltSelectedKeys] = useState<string[]>([]);
  const [altConflictMsg, setAltConflictMsg] = useState<string | null>(null);

  const altTeams = useMemo(() => {
    return [...new Set(pickableLegs.map(l => l.team).filter(Boolean))].sort();
  }, [pickableLegs]);

  const altLinesFiltered = useMemo(() => {
    let rows = pickableLegs;
    if (altTeamFilter) rows = rows.filter(l => l.team === altTeamFilter);
    if (altSearch.trim()) {
      const q = altSearch.trim().toLowerCase();
      rows = rows.filter(l => l.playerName.toLowerCase().includes(q));
    }
    const sorted = [...rows];
    switch (altSort) {
      case 'safest': sorted.sort((a, b) => b.modelProb - a.modelProb); break;
      case 'ev': sorted.sort((a, b) => b.expectedValue - a.expectedValue); break;
      case 'prob': sorted.sort((a, b) => b.modelProb - a.modelProb); break;
      case 'odds': sorted.sort((a, b) => a.odds - b.odds); break;
      case 'season': sorted.sort((a, b) => b.seasonHitRate - a.seasonHitRate); break;
      case 'last5': sorted.sort((a, b) => b.last5HitRate - a.last5HitRate); break;
    }
    return sorted;
  }, [pickableLegs, altTeamFilter, altSearch, altSort]);

  const altSelectedLegs = useMemo(() => {
    const byKey = new Map(pickableLegs.map(l => [legKey(l), l]));
    return altSelectedKeys.map(k => byKey.get(k)).filter((l): l is PullEmLeg => Boolean(l));
  }, [pickableLegs, altSelectedKeys]);

  const toggleAltLeg = useCallback((leg: PullEmLeg) => {
    const key = legKey(leg);
    setAltSelectedKeys(prev => {
      if (prev.includes(key)) {
        setAltConflictMsg(null);
        return prev.filter(k => k !== key);
      }
      const conflict = altSelectedLegs.find(existing => hasConflict(existing, leg));
      if (conflict) {
        setAltConflictMsg(
          conflict.playerId === leg.playerId
            ? `${leg.playerName} is already in your multi as ${conflict.displayLabel} — remove it first to pick a different line.`
            : `${leg.displayLabel} conflicts with ${conflict.playerName} ${conflict.displayLabel} already in your multi.`
        );
        return prev;
      }
      setAltConflictMsg(null);
      return [...prev, key];
    });
  }, [altSelectedLegs]);

  const clearAltLegs = useCallback(() => {
    setAltSelectedKeys([]);
    setAltConflictMsg(null);
    setCompletionNotes({});
    setCompletionMsg(null);
    setSwapCandidates(null);
  }, []);

  const altMulti = useMemo(() => {
    if (altSelectedLegs.length === 0) return null;
    const combinedOdds = altSelectedLegs.reduce((p, l) => p * l.odds, 1);
    const rawProbability = altSelectedLegs.reduce((p, l) => p * l.modelProb, 1);
    const conservativeProbability = applyCorrelationHaircut(altSelectedLegs, rawProbability);
    const estimatedEV = conservativeProbability * combinedOdds - 1;
    const avgAdjustedProb = altSelectedLegs.reduce((s, l) => s + l.modelProb, 0) / altSelectedLegs.length;
    const weakestLeg = altSelectedLegs.reduce((min, l) => (l.modelProb < min.modelProb ? l : min), altSelectedLegs[0]);
    const highestRiskLeg = altSelectedLegs.find(l => l.riskLevel === 'High')
      ?? altSelectedLegs.find(l => l.riskLevel === 'Medium')
      ?? null;
    const matchIds = new Set(altSelectedLegs.map(l => l.matchId));
    return {
      combinedOdds, rawProbability, conservativeProbability, estimatedEV, avgAdjustedProb,
      weakestLeg, highestRiskLeg, hasSameMatchLegs: matchIds.size < altSelectedLegs.length,
    };
  }, [altSelectedLegs]);

  // ── Lock legs + Complete My Multi ──────────────────────────────────────
  // "Locked" legs are simply whatever is currently selected in altSelectedLegs
  // (1-3 of them, picked manually above) — Complete My Multi fills the rest.
  const [completionMode, setCompletionMode] = useState<CompletionMode>('safest');
  const [targetOddsPreset, setTargetOddsPreset] = useState<'2' | '3' | '5' | 'custom'>('2');
  const [customTargetOdds, setCustomTargetOdds] = useState('4.00');
  const [completionNotes, setCompletionNotes] = useState<Record<string, string>>({});
  const [completionMsg, setCompletionMsg] = useState<string | null>(null);
  const [swapCandidates, setSwapCandidates] = useState<{ label: string; leg: PullEmLeg }[] | null>(null);

  const effectiveTargetOdds = targetOddsPreset === 'custom'
    ? (parseFloat(customTargetOdds) || 4.0)
    : parseFloat(targetOddsPreset);

  // Clear stale swap suggestions whenever the slip itself changes
  useEffect(() => { setSwapCandidates(null); }, [altSelectedKeys]);

  function scoreForMode(leg: PullEmLeg, mode: CompletionMode, opposingTeams: Set<string>, currentOdds: number, targetOdds: number): number {
    switch (mode) {
      case 'safest': return leg.modelProb;
      case 'bestValue': return leg.expectedValue;
      case 'bestMatchup': return leg.row.totalMatchupAdjustment ?? 0;
      case 'lowestCorrelation': return (opposingTeams.has(leg.team) ? 1 : 0) + leg.modelProb * 0.01;
      case 'closestTarget': return -Math.abs(currentOdds * leg.odds - targetOdds);
    }
  }

  function reasonForMode(leg: PullEmLeg, mode: CompletionMode, targetOdds: number): string {
    switch (mode) {
      case 'safest': return `Highest remaining probability (${(leg.modelProb * 100).toFixed(0)}%)`;
      case 'bestValue': return `Best expected value (${leg.expectedValue >= 0 ? '+' : ''}${(leg.expectedValue * 100).toFixed(0)}%)`;
      case 'bestMatchup': return leg.row.totalMatchupAdjustment
        ? `Matchup edge ${leg.row.totalMatchupAdjustment > 0 ? '+' : ''}${(leg.row.totalMatchupAdjustment * 100).toFixed(1)}%`
        : 'No matchup edge data — neutral pick';
      case 'lowestCorrelation': return 'From the opposing team, to reduce same-team correlation';
      case 'closestTarget': return `Keeps combined odds closest to your $${targetOdds.toFixed(2)} target`;
    }
  }

  // Greedy fill: one leg per remaining slot, always the best-scoring not-yet-used player.
  function runCompletion(mode: CompletionMode, targetOdds: number, maxTotalLegs: number) {
    const locked = altSelectedLegs;
    const usedPlayerIds = new Set(locked.map(l => l.playerId));
    let currentOdds = locked.reduce((p, l) => p * l.odds, 1);
    const usedTeams = new Set(locked.map(l => l.team));
    const homeTeam = selectedMatch?.home_team ?? null;
    const awayTeam = selectedMatch?.away_team ?? null;
    const added: PullEmLeg[] = [];
    const notes: Record<string, string> = {};

    const slotsToFill = Math.max(0, maxTotalLegs - locked.length);
    for (let i = 0; i < slotsToFill; i++) {
      const opposingTeams = new Set<string>();
      if (usedTeams.size === 1) {
        const only = [...usedTeams][0];
        if (homeTeam && only !== homeTeam) opposingTeams.add(homeTeam);
        if (awayTeam && only !== awayTeam) opposingTeams.add(awayTeam);
      }

      const byPlayer = new Map<string, PullEmLeg>();
      for (const leg of pickableLegs) {
        if (usedPlayerIds.has(leg.playerId)) continue;
        if (currentOdds * leg.odds > targetOdds * 1.5) continue;
        const existing = byPlayer.get(leg.playerId);
        if (!existing || scoreForMode(leg, mode, opposingTeams, currentOdds, targetOdds) > scoreForMode(existing, mode, opposingTeams, currentOdds, targetOdds)) {
          byPlayer.set(leg.playerId, leg);
        }
      }
      const candidates = [...byPlayer.values()].sort(
        (a, b) => scoreForMode(b, mode, opposingTeams, currentOdds, targetOdds) - scoreForMode(a, mode, opposingTeams, currentOdds, targetOdds)
      );
      const chosen = candidates[0];
      if (!chosen) break;

      added.push(chosen);
      notes[legKey(chosen)] = reasonForMode(chosen, mode, targetOdds);
      usedPlayerIds.add(chosen.playerId);
      usedTeams.add(chosen.team);
      currentOdds *= chosen.odds;

      if (mode === 'closestTarget' && currentOdds >= targetOdds * 0.9) break;
    }
    return { added, notes };
  }

  const handleCompleteMulti = useCallback(() => {
    const { added, notes } = runCompletion(completionMode, effectiveTargetOdds, 4);
    if (added.length === 0) {
      setCompletionMsg('No eligible legs left to complete this multi — try a different mode, a higher target, or fewer locked legs.');
      return;
    }
    setAltSelectedKeys(prev => [...prev, ...added.map(legKey)]);
    setCompletionNotes(prev => ({ ...prev, ...notes }));
    setCompletionMsg(null);
  }, [altSelectedLegs, pickableLegs, completionMode, effectiveTargetOdds, selectedMatch]);

  const handleSuggestNextLeg = useCallback(() => {
    const { added, notes } = runCompletion(completionMode, effectiveTargetOdds, altSelectedLegs.length + 1);
    if (added.length === 0) {
      setCompletionMsg('No eligible next leg found for this mode/target.');
      return;
    }
    setAltSelectedKeys(prev => [...prev, legKey(added[0])]);
    setCompletionNotes(prev => ({ ...prev, ...notes }));
    setCompletionMsg(null);
  }, [altSelectedLegs, pickableLegs, completionMode, effectiveTargetOdds, selectedMatch]);

  const handleSwapWeakest = useCallback(() => {
    if (!altMulti) return;
    const weakest = altMulti.weakestLeg;
    const usedPlayerIds = new Set(altSelectedLegs.filter(l => l !== weakest).map(l => l.playerId));
    const pool = pickableLegs.filter(l => l.playerId !== weakest.playerId && !usedPlayerIds.has(l.playerId));

    const bestByPlayerSafest = new Map<string, PullEmLeg>();
    const bestByPlayerEV = new Map<string, PullEmLeg>();
    for (const leg of pool) {
      const s = bestByPlayerSafest.get(leg.playerId);
      if (!s || leg.modelProb > s.modelProb) bestByPlayerSafest.set(leg.playerId, leg);
      const e = bestByPlayerEV.get(leg.playerId);
      if (!e || leg.expectedValue > e.expectedValue) bestByPlayerEV.set(leg.playerId, leg);
    }
    const usedTeams = new Set(altSelectedLegs.filter(l => l !== weakest).map(l => l.team));

    const safer = [...bestByPlayerSafest.values()].sort((a, b) => b.modelProb - a.modelProb)[0];
    const higherEV = [...bestByPlayerEV.values()].sort((a, b) => b.expectedValue - a.expectedValue)[0];
    const lowerCorr = [...bestByPlayerSafest.values()].filter(l => !usedTeams.has(l.team)).sort((a, b) => b.modelProb - a.modelProb)[0];

    const suggestions: { label: string; leg: PullEmLeg }[] = [];
    if (safer && safer.modelProb > weakest.modelProb) suggestions.push({ label: 'Safer', leg: safer });
    if (higherEV && higherEV.expectedValue > weakest.expectedValue && higherEV.playerId !== safer?.playerId) suggestions.push({ label: 'Higher EV', leg: higherEV });
    if (lowerCorr && !suggestions.some(s => s.leg.playerId === lowerCorr.playerId)) suggestions.push({ label: 'Lower correlation', leg: lowerCorr });

    if (suggestions.length === 0) {
      setCompletionMsg(`${weakest.playerName} ${weakest.displayLabel} is already the best available pick — no better replacement found.`);
      setSwapCandidates(null);
      return;
    }
    setCompletionMsg(null);
    setSwapCandidates(suggestions.slice(0, 3));
  }, [altMulti, altSelectedLegs, pickableLegs]);

  const applySwap = useCallback((replacement: PullEmLeg) => {
    if (!altMulti) return;
    const weakest = altMulti.weakestLeg;
    setAltSelectedKeys(prev => prev.filter(k => k !== legKey(weakest)).concat(legKey(replacement)));
    setSwapCandidates(null);
  }, [altMulti]);

  useEffect(() => {
    onResultsChange?.({
      poolSize: gameRecommendations.length,
      multiCount: multis.length,
      customLegsAvailable: pickableLegs.length,
    });
  }, [gameRecommendations.length, multis.length, pickableLegs.length, onResultsChange]);

  return (
    <div className="space-y-4">
      {/* Slate Info */}
      <div className="bg-gray-900 border border-cyan-500/20 rounded-xl p-4">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 uppercase tracking-wider">Stats through</span>
            <span className="text-emerald-400 font-bold text-sm">{statsRoundLabel}</span>
          </div>
        </div>
      </div>

      {/* Mode selector */}
      <div className="flex gap-2">
        <button onClick={() => switchMode('gameMulti')}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition ${mode === 'gameMulti' ? 'bg-emerald-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>
          <Target className="w-3.5 h-3.5" /> Game Multi
        </button>
        <button onClick={() => switchMode('roundMulti')}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition ${mode === 'roundMulti' ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}>
          <Zap className="w-3.5 h-3.5" /> Round Multi (Advanced)
        </button>
      </div>

      {/* Match selector for Game Multi mode */}
      {mode === 'gameMulti' && (
        <div className="bg-gray-900 border border-emerald-500/20 rounded-xl p-4">
          <label className="text-xs text-gray-500 uppercase tracking-wider block mb-2">Choose Match</label>
          <select
            value={selectedMatchId ?? ''}
            onChange={e => { onSelectMatch(e.target.value); setStaleResults(multis.length > 0); }}
            className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2"
          >
            <option value="">Select a match…</option>
            {matches.map(m => (
              <option key={m.id} value={m.id}>{m.home_team} vs {m.away_team}</option>
            ))}
          </select>
          <div className="mt-2 text-xs text-gray-500">
            Selected game: <span className="text-white font-medium">{selectedMatchName}</span>
            <span className="ml-3">Players with safe lines: <span className="text-emerald-400 font-bold">{safeLineCount}</span></span>
          </div>

          {/* Excluded Players */}
          <div className="mt-3 border-t border-gray-700/50 pt-3">
            <div className="flex items-center justify-between mb-1.5">
              <button
                onClick={() => setShowExclusionPanel(s => !s)}
                className="flex items-center gap-1.5 text-xs font-medium text-gray-400 hover:text-gray-300"
              >
                <UserX className="w-3.5 h-3.5" />
                Excluded Players
                {excludedPlayers.length > 0 && (
                  <span className="text-xs text-red-400 bg-red-500/10 px-1.5 py-0.5 rounded">
                    {excludedPlayers.length}
                  </span>
                )}
              </button>
              <div className="flex items-center gap-2">
                {excludedPlayers.length > 0 && (
                  <button
                    onClick={handleClearExclusions}
                    className="text-[10px] px-2 py-0.5 bg-gray-700 text-gray-400 border border-gray-600 rounded hover:bg-gray-600 transition"
                  >
                    Clear All
                  </button>
                )}
                {showExclusionPanel ? <ChevronDown className="w-3 h-3 text-gray-500" /> : <ChevronRight className="w-3 h-3 text-gray-500" />}
              </div>
            </div>
            {showExclusionPanel && (
              <div className="space-y-2">
                <input
                  type="text"
                  placeholder="Search players from this match..."
                  value={exclusionSearch}
                  onChange={e => setExclusionSearch(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-xs text-white placeholder-gray-600"
                />
                <div className="max-h-48 overflow-y-auto space-y-0.5">
                  {filteredMatchPlayers.map(p => {
                    const isExcluded = excludedPlayerIds.has(p.playerId);
                    return (
                      <label
                        key={p.playerId}
                        className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs cursor-pointer transition ${
                          isExcluded ? 'bg-red-500/10 text-red-400' : 'hover:bg-gray-800/60 text-gray-300'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isExcluded}
                          onChange={() => isExcluded ? handleUnexcludePlayer(p.playerId) : handleExcludePlayer(p)}
                          className="rounded"
                        />
                        <span className="flex-1">{p.playerName}</span>
                        {p.team && <span className="text-gray-600 text-[10px]">{p.team}</span>}
                      </label>
                    );
                  })}
                  {filteredMatchPlayers.length === 0 && (
                    <p className="text-xs text-gray-600 px-2 py-1">
                      {matchPlayers.length === 0 ? 'No players loaded for this match yet.' : 'No players match your search.'}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Profile + Line Safety */}
      <div className="bg-gray-900 border border-emerald-500/20 rounded-xl p-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <Target className="w-5 h-5 text-emerald-400" />
            <div>
              <h3 className="text-white font-semibold text-sm">
                {mode === 'gameMulti' ? 'Game Multi Builder' : 'Round Multi Builder'}
              </h3>
              <p className="text-gray-500 text-xs">
                Target ${settings.targetOdds.toFixed(2)} · {settings.preferredLegs} legs (fallback {settings.fallbackLegs}) · Max ${settings.hardMaxOdds.toFixed(2)} · Disposals only
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-[10px] text-gray-500 uppercase">Line Safety</label>
            <select value={lineSafety} onChange={e => onLineSafetyChange(e.target.value as LineSafetyMode)}
              className="bg-gray-800 border border-gray-700 text-white text-xs rounded px-2 py-1">
              <option value="conservative">Conservative</option>
              <option value="safe">Safe</option>
              <option value="balanced">Balanced</option>
            </select>
          </div>
        </div>

        <button onClick={() => setShowAdvanced(!showAdvanced)}
          className="mt-3 flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition">
          {showAdvanced ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          Advanced Settings
        </button>
        {showAdvanced && (
          <div className="mt-2 pt-3 border-t border-gray-800 grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div><label className="text-[10px] text-gray-500 uppercase">Target</label>
              <input type="number" step="0.05" value={settings.targetOdds} onChange={e => { setSettings({ ...settings, targetOdds: parseFloat(e.target.value) || 2.0 }); setStaleResults(multis.length > 0); }} className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded px-2 py-1" /></div>
            <div><label className="text-[10px] text-gray-500 uppercase">Pref Min</label>
              <input type="number" step="0.05" value={settings.preferredMinOdds} onChange={e => { setSettings({ ...settings, preferredMinOdds: parseFloat(e.target.value) || 1.8 }); setStaleResults(multis.length > 0); }} className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded px-2 py-1" /></div>
            <div><label className="text-[10px] text-gray-500 uppercase">Pref Max</label>
              <input type="number" step="0.05" value={settings.preferredMaxOdds} onChange={e => { setSettings({ ...settings, preferredMaxOdds: parseFloat(e.target.value) || 2.2 }); setStaleResults(multis.length > 0); }} className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded px-2 py-1" /></div>
            <div><label className="text-[10px] text-gray-500 uppercase">Hard Max</label>
              <input type="number" step="0.05" value={settings.hardMaxOdds} onChange={e => { setSettings({ ...settings, hardMaxOdds: parseFloat(e.target.value) || 2.5 }); setStaleResults(multis.length > 0); }} className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded px-2 py-1" /></div>
          </div>
        )}
      </div>

      {/* Build Button */}
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={handleBuild} disabled={loading || gameRecommendations.length === 0}
          className="flex items-center gap-2 px-5 py-2.5 bg-emerald-500 hover:bg-emerald-400 disabled:bg-gray-700 disabled:text-gray-500 text-gray-950 font-bold rounded-lg text-sm transition">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Target className="w-4 h-4" />}
          {loading ? 'Building…' : 'Build Game Multis'}
        </button>
        {loading && (
          <button onClick={handleCancel} className="flex items-center gap-1.5 px-3 py-2 bg-red-600 hover:bg-red-500 text-white text-xs font-medium rounded-lg transition">
            <X className="w-3.5 h-3.5" /> Cancel
          </button>
        )}
        {staleResults && !loading && (
          <span className="flex items-center gap-1.5 text-xs text-amber-400">
            <RefreshCw className="w-3 h-3" /> Settings changed — rebuild required
          </span>
        )}
      </div>

      {/* Progress */}
      {loading && progress && (
        <div className="bg-gray-900 border border-emerald-500/30 rounded-xl p-3">
          <div className="flex items-center gap-2 mb-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400" />
            <span className="text-xs text-emerald-400 font-medium">
              {progress.phase === 'preparing' && 'Preparing safe player lines…'}
              {progress.phase === 'searching' && 'Searching combinations…'}
              {progress.phase === 'done' && 'Complete'}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="text-gray-400">Safe lines: <span className="text-white font-bold">{progress.safePlayerLines}</span></div>
            <div className="text-gray-400">Checked: <span className="text-white font-bold">{progress.combinationsChecked}</span></div>
            <div className="text-gray-400">Found: <span className="text-cyan-400 font-bold">{progress.candidatesFound}</span></div>
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-900/20 border border-red-500/30 rounded-xl p-3">
          <p className="text-red-400 text-sm font-medium">Error: {error}</p>
        </div>
      )}

      {/* Section A — Best Individual Legs */}
      {gameRecommendations.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h3 className="text-white font-semibold text-sm mb-3">Best Individual Disposal Legs</h3>
          <div className="space-y-2">
            {gameRecommendations.filter(r => r.safeLine).map((rec, i) => {
              const fr = rec.safeLine!.freshness;
              const isStale = fr && fr.freshnessStatus !== 'CURRENT';
              return (
                <div key={i} className={`py-2 border-b border-gray-800/30 last:border-0 ${isStale ? 'opacity-60' : ''}`}>
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-3">
                      <span className="text-gray-600 text-xs font-mono">{i + 1}</span>
                      <div>
                        <span className="text-white font-medium text-sm">{rec.playerName}</span>
                        <span className="text-cyan-400 text-xs ml-2">{rec.safeLine!.line}+ @{rec.safeLine!.over_odds.toFixed(2)}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-4 text-[10px] text-gray-500">
                      <span>Season {Math.round(rec.seasonHitRate * 100)}%</span>
                      <span>L10 {rec.last10Hits}/10</span>
                      <span>L5 {rec.last5Hits}/5</span>
                      <span className={rec.safeLine!.modelProb.risk_level === 'Low' ? 'text-emerald-400' : 'text-amber-400'}>{rec.safeLine!.modelProb.risk_level}</span>
                    </div>
                  </div>
                  {fr && (
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[10px] text-gray-600">
                      <span>Last 5 values: {fr.latestFiveDisposals.join(', ')}</span>
                      <span>Stats latest: {fr.latestRound ? `Round ${fr.latestRound}` : 'Unknown'}</span>
                      <span className={fr.freshnessStatus === 'CURRENT' ? 'text-emerald-500' : fr.freshnessStatus === 'STALE' ? 'text-amber-500' : 'text-red-500'}>
                        Freshness: {fr.freshnessStatus.charAt(0) + fr.freshnessStatus.slice(1).toLowerCase()}
                      </span>
                      {isStale && <span className="text-amber-500">Not eligible for automatic multis: stale or unverified data</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Section A.5 — Build Your Own Multi (every genuine line, not just the safe pick) */}
      {gameRecommendations.length > 0 && (
        <div className="bg-gray-900 border border-cyan-500/20 rounded-xl p-4">
          <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
            <div className="flex items-center gap-2">
              <ListPlus className="w-4 h-4 text-cyan-400" />
              <h3 className="text-white font-semibold text-sm">Build Your Own Multi</h3>
              <span className="text-[10px] text-gray-500">
                {altLinesLoading ? 'Loading all lines…' : `${pickableLegs.length} genuine lines from bookmaker odds`}
              </span>
            </div>
            {altSelectedLegs.length > 0 && (
              <button onClick={clearAltLegs} className="flex items-center gap-1 text-xs text-gray-500 hover:text-red-400 transition">
                <X className="w-3 h-3" /> Clear ({altSelectedLegs.length})
              </button>
            )}
          </div>

          {allLinesResult && !allLinesResult.diagnostics.genuineUnderOddsAvailable && (
            <div className="flex items-start gap-2 text-xs text-amber-400 bg-amber-500/10 rounded-lg p-2.5 mb-3">
              <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>No genuine Over/Under odds are stored yet for this match — only ladder (N+) lines are available. Under legs will appear automatically once the bookmaker publishes them.</span>
            </div>
          )}

          {/* Search / filter / sort */}
          <div className="flex flex-wrap gap-2 mb-3">
            <div className="relative flex-1 min-w-[160px]">
              <Search className="w-3.5 h-3.5 text-gray-500 absolute left-2 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={altSearch}
                onChange={e => setAltSearch(e.target.value)}
                placeholder="Search player…"
                className="w-full bg-gray-800 border border-gray-700 text-white text-xs rounded-lg pl-7 pr-2 py-1.5"
              />
            </div>
            <select
              value={altTeamFilter}
              onChange={e => setAltTeamFilter(e.target.value)}
              className="bg-gray-800 border border-gray-700 text-white text-xs rounded-lg px-2 py-1.5"
            >
              <option value="">All teams</option>
              {altTeams.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <div className="flex items-center gap-1.5">
              <ArrowUpDown className="w-3.5 h-3.5 text-gray-500" />
              <select
                value={altSort}
                onChange={e => setAltSort(e.target.value as AltSortKey)}
                className="bg-gray-800 border border-gray-700 text-white text-xs rounded-lg px-2 py-1.5"
              >
                <option value="safest">Safest</option>
                <option value="ev">Best EV</option>
                <option value="prob">Highest probability</option>
                <option value="odds">Odds (shortest first)</option>
                <option value="season">Season hit rate</option>
                <option value="last5">Last-5 hit rate</option>
              </select>
            </div>
          </div>

          {altConflictMsg && (
            <div className="flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 mb-3">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              {altConflictMsg}
            </div>
          )}

          {/* Selectable lines */}
          <div className="max-h-80 overflow-y-auto space-y-1 mb-3 pr-1">
            {altLinesLoading && (
              <p className="text-xs text-gray-600 px-1 py-2">Loading every genuine bookmaker line for this match…</p>
            )}
            {!altLinesLoading && altLinesFiltered.length === 0 && (
              <p className="text-xs text-gray-600 px-1 py-2">
                {pickableLegs.length === 0 ? 'No genuine lines available yet for this match.' : 'No lines match your search/filter.'}
              </p>
            )}
            {altLinesFiltered.map(leg => {
              const key = legKey(leg);
              const isPicked = altSelectedKeys.includes(key);
              const fr = leg.row.freshness;
              const isStale = Boolean(fr && fr.freshnessStatus !== 'CURRENT');
              return (
                <button
                  key={key}
                  onClick={() => toggleAltLeg(leg)}
                  disabled={isStale && !isPicked}
                  className={`w-full text-left px-2.5 py-2 rounded-lg border transition disabled:opacity-40 disabled:cursor-not-allowed ${
                    isPicked ? 'bg-cyan-500/10 border-cyan-500/40' : 'bg-gray-800/40 border-gray-800 hover:border-gray-700'
                  }`}
                >
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-2">
                      {isPicked ? <Check className="w-3.5 h-3.5 text-cyan-400 shrink-0" /> : <span className="w-3.5 shrink-0" />}
                      <span className="text-white text-sm font-medium">{leg.playerName}</span>
                      <span className="text-gray-500 text-[10px]">{leg.team}</span>
                      <span className="text-cyan-400 text-xs">{leg.displayLabel}</span>
                    </div>
                    <div className="flex items-center gap-3 text-[10px] text-gray-500">
                      <span className="text-white font-bold text-xs">${leg.odds.toFixed(2)}</span>
                      <span>Season {leg.seasonHitRate.toFixed(0)}%</span>
                      <span>L5 {leg.last5HitRate.toFixed(0)}%</span>
                      <span>Adj prob {(leg.modelProb * 100).toFixed(0)}%</span>
                      <span className={leg.expectedValue >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                        EV {leg.expectedValue >= 0 ? '+' : ''}{(leg.expectedValue * 100).toFixed(0)}%
                      </span>
                      <span className={leg.riskLevel === 'Low' ? 'text-emerald-400' : leg.riskLevel === 'Medium' ? 'text-amber-400' : 'text-red-400'}>{leg.riskLevel}</span>
                      {isStale && <span className="text-amber-500">Stale</span>}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Selected slip */}
          {altSelectedLegs.length === 0 ? (
            <p className="text-xs text-gray-600">
              Pick any genuine line above — every real ladder rung and Over/Under for this match's eligible players. Mix and match, see the combined price update here.
            </p>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {altSelectedLegs.map(leg => (
                  <span key={legKey(leg)} className="flex items-center gap-1.5 text-xs text-white bg-gray-800 border border-gray-700 rounded-full pl-3 pr-1.5 py-1" title={completionNotes[legKey(leg)]}>
                    {leg.playerName} {leg.displayLabel} @{leg.odds.toFixed(2)}
                    <button onClick={() => toggleAltLeg(leg)} className="p-0.5 rounded-full hover:bg-gray-700 text-gray-400 hover:text-white transition">
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
              {altSelectedLegs.some(l => completionNotes[legKey(l)]) && (
                <div className="space-y-0.5">
                  {altSelectedLegs.filter(l => completionNotes[legKey(l)]).map(l => (
                    <p key={legKey(l)} className="text-[10px] text-cyan-400/80">
                      {l.playerName} {l.displayLabel}: {completionNotes[legKey(l)]}
                    </p>
                  ))}
                </div>
              )}

              {altSelectedLegs.length === 1 ? (
                <p className="text-xs text-gray-500">Add at least one more leg to see a combined multi price.</p>
              ) : altMulti && (
                <div className="bg-gray-800/50 rounded-lg p-3">
                  <div className="flex items-center gap-4 text-sm flex-wrap">
                    <span className="text-white font-bold">{altSelectedLegs.length} legs · ${altMulti.combinedOdds.toFixed(2)}</span>
                    <span className="text-gray-400">Conservative prob: {(altMulti.conservativeProbability * 100).toFixed(0)}%</span>
                    <span className={altMulti.estimatedEV >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                      Est EV: {altMulti.estimatedEV >= 0 ? '+' : ''}{(altMulti.estimatedEV * 100).toFixed(0)}%
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-gray-500">
                    <span>Raw independent prob: {(altMulti.rawProbability * 100).toFixed(0)}%</span>
                    <span>Avg adjusted prob: {(altMulti.avgAdjustedProb * 100).toFixed(0)}%</span>
                    <span>Weakest leg: {altMulti.weakestLeg.playerName} {altMulti.weakestLeg.displayLabel} ({(altMulti.weakestLeg.modelProb * 100).toFixed(0)}%)</span>
                    {altMulti.highestRiskLeg && (
                      <span className="text-amber-400">Highest risk: {altMulti.highestRiskLeg.playerName} ({altMulti.highestRiskLeg.riskLevel})</span>
                    )}
                  </div>
                  {altMulti.hasSameMatchLegs && (
                    <p className="mt-2 text-[10px] text-amber-400 flex items-center gap-1">
                      <AlertTriangle className="w-2.5 h-2.5 shrink-0" /> All legs from same match — probability may be overstated due to correlation.
                    </p>
                  )}
                </div>
              )}

              {swapCandidates && (
                <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-3">
                  <p className="text-xs text-amber-400 mb-2">
                    Replace weakest leg ({altMulti?.weakestLeg.playerName} {altMulti?.weakestLeg.displayLabel}) with:
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {swapCandidates.map(({ label, leg }) => (
                      <button
                        key={legKey(leg)}
                        onClick={() => applySwap(leg)}
                        className="text-xs text-left bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg px-2.5 py-1.5 transition"
                      >
                        <span className="text-amber-400 font-medium">{label}: </span>
                        <span className="text-white">{leg.playerName} {leg.displayLabel} @{leg.odds.toFixed(2)}</span>
                        <span className="text-gray-500"> · {(leg.modelProb * 100).toFixed(0)}% prob</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Lock legs + Complete My Multi */}
          <div className="mt-4 pt-3 border-t border-gray-800">
            <div className="flex items-center gap-2 mb-2">
              <Wand2 className="w-3.5 h-3.5 text-cyan-400" />
              <span className="text-xs font-semibold text-white">Complete My Multi</span>
              <span className="text-[10px] text-gray-500">Lock 1-3 legs above, then let the model pick the rest</span>
            </div>
            <div className="flex flex-wrap gap-2 mb-2">
              <select
                value={completionMode}
                onChange={e => setCompletionMode(e.target.value as CompletionMode)}
                className="bg-gray-800 border border-gray-700 text-white text-xs rounded-lg px-2 py-1.5"
              >
                <option value="safest">Safest</option>
                <option value="bestValue">Best Value</option>
                <option value="closestTarget">Closest to Target Odds</option>
                <option value="bestMatchup">Best Matchup</option>
                <option value="lowestCorrelation">Lowest Correlation</option>
              </select>
              <select
                value={targetOddsPreset}
                onChange={e => setTargetOddsPreset(e.target.value as typeof targetOddsPreset)}
                className="bg-gray-800 border border-gray-700 text-white text-xs rounded-lg px-2 py-1.5"
              >
                <option value="2">Target $2.00</option>
                <option value="3">Target $3.00</option>
                <option value="5">Target $5.00</option>
                <option value="custom">Custom target…</option>
              </select>
              {targetOddsPreset === 'custom' && (
                <input
                  type="number"
                  step="0.5"
                  value={customTargetOdds}
                  onChange={e => setCustomTargetOdds(e.target.value)}
                  className="w-20 bg-gray-800 border border-gray-700 text-white text-xs rounded-lg px-2 py-1.5"
                />
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={handleCompleteMulti}
                disabled={altSelectedLegs.length >= 4}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 hover:bg-cyan-500/30 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-xs font-medium transition"
              >
                <Wand2 className="w-3.5 h-3.5" /> Complete My Multi
              </button>
              <button
                onClick={handleSuggestNextLeg}
                disabled={altSelectedLegs.length >= 4}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 text-gray-300 border border-gray-700 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-xs font-medium transition"
              >
                <Plus className="w-3.5 h-3.5" /> Suggest Next Leg
              </button>
              <button
                onClick={handleSwapWeakest}
                disabled={altSelectedLegs.length < 2}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 text-gray-300 border border-gray-700 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-xs font-medium transition"
              >
                <RefreshCw className="w-3.5 h-3.5" /> Swap Weakest Leg
              </button>
            </div>
            {completionMsg && (
              <p className="mt-2 text-xs text-amber-400 flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" /> {completionMsg}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Section B — Suggested Multis */}
      {/* Freshness summary */}
      {gameRecommendations.length > 0 && (
        <div className="flex gap-4 text-xs">
          <span className="text-emerald-400">
            Current players eligible for automatic multis: {gameRecommendations.filter(r => { const sl = r.safeLine; return sl && sl.freshness && sl.freshness.freshnessStatus === 'CURRENT'; }).length}
          </span>
          <span className="text-amber-400">
            Stale/unverified players excluded: {gameRecommendations.filter(r => { const sl = r.safeLine; return sl && (!sl.freshness || sl.freshness.freshnessStatus !== 'CURRENT'); }).length}
          </span>
        </div>
      )}

      {!loading && multis.length === 0 && !error && gameRecommendations.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 text-center">
          <AlertCircle className="w-8 h-8 text-amber-400 mx-auto mb-2" />
          <p className="text-amber-400 font-medium text-sm">No multis generated yet.</p>
          <p className="text-gray-600 text-xs mt-1">Click "Build Game Multis" to search for combinations.</p>
        </div>
      )}

      {multis.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-white font-semibold text-sm">Suggested Multis</h3>
          {multis.map((multi, idx) => (
            <div key={idx} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <button onClick={() => setExpandedMulti(expandedMulti === idx ? null : idx)}
                className="w-full p-4 hover:bg-gray-800/50 transition text-left">
                <div className="flex items-center gap-2 mb-2">
                  {idx === 0 && <Award className="w-4 h-4 text-emerald-400" />}
                  {multi.labels.map((label, li) => (
                    <span key={li} className={`text-xs font-semibold px-2 py-0.5 rounded ${li === 0 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-cyan-500/20 text-cyan-400'}`}>{label}</span>
                  ))}
                </div>
                <div className="flex items-center gap-4 text-sm">
                  <span className="text-white font-bold">{multi.legCount} legs · ${multi.combinedOdds.toFixed(2)}</span>
                  <span className="text-gray-500">Conservative prob: {(multi.conservativeProbability * 100).toFixed(0)}%</span>
                  <span className="text-gray-500">Est EV: {multi.estimatedEV >= 0 ? '+' : ''}{(multi.estimatedEV * 100).toFixed(0)}%</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {multi.legs.map((leg, i) => (
                    <span key={`${leg.playerId}-${leg.line}-${i}`} className="text-xs text-gray-400 bg-gray-800/50 rounded px-2 py-1">
                      {leg.playerName} {leg.displayLabel ?? `${leg.line}+`} @{leg.odds.toFixed(2)}
                    </span>
                  ))}
                </div>
              </button>
              {expandedMulti === idx && (
                <div className="border-t border-gray-800">
                  {multi.hasSameMatchLegs && (
                    <div className="px-4 py-2 bg-amber-500/5 text-xs text-amber-400">
                      <AlertTriangle className="w-3.5 h-3.5 inline mr-1" />
                      Estimated probability assumes partial independence and may be overstated because all legs are from the same game.
                      <br />Raw independent probability {(multi.rawProbability * 100).toFixed(0)}% → Conservative estimate {(multi.conservativeProbability * 100).toFixed(0)}%
                    </div>
                  )}
                  <div className="divide-y divide-gray-800">
                    {multi.legs.map((leg, i) => (
                      <LegRow key={`${leg.playerId}-${leg.line}-${i}`} leg={leg} index={i} />
                    ))}
                  </div>
                  {multi.warnings.length > 0 && (
                    <div className="px-4 py-2 border-t border-gray-800 space-y-0.5">
                      {multi.warnings.map((w, i) => (
                        <p key={i} className="text-[10px] text-amber-400 flex items-center gap-1"><AlertCircle className="w-2.5 h-2.5" /> {w}</p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Advanced Diagnostics */}
      {diagnostics && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <button onClick={() => setShowDiagnostics(!showDiagnostics)}
            className="w-full flex items-center justify-between p-3 hover:bg-gray-800/50 transition">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-2">
              <Wrench className="w-3.5 h-3.5" /> Advanced Diagnostics
            </span>
            {showDiagnostics ? <ChevronDown className="w-4 h-4 text-gray-500" /> : <ChevronRight className="w-4 h-4 text-gray-500" />}
          </button>
          {showDiagnostics && (
            <div className="p-4 pt-0 space-y-3">
              <div className="flex items-center gap-3 text-xs">
                {diagnostics.stoppedByLimit ? <span className="text-amber-400">Stopped: {diagnostics.stoppedByLimit} ({diagnostics.runtimeMs}ms)</span> : <span className="text-emerald-400">Complete ({diagnostics.runtimeMs}ms)</span>}
                {diagnostics.validationErrors.length > 0 && <span className="text-red-400">Validation errors: {diagnostics.validationErrors.length}</span>}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
                <div className="bg-gray-800 rounded p-2"><p className="text-[10px] text-gray-500 uppercase">Safe Lines</p><p className="text-emerald-400 font-bold text-sm">{diagnostics.playersWithSafeLine}</p></div>
                <div className="bg-gray-800 rounded p-2"><p className="text-[10px] text-gray-500 uppercase">Pool Size</p><p className="text-cyan-400 font-bold text-sm">{diagnostics.poolSize}</p></div>
                <div className="bg-gray-800 rounded p-2"><p className="text-[10px] text-gray-500 uppercase">4-Leg Checked</p><p className="text-gray-300 font-bold text-sm">{diagnostics.fourLegCombinationsChecked}</p></div>
                <div className="bg-gray-800 rounded p-2"><p className="text-[10px] text-gray-500 uppercase">3-Leg Checked</p><p className="text-gray-300 font-bold text-sm">{diagnostics.threeLegCombinationsChecked}</p></div>
                <div className="bg-gray-800 rounded p-2"><p className="text-[10px] text-gray-500 uppercase">Final Multis</p><p className="text-emerald-400 font-bold text-sm">{diagnostics.finalMultisReturned}</p></div>
                <div className="bg-gray-800 rounded p-2"><p className="text-[10px] text-gray-500 uppercase">Val Errors</p><p className="text-red-400 font-bold text-sm">{diagnostics.validationErrors.length}</p></div>
              </div>
              {diagnostics.validationErrors.length > 0 && (
                <div className="mt-2 max-h-32 overflow-y-auto space-y-0.5">
                  {diagnostics.validationErrors.slice(0, 10).map((e, i) => <p key={i} className="text-[10px] text-red-400">{e}</p>)}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
