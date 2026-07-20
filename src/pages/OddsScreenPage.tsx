import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { TrendingUp, Search, Bug, ChevronDown, ChevronUp, RefreshCw, Calendar, AlertTriangle, Target } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { getAltLadderOddsForMatch, getOULinesForMatch, type NormalizedOddsRow } from '../lib/oddsNormalizer';
import type { Match } from '../lib/types';
import LoadingSpinner from '../components/LoadingSpinner';
import EmptyState from '../components/EmptyState';

function formatAge(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Group rows by player_name, then sort thresholds ascending within each player
function groupByPlayer(rows: NormalizedOddsRow[]): Map<string, NormalizedOddsRow[]> {
  const map = new Map<string, NormalizedOddsRow[]>();
  for (const row of rows) {
    const key = row.player_name || 'Unknown';
    const group = map.get(key) ?? [];
    group.push(row);
    map.set(key, group);
  }
  // Sort each player's rows by: line ASC, then bookmaker
  for (const [, group] of map) {
    group.sort((a, b) => a.line - b.line || a.bookmaker.localeCompare(b.bookmaker));
  }
  return map;
}

function PlayerLadderCard({ playerName, rows }: { playerName: string; rows: NormalizedOddsRow[] }) {
  // Get unique thresholds for this player
  const thresholds = [...new Set(rows.map(r => r.line))].sort((a, b) => a - b);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="px-4 py-3 bg-gray-800/40 border-b border-gray-700/40 flex items-center justify-between">
        <p className="text-white font-semibold text-sm">{playerName}</p>
        <span className="text-xs text-gray-500">
          {thresholds.length} threshold{thresholds.length !== 1 ? 's' : ''} · {new Set(rows.map(r => r.bookmaker)).size} bookmaker{new Set(rows.map(r => r.bookmaker)).size !== 1 ? 's' : ''}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-600 uppercase tracking-wider border-b border-gray-800/50">
              <th className="text-left px-4 py-2 font-medium">Threshold</th>
              <th className="text-left px-4 py-2 font-medium">Bookmaker</th>
              <th className="text-left px-4 py-2 font-medium">Raw Market</th>
              <th className="text-center px-4 py-2 font-medium">Over</th>
              <th className="text-center px-4 py-2 font-medium">Under</th>
              <th className="text-right px-4 py-2 font-medium">Fetched</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => {
              const prevLine = idx > 0 ? rows[idx - 1].line : null;
              const isNewThreshold = row.line !== prevLine;
              return (
                <tr
                  key={row.id}
                  className={`border-b border-gray-800/20 hover:bg-gray-800/20 transition ${isNewThreshold && idx > 0 ? 'border-t border-gray-700/30' : ''}`}
                >
                  <td className="px-4 py-2 font-bold tabular-nums">
                    {isNewThreshold ? (
                      <span className="text-amber-300 text-sm">{row.display_label ?? `${row.line}+`}</span>
                    ) : (
                      <span className="text-gray-700 select-none text-sm">↳</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-gray-300 capitalize">{row.bookmaker}</td>
                  <td className="px-4 py-2 text-gray-500 font-mono max-w-[220px] truncate" title={row.raw_market}>
                    {row.raw_market}
                  </td>
                  <td className="px-4 py-2 text-center text-emerald-400 font-bold tabular-nums">{row.over_odds.toFixed(2)}</td>
                  <td className="px-4 py-2 text-center text-red-400 font-bold tabular-nums">{row.under_odds != null ? row.under_odds.toFixed(2) : '-'}</td>
                  <td className="px-4 py-2 text-right text-gray-600">{formatAge(row.fetched_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function OddsScreenPage() {
  const [matches, setMatches] = useState<Match[]>([]);
  const [selectedMatchId, setSelectedMatchId] = useState<string>('');
  const [odds, setOdds] = useState<NormalizedOddsRow[]>([]);
  const [ouRows, setOuRows] = useState<NormalizedOddsRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [matchesLoading, setMatchesLoading] = useState(true);
  const [searchFilter, setSearchFilter] = useState('');
  const [showDebug, setShowDebug] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [showRefreshConfirm, setShowRefreshConfirm] = useState(false);

  useEffect(() => {
    const today = new Date().toISOString().split('T')[0];
    supabase
      .from('matches')
      .select('*')
      .gte('match_date', today)
      .order('commence_time_utc', { ascending: true, nullsFirst: false })
      .limit(30)
      .then(({ data }) => {
        setMatches(data ?? []);
        if (data && data.length > 0) setSelectedMatchId(data[0].id);
        setMatchesLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!selectedMatchId) return;
    setLoading(true);
    Promise.all([
      getAltLadderOddsForMatch(selectedMatchId),
      getOULinesForMatch(selectedMatchId),
    ]).then(([ladderRows, ouLineRows]) => {
      setOdds(ladderRows);
      setOuRows(ouLineRows);
      setLastRefresh(new Date().toISOString());
      setLoading(false);
    });
  }, [selectedMatchId]);

  function refresh() {
    setShowRefreshConfirm(true);
  }

  function doRefresh() {
    setShowRefreshConfirm(false);
    if (!selectedMatchId) return;
    setLoading(true);
    Promise.all([
      getAltLadderOddsForMatch(selectedMatchId),
      getOULinesForMatch(selectedMatchId),
    ]).then(([ladderRows, ouLineRows]) => {
      setOdds(ladderRows);
      setOuRows(ouLineRows);
      setLastRefresh(new Date().toISOString());
      setLoading(false);
    });
  }

  const filtered = useMemo(() => {
    if (!searchFilter.trim()) return odds;
    const q = searchFilter.toLowerCase();
    return odds.filter(o =>
      o.player_name.toLowerCase().includes(q) ||
      o.raw_market.toLowerCase().includes(q) ||
      o.bookmaker.toLowerCase().includes(q) ||
      (o.display_label ?? '').toLowerCase().includes(q)
    );
  }, [odds, searchFilter]);

  // Player-grouped map, sorted by player name
  const playerGroups = useMemo(() => {
    const grouped = groupByPlayer(filtered);
    return new Map([...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }, [filtered]);

  const selectedMatch = matches.find(m => m.id === selectedMatchId);

  const debugStats = useMemo(() => {
    const uniquePlayers = new Set(odds.map(o => o.player_name));
    const playerLabels = new Map<string, Set<string>>();
    for (const r of odds) {
      const set = playerLabels.get(r.player_name) ?? new Set<string>();
      set.add(r.display_label ?? String(r.line));
      playerLabels.set(r.player_name, set);
    }
    return {
      raw_rows: odds.length,
      filtered_rows: filtered.length,
      unique_players: uniquePlayers.size,
      unique_bookmakers: new Set(odds.map(o => o.bookmaker)).size,
      bookmakers: [...new Set(odds.map(o => o.bookmaker))].sort(),
      player_labels: playerLabels,
      sample_10: odds.slice(0, 10),
    };
  }, [odds, filtered]);

  if (matchesLoading) return <LoadingSpinner message="Loading fixtures..." />;

  return (
    <div className="space-y-6 max-w-7xl">
      <div className="flex items-center gap-3">
        <TrendingUp className="w-5 h-5 text-emerald-400" />
        <h2 className="text-white font-bold text-lg">Odds Screen</h2>
        <span className="text-xs text-gray-600 ml-1">Disposal ladders & genuine Over/Under lines from bookmakers</span>
      </div>

      {matches.length === 0 ? (
        <EmptyState title="No Upcoming Fixtures" message="Import fixtures first to view odds." />
      ) : (
        <>
          {/* Match Selector */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {matches.map(m => (
              <button
                key={m.id}
                onClick={() => setSelectedMatchId(m.id)}
                className={`text-left px-4 py-3 rounded-xl border transition ${
                  m.id === selectedMatchId
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-white'
                    : 'bg-gray-900 border-gray-800 text-gray-400 hover:border-gray-600 hover:text-white'
                }`}
              >
                <p className="text-sm font-semibold truncate">{m.home_team} vs {m.away_team}</p>
                <p className="text-xs text-gray-500 mt-0.5 flex items-center gap-1">
                  <Calendar className="w-3 h-3" />
                  R{m.round} · {m.match_date}
                </p>
              </button>
            ))}
          </div>

          {selectedMatch && (
            <div className="bg-gray-900/60 border border-gray-700/40 rounded-xl px-5 py-4 flex items-center justify-between gap-4 flex-wrap">
              <div>
                <p className="text-white font-bold">{selectedMatch.home_team} vs {selectedMatch.away_team}</p>
                <p className="text-gray-500 text-xs mt-0.5">{selectedMatch.venue ?? 'TBD'} · {selectedMatch.match_date} · Round {selectedMatch.round}</p>
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-xs px-2.5 py-1 rounded-full border bg-amber-500/10 border-amber-500/20 text-amber-400">
                  {debugStats.raw_rows} ladder rows
                </span>
                <span className="text-xs px-2.5 py-1 rounded-full border bg-gray-800 border-gray-700 text-gray-400">
                  {debugStats.unique_players} players
                </span>
                <button onClick={refresh} className="p-1.5 text-gray-500 hover:text-white transition">
                  <RefreshCw className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {/* Search */}
          <div className="relative max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              type="text"
              value={searchFilter}
              onChange={e => setSearchFilter(e.target.value)}
              placeholder="Filter by player, bookmaker, or threshold..."
              className="w-full bg-gray-900 border border-gray-700 rounded-xl pl-9 pr-4 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 transition"
            />
          </div>

          {/* Disposal Over/Under Section */}
          {loading ? null : ouRows.length === 0 ? (
            <div className="bg-gray-900 border border-gray-700/40 rounded-xl p-6 text-center">
              <p className="text-gray-400 font-medium text-sm">No genuine disposal Over/Under market is currently available for this match.</p>
              <p className="text-gray-600 text-xs mt-1">Run Sync Player Props from the Import page to fetch live O/U lines.</p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-white font-bold text-sm flex items-center gap-2">
                  <Target className="w-4 h-4 text-emerald-400" />
                  Disposal Over/Under
                </h3>
                <span className="text-xs px-2.5 py-1 rounded-full border bg-emerald-500/10 border-emerald-500/20 text-emerald-400">
                  {ouRows.length} genuine disposal O/U lines
                </span>
              </div>
              <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-800/40 border-b border-gray-700/40 text-gray-500 text-xs uppercase tracking-wider">
                      <th className="text-left px-4 py-2.5 font-medium">Player</th>
                      <th className="text-right px-4 py-2.5 font-medium">Line</th>
                      <th className="text-left px-4 py-2.5 font-medium">Bookmaker</th>
                      <th className="text-right px-4 py-2.5 font-medium">Over Odds</th>
                      <th className="text-right px-4 py-2.5 font-medium">Under Odds</th>
                      <th className="text-right px-4 py-2.5 font-medium">Fetched</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ouRows.map((r, i) => (
                      <tr key={`${r.player_name}-${r.line}-${i}`} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition">
                        <td className="px-4 py-2.5 text-white font-medium">{r.player_name}</td>
                        <td className="px-4 py-2.5 text-right text-gray-300 font-mono">{r.line}</td>
                        <td className="px-4 py-2.5 text-gray-400 capitalize">{r.bookmaker}</td>
                        <td className="px-4 py-2.5 text-right text-emerald-400 font-mono font-bold">{r.over_odds?.toFixed(2) ?? '—'}</td>
                        <td className="px-4 py-2.5 text-right text-amber-400 font-mono font-bold">{r.under_odds?.toFixed(2) ?? '—'}</td>
                        <td className="px-4 py-2.5 text-right text-gray-600 text-xs">{r.fetched_at ? formatAge(r.fetched_at) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Player Ladder Cards */}
          {loading ? (
            <LoadingSpinner message="Loading alt-ladder odds..." />
          ) : odds.length === 0 ? (
            <div className="bg-gray-900 border border-amber-500/30 rounded-xl p-8 text-center">
              <TrendingUp className="w-10 h-10 text-amber-500/40 mx-auto mb-3" />
              <p className="text-amber-400 font-semibold">No alt-ladder odds for this match</p>
              <p className="text-gray-500 text-sm mt-2">
                Querying <code className="text-gray-400 font-mono text-xs bg-gray-800 px-1.5 py-0.5 rounded">bookmaker_odds WHERE match_id = {selectedMatchId} AND market_type = 'alt_ladder'</code>
              </p>
              <Link to="/import" className="inline-flex items-center gap-1.5 mt-4 px-4 py-2 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-sm rounded-lg hover:bg-emerald-500/20 transition">
                Import Data
              </Link>
            </div>
          ) : playerGroups.size === 0 ? (
            <p className="text-gray-500 text-sm">No rows match current filter.</p>
          ) : (
            <div className="space-y-3">
              {[...playerGroups.entries()].map(([playerName, rows]) => (
                <PlayerLadderCard key={playerName} playerName={playerName} rows={rows} />
              ))}
            </div>
          )}

          {/* Debug Panel */}
          <div className="bg-gray-900/50 border border-gray-700/40 rounded-xl overflow-hidden">
            <button
              onClick={() => setShowDebug(!showDebug)}
              className="w-full px-4 py-3 flex items-center justify-between text-sm hover:bg-gray-800/40 transition"
            >
              <span className="flex items-center gap-2 text-gray-400">
                <Bug className="w-4 h-4" />
                Debug — {debugStats.raw_rows} raw rows · {debugStats.unique_players} players · {debugStats.unique_bookmakers} bookmakers
              </span>
              {showDebug ? <ChevronUp className="w-4 h-4 text-gray-500" /> : <ChevronDown className="w-4 h-4 text-gray-500" />}
            </button>
            {showDebug && (
              <div className="px-4 pb-4 space-y-3 text-xs font-mono">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {[
                    { label: 'Raw Rows', value: debugStats.raw_rows },
                    { label: 'Filtered Rows', value: debugStats.filtered_rows },
                    { label: 'Unique Players', value: debugStats.unique_players },
                    { label: 'Bookmakers', value: debugStats.unique_bookmakers },
                  ].map(({ label, value }) => (
                    <div key={label} className="bg-gray-800/50 rounded-lg p-2">
                      <div className="text-gray-500 text-xs">{label}</div>
                      <div className="text-white font-bold text-base">{value}</div>
                    </div>
                  ))}
                </div>

                {/* Unique ladder labels per player */}
                {debugStats.player_labels.size > 0 && (
                  <div className="bg-gray-800/50 rounded-lg p-3">
                    <div className="text-gray-500 mb-2">Unique Ladder Labels Per Player</div>
                    <div className="space-y-1 max-h-48 overflow-y-auto">
                      {[...debugStats.player_labels.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([player, labels]) => (
                        <div key={player} className="flex items-center gap-2">
                          <span className="text-gray-300 min-w-0 truncate flex-1">{player}</span>
                          <span className="text-amber-400 shrink-0">
                            {[...labels].sort((a, b) => parseFloat(a) - parseFloat(b)).join(', ')}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Bookmakers */}
                {debugStats.bookmakers.length > 0 && (
                  <div className="bg-gray-800/50 rounded-lg p-2">
                    <div className="text-gray-500 mb-1">Bookmaker Sources</div>
                    <div className="flex flex-wrap gap-1">
                      {debugStats.bookmakers.map(b => (
                        <span key={b} className="px-2 py-0.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded capitalize">{b}</span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Sample 10 rows exactly as stored */}
                {debugStats.sample_10.length > 0 && (
                  <div className="bg-gray-800/50 rounded-lg p-3">
                    <div className="text-gray-500 mb-2">Sample 10 Rows (exact DB values)</div>
                    <div className="space-y-1 overflow-x-auto">
                      {debugStats.sample_10.map(r => (
                        <div key={r.id} className="text-gray-300 whitespace-nowrap text-xs">
                          {JSON.stringify({
                            bookmaker: r.bookmaker,
                            player: r.player_name,
                            raw_market: r.raw_market,
                            raw_line: r.raw_line,
                            line: r.line,
                            display_label: r.display_label,
                            market_type: r.market_type,
                            over_odds: r.over_odds,
                            under_odds: r.under_odds,
                          })}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {lastRefresh && (
                  <div className="bg-gray-800/50 rounded-lg p-2">
                    <div className="text-gray-500">Last Refresh</div>
                    <div className="text-white">{formatAge(lastRefresh)}</div>
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* Refresh Confirmation Dialog */}
      {showRefreshConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl">
            <div className="flex items-start gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-amber-500/10 border border-amber-500/30 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5 text-amber-400" />
              </div>
              <div className="flex-1">
                <h3 className="text-white font-semibold text-base">Confirm Refresh</h3>
                <p className="text-gray-400 text-sm mt-1">
                  This may use The Odds API credits. Continue?
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 mt-6">
              <button
                onClick={() => setShowRefreshConfirm(false)}
                className="px-4 py-2 text-sm text-gray-400 hover:text-white transition"
              >
                Cancel
              </button>
              <button
                onClick={doRefresh}
                className="px-4 py-2 text-sm font-medium bg-amber-500/20 border border-amber-500/30 text-amber-400 rounded-lg hover:bg-amber-500/30 transition flex items-center gap-2"
              >
                <RefreshCw className="w-4 h-4" />
                Continue
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
