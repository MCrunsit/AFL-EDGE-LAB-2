import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  Target, Zap, Shield, Scale, Settings2, ChevronDown, ChevronUp,
  AlertTriangle, Info, Layers, ArrowDown, ArrowUp,
  Activity, DollarSign, Search, UserX, X,
} from 'lucide-react';
import type { Match } from '../lib/types';
import type { ModelledOddsRow, ModelCoverage } from '../lib/modelResolver';
import { getModelledBookmakerOddsForMatch } from '../lib/modelResolver';
import { extractStatType } from '../lib/oddsNormalizer';
import {
  generatePullEmMultis,
  DEFAULT_PULL_EM_SETTINGS,
  type PullEmSettings,
  type PullEmMulti,
  type PullEmResult,
  type PullEmDiagnostics,
  type MarketFocus,
  type MarketTypeFilter,
  type GenerationMode,
} from '../lib/pullEmMultiOptimizer';
import {
  getExcludedPlayers, excludePlayer, unexcludePlayer, clearExcludedPlayers,
  type ExcludedPlayer,
} from '../lib/playerExclusions';

interface Props {
  matchNames: Record<string, string>;
  matches: Match[];
  selectedMatchIds: string[];
  modelledRows: ModelledOddsRow[];
  coverage: ModelCoverage | null;
}

const FOCUS_CONFIG: Record<MarketFocus, { label: string; desc: string }> = {
  disposals_only: { label: 'Disposals Only', desc: '15+, 20+, 25+, 30+, 35+, 40+ ladders and O/U lines' },
  disposals_and_marks: { label: 'Disposals + Marks', desc: 'Disposal and mark markets' },
  all_player_props: { label: 'All Player Props', desc: 'Disposals, marks, tackles, goals, hitouts' },
};

