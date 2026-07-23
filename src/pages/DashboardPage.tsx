import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { TrendingUp, TrendingDown, Flame, Award, BarChart2, Users, ArrowRight, Target, CheckCircle2, AlertTriangle, AlertOctagon } from 'lucide-react';
import { usePlayers } from '../hooks/usePlayerData';
import LoadingSpinner from '../components/LoadingSpinner';
import EmptyState from '../components/EmptyState';
import RoundReadyChecklist from '../components/RoundReadyChecklist';
import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { getDataStatus } from '../lib/playerStatsSync';
import { fetchAllRows } from '../lib/supabasePagination';
import type { Player, PlayerGameStat } from '../lib/types';
import {
  calcAvgForStats, getLastN, consistencyRating, sortStatsByDate, detectTrend, average
} from '../lib/analytics';

interface PlayerWithStats {
  player: Player;
  stats: PlayerGameStat[];
}

export default function DashboardPage() {
  const { players, loading: playersLoading } = usePlayers();
  const [allStats, setAllStats] = useState<PlayerGameStat[]>([]);
  const [statsLoading, setStatsLoading] = useState(true);
  const [dataStatus, setDataStatus] = useState<{ status: 'READY' | 'WARNING' | 'BROKEN'; latestCompletedRound: string | null; latestStatRound: string | null; isStale: boolean; reasons: string[] } | null>(null);

  useEffect(() => {
    // Fully paginated — an unpaginated select here was silently capped at
    // Supabase's 1000-row default out of ~7000+ stat rows, so leaderboards
    // (Top Disposal, Most Consistent, etc.) only ever considered the most
    // recent ~1000 rows instead of full-season data.
    fetchAllRows<PlayerGameStat>(supabase, 'player_game_stats', '*')
      .then(data => {
        setAllStats(data);
        setStatsLoading(false);
      })
      .catch(() => setStatsLoading(false));
    getDataStatus(new Date().getFullYear()).then(setDataStatus);
  }, []);

  const loading = playersLoading || statsLoading;

  const playersWithStats = useMemo((): PlayerWithStats[] => {
    return players.map(p => ({
      player: p,
      stats: allStats.filter(s => s.player_id === p.id),
    }));
  }, [players, allStats]);

  const hasData = allStats.length > 0;

  const topDisposal = useMemo(() => {
    return playersWithStats
      .filter(p => p.stats.length >= 3)
      .map(p => ({ ...p, avg: calcAvgForStats(getLastN(p.stats, 5), 'disposals') }))
      .sort((a, b) => b.avg - a.avg)
      .slice(0, 5);
  }, [playersWithStats]);

  const mostConsistent = useMemo(() => {
    return playersWithStats
      .filter(p => p.stats.length >= 5)
      .map(p => ({
        ...p,
        consistency: consistencyRating(p.stats.map(s => s.disposals)),
        avg: average(p.stats.map(s => s.disposals)),
      }))
      .sort((a, b) => b.consistency - a.consistency)
      .slice(0, 5);
  }, [playersWithStats]);

  const hotForm = useMemo(() => {
    return playersWithStats
      .filter(p => p.stats.length >= 4)
      .map(p => {
        const sorted = sortStatsByDate(p.stats);
        const last3 = sorted.slice(0, 3);
        const rest = sorted.slice(3, 8);
        const last3Avg = calcAvgForStats(last3, 'disposals');
        const restAvg = rest.length > 0 ? calcAvgForStats(rest, 'disposals') : last3Avg;
        return { ...p, last3Avg, restAvg, uplift: last3Avg - restAvg };
      })
      .filter(p => p.uplift > 0)
      .sort((a, b) => b.uplift - a.uplift)
      .slice(0, 5);
  }, [playersWithStats]);

  const trends = useMemo(() => {
    const results = playersWithStats
      .map(p => detectTrend(p.player, p.stats, 'disposals'))
      .filter(Boolean) as NonNullable<ReturnType<typeof detectTrend>>[];
    return {
      improving: results.filter(t => t.trend === 'improving' || t.trend === 'breakout').sort((a, b) => b.trendScore - a.trendScore).slice(0, 4),
      declining: results.filter(t => t.trend === 'declining').sort((a, b) => b.trendScore - a.trendScore).slice(0, 4),
    };
  }, [playersWithStats]);

  const summary = useMemo(() => ({
    totalPlayers: players.length,
    totalGames: new Set(allStats.map(s => s.match_id ?? s.match_date)).size,
    totalRecords: allStats.length,
    avgDisposals: allStats.length > 0 ? average(allStats.map(s => s.disposals)) : 0,
  }), [players, allStats]);

  if (loading) return <LoadingSpinner message="Loading analytics..." />;

  return (
    <div className="space-y-6">
      {/* Summary Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Players', value: summary.totalPlayers, icon: Users, color: 'text-cyan-400' },
          { label: 'Games Logged', value: summary.totalGames, icon: BarChart2, color: 'text-blue-400' },
          { label: 'Stat Records', value: summary.totalRecords, icon: Target, color: 'text-emerald-400' },
          { label: 'Avg Disposals', value: summary.avgDisposals.toFixed(1), icon: TrendingUp, color: 'text-amber-400' },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-gray-500 uppercase tracking-wider">{label}</p>
              <Icon className={`w-4 h-4 ${color}`} />
            </div>
            <p className="text-2xl font-bold text-white">{value}</p>
          </div>
        ))}
      </div>

      {/* Data Status Readiness Gate */}
      {dataStatus && (
        <div className={`rounded-xl p-4 border flex items-center gap-3 ${
          dataStatus.status === 'READY'
            ? 'bg-emerald-500/10 border-emerald-500/30'
            : dataStatus.status === 'WARNING'
              ? 'bg-amber-500/10 border-amber-500/30'
              : 'bg-red-500/10 border-red-500/30'
        }`}>
          {dataStatus.status === 'READY'
            ? <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
            : dataStatus.status === 'WARNING'
              ? <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
              : <AlertOctagon className="w-5 h-5 text-red-400 shrink-0" />}
          <div className="flex-1">
            <p className={`text-sm font-semibold ${
              dataStatus.status === 'READY' ? 'text-emerald-400' : dataStatus.status === 'WARNING' ? 'text-amber-400' : 'text-red-400'
            }`}>
              Data Status: {dataStatus.status}
              {dataStatus.latestStatRound && dataStatus.latestCompletedRound && (
                <span className="text-gray-400 font-normal ml-2">
                  Stats R{dataStatus.latestStatRound} / Expected R{dataStatus.latestCompletedRound}
                </span>
              )}
            </p>
            {dataStatus.reasons.length > 0 && (
              <p className="text-xs text-gray-500 mt-0.5">{dataStatus.reasons[0]}</p>
            )}
          </div>
        </div>
      )}

      {/* Round Ready Checklist */}
      <RoundReadyChecklist />

      {!hasData && (
        <EmptyState
          title="No Game Data Imported"
          message="Import player_game_stats CSV to unlock all analytics. Dashboard will populate automatically."
        />
      )}

      {hasData && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Top Disposal Players */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
              <div className="flex items-center gap-2">
                <Award className="w-4 h-4 text-amber-400" />
                <h3 className="text-white font-semibold text-sm">Top Disposals (Last 5)</h3>
              </div>
              <Link to="/players" className="text-xs text-gray-500 hover:text-emerald-400 transition flex items-center gap-1">
                View all <ArrowRight className="w-3 h-3" />
              </Link>
            </div>
            <div className="divide-y divide-gray-800">
              {topDisposal.length === 0 ? (
                <p className="px-5 py-4 text-gray-600 text-sm">Insufficient data</p>
              ) : topDisposal.map(({ player, avg, stats }, i) => (
                <Link key={player.id} to={`/players/${player.id}`} className="flex items-center gap-4 px-5 py-3 hover:bg-gray-800/50 transition">
                  <span className="text-gray-600 text-sm w-5 text-center font-mono">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-white text-sm font-medium truncate">{player.name}</p>
                    <p className="text-gray-500 text-xs">{player.team} &bull; {player.position ?? 'Unknown'}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-amber-400 font-bold">{avg.toFixed(1)}</p>
                    <p className="text-gray-600 text-xs">{stats.length} games</p>
                  </div>
                </Link>
              ))}
            </div>
          </div>

          {/* Hot Form */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl">
            <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-800">
              <Flame className="w-4 h-4 text-red-400" />
              <h3 className="text-white font-semibold text-sm">Hot Form</h3>
              <span className="text-xs text-gray-600">(last 3 vs prior)</span>
            </div>
            <div className="divide-y divide-gray-800">
              {hotForm.length === 0 ? (
                <p className="px-5 py-4 text-gray-600 text-sm">Insufficient data</p>
              ) : hotForm.map(({ player, last3Avg, uplift }) => (
                <Link key={player.id} to={`/players/${player.id}`} className="flex items-center gap-4 px-5 py-3 hover:bg-gray-800/50 transition">
                  <div className="w-8 h-8 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center justify-center shrink-0">
                    <Flame className="w-4 h-4 text-red-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-white text-sm font-medium truncate">{player.name}</p>
                    <p className="text-gray-500 text-xs">{player.team}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-white font-bold">{last3Avg.toFixed(1)}</p>
                    <p className="text-emerald-400 text-xs">+{uplift.toFixed(1)} disp</p>
                  </div>
                </Link>
              ))}
            </div>
          </div>

          {/* Consistency */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl">
            <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-800">
              <BarChart2 className="w-4 h-4 text-cyan-400" />
              <h3 className="text-white font-semibold text-sm">Most Consistent</h3>
              <span className="text-xs text-gray-600">(disposal variance)</span>
            </div>
            <div className="divide-y divide-gray-800">
              {mostConsistent.length === 0 ? (
                <p className="px-5 py-4 text-gray-600 text-sm">Insufficient data</p>
              ) : mostConsistent.map(({ player, consistency, avg }, i) => (
                <Link key={player.id} to={`/players/${player.id}`} className="flex items-center gap-4 px-5 py-3 hover:bg-gray-800/50 transition">
                  <span className="text-gray-600 text-sm w-5 text-center font-mono">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-white text-sm font-medium truncate">{player.name}</p>
                    <p className="text-gray-500 text-xs">{player.team}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="flex items-center gap-2">
                      <div className="w-16 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-cyan-400 rounded-full"
                          style={{ width: `${consistency}%` }}
                        />
                      </div>
                      <span className="text-cyan-400 font-bold text-sm w-8">{consistency}</span>
                    </div>
                    <p className="text-gray-600 text-xs text-right">{avg.toFixed(1)} avg</p>
                  </div>
                </Link>
              ))}
            </div>
          </div>

          {/* Trends */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl">
            <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-800">
              <TrendingUp className="w-4 h-4 text-emerald-400" />
              <h3 className="text-white font-semibold text-sm">Momentum Signals</h3>
            </div>
            <div className="px-5 py-3 space-y-3">
              <div>
                <p className="text-xs text-emerald-500 uppercase tracking-wider mb-2">Improving</p>
                {trends.improving.length === 0 ? (
                  <p className="text-gray-600 text-xs">No signals detected</p>
                ) : trends.improving.map(t => (
                  <Link key={t.player.id} to={`/players/${t.player.id}`} className="flex items-center gap-2 py-1.5 hover:text-emerald-400 transition group">
                    <TrendingUp className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    <span className="text-white text-sm group-hover:text-emerald-400 transition truncate">{t.player.name}</span>
                    <span className="ml-auto text-emerald-400 text-xs font-mono shrink-0">+{t.trendScore}%</span>
                  </Link>
                ))}
              </div>
              <div className="border-t border-gray-800 pt-3">
                <p className="text-xs text-red-500 uppercase tracking-wider mb-2">Declining</p>
                {trends.declining.length === 0 ? (
                  <p className="text-gray-600 text-xs">No signals detected</p>
                ) : trends.declining.map(t => (
                  <Link key={t.player.id} to={`/players/${t.player.id}`} className="flex items-center gap-2 py-1.5 hover:text-red-400 transition group">
                    <TrendingDown className="w-3.5 h-3.5 text-red-400 shrink-0" />
                    <span className="text-white text-sm group-hover:text-red-400 transition truncate">{t.player.name}</span>
                    <span className="ml-auto text-red-400 text-xs font-mono shrink-0">-{t.trendScore}%</span>
                  </Link>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
