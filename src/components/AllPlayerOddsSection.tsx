import { useState, useMemo, useCallback } from 'react';
import { Search, Users, AlertTriangle, CheckCircle, XCircle, Info, ChevronLeft, ChevronRight, ChevronDown, ChevronUp } from 'lucide-react';
import type { Match } from '../lib/types';

export interface AllPlayerOddsRow {
  id: string;
  matchId: string;
  matchName: string;
  playerName: string;
  team: string;
  statType: string;
  market: string;
  line: number;
  displayLabel: string | null;
  overOdds: number;
  underOdds: number | null;
  modelStatus: AllPlayerOddsStatus;
  statusReason: string;
  totalStatsRows: number;
  marketSample: number;
  hitCount: number;
  hitRate: number;
  adjustedProb: number | null;
  adjustedEV: number | null;
  finalProbability: number | null;
  finalEV: number | null;
  risk: 'Low' | 'Medium' | 'High';
  multiReady: boolean;
  // Repair status fields
  repairStatus?: string;
  repairReason?: string;
}

export type AllPlayerOddsStatus =
  | 'MULTI READY'
  | 'MODEL READY BUT FILTERED OUT'
  | 'NO MODEL — NO PLAYER STATS'
  | 'NO MODEL — INSUFFICIENT MARKET SAMPLE'
  | 'FILTERED OUT — WRONG MARKET'
  | 'FILTERED OUT — LOW SAMPLE'
  | 'FILTERED OUT — LOW HITS'
  | 'FILTERED OUT — LOW EV'
  | 'FILTERED OUT — ODDS TOO HIGH'
  | 'FILTERED OUT — RISK TOO HIGH'
  | 'EXCLUDED BY USER'
  | 'EXCLUDED BY TAG RISK';

const STATUS_COLORS: Record<string, string> = {
  'MULTI READY': 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  'MODEL READY BUT FILTERED OUT': 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  'NO MODEL — NO PLAYER STATS': 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  'NO MODEL — INSUFFICIENT MARKET SAMPLE': 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  'FILTERED OUT — WRONG MARKET': 'bg-gray-600/30 text-gray-400 border-gray-600/40',
  'FILTERED OUT — LOW SAMPLE': 'bg-red-500/15 text-red-400 border-red-500/25',
  'FILTERED OUT — LOW HITS': 'bg-red-500/15 text-red-400 border-red-500/25',
  'FILTERED OUT — LOW EV': 'bg-red-500/15 text-red-400 border-red-500/25',
  'FILTERED OUT — ODDS TOO HIGH': 'bg-red-500/15 text-red-400 border-red-500/25',
  'FILTERED OUT — RISK TOO HIGH': 'bg-red-500/15 text-red-400 border-red-500/25',
  'EXCLUDED BY USER': 'bg-red-500/20 text-red-400 border-red-500/30',
  'EXCLUDED BY TAG RISK': 'bg-red-500/20 text-red-400 border-red-500/30',
};

const STATUS_ICONS: Record<string, typeof CheckCircle> = {
  'MULTI READY': CheckCircle,
  'MODEL READY BUT FILTERED OUT': Info,
  'NO MODEL — NO PLAYER STATS': AlertTriangle,
  'NO MODEL — INSUFFICIENT MARKET SAMPLE': AlertTriangle,
  'FILTERED OUT — WRONG MARKET': XCircle,
  'FILTERED OUT — LOW SAMPLE': XCircle,
  'FILTERED OUT — LOW HITS': XCircle,
  'FILTERED OUT — LOW EV': XCircle,
  'FILTERED OUT — ODDS TOO HIGH': XCircle,
  'FILTERED OUT — RISK TOO HIGH': XCircle,
  'EXCLUDED BY USER': XCircle,
  'EXCLUDED BY TAG RISK': XCircle,
};

// ── Null-safe field accessors ──
function safeStr(val: unknown, fallback: string): string {
  if (val === null || val === undefined) return fallback;
  const s = String(val);
  return s.trim() || fallback;
}

function safeNum(val: unknown, fallback: number | null): number | null {
  if (val === null || val === undefined) return fallback;
  const n = Number(val);
  return isNaN(n) ? fallback : n;
}

function safePct(val: unknown): string {
  const n = safeNum(val, null);
  if (n === null) return '—';
  return (n * 100).toFixed(1) + '%';
}

function safePctSigned(val: unknown): string {
  const n = safeNum(val, null);
  if (n === null) return '—';
  const pct = (n * 100).toFixed(1);
  return (n > 0 ? '+' : '') + pct + '%';
}