const MODE_CONFIG: Record<GenerationMode, { label: string; icon: typeof Shield; activeClass: string; desc: string }> = {
  safest: { label: 'Safest', icon: Shield, activeClass: 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30', desc: 'Highest probability legs, lowest risk' },
  best_value: { label: 'Best Value', icon: DollarSign, activeClass: 'bg-amber-500/20 text-amber-400 border border-amber-500/30', desc: 'Best expected value, higher odds' },
  balanced: { label: 'Balanced', icon: Scale, activeClass: 'bg-sky-500/20 text-sky-400 border border-sky-500/30', desc: 'Balance of safety and value' },
};

function formatMatchLabel(m: Match): string {
  const home = m.home_team ?? 'TBD';
  const away = m.away_team ?? 'TBD';
  const round = m.round ? `Round ${m.round}` : 'Round TBD';
  const time = m.match_date
    ? new Date(m.match_date).toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : 'Time TBD';
  return `${home} vs ${away} — ${round} — ${time}`;
}

export default function PullEmDisposalMultiPanel({
  matchNames, matches, selectedMatchIds, modelledRows, coverage,
}: Props) {
  const [settings, setSettings] = useState<PullEmSettings>(DEFAULT_PULL_EM_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  const [result, setResult] = useState<PullEmResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedMulti, setExpandedMulti] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedPullEmMatchId, setSelectedPullEmMatchId] = useState<string | null>(null);
  const [matchRows, setMatchRows] = useState<ModelledOddsRow[]>([]);
  const [matchesWithDisposalOdds, setMatchesWithDisposalOdds] = useState<Match[]>([]);
  const [excludedPlayers, setExcludedPlayers] = useState<ExcludedPlayer[]>([]);
  const [exclusionSearch, setExclusionSearch] = useState('');
  const [showExclusionPanel, setShowExclusionPanel] = useState(false);

  // Determine which matches have disposal odds available
  const allAvailableRows = useMemo(() => {
    return [...modelledRows, ...matchRows];
  }, [modelledRows, matchRows]);

  // Filter available matches to those that have disposal odds
  useEffect(() => {
    if (matches.length === 0 || allAvailableRows.length === 0) {
      setMatchesWithDisposalOdds([]);
      return;
    }
    const matchIdsWithDisposals = new Set(
      allAvailableRows
        .filter(r => {
          const stat = r.resolvedStatType ?? extractStatType(r.raw_market) ?? r.stat_type;
          return stat === 'disposals';
        })
        .map(r => r.match_id)
    );
    const filtered = matches.filter(m => matchIdsWithDisposals.has(m.id));
    setMatchesWithDisposalOdds(filtered);
  }, [matches, allAvailableRows]);

  // Reset everything when the selected match changes
  useEffect(() => {
    setResult(null);
    setExpandedMulti(null);
    setError(null);
    setMatchRows([]);
    setExclusionSearch('');

    // Load saved exclusions for this match
    if (selectedPullEmMatchId) {
      setExcludedPlayers(getExcludedPlayers(selectedPullEmMatchId));
    } else {
      setExcludedPlayers([]);
    }

    if (!selectedPullEmMatchId) return;

    // Load rows for the selected match with O/U lines included
    setLoading(true);
    getModelledBookmakerOddsForMatch(selectedPullEmMatchId, { includeOULines: true })
      .then(res => {
        setMatchRows(res.rows);
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }, [selectedPullEmMatchId]);

  // Filter rows to the selected match before building
  const rowsForSelectedMatch = useMemo(() => {
    if (!selectedPullEmMatchId) return [];
    return allAvailableRows.filter(r => r.match_id === selectedPullEmMatchId);
  }, [allAvailableRows, selectedPullEmMatchId]);

  const excludedPlayerIds = useMemo(() => {
    return new Set(excludedPlayers.map(p => p.playerId));
  }, [excludedPlayers]);

  // Unique players from the selected match's rows — for the exclusion UI
  const matchPlayers = useMemo(() => {
    const seen = new Map<string, { playerId: string; playerName: string; team: string }>();
    for (const r of rowsForSelectedMatch) {
      const pid = r.player_id ?? r.resolvedPlayerId ?? '';
      if (!pid) continue;
      if (seen.has(pid)) continue;
      seen.set(pid, { playerId: pid, playerName: r.player_name, team: r.playerTeam ?? '' });
    }
    return [...seen.values()].sort((a, b) => a.playerName.localeCompare(b.playerName));
  }, [rowsForSelectedMatch]);

  const filteredMatchPlayers = useMemo(() => {
    if (!exclusionSearch.trim()) return matchPlayers;
    const q = exclusionSearch.toLowerCase();
    return matchPlayers.filter(p =>
      p.playerName.toLowerCase().includes(q) ||
      p.team.toLowerCase().includes(q)
    );
  }, [matchPlayers, exclusionSearch]);

  // Rows after exclusions are applied
  const rowsAfterExclusions = useMemo(() => {
    if (excludedPlayerIds.size === 0) return rowsForSelectedMatch;
    return rowsForSelectedMatch.filter(r => {
      const pid = r.player_id ?? r.resolvedPlayerId ?? '';
      return !excludedPlayerIds.has(pid);
    });
  }, [rowsForSelectedMatch, excludedPlayerIds]);

  const handleExcludePlayer = useCallback((player: { playerId: string; playerName: string; team: string }) => {
    if (!selectedPullEmMatchId) return;
    excludePlayer(selectedPullEmMatchId, player);
    setExcludedPlayers(getExcludedPlayers(selectedPullEmMatchId));
  }, [selectedPullEmMatchId]);

  const handleUnexcludePlayer = useCallback((playerId: string) => {
    if (!selectedPullEmMatchId) return;
    unexcludePlayer(selectedPullEmMatchId, playerId);
    setExcludedPlayers(getExcludedPlayers(selectedPullEmMatchId));
  }, [selectedPullEmMatchId]);

  const handleClearExclusions = useCallback(() => {
    if (!selectedPullEmMatchId) return;
    clearExcludedPlayers(selectedPullEmMatchId);
    setExcludedPlayers([]);
  }, [selectedPullEmMatchId]);

  const handleGenerate = useCallback(async () => {
    if (!selectedPullEmMatchId) {
      setError('Select a match first.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Ensure we have O/U rows loaded for the selected match
      let rowsToUse = rowsAfterExclusions;
      if (matchRows.length === 0) {
        const res = await getModelledBookmakerOddsForMatch(selectedPullEmMatchId, { includeOULines: true });
        setMatchRows(res.rows);
        // Apply exclusions to the freshly loaded rows
        rowsToUse = res.rows.filter(r => {
          if (r.match_id !== selectedPullEmMatchId) return false;
          const pid = r.player_id ?? r.resolvedPlayerId ?? '';
          return !excludedPlayerIds.has(pid);
        });
      }

      const res = generatePullEmMultis(
        rowsToUse,
        matchNames,
        settings,
        matches,
        selectedPullEmMatchId
      );
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [selectedPullEmMatchId, rowsAfterExclusions, matchRows, matchNames, settings, matches, excludedPlayerIds]);

  const updateSettings = (patch: Partial<PullEmSettings>) => {
    setSettings(prev => ({ ...prev, ...patch }));
  };

  const toggleMarketType = (type: MarketTypeFilter) => {
    setSettings(prev => {
      const next = new Set(prev.marketTypes);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      const patch: Partial<PullEmSettings> = { marketTypes: next };
      if (type === 'under') {
        patch.allowUnders = next.has('under');
      }
      return { ...prev, ...patch };
    });
  };

  const noUnderOddsAvailable = result?.diagnostics?.genuineUnderOddsAvailable === false;

  return (
    <div className="bg-gradient-to-br from-gray-900 via-gray-900 to-gray-800 border border-sky-500/20 rounded-xl p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-sky-500/20 flex items-center justify-center">
            <Target className="w-4 h-4 text-sky-400" />
          </div>
          <div>
            <h4 className="text-sm font-semibold text-white">Pull 'Em Disposal Multi</h4>
            <p className="text-xs text-gray-500">Same Game Multi for one selected match — min $5.00 combined</p>
          </div>
        </div>
        <button
          onClick={() => setShowSettings(s => !s)}
          className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 transition"
        >
          <Settings2 className="w-3 h-3" />
          Settings
          {showSettings ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>
      </div>

      {/* Match Selector */}
      <div className="bg-gray-800/40 rounded-lg p-3 border border-gray-700/50">
        <label className="text-xs font-medium text-gray-400 block mb-1.5">Select Match</label>
        <select
          value={selectedPullEmMatchId ?? ''}
          onChange={e => setSelectedPullEmMatchId(e.target.value || null)}
          className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
        >
          <option value="">— Select a match —</option>
          {matchesWithDisposalOdds.map(m => (
            <option key={m.id} value={m.id}>
              {formatMatchLabel(m)}
            </option>
          ))}
        </select>
        {matchesWithDisposalOdds.length === 0 && (
          <p className="text-xs text-amber-400 mt-1.5">
            No matches with disposal odds available. Load matches above first.
          </p>
        )}
        {selectedPullEmMatchId && (
          <p className="text-xs text-gray-500 mt-1.5">
            {rowsForSelectedMatch.length} rows loaded for this match
          </p>
        )}
      </div>

      {/* Excluded Players */}
      {selectedPullEmMatchId && (
        <div className="bg-gray-800/40 rounded-lg p-3 border border-gray-700/50">
          <div className="flex items-center justify-between mb-2">
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
              {showExclusionPanel ? <ChevronUp className="w-3 h-3 text-gray-500" /> : <ChevronDown className="w-3 h-3 text-gray-500" />}
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
      )}

      {/* Settings Panel */}
      {showSettings && (
        <div className="bg-gray-800/40 rounded-lg p-3 space-y-3 border border-gray-700/50">
          {/* Market Focus */}
          <div>
            <label className="text-xs font-medium text-gray-400 block mb-1.5">Market Focus</label>
            <div className="flex gap-2">
              {(Object.keys(FOCUS_CONFIG) as MarketFocus[]).map(focus => (
                <button
                  key={focus}
                  onClick={() => updateSettings({ marketFocus: focus })}
                  className={`flex-1 px-2 py-1.5 rounded-lg text-xs font-medium transition ${
                    settings.marketFocus === focus
                      ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30'
                      : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                  }`}
                  title={FOCUS_CONFIG[focus].desc}
                >
                  {FOCUS_CONFIG[focus].label}
                </button>
              ))}
            </div>
          </div>

          {/* Market Type Checkboxes */}
          <div>
            <label className="text-xs font-medium text-gray-400 block mb-1.5">Market Types</label>
            <div className="flex gap-2">
              {([
                { key: 'ladder' as const, label: 'Ladders', icon: Layers, desc: '15+, 20+, 25+...' },
                { key: 'over' as const, label: 'Overs', icon: ArrowUp, desc: 'Over 19.5, 24.5...' },
                { key: 'under' as const, label: 'Unders', icon: ArrowDown, desc: 'Under 19.5, 24.5...' },
              ]).map(({ key, label, icon: Icon, desc }) => (
                <button
                  key={key}
                  onClick={() => toggleMarketType(key)}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium transition ${
                    settings.marketTypes.has(key)
                      ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30'
                      : 'bg-gray-800 text-gray-500 hover:bg-gray-700'
                  }`}
                  title={desc}
                >
                  <Icon className="w-3 h-3" />
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Generation Mode */}
          <div>
            <label className="text-xs font-medium text-gray-400 block mb-1.5">Generation Mode</label>
            <div className="flex gap-2">
              {(Object.keys(MODE_CONFIG) as GenerationMode[]).map(mode => {
                const cfg = MODE_CONFIG[mode];
                const Icon = cfg.icon;
                return (
                  <button
                    key={mode}
                    onClick={() => updateSettings({ generationMode: mode })}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium transition ${
                      settings.generationMode === mode
                        ? cfg.activeClass
                        : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                    }`}
                    title={cfg.desc}
                  >
                    <Icon className="w-3 h-3" />
                    {cfg.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Numeric Settings */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <div>
              <label className="text-xs text-gray-500 block mb-1">Min Combined Odds</label>
              <input
                type="number"
                step="0.50"
                value={settings.minCombinedOdds}
                onChange={e => updateSettings({ minCombinedOdds: Number(e.target.value) })}
                className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-white"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Max Combined Odds</label>
              <input
                type="number"
                step="1"
                value={settings.maxCombinedOdds}
                onChange={e => updateSettings({ maxCombinedOdds: Number(e.target.value) })}
                className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-white"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Min Legs</label>
              <input
                type="number"
                min="2"
                max="8"
                value={settings.minLegs}
                onChange={e => updateSettings({ minLegs: Number(e.target.value) })}
                className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-white"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Max Legs</label>
              <input
                type="number"
                min="2"
                max="8"
                value={settings.maxLegs}
                onChange={e => updateSettings({ maxLegs: Number(e.target.value) })}
                className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-white"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Min Hit Rate %</label>
              <input
                type="number"
                min="0"
                max="100"
                value={settings.minHitRate}
                onChange={e => updateSettings({ minHitRate: Number(e.target.value) })}
                className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-white"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Min Model Confidence %</label>
              <input
                type="number"
                min="0"
                max="100"
                value={settings.minModelConfidence}
                onChange={e => updateSettings({ minModelConfidence: Number(e.target.value) })}
                className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-white"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Min Expected Value %</label>
              <input
                type="number"
                step="1"
                value={settings.minExpectedValue}
                onChange={e => updateSettings({ minExpectedValue: Number(e.target.value) })}
                className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-white"
              />
            </div>
            <div className="flex items-end gap-3 pb-1">
              <label className="flex items-center gap-1.5 text-xs text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.confirmedPlayersOnly}
                  onChange={e => updateSettings({ confirmedPlayersOnly: e.target.checked })}
                  className="rounded"
                />
                Confirmed only
              </label>
              <label className="flex items-center gap-1.5 text-xs text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.allowUnders}
                  onChange={e => updateSettings({ allowUnders: e.target.checked })}
                  className="rounded"
                />
                Allow unders
              </label>
            </div>
          </div>
        </div>
      )}

      {/* Generate Button */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleGenerate}
          disabled={loading || !selectedPullEmMatchId}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-sky-500/20 text-sky-400 border border-sky-500/30 hover:bg-sky-500/30 transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? <Activity className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          Generate Pull 'Em Multi
        </button>
        {!selectedPullEmMatchId && (
          <span className="text-xs text-gray-500">Select a match first</span>
        )}
        {coverage && (
          <span className="text-xs text-gray-500">{coverage.modelReady} model-ready rows</span>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 rounded-lg p-2">
          <AlertTriangle className="w-3.5 h-3.5" />
          {error}
        </div>
      )}

      {/* No genuine under odds warning */}
      {result && noUnderOddsAvailable && (
        <div className="flex items-start gap-2 text-xs text-amber-400 bg-amber-500/10 rounded-lg p-2.5">
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            No genuine under odds are stored in the database for this match.
            Under legs cannot be generated without real bookmaker under prices.
            Over and ladder legs are still available.
          </span>
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="space-y-3">
          {/* Summary */}
          <div className="flex items-center gap-4 text-xs text-gray-500">
            <span>Pool: {result.poolSize} legs</span>
            <span>Combinations: {result.combinationsChecked}</span>
            <span>Runtime: {result.runtimeMs}ms</span>
            {result.multis.length > 0 && <span className="text-sky-400">{result.multis.length} multis found</span>}
          </div>

          {/* Diagnostics */}
          {result.diagnostics && (
            <DiagnosticsPanel diag={result.diagnostics} />
          )}

          {/* No results */}
          {result.multis.length === 0 && (
            <div className="bg-gray-800/40 rounded-lg p-4 text-center border border-gray-700/50">
              <AlertTriangle className="w-5 h-5 text-amber-400 mx-auto mb-2" />
              <p className="text-sm text-gray-300 font-medium">
                No suitable ${settings.minCombinedOdds.toFixed(2)}+ Pull 'Em Same Game Multi was found for this match.
              </p>
              <p className="text-xs text-gray-500 mt-1">
                Try adjusting filters: lower minimum odds, reduce min hit rate, or allow more market types.
              </p>
              {result.rejectedReasons.length > 0 && (
                <ul className="text-xs text-gray-600 mt-2 space-y-0.5">
                  {result.rejectedReasons.map((r, i) => <li key={i}>- {r}</li>)}
                </ul>
              )}
            </div>
          )}

          {/* Multi Cards */}
          {result.multis.map((multi, idx) => (
            <MultiCard
              key={idx}
              multi={multi}
              expanded={expandedMulti === idx}
              onToggle={() => setExpandedMulti(expandedMulti === idx ? null : idx)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MultiCard({
  multi, expanded, onToggle,
}: {
  multi: PullEmMulti;
  expanded: boolean;
  onToggle: () => void;
}) {
  const combinedOddsStr = multi.combinedOdds.toFixed(2);
  const probStr = (multi.combinedModelProb * 100).toFixed(1);
  const evStr = (multi.combinedEV * 100).toFixed(1);

  return (
    <div className="bg-gray-800/40 rounded-lg border border-gray-700/50 overflow-hidden">
      <button onClick={onToggle} className="w-full p-3 flex items-center justify-between hover:bg-gray-800/60 transition">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-lg bg-sky-500/20 flex items-center justify-center">
            <Zap className="w-3.5 h-3.5 text-sky-400" />
          </div>
          <div className="text-left">
            <div className="text-sm font-medium text-white">
              {multi.labels[0]} - {multi.legs.length} legs
            </div>
            <div className="text-xs text-gray-500">
              {multi.legs.map(l => l.playerName.split(' ').slice(-1)[0]).join(' - ')}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-sm font-bold text-sky-400">${combinedOddsStr}</div>
            <div className="text-xs text-gray-500">{probStr}% prob - {evStr}% EV</div>
          </div>
          {expanded ? <ChevronUp className="w-4 h-4 text-gray-500" /> : <ChevronDown className="w-4 h-4 text-gray-500" />}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-gray-700/50 p-3 space-y-2">
          {multi.isEstimated && (
            <div className="flex items-center gap-1.5 text-xs text-amber-400/70 bg-amber-500/5 rounded px-2 py-1">
              <Info className="w-3 h-3" />
              Estimated combined odds from individual leg prices
            </div>
          )}

          {multi.legs.map((leg, legIdx) => (
            <LegRow
              key={legIdx}
              leg={leg}
              isWeakest={legIdx === multi.weakestLegIndex}
              weakestReason={legIdx === multi.weakestLegIndex ? multi.weakestLegReason : undefined}
            />
          ))}

          <div className="flex items-center justify-between pt-2 border-t border-gray-700/30">
            <div className="text-xs text-gray-500">
              Combined: <span className="text-sky-400 font-medium">${combinedOddsStr}</span>
              {' - '}Prob: <span className="text-sky-400">{probStr}%</span>
              {' - '}EV: <span className={multi.combinedEV >= 0 ? 'text-emerald-400' : 'text-red-400'}>{evStr}%</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function LegRow({
  leg, isWeakest, weakestReason,
}: {
  leg: PullEmMulti['legs'][number];
  isWeakest: boolean;
  weakestReason?: string;
}) {
  const oddsStr = leg.odds.toFixed(2);
  const probStr = (leg.modelProb * 100).toFixed(0);
  const evStr = (leg.expectedValue * 100).toFixed(0);
  const riskColor = leg.riskLevel === 'High' ? 'text-red-400' : leg.riskLevel === 'Medium' ? 'text-amber-400' : 'text-emerald-400';

  const Icon = leg.selectionType === 'ladder' ? Layers : leg.selectionType === 'over' ? ArrowUp : ArrowDown;

  return (
    <div className={`rounded-lg p-2.5 border ${isWeakest ? 'bg-amber-500/5 border-amber-500/30' : 'bg-gray-900/40 border-gray-700/30'}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className="w-3.5 h-3.5 text-sky-400" />
          <span className="text-sm font-medium text-white">{leg.playerName}</span>
          <span className="text-xs text-gray-500">{leg.team}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-sky-400">${oddsStr}</span>
          {isWeakest && (
            <span className="text-xs font-medium text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded">
              Pull 'Em Leg
            </span>
          )}
        </div>
      </div>

      <div className="text-xs text-gray-400 mt-1">
        {leg.displayLabel} {leg.row.resolvedStatType === 'disposals' ? 'Disposals' : leg.row.resolvedStatType}
        {' - '}vs {leg.row.opponent ?? 'TBD'}
      </div>

      <div className="grid grid-cols-4 gap-1.5 mt-2 text-xs">
        <StatCell label="Model Prob" value={`${probStr}%`} color="text-sky-400" />
        <StatCell label="Exp. Value" value={`${evStr}%`} color={leg.expectedValue >= 0 ? 'text-emerald-400' : 'text-red-400'} />
        <StatCell label="Confidence" value={`${leg.confidence}%`} color="text-gray-300" />
        <StatCell label="Risk" value={leg.riskLevel} color={riskColor} />
        <StatCell label="Season HR" value={`${leg.seasonHitRate.toFixed(0)}%`} color="text-gray-300" />
        <StatCell label="Last 10" value={`${leg.last10HitRate.toFixed(0)}%`} color="text-gray-300" />
        <StatCell label="Last 5" value={`${leg.last5HitRate.toFixed(0)}%`} color="text-gray-300" />
        <StatCell label="Predicted" value={leg.predictedDisposals.toFixed(1)} color="text-gray-300" />
      </div>

      {leg.lastFiveValues.length > 0 && (
        <div className="text-xs text-gray-500 mt-1.5">
          Last 5: [{leg.lastFiveValues.join(', ')}]
        </div>
      )}

      <div className={`text-xs mt-1.5 ${leg.riskLevel === 'High' ? 'text-red-400' : leg.riskLevel === 'Medium' ? 'text-amber-400' : 'text-gray-500'}`}>
        {leg.riskWarning}
      </div>

      {isWeakest && weakestReason && (
        <div className="text-xs text-amber-400 mt-1.5 flex items-start gap-1.5">
          <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
          <span><span className="font-medium">Suggested Pull 'Em Leg:</span> {weakestReason}</span>
        </div>
      )}
    </div>
  );
}

function StatCell({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="bg-gray-800/40 rounded px-1.5 py-1">
      <div className="text-gray-600 text-[10px]">{label}</div>
      <div className={`font-medium ${color}`}>{value}</div>
    </div>
  );
}

function DiagnosticsPanel({ diag }: { diag: PullEmDiagnostics }) {
  const [expanded, setExpanded] = useState(false);

  const entries: Array<{ label: string; value: number | string; highlight?: boolean }> = [
    { label: 'Selected match', value: diag.selectedMatchName || diag.selectedMatchId || 'None', highlight: true },
    { label: 'Rows for selected match', value: diag.rowsForSelectedMatch, highlight: true },
    { label: 'Cross-match rows rejected', value: diag.crossMatchRowsRejected },
    { label: 'Input model rows (total)', value: diag.inputModelRows },
    { label: 'Recognised disposal rows', value: diag.recognisedDisposalRows, highlight: true },
    { label: 'Recognised ladder legs', value: diag.recognisedLadderRows },
    { label: 'Recognised over legs', value: diag.recognisedOverRows, highlight: true },
    { label: 'Recognised under legs', value: diag.recognisedUnderRows, highlight: true },
    { label: 'Genuine under odds available', value: diag.genuineUnderOddsAvailable ? 'Yes' : 'No' },
    { label: 'Invalid player', value: diag.invalidPlayer },
    { label: 'Invalid odds', value: diag.invalidOdds },
    { label: 'Invalid line', value: diag.invalidLine },
    { label: 'Unrecognised market', value: diag.unrecognisedMarket },
    { label: 'Excluded by market-type setting', value: diag.excludedByMarketType },
    { label: 'Excluded by hit rate', value: diag.excludedByHitRate },
    { label: 'Excluded by confidence', value: diag.excludedByConfidence },
    { label: 'Excluded by EV', value: diag.excludedByEV },
    { label: 'Excluded by confirmation', value: diag.excludedByConfirmation },
    { label: 'Final candidate pool', value: diag.finalCandidatePool, highlight: true },
    { label: 'Same-game combinations generated', value: diag.sameGameCombinationsGenerated, highlight: true },
  ];

  return (
    <div className="bg-gray-800/30 rounded-lg border border-gray-700/40 overflow-hidden">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full px-3 py-2 flex items-center justify-between text-xs text-gray-400 hover:bg-gray-800/50 transition"
      >
        <span className="font-medium">Candidate-Building Diagnostics</span>
        {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-1.5">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-1.5">
            {entries.map(({ label, value, highlight }) => (
              <div
                key={label}
                className={`flex items-center justify-between rounded px-2 py-1 text-xs ${
                  highlight ? 'bg-sky-500/10 text-sky-400' : 'bg-gray-900/40 text-gray-400'
                }`}
              >
                <span>{label}</span>
                <span className="font-medium">{value}</span>
              </div>
            ))}
          </div>
          {diag.sampleUnrecognised.length > 0 && (
            <div className="mt-2">
              <div className="text-xs text-gray-500 mb-1">Sample unrecognised rows:</div>
              {diag.sampleUnrecognised.map((s, i) => (
                <div key={i} className="text-xs text-gray-600 bg-gray-900/40 rounded px-2 py-1 mb-0.5">
                  market: {s.raw_market} | type: {s.market_type} | stat: {s.stat_type ?? 'null'} | line: {s.line ?? 'null'} | over: {s.over_odds ?? 'null'} | under: {s.under_odds ?? 'null'}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
