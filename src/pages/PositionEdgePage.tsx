import { useState, useEffect, useMemo } from 'react';
import { Crosshair, RefreshCw, Filter, ChevronDown, TrendingUp, TrendingDown, AlertCircle, Info, Beaker, Database, Zap } from 'lucide-react';
import { supabase } from '../lib/supabase';
import {
  loadPositionEdgeCache,
  calculatePositionEdges,
  savePositionEdges,
  createTestEdge,
  getPositionEdgeCount,
  getPositionEdgeColor,
  formatPositionEdgeLabel,
  normalizeOpponentName,
  normalizeTeamName,
  autoAssignPositionGroups,
  loadPositionOverrides,
  resolvePositionGroup,
  canonicalizePositionGroup,
  BETTING_RELEVANT_STATS,
  AFL_TEAMS,
  type PositionEdgeResult,
  type PositionEdgeCache,
  type PositionEdgeDiagnostics,
  type PositionOverride,
  type StatType,
} from '../lib/positionEdge';
import { POSITION_GROUPS } from '../lib/types';
import type { Match } from '../lib/types';
import LoadingSpinner from '../components/LoadingSpinner';

interface PositionAuditData {
  totalPlayers: number;
  mapped: number;
  unknown: number;
  lowConfidence: number;
  manual: number;
  autoProfile: number;
  missingStats: number;
  perMatch: Record<string, { mapped: number; unknown: number }>;
  unresolvedPlayers: string[];
}

