import { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import { Target, Award, AlertCircle, Loader2, X, RefreshCw, ChevronDown, ChevronRight, Zap, AlertTriangle, Wrench, Check, Minus, TrendingUp, TrendingDown, UserX, Plus, ListPlus } from 'lucide-react';
import type { MultiCandidate, OptimizerDiagnostics, OptimizerProgress, MultiOptimizerSettings, CancellationRef, OptimizerPreset, OptimizerLeg } from '../lib/multiOptimizer';
import { runMultiOptimizerAsync, GAME_MULTI_PRESET, ROUND_MULTI_PRESET, SAME_GAME_PRESET, rowToLeg, buildCustomMulti } from '../lib/multiOptimizer';
import type { DisposalLineRecommendation } from '../lib/disposalLineSelector';
import type { LineSafetyMode } from '../lib/disposalLineSelector';
import type { TeamEnvironmentMap, TeamMatchupEnvironment } from '../lib/teamStatsService';
import { getLabelDisplay } from '../lib/teamStatsService';
import type { RoleTrendMap } from '../lib/roleTrendService';
import { getTrendDisplay } from '../lib/roleTrendService';
import type { Match } from '../lib/types';
import {
  getExcludedPlayers, excludePlayer, unexcludePlayer, clearExcludedPlayers,
  type ExcludedPlayer,
} from '../lib/playerExclusions';

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
  const [customLegIds, setCustomLegIds] = useState<string[]>([]);
  const cancelRef = useRef<CancellationRef>({ cancelled: false });

  // Load saved exclusions when the selected match changes
  useEffect(() => {
    if (selectedMatchId && mode === 'gameMulti') {
      setExcludedPlayers(getExcludedPlayers(selectedMatchId));
    } else {
      setExcludedPlayers([]);
    }
    setCustomLegIds([]);
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

  // Pool of pickable legs for the custom builder — same source as "Best Individual Disposal Legs"
  const customLegPool = useMemo(() => {
    return gameRecommendations
      .filter(r => r.safeLine)
      .map(r => rowToLeg(r.safeLine!, matchNames[r.matchId] ?? r.matchId, teamEnvMap, roleTrends));
  }, [gameRecommendations, matchNames, teamEnvMap, roleTrends]);

  const selectedCustomLegs = useMemo(() => {
    const byId = new Map(customLegPool.map(l => [l.playerId, l]));
    return customLegIds.map(id => byId.get(id)).filter((l): l is OptimizerLeg => Boolean(l));
  }, [customLegPool, customLegIds]);

  const customMulti = useMemo(() => buildCustomMulti(selectedCustomLegs), [selectedCustomLegs]);

  const toggleCustomLeg = useCallback((playerId: string) => {
    setCustomLegIds(prev => prev.includes(playerId) ? prev.filter(id => id !== playerId) : [...prev, playerId]);
  }, []);

  const clearCustomLegs = useCallback(() => setCustomLegIds([]), []);

  useEffect(() => {
    onResultsChange?.({
      poolSize: gameRecommendations.length,
      multiCount: multis.length,
      customLegsAvailable: customLegPool.length,
    });
  }, [gameRecommendations.length, multis.length, customLegPool.length, onResultsChange]);

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
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-white font-semibold text-sm">Best Individual Disposal Legs</h3>
            <span className="text-[10px] text-gray-500">Click + to add a leg to your own multi below</span>
          </div>
          <div className="space-y-2">
            {gameRecommendations.filter(r => r.safeLine).map((rec, i) => {
              const fr = rec.safeLine!.freshness;
              const isStale = fr && fr.freshnessStatus !== 'CURRENT';
              const playerId = rec.safeLine!.resolvedPlayerId ?? rec.safeLine!.player_id ?? rec.safeLine!.player_name;
              const isPicked = customLegIds.includes(playerId);
              return (
                <div key={i} className={`py-2 border-b border-gray-800/30 last:border-0 ${isStale ? 'opacity-60' : ''} ${isPicked ? 'bg-emerald-500/5 -mx-2 px-2 rounded' : ''}`}>
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => toggleCustomLeg(playerId)}
                        disabled={Boolean(isStale)}
                        title={isStale ? 'Stale/unverified data — cannot add to custom multi' : isPicked ? 'Remove from your multi' : 'Add to your multi'}
                        className={`w-5 h-5 flex items-center justify-center rounded transition shrink-0 disabled:opacity-40 disabled:cursor-not-allowed ${
                          isPicked ? 'bg-emerald-500 text-gray-950' : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white'
                        }`}
                      >
                        {isPicked ? <Check className="w-3 h-3" /> : <Plus className="w-3 h-3" />}
                      </button>
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

      {/* Section A.5 — Build Your Own Multi */}
      {gameRecommendations.length > 0 && (
        <div className="bg-gray-900 border border-cyan-500/20 rounded-xl p-4">
          <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
            <div className="flex items-center gap-2">
              <ListPlus className="w-4 h-4 text-cyan-400" />
              <h3 className="text-white font-semibold text-sm">Build Your Own Multi</h3>
            </div>
            {selectedCustomLegs.length > 0 && (
              <button onClick={clearCustomLegs} className="flex items-center gap-1 text-xs text-gray-500 hover:text-red-400 transition">
                <X className="w-3 h-3" /> Clear ({selectedCustomLegs.length})
              </button>
            )}
          </div>

          {selectedCustomLegs.length === 0 ? (
            <p className="text-xs text-gray-600">
              Pick any legs from "Best Individual Disposal Legs" above — mix and match your own players and lines, and see the combined price update here.
            </p>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {selectedCustomLegs.map(leg => (
                  <span key={leg.playerId} className="flex items-center gap-1.5 text-xs text-white bg-gray-800 border border-gray-700 rounded-full pl-3 pr-1.5 py-1">
                    {leg.playerName} {leg.displayLabel ?? `${leg.line}+`} @{leg.odds.toFixed(2)}
                    <button onClick={() => toggleCustomLeg(leg.playerId)} className="p-0.5 rounded-full hover:bg-gray-700 text-gray-400 hover:text-white transition">
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>

              {selectedCustomLegs.length === 1 ? (
                <p className="text-xs text-gray-500">Add at least one more leg to see a combined multi price.</p>
              ) : customMulti ? (
                <div className="bg-gray-800/50 rounded-lg p-3">
                  <div className="flex items-center gap-4 text-sm flex-wrap">
                    <span className="text-white font-bold">{customMulti.legCount} legs · ${customMulti.combinedOdds.toFixed(2)}</span>
                    <span className="text-gray-400">Conservative prob: {(customMulti.conservativeProbability * 100).toFixed(0)}%</span>
                    <span className={customMulti.estimatedEV >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                      Est EV: {customMulti.estimatedEV >= 0 ? '+' : ''}{(customMulti.estimatedEV * 100).toFixed(0)}%
                    </span>
                  </div>
                  {customMulti.warnings.length > 0 && (
                    <div className="mt-2 space-y-0.5">
                      {customMulti.warnings.map((w, i) => (
                        <p key={i} className="text-[10px] text-amber-400 flex items-center gap-1"><AlertTriangle className="w-2.5 h-2.5 shrink-0" /> {w}</p>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-xs text-red-400">Couldn't price this combination — you may have picked the same player twice.</p>
              )}
            </div>
          )}
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