function safeFixed(val: unknown, digits: number): string {
  const n = safeNum(val, null);
  if (n === null) return '—';
  return n.toFixed(digits);
}

interface Props {
  rows: AllPlayerOddsRow[];
  matches: Match[];
  selectedMatchIds: string[];
  defaultMarkets: Record<string, boolean>;
  applyMarketFilter: boolean;
}

const PAGE_SIZE_OPTIONS = [50, 100, 250] as const;

export default function AllPlayerOddsSection({ rows, matches, selectedMatchIds }: Props) {
  const [search, setSearch] = useState('');
  const [matchFilter, setMatchFilter] = useState('all');
  const [teamFilter, setTeamFilter] = useState('all');
  const [marketFilter, setMarketFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [showModelReadyOnly, setShowModelReadyOnly] = useState(false);
  const [showNoModelOnly, setShowNoModelOnly] = useState(false);
  const [showFilteredOutOnly, setShowFilteredOutOnly] = useState(false);
  const [collapsedMatches, setCollapsedMatches] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(100);

  const allTeams = useMemo(() => {
    const teams = new Set<string>();
    for (const r of rows) {
      const t = safeStr(r.team, '');
      if (t) teams.add(t);
    }
    return [...teams].sort();
  }, [rows]);

  const allStatTypes = useMemo(() => {
    const stats = new Set<string>();
    for (const r of rows) {
      const s = safeStr(r.statType, '');
      if (s) stats.add(s);
    }
    return [...stats].sort();
  }, [rows]);

  const allStatuses = useMemo(() => {
    const stats = new Set<string>();
    for (const r of rows) {
      const s = safeStr(r.modelStatus, 'UNKNOWN');
      stats.add(s);
    }
    return [...stats].sort();
  }, [rows]);

  const selectedMatches = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of matches) {
      if (selectedMatchIds.includes(m.id)) {
        const home = safeStr(m.home_team, '');
        const away = safeStr(m.away_team, '');
        map.set(m.id, `${home} vs ${away}`.trim() || m.id);
      }
    }
    return map;
  }, [matches, selectedMatchIds]);

  const filteredRows = useMemo(() => {
    const searchLower = search.trim().toLowerCase();
    return rows.filter(r => {
      const playerName = safeStr(r.playerName, '');
      if (searchLower && !playerName.toLowerCase().includes(searchLower)) return false;
      if (matchFilter !== 'all' && r.matchId !== matchFilter) return false;
      const team = safeStr(r.team, '');
      if (teamFilter !== 'all' && team !== teamFilter) return false;
      const statType = safeStr(r.statType, '');
      if (marketFilter !== 'all' && statType !== marketFilter) return false;
      const status = safeStr(r.modelStatus, 'UNKNOWN');
      if (statusFilter !== 'all' && status !== statusFilter) return false;
      if (showModelReadyOnly && !status.includes('READY') && status !== 'MODEL READY BUT FILTERED OUT') return false;
      if (showNoModelOnly && !status.includes('NO MODEL')) return false;
      if (showFilteredOutOnly && !status.includes('FILTERED OUT') && status !== 'MODEL READY BUT FILTERED OUT') return false;
      return true;
    });
  }, [rows, search, matchFilter, teamFilter, marketFilter, statusFilter, showModelReadyOnly, showNoModelOnly, showFilteredOutOnly]);

  // Build match groups
  const matchGroups = useMemo(() => {
    const byMatch = new Map<string, AllPlayerOddsRow[]>();
    for (const r of filteredRows) {
      if (!byMatch.has(r.matchId)) byMatch.set(r.matchId, []);
      byMatch.get(r.matchId)!.push(r);
    }
    const groups: Array<{
      matchId: string;
      matchName: string;
      totalOddsRows: number;
      modelReadyRows: number;
      multiReadyRows: number;
      noModelRows: number;
      filteredOutRows: number;
      rows: AllPlayerOddsRow[];
    }> = [];
    for (const [matchId, matchRows] of byMatch) {
      groups.push({
        matchId,
        matchName: matchRows[0]?.matchName || selectedMatches.get(matchId) || matchId,
        totalOddsRows: matchRows.length,
        modelReadyRows: matchRows.filter(r => safeStr(r.modelStatus, '').includes('READY') && r.modelStatus !== 'MULTI READY').length,
        multiReadyRows: matchRows.filter(r => r.modelStatus === 'MULTI READY').length,
        noModelRows: matchRows.filter(r => safeStr(r.modelStatus, '').includes('NO MODEL')).length,
        filteredOutRows: matchRows.filter(r => safeStr(r.modelStatus, '').includes('FILTERED OUT')).length,
        rows: matchRows.sort((a, b) => {
          if (a.multiReady !== b.multiReady) return a.multiReady ? -1 : 1;
          const probA = safeNum(a.adjustedProb, null);
          const probB = safeNum(b.adjustedProb, null);
          if (probA !== null && probB !== null) return probB - probA;
          if (probA !== null) return -1;
          if (probB !== null) return 1;
          return safeStr(a.playerName, '').localeCompare(safeStr(b.playerName, ''));
        }),
      });
    }
    return groups.sort((a, b) => safeStr(a.matchName, '').localeCompare(safeStr(b.matchName, '')));
  }, [filteredRows, selectedMatches]);

  // Flatten all filtered rows for flat pagination mode
  const flatSortedRows = useMemo(() => {
    return [...filteredRows].sort((a, b) => {
      const matchA = safeStr(a.matchName, '');
      const matchB = safeStr(b.matchName, '');
      if (matchA !== matchB) return matchA.localeCompare(matchB);
      if (a.multiReady !== b.multiReady) return a.multiReady ? -1 : 1;
      return safeStr(a.playerName, '').localeCompare(safeStr(b.playerName, ''));
    });
  }, [filteredRows]);

  const totalPages = Math.max(1, Math.ceil(flatSortedRows.length / pageSize));
  const currentPage = Math.min(page, totalPages - 1);
  const pagedRows = flatSortedRows.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

  const totals = useMemo(() => ({
    total: filteredRows.length,
    modelReady: filteredRows.filter(r => {
      const s = safeStr(r.modelStatus, '');
      return s.includes('READY') && r.modelStatus !== 'MULTI READY';
    }).length,
    multiReady: filteredRows.filter(r => r.modelStatus === 'MULTI READY').length,
    noModel: filteredRows.filter(r => safeStr(r.modelStatus, '').includes('NO MODEL')).length,
    filteredOut: filteredRows.filter(r => safeStr(r.modelStatus, '').includes('FILTERED OUT')).length,
    excluded: filteredRows.filter(r => safeStr(r.modelStatus, '').includes('EXCLUDED')).length,
  }), [filteredRows]);

  const toggleMatch = useCallback((matchId: string) => {
    setCollapsedMatches(prev => {
      const next = new Set(prev);
      if (next.has(matchId)) next.delete(matchId);
      else next.add(matchId);
      return next;
    });
  }, []);

  const goPrevPage = useCallback(() => setPage(p => Math.max(0, p - 1)), []);
  const goNextPage = useCallback(() => setPage(p => Math.min(totalPages - 1, p + 1)), [totalPages]);

  function renderStatusBadge(status: string) {
    const icon = STATUS_ICONS[status] || AlertTriangle;
    const color = STATUS_COLORS[status] || 'bg-gray-700/30 text-gray-400 border-gray-700/40';
    const Icon = icon;
    return (
      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium whitespace-nowrap ${color}`}>
        <Icon className="w-2.5 h-2.5 shrink-0" />
        {status || 'UNKNOWN'}
      </span>
    );
  }

  function renderRow(r: AllPlayerOddsRow) {
    const playerName = safeStr(r.playerName, 'Unknown Player');
    const team = safeStr(r.team, 'Unknown Team');
    const statType = safeStr(r.statType, 'Unknown Market');
    const line = safeNum(r.line, null);
    const overOdds = safeNum(r.overOdds, null);
    const risk = safeStr(r.risk, 'High');
    const status = safeStr(r.modelStatus, 'UNKNOWN');
    const reason = safeStr(r.statusReason, '—');
    const repairStatus = safeStr(r.repairStatus, '');
    const repairReason = safeStr(r.repairReason, '');

    return (
      <tr key={r.id} className="border-b border-gray-800/30 hover:bg-gray-800/20 transition">
        <td className="px-2 py-1.5 text-white font-medium whitespace-nowrap">{playerName}</td>
        <td className="px-2 py-1.5 text-gray-400 whitespace-nowrap">{team}</td>
        <td className="px-2 py-1.5 text-gray-400 whitespace-nowrap">{statType}</td>
        <td className="px-2 py-1.5 text-right text-gray-300 font-mono">{line !== null ? line : '—'}</td>
        <td className="px-2 py-1.5 text-right text-white font-mono">{safeFixed(overOdds, 2)}</td>
        <td className="px-2 py-1.5">{renderStatusBadge(status)}</td>
        <td className="px-2 py-1.5 text-right text-gray-400 font-mono">{safeNum(r.totalStatsRows, 0) ?? 0}</td>
        <td className="px-2 py-1.5 text-right text-gray-400 font-mono">{safeNum(r.marketSample, 0) ?? 0}</td>
        <td className="px-2 py-1.5 text-right font-mono">
          {r.adjustedProb !== null && r.adjustedProb !== undefined ? (
            <span className="text-blue-400">{safePct(r.adjustedProb)}</span>
          ) : <span className="text-gray-600">—</span>}
        </td>
        <td className="px-2 py-1.5 text-right font-mono">
          {r.adjustedEV !== null && r.adjustedEV !== undefined ? (
            <span className={safeNum(r.adjustedEV, 0)! > 0 ? 'text-emerald-400' : 'text-red-400'}>
              {safePctSigned(r.adjustedEV)}
            </span>
          ) : <span className="text-gray-600">—</span>}
        </td>
        <td className="px-2 py-1.5 text-center">
          <span className={`px-1 py-0.5 rounded text-[10px] font-medium ${
            risk === 'Low' ? 'bg-emerald-500/20 text-emerald-400' :
            risk === 'Medium' ? 'bg-amber-500/20 text-amber-400' :
            'bg-red-500/20 text-red-400'
          }`}>{risk}</span>
        </td>
        <td className="px-2 py-1.5 text-gray-500 text-[10px] max-w-[200px] truncate" title={reason}>
          {reason}
        </td>
        {repairStatus && (
          <td className="px-2 py-1.5">
            <span className="text-[10px] px-1 py-0.5 rounded bg-blue-500/15 text-blue-400 whitespace-nowrap">{repairStatus}</span>
            {repairReason && <p className="text-[9px] text-gray-600 mt-0.5 truncate">{repairReason}</p>}
          </td>
        )}
      </tr>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-6 gap-2">
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-2.5 text-center">
          <p className="text-xl font-bold text-white">{totals.total}</p>
          <p className="text-[10px] text-gray-500">Total Rows</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-2.5 text-center">
          <p className="text-xl font-bold text-blue-400">{totals.modelReady}</p>
          <p className="text-[10px] text-gray-500">Model Ready</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-2.5 text-center">
          <p className="text-xl font-bold text-emerald-400">{totals.multiReady}</p>
          <p className="text-[10px] text-gray-500">Multi Ready</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-2.5 text-center">
          <p className="text-xl font-bold text-amber-400">{totals.noModel}</p>
          <p className="text-[10px] text-gray-500">No Model</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-2.5 text-center">
          <p className="text-xl font-bold text-red-400">{totals.filteredOut}</p>
          <p className="text-[10px] text-gray-500">Filtered Out</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-2.5 text-center">
          <p className="text-xl font-bold text-red-300">{totals.excluded}</p>
          <p className="text-[10px] text-gray-500">Excluded</p>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[180px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
            <input
              type="text"
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(0); }}
              placeholder="Search player..."
              className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-8 pr-3 py-1.5 text-white text-xs"
            />
          </div>
          <select value={matchFilter} onChange={e => { setMatchFilter(e.target.value); setPage(0); }} className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs">
            <option value="all">All Matches</option>
            {[...selectedMatches.entries()].map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>
          <select value={teamFilter} onChange={e => { setTeamFilter(e.target.value); setPage(0); }} className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs">
            <option value="all">All Teams</option>
            {allTeams.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <select value={marketFilter} onChange={e => { setMarketFilter(e.target.value); setPage(0); }} className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs">
            <option value="all">All Markets</option>
            {allStatTypes.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(0); }} className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs">
            <option value="all">All Statuses</option>
            {allStatuses.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-[11px] text-gray-300 cursor-pointer">
            <input type="checkbox" checked={showModelReadyOnly} onChange={e => { setShowModelReadyOnly(e.target.checked); setPage(0); }} className="accent-blue-500" />
            Model-ready only
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-gray-300 cursor-pointer">
            <input type="checkbox" checked={showNoModelOnly} onChange={e => { setShowNoModelOnly(e.target.checked); setPage(0); }} className="accent-amber-500" />
            No-model only
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-gray-300 cursor-pointer">
            <input type="checkbox" checked={showFilteredOutOnly} onChange={e => { setShowFilteredOutOnly(e.target.checked); setPage(0); }} className="accent-red-500" />
            Filtered-out only
          </label>
          <span className="text-[10px] text-gray-600 ml-auto">{filteredRows.length} of {rows.length} rows shown</span>
        </div>
      </div>

      {/* Paginated table — flat mode (all rows in one table with pagination) */}
      {filteredRows.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 text-center text-gray-500 text-sm">
          {rows.length === 0 ? 'No odds rows loaded. Select matches to load odds.' : 'No rows match the current filters.'}
        </div>
      ) : (
        <>
          {/* Match group summary (collapsible, no heavy tables) */}
          <div className="space-y-2">
            {matchGroups.map(group => {
              const collapsed = collapsedMatches.has(group.matchId);
              return (
                <div key={group.matchId} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                  <button
                    onClick={() => toggleMatch(group.matchId)}
                    className="w-full px-4 py-3 bg-gray-800/40 hover:bg-gray-800/60 transition flex items-center justify-between text-left"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {collapsed ? <ChevronRight className="w-4 h-4 text-gray-500 shrink-0" /> : <ChevronDown className="w-4 h-4 text-gray-500 shrink-0" />}
                      <Users className="w-4 h-4 text-emerald-400 shrink-0" />
                      <span className="text-white font-semibold text-sm truncate">{group.matchName}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[10px] px-1.5 py-0.5 bg-gray-700/60 text-gray-400 rounded">{group.totalOddsRows} rows</span>
                      <span className="text-[10px] px-1.5 py-0.5 bg-blue-500/15 text-blue-400 rounded">{group.modelReadyRows} model</span>
                      <span className="text-[10px] px-1.5 py-0.5 bg-emerald-500/15 text-emerald-400 rounded">{group.multiReadyRows} multi</span>
                      <span className="text-[10px] px-1.5 py-0.5 bg-amber-500/15 text-amber-400 rounded">{group.noModelRows} no-model</span>
                      <span className="text-[10px] px-1.5 py-0.5 bg-red-500/15 text-red-400 rounded">{group.filteredOutRows} filtered</span>
                    </div>
                  </button>
                  {!collapsed && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead className="bg-gray-800/30 border-b border-gray-800">
                          <tr>
                            <th className="px-2 py-2 text-left text-gray-500 font-medium">Player</th>
                            <th className="px-2 py-2 text-left text-gray-500 font-medium">Team</th>
                            <th className="px-2 py-2 text-left text-gray-500 font-medium">Market</th>
                            <th className="px-2 py-2 text-right text-gray-500 font-medium">Line</th>
                            <th className="px-2 py-2 text-right text-gray-500 font-medium">Odds</th>
                            <th className="px-2 py-2 text-left text-gray-500 font-medium">Status</th>
                            <th className="px-2 py-2 text-right text-gray-500 font-medium">Stats</th>
                            <th className="px-2 py-2 text-right text-gray-500 font-medium">Sample</th>
                            <th className="px-2 py-2 text-right text-gray-500 font-medium">Adj Prob</th>
                            <th className="px-2 py-2 text-right text-gray-500 font-medium">EV</th>
                            <th className="px-2 py-2 text-center text-gray-500 font-medium">Risk</th>
                            <th className="px-2 py-2 text-left text-gray-500 font-medium">Reason</th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.rows.map(r => {
                            try {
                              return renderRow(r);
                            } catch {
                              return (
                                <tr key={r.id || Math.random()} className="border-b border-gray-800/30">
                                  <td colSpan={12} className="px-2 py-1.5 text-red-400 text-[10px]">Error rendering row</td>
                                </tr>
                              );
                            }
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Pagination controls */}
          <div className="flex flex-wrap items-center justify-between gap-3 bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
            <div className="flex items-center gap-2">
              <button
                onClick={goPrevPage}
                disabled={currentPage === 0}
                className="flex items-center gap-1 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed text-gray-300 rounded-lg text-xs transition"
              >
                <ChevronLeft className="w-3.5 h-3.5" /> Prev
              </button>
              <span className="text-xs text-gray-400">
                Page {currentPage + 1} of {totalPages}
              </span>
              <button
                onClick={goNextPage}
                disabled={currentPage >= totalPages - 1}
                className="flex items-center gap-1 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed text-gray-300 rounded-lg text-xs transition"
              >
                Next <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-gray-500">Rows per page:</span>
              <select
                value={pageSize}
                onChange={e => { setPageSize(Number(e.target.value)); setPage(0); }}
                className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-white text-xs"
              >
                {PAGE_SIZE_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
              <span className="text-[11px] text-gray-500">
                Showing {currentPage * pageSize + 1}-{Math.min((currentPage + 1) * pageSize, flatSortedRows.length)} of {flatSortedRows.length}
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