export default function PositionEdgePage() {
  const [cache, setCache] = useState<PositionEdgeCache>({});
  const [loading, setLoading] = useState(true);
  const [recalculating, setRecalculating] = useState(false);
  const [selectedStat, setSelectedStat] = useState<StatType>('disposals');
  const [showSignificantOnly, setShowSignificantOnly] = useState(false);
  const [roundMatches, setRoundMatches] = useState<Match[]>([]);
  const [expandedBoost, setExpandedBoost] = useState(true);
  const [expandedSuppress, setExpandedSuppress] = useState(true);
  const [recalcMessage, setRecalcMessage] = useState<string | null>(null);
  const [testEdgeMessage, setTestEdgeMessage] = useState<string | null>(null);
  const [edgeCount, setEdgeCount] = useState(0);
  const [diagnostics, setDiagnostics] = useState<PositionEdgeDiagnostics | null>(null);
  const [autoAssigning, setAutoAssigning] = useState(false);
  const [autoAssignMessage, setAutoAssignMessage] = useState<string | null>(null);
  const [auditData, setAuditData] = useState<PositionAuditData | null>(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [dataLens, setDataLens] = useState<'this_season' | 'last_2_seasons' | 'all_data'>('this_season');

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    const edgeCache = await loadPositionEdgeCache();
    setCache(edgeCache);
    const count = await getPositionEdgeCount();
    setEdgeCount(count);

    // Load active betting slate matches (next round with fixtures)
    const { getActiveBettingSlate } = await import('../lib/roundManager');
    const slate = await getActiveBettingSlate(2026);
    const matches = slate.matches;
    setRoundMatches(matches);
    setLoading(false);

    // Load audit data for the current round's matches
    loadAuditData(matches);
  }

  async function loadAuditData(matches: Match[]) {
    if (matches.length === 0) {
      setAuditData(null);
      return;
    }
    setAuditLoading(true);
    try {
      const matchIds = matches.map(m => m.id);

      // 1. Paginate all bookmaker_odds rows for these matches
      const allOddsRows: any[] = [];
      const PAGE_SIZE = 1000;
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from('bookmaker_odds')
          .select('player_id, bookmaker_player_name, match_id')
          .in('match_id', matchIds)
          .range(from, from + PAGE_SIZE - 1);
        if (error || !data || data.length === 0) break;
        allOddsRows.push(...data);
        if (data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }

      // 2. Collect unique non-null player IDs
      const uniquePlayerIds = new Set<string>();
      for (const row of allOddsRows) {
        if (row.player_id) uniquePlayerIds.add(row.player_id);
      }
      const playerIds = Array.from(uniquePlayerIds);

      if (playerIds.length === 0) {
        setAuditData({
          totalPlayers: 0,
          mapped: 0,
          unknown: 0,
          lowConfidence: 0,
          manual: 0,
          autoProfile: 0,
          missingStats: 0,
          perMatch: {},
          unresolvedPlayers: [],
        });
        setAuditLoading(false);
        return;
      }

      // 3. Query players by those IDs (batched to avoid IN-filter cap)
      const playerList: Pick<any, 'id' | 'name' | 'team' | 'position_group'>[] = [];
      const BATCH = 200;
      for (let i = 0; i < playerIds.length; i += BATCH) {
        const batch = playerIds.slice(i, i + BATCH);
        const { data: batchPlayers } = await supabase
          .from('players')
          .select('id, name, team, position_group')
          .in('id', batch);
        if (batchPlayers) playerList.push(...batchPlayers);
      }

      const overrides = await loadPositionOverrides();

      // 4. Determine which players have stats
      const playersWithStats = new Set<string>();
      for (let i = 0; i < playerIds.length; i += BATCH) {
        const batch = playerIds.slice(i, i + BATCH);
        const { data: statRows } = await supabase
          .from('player_game_stats')
          .select('player_id')
          .in('player_id', batch);
        for (const row of statRows ?? []) {
          if (row.player_id) playersWithStats.add(row.player_id);
        }
      }

      // 5. Calculate audit metrics
      let mapped = 0;
      let unknown = 0;
      let lowConfidence = 0;
      let manual = 0;
      let autoProfile = 0;
      let missingStats = 0;
      const unresolvedPlayers: string[] = [];

      const perMatch: Record<string, { mapped: number; unknown: number }> = {};
      for (const m of matches) {
        perMatch[m.id] = { mapped: 0, unknown: 0 };
      }

      // Build a map of player_id → match_ids from odds rows
      const playerToMatches = new Map<string, Set<string>>();
      for (const row of allOddsRows) {
        if (!row.player_id) continue;
        if (!playerToMatches.has(row.player_id)) playerToMatches.set(row.player_id, new Set());
        playerToMatches.get(row.player_id)!.add(row.match_id);
      }

      for (const p of playerList) {
        const resolved = resolvePositionGroup(p.id, p.name, p.team, p.position_group, overrides);
        const isUnknown = resolved.group === 'UNKNOWN' || canonicalizePositionGroup(resolved.group) === 'UNKNOWN';
        if (isUnknown) {
          unknown++;
          unresolvedPlayers.push(p.name);
        } else {
          mapped++;
        }
        if (resolved.confidence === 'low') lowConfidence++;
        if (resolved.source === 'manual') manual++;
        if (resolved.source === 'auto_profile') autoProfile++;
        if (!p.id || !playersWithStats.has(p.id)) missingStats++;

        // Attribute to matches containing this player's odds
        const playerMatches = playerToMatches.get(p.id);
        if (playerMatches) {
          for (const matchId of playerMatches) {
            if (perMatch[matchId]) {
              if (isUnknown) perMatch[matchId].unknown++;
              else perMatch[matchId].mapped++;
            }
          }
        }
      }

      setAuditData({
        totalPlayers: playerList.length,
        mapped,
        unknown,
        lowConfidence,
        manual,
        autoProfile,
        missingStats,
        perMatch,
        unresolvedPlayers,
      });
    } catch {
      setAuditData(null);
    }
    setAuditLoading(false);
  }

  async function handleRecalculate() {
    setRecalculating(true);
    setRecalcMessage(null);
    try {
      const { cache: edges, diagnostics: diag } = await calculatePositionEdges();
      setDiagnostics(diag);
      const count = Object.keys(edges).length;
      if (count === 0) {
        setRecalcMessage('No position edges could be calculated. Check player_game_stats data and player position_group mappings.');
      } else {
        const saved = await savePositionEdges(edges);
        setRecalcMessage(`Created/updated ${saved} position edge rows (${count} total computed).`);
        const newCount = await getPositionEdgeCount();
        setEdgeCount(newCount);
        const newCache = await loadPositionEdgeCache();
        setCache(newCache);
      }
    } catch (err) {
      setRecalcMessage(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
    setRecalculating(false);
    setTimeout(() => setRecalcMessage(null), 8000);
  }

  async function handleCreateTestEdge() {
    setTestEdgeMessage(null);
    try {
      await createTestEdge();
      setTestEdgeMessage('Test edge created: MID-OUT vs Fremantle disposals +4.0 (very_significant)');
      const newCount = await getPositionEdgeCount();
      setEdgeCount(newCount);
      const newCache = await loadPositionEdgeCache();
      setCache(newCache);
    } catch (err) {
      setTestEdgeMessage(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
    setTimeout(() => setTestEdgeMessage(null), 8000);
  }

  async function handleAutoAssign() {
    setAutoAssigning(true);
    setAutoAssignMessage(null);
    try {
      const result = await autoAssignPositionGroups();
      setAutoAssignMessage(
        `Checked ${result.checked} · Already mapped: ${result.alreadyMapped} · Assigned: ${result.updated} · Still UNKNOWN: ${result.stillUnknown} · Errors: ${result.errors}`
      );
    } catch (err) {
      setAutoAssignMessage(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
    setAutoAssigning(false);
    setTimeout(() => setAutoAssignMessage(null), 6000);
  }

  const matrix = useMemo(() => {
    const grid: (PositionEdgeResult | null)[][] = [];
    for (const pg of POSITION_GROUPS) {
      const row: (PositionEdgeResult | null)[] = [];
      for (const team of AFL_TEAMS) {
        const key = `${pg}|${team}|${selectedStat}`;
        let edge = cache[key] ?? null;
        // Fallback: try normalizeTeamName in case cache uses different variant
        if (!edge) {
          const normKey = `${pg}|${normalizeTeamName(team)}|${selectedStat}`;
          edge = cache[normKey] ?? null;
        }
        row.push(edge);
      }
      grid.push(row);
    }
    return grid;
  }, [cache, selectedStat]);

  const boosts = useMemo(() => {
    const list: PositionEdgeResult[] = [];
    for (const edge of Object.values(cache)) {
      if (edge.edge_value > 1.5 && edge.games >= 8) {
        list.push(edge);
      }
    }
    return list.sort((a, b) => b.edge_value - a.edge_value);
  }, [cache]);

  const suppressions = useMemo(() => {
    const list: PositionEdgeResult[] = [];
    for (const edge of Object.values(cache)) {
      if (edge.edge_value < -1.5 && edge.games >= 8) {
        list.push(edge);
      }
    }
    return list.sort((a, b) => a.edge_value - b.edge_value);
  }, [cache]);

  const thisRoundBoosts = useMemo(() => {
    if (roundMatches.length === 0) return [];

    const teamsPlaying = new Set<string>();
    for (const m of roundMatches) {
      if (m.home_team) teamsPlaying.add(normalizeTeamName(m.home_team));
      if (m.away_team) teamsPlaying.add(normalizeTeamName(m.away_team));
    }

    return boosts.filter(e => teamsPlaying.has(normalizeTeamName(e.opponent_team)));
  }, [boosts, roundMatches]);

  const thisRoundSuppressions = useMemo(() => {
    if (roundMatches.length === 0) return [];

    const teamsPlaying = new Set<string>();
    for (const m of roundMatches) {
      if (m.home_team) teamsPlaying.add(normalizeTeamName(m.home_team));
      if (m.away_team) teamsPlaying.add(normalizeTeamName(m.away_team));
    }

    return suppressions.filter(e => teamsPlaying.has(normalizeTeamName(e.opponent_team)));
  }, [suppressions, roundMatches]);

  function getCellColor(edge: PositionEdgeResult | null): string {
    if (!edge) return 'bg-gray-800/30';
    const { edge_value, significance } = edge;
    if (edge_value >= 3.0) return 'bg-emerald-500/40';
    if (edge_value >= 1.5) return 'bg-emerald-500/25';
    if (edge_value > 0) return 'bg-emerald-500/10';
    if (edge_value <= -3.0) return 'bg-red-500/40';
    if (edge_value <= -1.5) return 'bg-red-500/25';
    if (edge_value < 0) return 'bg-red-500/10';
    return 'bg-gray-800/30';
  }

  function formatCellLabel(edge: PositionEdgeResult | null): string {
    if (!edge) return '—';
    if (edge.games < 8) return `${edge.games}`;
    const sign = edge.edge_value > 0 ? '+' : '';
    return `${sign}${edge.edge_value.toFixed(1)}`;
  }

  if (loading) return <LoadingSpinner message="Loading position edges..." />;

  return (
    <div className="space-y-6 max-w-7xl">
      <div className="flex items-center gap-3 flex-wrap">
        <Crosshair className="w-5 h-5 text-emerald-400" />
        <h2 className="text-white font-bold text-lg">Position Edge</h2>
        <span className="text-xs text-gray-500">Position group vs opponent matchup analysis</span>
        <button
          onClick={loadData}
          className="ml-auto px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-xs text-gray-400 hover:bg-gray-700 transition flex items-center gap-2"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </button>
        <button
          onClick={handleRecalculate}
          disabled={recalculating}
          className="px-3 py-1.5 bg-blue-500/20 text-blue-400 border border-blue-500/30 rounded-lg text-xs font-medium hover:bg-blue-500/30 disabled:opacity-50 flex items-center gap-1.5"
        >
          <Database className="w-3.5 h-3.5" />
          {recalculating ? 'Calculating...' : 'Recalculate Position Edges'}
        </button>
        <button
          onClick={handleCreateTestEdge}
          className="px-3 py-1.5 bg-amber-500/20 text-amber-400 border border-amber-500/30 rounded-lg text-xs font-medium hover:bg-amber-500/30 flex items-center gap-1.5"
        >
          <Beaker className="w-3.5 h-3.5" />
          Create Test Edge
        </button>
        <button
          onClick={handleAutoAssign}
          disabled={autoAssigning}
          className="px-3 py-1.5 bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded-lg text-xs font-medium hover:bg-emerald-500/30 disabled:opacity-50 flex items-center gap-1.5"
        >
          <Zap className="w-3.5 h-3.5" />
          {autoAssigning ? 'Assigning...' : 'Auto Assign Players'}
        </button>
      </div>

      {/* Diagnostics */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <Crosshair className="w-4 h-4 text-emerald-400" />
          <h3 className="text-white font-semibold text-sm">Position Edge Diagnostics</h3>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div>
            <p className="text-gray-500">Position Edge Rows</p>
            <p className="text-white font-bold">{edgeCount}</p>
          </div>
          <div>
            <p className="text-gray-500">Cache Size</p>
            <p className={`font-bold ${Object.keys(cache).length < edgeCount ? 'text-amber-400' : 'text-white'}`}>{Object.keys(cache).length}</p>
          </div>
          <div>
            <p className="text-gray-500">Stat Types</p>
            <p className="text-white font-bold">{BETTING_RELEVANT_STATS.length}</p>
          </div>
          <div>
            <p className="text-gray-500">Position Groups</p>
            <p className="text-white font-bold">14</p>
          </div>
        </div>
        {edgeCount === 0 && (
          <div className="mt-3 flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            position_edges table has 0 rows. Click "Create Test Edge" to add a test row, or "Recalculate Position Edges" to compute from historical data.
          </div>
        )}
        {edgeCount > 0 && Object.keys(cache).length < edgeCount && (
          <div className="mt-3 flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            Cache loaded {Object.keys(cache).length} rows but table has {edgeCount} rows. Some edges may not be displayed.
          </div>
        )}
        {recalcMessage && (
          <div className="mt-3 flex items-center gap-2 text-xs text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2">
            <Info className="w-4 h-4 shrink-0" />
            {recalcMessage}
          </div>
        )}
        {testEdgeMessage && (
          <div className="mt-3 flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
            <Beaker className="w-4 h-4 shrink-0" />
            {testEdgeMessage}
          </div>
        )}
          {diagnostics && (
            <div className="mt-4 border-t border-gray-800 pt-3">
              <p className="text-xs text-gray-500 mb-2">Last Recalculation Details</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                <div>
                  <p className="text-gray-500">Stats Rows Fetched</p>
                  <p className="text-white font-bold">{diagnostics.statsRowsFetched}</p>
                </div>
                <div>
                  <p className="text-gray-500">From Opponent Column</p>
                  <p className="text-white font-bold">{diagnostics.rowsWithOpponentColumn}</p>
                </div>
                <div>
                  <p className="text-gray-500">From Match ID Join</p>
                  <p className="text-white font-bold">{diagnostics.rowsWithOpponentFromMatchId}</p>
                </div>
                <div>
                  <p className="text-gray-500">From Date/Team Match</p>
                  <p className="text-white font-bold">{diagnostics.rowsWithOpponentFromDateTeam}</p>
                </div>
                <div>
                  <p className="text-gray-500">Orphaned Rows</p>
                  <p className="text-amber-400 font-bold">{diagnostics.orphanedRows}</p>
                </div>
                <div>
                  <p className="text-gray-500">Players Fetched</p>
                  <p className="text-white font-bold">{diagnostics.playersFetched}</p>
                </div>
                <div>
                  <p className="text-gray-500">Mapped Players</p>
                  <p className="text-emerald-400 font-bold">{diagnostics.mappedPlayers}</p>
                </div>
                <div>
                  <p className="text-gray-500">UNKNOWN Players</p>
                  <p className="text-amber-400 font-bold">{diagnostics.unknownPlayers}</p>
                </div>
                <div>
                  <p className="text-gray-500">Rows Skipped (UNKNOWN)</p>
                  <p className="text-amber-400 font-bold">{diagnostics.rowsSkippedUnknown}</p>
                </div>
                <div>
                  <p className="text-gray-500">Edges Created</p>
                  <p className="text-emerald-400 font-bold">{diagnostics.edgesCreated}</p>
                </div>
              </div>
              {Object.keys(diagnostics.edgesByStatType).length > 0 && (
                <div className="mt-3">
                  <p className="text-gray-500 text-xs mb-1">By Stat Type:</p>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(diagnostics.edgesByStatType).map(([stat, cnt]) => (
                      <span key={stat} className="text-xs px-2 py-0.5 bg-gray-800 text-gray-300 rounded">{stat}: {cnt}</span>
                    ))}
                  </div>
                </div>
              )}
              {Object.keys(diagnostics.edgesByOpponent).length > 0 && (
                <div className="mt-2">
                  <p className="text-gray-500 text-xs mb-1">By Opponent:</p>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(diagnostics.edgesByOpponent).map(([opp, cnt]) => (
                      <span key={opp} className="text-xs px-2 py-0.5 bg-gray-800 text-gray-300 rounded">{opp}: {cnt}</span>
                    ))}
                  </div>
                </div>
              )}
              {Object.keys(diagnostics.edgesByPositionGroup).length > 0 && (
                <div className="mt-2">
                  <p className="text-gray-500 text-xs mb-1">By Position Group:</p>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(diagnostics.edgesByPositionGroup).map(([pg, cnt]) => (
                      <span key={pg} className="text-xs px-2 py-0.5 bg-gray-800 text-gray-300 rounded">{pg}: {cnt}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {autoAssignMessage && (
            <div className="mt-3 flex items-center gap-2 text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">
              <Zap className="w-4 h-4 shrink-0" />
              {autoAssignMessage}
            </div>
          )}
      </div>

      {/* Position Group Audit Panel */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-emerald-400" />
            <h3 className="text-white font-semibold text-sm">Position Group Audit</h3>
            {auditLoading && <span className="text-xs text-gray-500">Loading…</span>}
          </div>

          {/* Data Lens Selector */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-gray-500 mr-1">Lens:</span>
            {([
              { key: 'this_season', label: 'This Season' },
              { key: 'last_2_seasons', label: 'Last 2 Seasons' },
              { key: 'all_data', label: 'All Data' },
            ] as const).map(lens => (
              <button
                key={lens.key}
                onClick={() => setDataLens(lens.key)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition ${
                  dataLens === lens.key
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                }`}
              >
                {lens.label}
              </button>
            ))}
          </div>
        </div>

        {auditData ? (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
              <div className="bg-gray-800/50 rounded-lg p-3">
                <p className="text-xs text-gray-500">Total Players</p>
                <p className="text-white font-bold text-lg">{auditData.totalPlayers}</p>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-3">
                <p className="text-xs text-gray-500">Mapped</p>
                <p className="text-emerald-400 font-bold text-lg">{auditData.mapped}</p>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-3">
                <p className="text-xs text-gray-500">UNKNOWN</p>
                <p className="text-amber-400 font-bold text-lg">{auditData.unknown}</p>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-3">
                <p className="text-xs text-gray-500">Low Confidence</p>
                <p className="text-amber-400 font-bold text-lg">{auditData.lowConfidence}</p>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-3">
                <p className="text-xs text-gray-500">Manual Override</p>
                <p className="text-emerald-400 font-bold text-lg">{auditData.manual}</p>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-3">
                <p className="text-xs text-gray-500">Auto Profile</p>
                <p className="text-emerald-400 font-bold text-lg">{auditData.autoProfile}</p>
              </div>
              <div className="bg-gray-800/50 rounded-lg p-3">
                <p className="text-xs text-gray-500">Missing Stats</p>
                <p className="text-red-400 font-bold text-lg">{auditData.missingStats}</p>
              </div>
            </div>

            {/* Mapping Percentage */}
            <div className="flex items-center gap-3 text-sm">
              <span className="text-gray-500">Mapping coverage:</span>
              <span className={`font-bold ${auditData.totalPlayers > 0 && auditData.mapped / auditData.totalPlayers >= 0.9 ? 'text-emerald-400' : 'text-amber-400'}`}>
                {auditData.totalPlayers > 0 ? ((auditData.mapped / auditData.totalPlayers) * 100).toFixed(1) : '0'}%
              </span>
              <span className="text-gray-600 text-xs">
                ({auditData.mapped} mapped / {auditData.totalPlayers} total)
              </span>
            </div>

            {/* Unresolved Players List */}
            {auditData.unresolvedPlayers && auditData.unresolvedPlayers.length > 0 && (
              <div>
                <p className="text-xs text-red-400 font-medium mb-1">Unresolved Position Players ({auditData.unresolvedPlayers.length})</p>
                <div className="max-h-32 overflow-y-auto bg-gray-800/50 rounded border border-gray-700/50">
                  {auditData.unresolvedPlayers.map((name, i) => (
                    <div key={i} className="px-2 py-1 text-xs text-gray-400 border-b border-gray-800/30">{name}</div>
                  ))}
                </div>
              </div>
            )}

            {/* Audit Warnings */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-xs text-gray-400 bg-gray-800/30 border border-gray-700/50 rounded-lg px-3 py-2">
                <AlertCircle className="w-3.5 h-3.5 shrink-0 text-gray-500" />
                Different from external tools because classification/data/formula may differ
              </div>
              {(thisRoundBoosts.some(e => e.games < 5) || thisRoundSuppressions.some(e => e.games < 5)) && (
                <div className="flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  Low sample — at least one edge has fewer than 5 games
                </div>
              )}
              {auditData.unknown > 0 && (
                <div className="flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  UNKNOWN players excluded
                </div>
              )}
              {auditData.unknown > 0 && (
                <div className="flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  Manual overrides needed — {auditData.unknown} player{auditData.unknown === 1 ? '' : 's'} unmapped
                </div>
              )}
            </div>
          </>
        ) : (
          !auditLoading && (
            <p className="text-xs text-gray-500">No audit data available for the current round.</p>
          )
        )}
      </div>

      {/* Current-Round Position Edge Coverage */}
      {roundMatches.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-emerald-400" />
            <h3 className="text-white font-semibold text-sm">Current-Round Position Edge Coverage</h3>
          </div>
          <div className="space-y-2">
            {roundMatches.map(m => {
              const matchTeams = new Set<string>();
              if (m.home_team) matchTeams.add(normalizeTeamName(m.home_team));
              if (m.away_team) matchTeams.add(normalizeTeamName(m.away_team));

              const matchBoosts = thisRoundBoosts.filter(e => matchTeams.has(normalizeTeamName(e.opponent_team)));
              const matchSuppressions = thisRoundSuppressions.filter(e => matchTeams.has(normalizeTeamName(e.opponent_team)));

              const strongestBoost = matchBoosts.length > 0
                ? matchBoosts.reduce((max, e) => (e.edge_value > max.edge_value ? e : max), matchBoosts[0])
                : null;
              const strongestSuppression = matchSuppressions.length > 0
                ? matchSuppressions.reduce((min, e) => (e.edge_value < min.edge_value ? e : min), matchSuppressions[0])
                : null;

              const coverage = auditData?.perMatch[m.id];
              const unknownCount = coverage?.unknown ?? 0;
              const mappedCount = coverage?.mapped ?? 0;
              const tooManyUnknown = unknownCount > 0 && (unknownCount / Math.max(unknownCount + mappedCount, 1)) > 0.4;

              return (
                <div key={m.id} className="bg-gray-800/40 border border-gray-700/50 rounded-lg p-3 space-y-2">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <span className="text-white text-sm font-medium">
                      {m.home_team ?? '?'} <span className="text-gray-500">vs</span> {m.away_team ?? '?'}
                    </span>
                    <div className="flex items-center gap-3 text-xs">
                      <span className="text-emerald-400">Mapped: {mappedCount}</span>
                      <span className="text-amber-400">UNKNOWN: {unknownCount}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-gray-400 flex-wrap">
                    {strongestBoost ? (
                      <span>
                        <span className="text-emerald-400">Strongest boost:</span>{' '}
                        {strongestBoost.position_group} +{strongestBoost.edge_value.toFixed(1)} ({strongestBoost.stat_type}, {strongestBoost.games}g)
                      </span>
                    ) : (
                      <span className="text-gray-600">No boost</span>
                    )}
                    {strongestSuppression ? (
                      <span>
                        <span className="text-red-400">Strongest suppression:</span>{' '}
                        {strongestSuppression.position_group} {strongestSuppression.edge_value.toFixed(1)} ({strongestSuppression.stat_type}, {strongestSuppression.games}g)
                      </span>
                    ) : (
                      <span className="text-gray-600">No suppression</span>
                    )}
                  </div>
                  {tooManyUnknown && (
                    <div className="flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                      Position Edge unreliable for this match due to missing player roles.
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Stat Selector */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-center gap-3 flex-wrap">
        <Filter className="w-4 h-4 text-gray-500" />
        <span className="text-xs text-gray-500">Stat:</span>
        <div className="flex gap-1.5">
          {BETTING_RELEVANT_STATS.map(stat => (
            <button
              key={stat}
              onClick={() => setSelectedStat(stat)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                selectedStat === stat
                  ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
              }`}
            >
              {stat.charAt(0).toUpperCase() + stat.slice(1)}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 ml-auto text-xs text-gray-400">
          <input
            type="checkbox"
            checked={showSignificantOnly}
            onChange={e => setShowSignificantOnly(e.target.checked)}
            className="accent-emerald-500"
          />
          Show significant only
        </label>
      </div>

      {/* This Round's Strongest Matchups */}
      {(thisRoundBoosts.length > 0 || thisRoundSuppressions.length > 0) && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-amber-400" />
            <h3 className="text-amber-400 font-semibold text-sm">This Round's Strongest Matchups</h3>
          </div>

          {/* Boosts */}
          <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl overflow-hidden">
            <button
              onClick={() => setExpandedBoost(!expandedBoost)}
              className="w-full px-4 py-3 flex items-center gap-2 hover:bg-emerald-500/5 transition"
            >
              <TrendingUp className="w-4 h-4 text-emerald-400" />
              <span className="text-emerald-400 font-semibold text-sm">Boosts</span>
              <span className="text-xs text-gray-500">({thisRoundBoosts.length})</span>
              <ChevronDown className={`w-4 h-4 text-gray-500 ml-auto transition ${expandedBoost ? 'rotate-180' : ''}`} />
            </button>
            {expandedBoost && (
              <div className="p-3 space-y-2 border-t border-emerald-500/20">
                {thisRoundBoosts.slice(0, 10).map((edge, i) => (
                  <div key={i} className="flex items-center gap-3 bg-gray-900/50 rounded-lg p-2 text-xs">
                    <span className="text-white font-medium w-20">{edge.position_group}</span>
                    <span className="text-gray-500">vs</span>
                    <span className="text-gray-300 w-12">{edge.opponent_team}</span>
                    <span className="text-gray-600">·</span>
                    <span className="text-gray-400 w-20">{edge.stat_type}</span>
                    <span className="text-emerald-400 font-bold">+{edge.edge_value.toFixed(1)}</span>
                    <span className="text-gray-500">({edge.games}g, {edge.consistency.toFixed(0)}%)</span>
                    {edge.significance === 'very_significant' && (
                      <span className="px-1.5 py-0.5 bg-emerald-500/20 text-emerald-400 rounded text-[10px] font-bold">VERY SIG</span>
                    )}
                    {edge.significance === 'significant' && (
                      <span className="px-1.5 py-0.5 bg-emerald-500/10 text-emerald-400 rounded text-[10px]">SIG</span>
                    )}
                  </div>
                ))}
                {thisRoundBoosts.length === 0 && (
                  <p className="text-xs text-gray-500 text-center py-2">No significant boosts this round</p>
                )}
              </div>
            )}
          </div>

          {/* Suppressions */}
          <div className="bg-red-500/10 border border-red-500/30 rounded-xl overflow-hidden">
            <button
              onClick={() => setExpandedSuppress(!expandedSuppress)}
              className="w-full px-4 py-3 flex items-center gap-2 hover:bg-red-500/5 transition"
            >
              <TrendingDown className="w-4 h-4 text-red-400" />
              <span className="text-red-400 font-semibold text-sm">Suppressions</span>
              <span className="text-xs text-gray-500">({thisRoundSuppressions.length})</span>
              <ChevronDown className={`w-4 h-4 text-gray-500 ml-auto transition ${expandedSuppress ? 'rotate-180' : ''}`} />
            </button>
            {expandedSuppress && (
              <div className="p-3 space-y-2 border-t border-red-500/20">
                {thisRoundSuppressions.slice(0, 10).map((edge, i) => (
                  <div key={i} className="flex items-center gap-3 bg-gray-900/50 rounded-lg p-2 text-xs">
                    <span className="text-white font-medium w-20">{edge.position_group}</span>
                    <span className="text-gray-500">vs</span>
                    <span className="text-gray-300 w-12">{edge.opponent_team}</span>
                    <span className="text-gray-600">·</span>
                    <span className="text-gray-400 w-20">{edge.stat_type}</span>
                    <span className="text-red-400 font-bold">{edge.edge_value.toFixed(1)}</span>
                    <span className="text-gray-500">({edge.games}g, {edge.consistency.toFixed(0)}%)</span>
                    {edge.significance === 'very_significant' && (
                      <span className="px-1.5 py-0.5 bg-red-500/20 text-red-400 rounded text-[10px] font-bold">VERY SIG</span>
                    )}
                    {edge.significance === 'significant' && (
                      <span className="px-1.5 py-0.5 bg-red-500/10 text-red-400 rounded text-[10px]">SIG</span>
                    )}
                  </div>
                ))}
                {thisRoundSuppressions.length === 0 && (
                  <p className="text-xs text-gray-500 text-center py-2">No significant suppressions this round</p>
                )}
              </div>
            )}
          </div>
        </div>
      )}

        {/* Matrix Debug */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <Info className="w-4 h-4 text-blue-400" />
            <h3 className="text-blue-400 font-semibold text-sm">Matrix Debug</h3>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div>
              <p className="text-gray-500">Selected Stat</p>
              <p className="text-white font-bold">{selectedStat}</p>
            </div>
            <div>
              <p className="text-gray-500">Edges for Stat</p>
              <p className="text-white font-bold">{Object.values(cache).filter(e => e.stat_type === selectedStat).length}</p>
            </div>
            <div>
              <p className="text-gray-500">Matrix Cells Matched</p>
              <p className="text-emerald-400 font-bold">{matrix.flat().filter(e => e !== null).length}</p>
            </div>
            <div>
              <p className="text-gray-500">Significant Cells</p>
              <p className="text-amber-400 font-bold">{matrix.flat().filter(e => e && e.significance !== 'none').length}</p>
            </div>
          </div>
          {matrix.flat().filter(e => e !== null).length === 0 && Object.keys(cache).length > 0 && (
            <div className="mt-3 flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              Cache has {Object.keys(cache).length} edges but 0 matched the matrix. Check team name normalization.
            </div>
          )}
        </div>

      {/* Matrix View */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-2">
          <Info className="w-4 h-4 text-blue-400" />
          <h3 className="text-blue-400 font-semibold text-sm">{selectedStat.charAt(0).toUpperCase() + selectedStat.slice(1)} Edge Matrix</h3>
          <span className="text-xs text-gray-500">Rows: Position Groups, Columns: AFL Teams</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-gray-800">
              <tr>
                <th className="sticky left-0 bg-gray-800 text-left px-3 py-2 font-medium text-gray-500 uppercase tracking-wider">Position</th>
                {AFL_TEAMS.map(team => (
                  <th key={team} className="text-center px-2 py-2 font-medium text-gray-500">{team}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {POSITION_GROUPS.map((pg, rowIdx) => (
                <tr key={pg} className="border-t border-gray-800/50">
                  <td className="sticky left-0 bg-gray-900 px-3 py-2 text-white font-medium">{pg}</td>
                  {AFL_TEAMS.map((team, colIdx) => {
                    const edge = matrix[rowIdx]?.[colIdx] ?? null;
                    const showCell = !showSignificantOnly || (edge && edge.significance !== 'none');
                    if (!showCell) {
                      return (
                        <td key={team} className="text-center px-2 py-1.5 bg-gray-800/20">
                          <span className="text-gray-700">—</span>
                        </td>
                      );
                    }
                    return (
                      <td
                        key={team}
                        className={`text-center px-2 py-1.5 ${getCellColor(edge)} transition hover:brightness-110`}
                        title={edge ? `${pg} vs ${team}: ${formatPositionEdgeLabel(edge)} (${edge.games}g)` : ''}
                      >
                        <div className="flex flex-col items-center gap-0.5">
                          <span className={`font-mono font-bold ${edge && edge.edge_value >= 0 ? 'text-emerald-400' : edge ? 'text-red-400' : 'text-gray-600'}`}>
                            {formatCellLabel(edge)}
                          </span>
                          {edge && edge.games >= 8 && edge.significance !== 'none' && (
                            <span className={`text-[9px] ${edge.edge_value > 0 ? 'text-emerald-500/70' : 'text-red-500/70'}`}>
                              {edge.significance === 'very_significant' ? 'VS' : 'S'}
                            </span>
                          )}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-2 border-t border-gray-800/50 text-xs text-gray-600 flex items-center gap-4">
          <span>+ = Boost (favorable matchup)</span>
          <span>− = Suppress (unfavorable matchup)</span>
          <span>VS = Very Significant</span>
          <span>S = Significant</span>
        </div>
      </div>

      {/* All Boosts List */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-emerald-400" />
            <h3 className="text-emerald-400 font-semibold text-sm">All Boosts</h3>
            <span className="text-xs text-gray-500">({boosts.length})</span>
          </div>
          <div className="max-h-80 overflow-y-auto">
            {boosts.slice(0, 20).map((edge, i) => (
              <div key={i} className="flex items-center gap-2 px-4 py-2 border-b border-gray-800/30 text-xs hover:bg-gray-800/30">
                <span className="text-white font-medium">{edge.position_group}</span>
                <span className="text-gray-500">vs</span>
                <span className="text-gray-300">{edge.opponent_team}</span>
                <span className="text-gray-600">·</span>
                <span className="text-gray-400">{edge.stat_type}</span>
                <span className="text-emerald-400 font-bold ml-auto">+{edge.edge_value.toFixed(1)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-2">
            <TrendingDown className="w-4 h-4 text-red-400" />
            <h3 className="text-red-400 font-semibold text-sm">All Suppressions</h3>
            <span className="text-xs text-gray-500">({suppressions.length})</span>
          </div>
          <div className="max-h-80 overflow-y-auto">
            {suppressions.slice(0, 20).map((edge, i) => (
              <div key={i} className="flex items-center gap-2 px-4 py-2 border-b border-gray-800/30 text-xs hover:bg-gray-800/30">
                <span className="text-white font-medium">{edge.position_group}</span>
                <span className="text-gray-500">vs</span>
                <span className="text-gray-300">{edge.opponent_team}</span>
                <span className="text-gray-600">·</span>
                <span className="text-gray-400">{edge.stat_type}</span>
                <span className="text-red-400 font-bold ml-auto">{edge.edge_value.toFixed(1)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
