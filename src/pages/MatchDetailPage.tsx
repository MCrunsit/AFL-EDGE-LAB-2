import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  Calendar, MapPin, ChevronLeft, RefreshCw, Clock, ExternalLink,
  ChevronDown, ChevronUp, Bug, AlertCircle, Search
} from 'lucide-react';
import { getUnifiedMatchPlayerProps, type UnifiedMatchProps, type UnifiedPlayerProp } from '../lib/unifiedMatchPlayerProps';
import { getMatchBookmakerMarkets, type RawBookmakerMarket } from '../lib/rawBookmakerOdds';
import { formatSyncAge } from '../lib/syncPlayerPropOdds';
import ErrorBoundary from '../components/ErrorBoundary';
import LoadingSpinner from '../components/LoadingSpinner';

function DebugPanel({
  matchId,
  playersCount,
  oddsCount,
  lastFetch,
  allMarkets
}: {
  matchId: string;
  playersCount: number;
  oddsCount: number;
  lastFetch: string | null;
  allMarkets: RawBookmakerMarket[];
}) {
  const [expanded, setExpanded] = useState(false);
  const bookmakerSources = new Set(allMarkets.map(m => m.bookmaker_id));
  const lineValues = new Set(allMarkets.map(m => m.line));
  const rawMarkets = new Set(allMarkets.map(m => m.raw_market ?? m.market));

  return (
    <div className="bg-gray-900/50 border border-gray-700/40 rounded-xl overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 flex items-center justify-between text-sm hover:bg-gray-800/40 transition-colors"
      >
        <span className="flex items-center gap-2 text-gray-400">
          <Bug className="w-4 h-4" /> Raw Bookmaker Data Debug ({allMarkets.length} rows)
        </span>
        {expanded ? <ChevronUp className="w-4 h-4 text-gray-500" /> : <ChevronDown className="w-4 h-4 text-gray-500" />}
      </button>
      {expanded && (
        <div className="px-4 pb-4 space-y-3 text-xs">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-gray-800/50 rounded-lg p-2">
              <div className="text-gray-500">Raw Rows</div>
              <div className="text-white font-mono">{oddsCount}</div>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2">
              <div className="text-gray-500">Bookmakers</div>
              <div className="text-white">{bookmakerSources.size}</div>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2">
              <div className="text-gray-500">Distinct Lines</div>
              <div className="text-white">{lineValues.size}</div>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2">
              <div className="text-gray-500">Distinct Markets</div>
              <div className="text-white">{rawMarkets.size}</div>
            </div>
          </div>

          <div className="bg-gray-800/50 rounded-lg p-2">
            <div className="text-gray-500">Last Sync</div>
            <div className="text-white">{lastFetch ? formatSyncAge(lastFetch) : 'Never'}</div>
          </div>

          {rawMarkets.size > 0 && (
            <div className="bg-gray-800/50 rounded-lg p-2">
              <div className="text-gray-500 mb-1">Raw Market Strings (exact from bookmaker)</div>
              <div className="flex flex-wrap gap-1">
                {[...rawMarkets].sort().map(rm => (
                  <span key={rm} className="px-1.5 py-0.5 bg-gray-700/50 rounded text-gray-300 font-mono text-xs">
                    {rm}
                  </span>
                ))}
              </div>
            </div>
          )}

          {allMarkets.length > 0 && (
            <div className="bg-gray-800/50 rounded-lg p-2 overflow-x-auto">
              <div className="text-gray-500 mb-2">All Raw Bookmaker Rows (no merging, no dedup)</div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-500 border-b border-gray-700/30">
                    <th className="text-left py-1.5 px-2 font-medium">Bookmaker</th>
                    <th className="text-left py-1.5 px-2 font-medium">Raw Market</th>
                    <th className="text-right py-1.5 px-2 font-medium">Raw Line</th>
                    <th className="text-right py-1.5 px-2 font-medium">Line</th>
                    <th className="text-right py-1.5 px-2 font-medium">Over</th>
                    <th className="text-right py-1.5 px-2 font-medium">Under</th>
                    <th className="text-right py-1.5 px-2 font-medium">Fetched</th>
                  </tr>
                </thead>
                <tbody>
                  {allMarkets.map(m => (
                    <tr key={m.id} className="border-b border-gray-700/10">
                      <td className="py-1.5 px-2 text-gray-400">{m.bookmaker_id}</td>
                      <td className="py-1.5 px-2 text-gray-300 font-mono">{m.raw_market ?? m.market}</td>
                      <td className="py-1.5 px-2 text-right text-gray-400 font-mono">{m.raw_line ?? '—'}</td>
                      <td className="py-1.5 px-2 text-right text-white font-mono">{m.line.toFixed(1)}</td>
                      <td className="py-1.5 px-2 text-right text-emerald-400 font-mono">{m.over_odds.toFixed(2)}</td>
                      <td className="py-1.5 px-2 text-right text-red-400 font-mono">{m.under_odds.toFixed(2)}</td>
                      <td className="py-1.5 px-2 text-right text-gray-500">{formatSyncAge(m.fetched_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="bg-gray-800/50 rounded-lg p-2">
            <div className="text-gray-500">Data Source</div>
            <div className={oddsCount > 0 ? 'text-emerald-400' : 'text-red-400'}>
              {oddsCount > 0 ? 'bookmaker_odds (raw, no transformation)' : 'No odds data'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MatchDetailInner() {
  const { matchId } = useParams<{ matchId: string }>();
  const [data, setData] = useState<UnifiedMatchProps | null>(null);
  const [bookmakerMarkets, setBookmakerMarkets] = useState<Map<string, RawBookmakerMarket[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchFilter, setSearchFilter] = useState('');

  const loadMatch = useCallback(async () => {
    if (!matchId) return;
    setLoading(true);
    setLoadError(null);

    try {
      const result = await getUnifiedMatchPlayerProps(matchId);
      setData(result);

      if (result) {
        const markets = await getMatchBookmakerMarkets(matchId);
        setBookmakerMarkets(markets);
      }

      if (!result) {
        setLoadError('Match not found');
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load match');
      console.error('[MatchDetailPage]', err);
    } finally {
      setLoading(false);
    }
  }, [matchId]);

  useEffect(() => {
    loadMatch();
  }, [loadMatch]);

  if (loading) {
    return (
      <div className="max-w-6xl">
        <Link to="/matches" className="inline-flex items-center gap-1.5 text-gray-500 hover:text-white text-sm transition-colors mb-6">
          <ChevronLeft className="w-4 h-4" /> Match Hub
        </Link>
        <LoadingSpinner message="Loading match details..." />
      </div>
    );
  }

  if (loadError || !data) {
    return (
      <div className="max-w-6xl">
        <Link to="/matches" className="inline-flex items-center gap-1.5 text-gray-500 hover:text-white text-sm transition-colors mb-6">
          <ChevronLeft className="w-4 h-4" /> Match Hub
        </Link>
        <div className="flex flex-col items-center justify-center py-24 gap-4">
          <AlertCircle className="w-10 h-10 text-amber-500" />
          <p className="text-amber-400 font-medium">{loadError || 'Match not found'}</p>
          <button onClick={loadMatch} className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs rounded-lg transition-colors">
            Retry
          </button>
        </div>
      </div>
    );
  }

  const { match: m } = data;
  const matchDate = new Date(m.match_date ?? '');
  const isValidDate = !isNaN(matchDate.getTime());
  const dateStr = isValidDate ? matchDate.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' }) : '—';
  const timeStr = isValidDate ? matchDate.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' }) : '';

  const allMarkets = [...bookmakerMarkets.values()].flat();
  const lastFetch = allMarkets.reduce((max: string | null, mk) =>
    mk.fetched_at && (!max || mk.fetched_at > max) ? mk.fetched_at : max, null);
  const totalOdds = allMarkets.length;

  const filterLower = searchFilter.toLowerCase().trim();

  function renderTeamTable(players: UnifiedPlayerProp[], label: string) {
    // Helper to get markets for a player by id or name
    const getMarketsForPlayer = (p: UnifiedPlayerProp): RawBookmakerMarket[] => {
      // Try player_id first
      let markets = bookmakerMarkets.get(p.player_id) || [];
      // If no match and player_id is null, try by name
      if (markets.length === 0) {
        const nameKey = `name:${p.player_name.toLowerCase().trim()}`;
        markets = bookmakerMarkets.get(nameKey) || [];
        // Try last name
        if (markets.length === 0) {
          const parts = p.player_name.split(' ');
          if (parts.length >= 2) {
            const lastName = parts.slice(1).join(' ').toLowerCase().trim();
            for (const [key, vals] of bookmakerMarkets.entries()) {
              if (key.startsWith('name:') && key.slice(5).includes(lastName)) {
                markets = vals;
                break;
              }
            }
          }
        }
      }
      return markets;
    };

    return (
      <div className="bg-gray-900/50 border border-gray-700/40 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-700/40 flex items-center justify-between bg-gray-800/40">
          <div>
            <h3 className="text-white font-semibold text-sm">{label}</h3>
            <span className="text-xs text-gray-500">{players.length} players</span>
          </div>
          <button onClick={loadMatch} className="p-1.5 text-gray-600 hover:text-gray-300 transition-colors">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-500 uppercase tracking-wider border-b border-gray-700/30 bg-gray-800/20">
                <th className="text-left px-4 py-2.5 font-medium">Player</th>
                <th className="text-left px-3 py-2.5 font-medium">Bookmaker</th>
                <th className="text-left px-3 py-2.5 font-medium">Raw Market</th>
                <th className="text-center px-3 py-2.5 font-medium">Line</th>
                <th className="text-center px-3 py-2.5 font-medium">Over</th>
                <th className="text-center px-3 py-2.5 font-medium">Under</th>
              </tr>
            </thead>
            <tbody>
              {players.map(p => {
                const markets = getMarketsForPlayer(p);
                const relevant = filterLower
                  ? markets.filter(mk =>
                      mk.market.toLowerCase().includes(filterLower) ||
                      mk.bookmaker_id.toLowerCase().includes(filterLower) ||
                      p.player_name.toLowerCase().includes(filterLower) ||
                      (mk.bookmaker_player_name?.toLowerCase().includes(filterLower)))
                  : markets;

                if (relevant.length === 0) {
                  return (
                    <tr key={p.player_id || p.player_name} className="border-b border-gray-700/20">
                      <td className="px-4 py-3 text-white font-medium text-sm">{p.player_name}</td>
                      <td colSpan={5} className="px-3 py-3 text-center text-gray-600 text-xs">
                        {filterLower ? 'No markets match filter' : 'No bookmaker odds available'}
                      </td>
                    </tr>
                  );
                }

                return relevant.map((mk, idx) => {
                  // Display player name from bookmaker_player_name if available
                  const displayName = mk.bookmaker_player_name || p.player_name;
                  // Format under_odds - show "-" if null
                  const underDisplay = mk.under_odds == null ? '-' : mk.under_odds.toFixed(2);
                  return (
                    <tr key={mk.id} className="border-b border-gray-700/20 hover:bg-gray-800/40 transition-colors">
                      <td className="px-4 py-3 text-white font-medium text-sm">
                        {idx === 0 ? displayName : ''}
                      </td>
                      <td className="px-3 py-3 text-gray-500 text-sm">{mk.bookmaker_id}</td>
                      <td className="px-3 py-3 text-gray-400 text-xs font-mono" title={mk.raw_market ?? mk.market}>
                        {mk.raw_market ?? mk.market}
                      </td>
                      <td className="px-3 py-3 text-center text-white font-medium text-sm tabular-nums">{mk.line.toFixed(1)}</td>
                      <td className="px-3 py-3 text-center text-emerald-400 font-semibold text-sm tabular-nums">{mk.over_odds.toFixed(2)}</td>
                      <td className="px-3 py-3 text-center text-red-400 font-semibold text-sm tabular-nums">{underDisplay}</td>
                    </tr>
                  );
                });
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-6xl">
      <Link to="/matches" className="inline-flex items-center gap-1.5 text-gray-500 hover:text-white text-sm transition-colors">
        <ChevronLeft className="w-4 h-4" /> Match Hub
      </Link>

      {/* Match Info */}
      <div className="bg-gradient-to-br from-gray-800/60 to-gray-900/60 border border-gray-700/40 rounded-2xl p-6">
        <div className="flex items-center justify-between mb-5">
          <span className="text-xs font-semibold text-emerald-500 uppercase tracking-widest">
            Round {m.round} · {m.season}
          </span>
          <div className="flex items-center gap-3 text-xs text-gray-500">
            <span className={totalOdds > 0 ? 'text-emerald-400' : 'text-gray-600'}>
              {totalOdds} raw markets
            </span>
          </div>
        </div>

        <div className="grid grid-cols-3 items-center gap-4 mb-5">
          <div className="text-right">
            <div className="text-2xl font-bold text-white">{m.home_team}</div>
            <div className="text-xs text-emerald-600 mt-1 uppercase tracking-wider">Home</div>
          </div>
          <div className="text-center">
            <div className="text-3xl font-light text-gray-600">vs</div>
          </div>
          <div className="text-left">
            <div className="text-2xl font-bold text-white">{m.away_team}</div>
            <div className="text-xs text-gray-600 mt-1 uppercase tracking-wider">Away</div>
          </div>
        </div>

        <div className="flex items-center justify-center gap-6 text-sm text-gray-500 border-t border-gray-700/30 pt-4">
          <span className="flex items-center gap-1.5">
            <Calendar className="w-4 h-4" /> {dateStr} {timeStr}
          </span>
          {m.venue && (
            <span className="flex items-center gap-1.5">
              <MapPin className="w-4 h-4" /> {m.venue}
            </span>
          )}
        </div>
      </div>

      {/* Text Search Filter — NOT a canonical stat type filter */}
      <div className="bg-gray-800/30 border border-gray-700/30 rounded-xl p-4 flex items-center gap-3">
        <Search className="w-4 h-4 text-gray-500" />
        <input
          type="text"
          value={searchFilter}
          onChange={e => setSearchFilter(e.target.value)}
          placeholder="Filter by player, bookmaker, or market text (e.g. 'disposals', 'Sportsbet', 'Heeney')"
          className="flex-1 bg-transparent text-sm text-white placeholder-gray-600 outline-none"
        />
        {searchFilter && (
          <button onClick={() => setSearchFilter('')} className="text-xs text-gray-500 hover:text-gray-300">
            Clear
          </button>
        )}
      </div>

      {/* No Odds Notice */}
      {totalOdds === 0 && (
        <div className="bg-gray-800/30 border border-gray-700/30 rounded-xl p-5">
          <div className="flex items-start gap-3">
            <Clock className="w-5 h-5 text-gray-500 shrink-0 mt-0.5" />
            <div>
              <p className="text-gray-300 font-medium text-sm">No bookmaker odds available</p>
              <p className="text-gray-600 text-xs mt-1">
                Lines shown are from bookmaker_odds table only. Connect a feed or import CSV.
              </p>
              <Link to="/import" className="inline-flex items-center gap-1.5 mt-3 px-3 py-1.5 bg-emerald-600/20 border border-emerald-600/30 text-emerald-400 text-xs rounded-lg hover:bg-emerald-600/30 transition-colors">
                <ExternalLink className="w-3 h-3" /> Import Odds
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Player Markets Tables — 1 row per bookmaker market entry */}
      <div className="space-y-4">
        {renderTeamTable(data.home_players, m.home_team ?? '—')}
        {renderTeamTable(data.away_players, m.away_team ?? '—')}
      </div>

      {/* Unmatched Odds Section - shows odds with player_id=null */}
      {(() => {
        // Find odds rows that weren't matched to known players
        const unmatchedOdds = [...bookmakerMarkets.entries()]
          .filter(([key]) => key.startsWith('name:'))
          .flatMap(([, vals]) => vals);

        if (unmatchedOdds.length === 0) return null;

        return (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <AlertCircle className="w-4 h-4 text-amber-400" />
              <h3 className="text-amber-300 font-medium text-sm">Unmatched Odds ({unmatchedOdds.length} rows)</h3>
            </div>
            <p className="text-xs text-gray-400 mb-3">
              These odds have bookmaker_player_name but no matching player_id. Names may need manual matching.
            </p>
            <div className="overflow-x-auto max-h-64">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-500 border-b border-gray-700/30">
                    <th className="text-left py-1.5 px-2">Player Name</th>
                    <th className="text-left py-1.5 px-2">Market</th>
                    <th className="text-right py-1.5 px-2">Line</th>
                    <th className="text-right py-1.5 px-2">Over</th>
                  </tr>
                </thead>
                <tbody>
                  {unmatchedOdds.slice(0, 50).map(o => (
                    <tr key={o.id} className="border-b border-gray-700/10">
                      <td className="py-1.5 px-2 text-white">{o.bookmaker_player_name || '—'}</td>
                      <td className="py-1.5 px-2 text-gray-400">{o.raw_market || o.market}</td>
                      <td className="py-1.5 px-2 text-right text-white tabular-nums">{o.display_label || o.line}</td>
                      <td className="py-1.5 px-2 text-right text-emerald-400 tabular-nums">{o.over_odds.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {/* Debug Panel */}
      <DebugPanel
        matchId={matchId || ''}
        playersCount={data.home_players.length + data.away_players.length}
        oddsCount={totalOdds}
        lastFetch={lastFetch}
        allMarkets={allMarkets}
      />
    </div>
  );
}

export default function MatchDetailPage() {
  return (
    <ErrorBoundary fallbackLabel="Match Detail">
      <MatchDetailInner />
    </ErrorBoundary>
  );
}
