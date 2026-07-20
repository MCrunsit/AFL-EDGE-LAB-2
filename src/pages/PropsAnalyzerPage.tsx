import { useState, useMemo, useEffect } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Target, AlertTriangle, ChevronDown, TrendingUp, Calendar, Bug } from 'lucide-react';
import { usePlayers, useUpcomingGames, useBookmakerOdds } from '../hooks/usePlayerData';
import type { StatType } from '../lib/types';
import { formatSyncAge } from '../lib/syncPlayerPropOdds';
import PlayerCombobox from '../components/PlayerCombobox';
import ErrorBoundary from '../components/ErrorBoundary';
import LoadingSpinner from '../components/LoadingSpinner';
import EmptyState from '../components/EmptyState';

const STAT_OPTIONS: { value: StatType; label: string }[] = [
  { value: 'disposals', label: 'Disposals' },
  { value: 'goals', label: 'Goals' },
  { value: 'tackles', label: 'Tackles' },
  { value: 'marks', label: 'Marks' },
  { value: 'hitouts', label: 'Hitouts' },
];

export default function PropsAnalyzerPage() {
  const [searchParams] = useSearchParams();
  const { players, loading: playersLoading } = usePlayers();
  const [selectedPlayerId, setSelectedPlayerId] = useState(searchParams.get('player') ?? '');
  const [statType, setStatType] = useState<StatType>('disposals');
  const [showDebug, setShowDebug] = useState(false);

  const selectedPlayer = players.find(p => p.id === selectedPlayerId);
  const { games: upcomingGames, loading: gamesLoading } = useUpcomingGames(selectedPlayer?.team ?? null, 5);

  const nextMatchId = upcomingGames[0]?.match_id || null;
  const { odds: bookmakerOdds, loading: bookmakerLoading } = useBookmakerOdds(selectedPlayerId || null, nextMatchId, statType);

  if (playersLoading) return <LoadingSpinner message="Loading players..." />;

  if (players.length === 0) {
    return <EmptyState title="No Players Available" message="Import player data first to use the Props Analyzer." />;
  }

  // Debug info
  const bookmakerSources = new Set(bookmakerOdds.map(o => o.bookmaker_id));
  const lineValues = new Set(bookmakerOdds.map(o => o.line));
  const lastSync = bookmakerOdds.reduce((max: string | null, o) =>
    o.fetched_at && (!max || o.fetched_at > max) ? o.fetched_at : max, null);

  return (
    <ErrorBoundary fallbackLabel="Props Analyzer">
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center gap-3">
        <Target className="w-5 h-5 text-emerald-400" />
        <h2 className="text-white font-bold text-lg">Props / Legs Analyzer</h2>
      </div>

      {/* Input Form */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
        <p className="text-gray-400 text-sm">Select a player and market to view raw bookmaker odds. No calculations or predictions.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Player</label>
            <PlayerCombobox
              players={players}
              value={selectedPlayerId}
              onChange={setSelectedPlayerId}
              placeholder="Search by name, team, or position..."
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Market</label>
            <div className="relative">
              <select
                value={statType}
                onChange={e => setStatType(e.target.value as StatType)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-3 text-white text-sm focus:outline-none focus:border-emerald-500 appearance-none"
              >
                {STAT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
            </div>
          </div>
        </div>
      </div>

      {selectedPlayerId && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* Upcoming Games */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <div className="flex items-center gap-2 mb-4">
              <Calendar className="w-4 h-4 text-emerald-400" />
              <h3 className="text-white font-semibold text-sm">Upcoming Games</h3>
            </div>
            {gamesLoading ? (
              <p className="text-gray-500 text-sm">Loading...</p>
            ) : upcomingGames.length === 0 ? (
              <div className="text-sm space-y-1">
                <p className="text-amber-400">No upcoming fixtures found for {selectedPlayer?.team}.</p>
                <p className="text-gray-600 text-xs">This likely means no future matches have been imported yet.</p>
                <Link to="/import" className="inline-block mt-1.5 px-3 py-1.5 bg-emerald-600 text-white text-xs rounded-lg hover:bg-emerald-500 transition-colors">Import Fixtures</Link>
              </div>
            ) : (
              <div className="space-y-2">
                {upcomingGames.map(g => (
                  <div key={g.match_id} className="flex items-center justify-between bg-gray-800/60 border border-gray-700/50 rounded-lg p-3">
                    <div>
                      <p className="text-white text-sm font-medium">
                        {g.is_home ? 'vs' : '@'} {g.opponent}
                      </p>
                      <p className="text-gray-500 text-xs">{g.venue ?? 'TBD'} &bull; {g.match_date}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-gray-400 text-xs">R{g.round ?? '-'}</p>
                      <p className="text-gray-600 text-xs">{g.season}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Raw Bookmaker Odds — ONE row per bookmaker/market/line */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <div className="flex items-center gap-2 mb-4">
              <TrendingUp className="w-4 h-4 text-emerald-400" />
              <h3 className="text-white font-semibold text-sm">Raw Bookmaker Odds — {statType}</h3>
              {bookmakerOdds.length > 0 && (
                <span className="text-xs text-emerald-400 ml-auto">{bookmakerOdds.length} rows</span>
              )}
            </div>

            {bookmakerLoading ? (
              <p className="text-gray-500 text-sm">Loading...</p>
            ) : bookmakerOdds.length > 0 ? (
              <div className="space-y-3">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-gray-500 border-b border-gray-700/50">
                        <th className="text-left py-2 px-2">Bookmaker</th>
                        <th className="text-left py-2 px-2">Raw Market</th>
                        <th className="text-center py-2 px-2">Line</th>
                        <th className="text-center py-2 px-2">Over</th>
                        <th className="text-center py-2 px-2">Under</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bookmakerOdds.map(b => (
                        <tr key={b.id} className="border-b border-gray-800/30 hover:bg-gray-800/30">
                          <td className="py-2 px-2 text-white font-medium capitalize">{b.bookmaker_id}</td>
                          <td className="py-2 px-2 text-gray-400 font-mono text-xs" title={(b as unknown as Record<string, unknown>).raw_market as string ?? b.market}>{((b as unknown as Record<string, unknown>).raw_market as string) ?? b.market}</td>
                          <td className="py-2 px-2 text-center text-gray-300 tabular-nums">{Number(b.line).toFixed(1)}</td>
                          <td className="py-2 px-2 text-center text-emerald-400 font-semibold tabular-nums">{b.over_odds.toFixed(2)}</td>
                          <td className="py-2 px-2 text-center text-red-400 font-semibold tabular-nums">{b.under_odds != null ? b.under_odds.toFixed(2) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {lastSync && (
                  <p className="text-gray-600 text-xs">Last sync: {formatSyncAge(lastSync)}</p>
                )}
              </div>
            ) : nextMatchId ? (
              <div className="space-y-2">
                <p className="text-gray-400 text-sm">No bookmaker odds available for this market.</p>
                <p className="text-gray-600 text-xs">If a bookmaker does not provide a line, it will not appear here.</p>
                <Link to="/import" className="inline-flex items-center gap-1.5 mt-2 px-3 py-1.5 bg-emerald-600/20 border border-emerald-600/30 text-emerald-400 text-xs rounded-lg hover:bg-emerald-600/30 transition-colors">
                  Import Bookmaker Odds
                </Link>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-gray-400 text-sm">No upcoming match found for this player's team.</p>
                <p className="text-gray-600 text-xs">Odds are only available for upcoming matches.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Debug Toggle */}
      {selectedPlayerId && (
        <div className="bg-gray-900/50 border border-gray-700/40 rounded-xl overflow-hidden">
          <button
            onClick={() => setShowDebug(!showDebug)}
            className="w-full px-4 py-3 flex items-center justify-between text-sm hover:bg-gray-800/40 transition-colors"
          >
            <span className="flex items-center gap-2 text-gray-400">
              <Bug className="w-4 h-4" /> Show Raw Odds Debug
            </span>
            <ChevronDown className={`w-4 h-4 text-gray-500 transition-transform ${showDebug ? 'rotate-180' : ''}`} />
          </button>
          {showDebug && (
            <div className="px-4 pb-4 space-y-3 text-xs">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="bg-gray-800/50 rounded-lg p-2">
                  <div className="text-gray-500">Raw Rows Count</div>
                  <div className="text-white font-mono">{bookmakerOdds.length}</div>
                </div>
                <div className="bg-gray-800/50 rounded-lg p-2">
                  <div className="text-gray-500">Bookmaker Sources</div>
                  <div className="text-white">{bookmakerSources.size}</div>
                </div>
                <div className="bg-gray-800/50 rounded-lg p-2">
                  <div className="text-gray-500">Line Values</div>
                  <div className="text-white">{lineValues.size}</div>
                </div>
                <div className="bg-gray-800/50 rounded-lg p-2">
                  <div className="text-gray-500">Last Sync</div>
                  <div className="text-white">{lastSync ? formatSyncAge(lastSync) : 'Never'}</div>
                </div>
              </div>
              {bookmakerSources.size > 0 && (
                <div className="bg-gray-800/50 rounded-lg p-2">
                  <div className="text-gray-500 mb-1">Bookmaker Sources Present</div>
                  <div className="text-gray-300 capitalize">{[...bookmakerSources].join(', ')}</div>
                </div>
              )}
              {lineValues.size > 0 && (
                <div className="bg-gray-800/50 rounded-lg p-2">
                  <div className="text-gray-500 mb-1">Line Values Per Bookmaker</div>
                  <div className="space-y-1">
                    {[...bookmakerSources].sort().map(bm => {
                      const bmLines = bookmakerOdds.filter(o => o.bookmaker_id === bm).map(o => Number(o.line).toFixed(1));
                      return (
                        <div key={bm} className="flex justify-between">
                          <span className="text-gray-400 capitalize">{bm}</span>
                          <span className="text-gray-300 font-mono">{bmLines.join(', ')}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
    </ErrorBoundary>
  );
}
