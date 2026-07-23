import { useMemo, useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Activity, TrendingUp, TrendingDown, Zap, Minus, ArrowRight } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { fetchAllRows } from '../lib/supabasePagination';
import type { Player, PlayerGameStat, EnrichedStat, StatType } from '../lib/types';
import { detectTrend, sortStatsByDate, calcAvgForStats, getLastN, average } from '../lib/analytics';
import LoadingSpinner from '../components/LoadingSpinner';
import EmptyState from '../components/EmptyState';

const STAT_OPTIONS: { value: StatType; label: string }[] = [
  { value: 'disposals', label: 'Disposals' },
  { value: 'goals', label: 'Goals' },
  { value: 'tackles', label: 'Tackles' },
  { value: 'marks', label: 'Marks' },
  { value: 'hitouts', label: 'Hitouts' },
];

type ContextFilter = 'all' | 'top8' | 'bottom8' | 'home' | 'away' | 'last5vsseason';

const CONTEXT_FILTERS: { value: ContextFilter; label: string }[] = [
  { value: 'all', label: 'All Games' },
  { value: 'top8', label: 'vs Top 8' },
  { value: 'bottom8', label: 'vs Bottom 8' },
  { value: 'home', label: 'Home Only' },
  { value: 'away', label: 'Away Only' },
  { value: 'last5vsseason', label: 'Last 5 vs Season Avg' },
];

const trendConfig = {
  breakout: { label: 'Breakout', color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/20', icon: Zap },
  improving: { label: 'Improving', color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20', icon: TrendingUp },
  stable: { label: 'Stable', color: 'text-gray-400', bg: 'bg-gray-800 border-gray-700', icon: Minus },
  declining: { label: 'Declining', color: 'text-red-400', bg: 'bg-red-500/10 border-red-500/20', icon: TrendingDown },
};

export default function TrendEnginePage() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [allStats, setAllStats] = useState<PlayerGameStat[]>([]);
  const [enrichedStats, setEnrichedStats] = useState<EnrichedStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [statType, setStatType] = useState<StatType>('disposals');
  const [filterTrend, setFilterTrend] = useState<string>('all');
  const [contextFilter, setContextFilter] = useState<ContextFilter>('all');
  const [topBottom, setTopBottom] = useState<{ top: Set<string>; bottom: Set<string> }>({ top: new Set(), bottom: new Set() });

  useEffect(() => {
    // player_game_stats and enriched_player_stats are fully paginated — both
    // have several thousand rows and an unpaginated select was silently
    // capped at Supabase's 1000-row default, limiting trend detection to
    // only the most recent games instead of full season history.
    Promise.all([
      supabase.from('current_players').select('*').order('name'),
      fetchAllRows<PlayerGameStat>(supabase, 'player_game_stats', '*'),
      fetchAllRows<EnrichedStat>(supabase, 'enriched_player_stats', '*'),
    ]).then(([p, s, es]) => {
      setPlayers(p.data ?? []);
      setAllStats(s);
      setEnrichedStats(es);
      setLoading(false);

      // Compute top/bottom 8 teams by win frequency from stats data
      const teamWins = new Map<string, number>();
      for (const stat of s) {
        const t = stat.team;
        if (t) teamWins.set(t, (teamWins.get(t) ?? 0) + 1);
      }
      const sorted = [...teamWins.entries()].sort((a, b) => b[1] - a[1]);
      const top = new Set(sorted.slice(0, 8).map(([team]) => team));
      const bottom = new Set(sorted.slice(-8).map(([team]) => team));
      setTopBottom({ top, bottom });
    });
  }, []);

  const statsByPlayer = useMemo(() => {
    const map = new Map<string, PlayerGameStat[]>();
    for (const s of allStats) {
      if (!map.has(s.player_id)) map.set(s.player_id, []);
      map.get(s.player_id)!.push(s);
    }
    return map;
  }, [allStats]);

  const enrichedByPlayer = useMemo(() => {
    const map = new Map<string, EnrichedStat[]>();
    for (const s of enrichedStats) {
      if (!map.has(s.player_id)) map.set(s.player_id, []);
      map.get(s.player_id)!.push(s);
    }
    return map;
  }, [enrichedStats]);

  const trends = useMemo(() => {
    const results = players
      .map(player => {
        let statsToUse = statsByPlayer.get(player.id) ?? [];

        // Apply context filter using enriched stats
        if (contextFilter !== 'all') {
          const enriched = enrichedByPlayer.get(player.id) ?? [];
          if (contextFilter === 'top8') {
            statsToUse = enriched.filter(s => s.opponent && topBottom.top.has(s.opponent));
          } else if (contextFilter === 'bottom8') {
            statsToUse = enriched.filter(s => s.opponent && topBottom.bottom.has(s.opponent));
          } else if (contextFilter === 'home') {
            statsToUse = enriched.filter(s => s.is_home === true);
          } else if (contextFilter === 'away') {
            statsToUse = enriched.filter(s => s.is_home === false);
          } else if (contextFilter === 'last5vsseason') {
            // Use all stats for trend detection but the delta will naturally reflect recent form
            statsToUse = enriched.length > 0 ? enriched : statsToUse;
          }
        }

        if (statsToUse.length < 4) return null;
        return detectTrend(player, statsToUse, statType);
      })
      .filter(Boolean) as NonNullable<ReturnType<typeof detectTrend>>[];

    if (filterTrend === 'all') return results;
    return results.filter(t => t.trend === filterTrend);
  }, [players, statsByPlayer, enrichedByPlayer, statType, filterTrend, contextFilter, topBottom]);

  const trendGroups = useMemo(() => ({
    breakout: trends.filter(t => t.trend === 'breakout'),
    improving: trends.filter(t => t.trend === 'improving'),
    declining: trends.filter(t => t.trend === 'declining'),
    stable: trends.filter(t => t.trend === 'stable'),
  }), [trends]);

  const hasData = allStats.length > 0;

  if (loading) return <LoadingSpinner message="Running trend analysis..." />;
  if (!hasData) return <EmptyState title="No Data for Trend Analysis" message="Import player_game_stats to enable the Trend Engine." />;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-emerald-400" />
          <h2 className="text-white font-bold text-lg">Trend Engine</h2>
        </div>
        <div className="flex items-center gap-2 flex-wrap ml-auto">
          <select
            value={statType}
            onChange={e => setStatType(e.target.value as StatType)}
            className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-emerald-500"
          >
            {STAT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select
            value={contextFilter}
            onChange={e => setContextFilter(e.target.value as ContextFilter)}
            className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-emerald-500"
          >
            {CONTEXT_FILTERS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
          <div className="flex gap-1">
            {(['all', 'breakout', 'improving', 'declining'] as const).map(f => (
              <button
                key={f}
                onClick={() => setFilterTrend(f)}
                className={`px-3 py-2 text-xs rounded-lg border capitalize transition ${
                  filterTrend === f
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                    : 'bg-gray-800 border-gray-700 text-gray-500 hover:text-white'
                }`}
              >
                {f === 'all' ? `All (${trends.length})` : `${f.charAt(0).toUpperCase() + f.slice(1)} (${trendGroups[f as keyof typeof trendGroups]?.length ?? 0})`}
              </button>
            ))}
          </div>
        </div>
      </div>

      {contextFilter === 'last5vsseason' && (
        <div className="flex items-center gap-2 p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg text-blue-400 text-xs">
          <Activity className="w-4 h-4 shrink-0" />
          Showing trend delta: last 5 games vs full-season average. Positive delta = player is trending above their season baseline.
        </div>
      )}

      {trends.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-gray-500">No trends detected — need at least 4 games per player for the selected filter.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {filterTrend === 'all' ? (
            <>
              {(['breakout', 'improving', 'declining', 'stable'] as const).map(cat => {
                const group = trendGroups[cat];
                if (group.length === 0) return null;
                const cfg = trendConfig[cat];
                const Icon = cfg.icon;
                return (
                  <div key={cat} className="bg-gray-900 border border-gray-800 rounded-xl">
                    <div className={`flex items-center gap-2 px-5 py-3 border-b border-gray-800`}>
                      <Icon className={`w-4 h-4 ${cfg.color}`} />
                      <h3 className={`font-semibold text-sm ${cfg.color}`}>{cfg.label}</h3>
                      <span className="text-gray-600 text-xs ml-1">({group.length} players)</span>
                    </div>
                    <div className="divide-y divide-gray-800/50">
                      {group.sort((a, b) => b.trendScore - a.trendScore).map(t => (
                        <TrendRow key={t.player.id} trend={t} statType={statType} contextFilter={contextFilter} />
                      ))}
                    </div>
                  </div>
                );
              })}
            </>
          ) : (
            <div className="bg-gray-900 border border-gray-800 rounded-xl">
              <div className="divide-y divide-gray-800/50">
                {trends.sort((a, b) => b.trendScore - a.trendScore).map(t => (
                  <TrendRow key={t.player.id} trend={t} statType={statType} contextFilter={contextFilter} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TrendRow({ trend, statType, contextFilter }: { trend: NonNullable<ReturnType<typeof detectTrend>>; statType: StatType; contextFilter: ContextFilter }) {
  const cfg = trendConfig[trend.trend];
  const Icon = cfg.icon;
  const sparkData = sortStatsByDate(trend.stats).slice(0, 8).reverse();

  // For last5vsseason, show last 5 avg vs season avg instead of recent3 vs recent10
  const last5Avg = calcAvgForStats(getLastN(trend.stats, 5), statType);
  const seasonAvg = calcAvgForStats(trend.stats, statType);
  const customDelta = contextFilter === 'last5vsseason' ? last5Avg - seasonAvg : trend.delta;
  const customRecent = contextFilter === 'last5vsseason' ? last5Avg : trend.recent3Avg;
  const customBaseline = contextFilter === 'last5vsseason' ? seasonAvg : trend.recent10Avg;

  return (
    <Link
      to={`/players/${trend.player.id}`}
      className="flex items-center gap-4 px-5 py-4 hover:bg-gray-800/50 transition group"
    >
      <div className={`w-8 h-8 rounded-lg border flex items-center justify-center shrink-0 ${cfg.bg}`}>
        <Icon className={`w-4 h-4 ${cfg.color}`} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-white text-sm font-semibold truncate group-hover:text-emerald-400 transition">{trend.player.name}</p>
          <span className={`text-xs px-1.5 py-0.5 rounded border ${cfg.bg} ${cfg.color} shrink-0`}>{cfg.label}</span>
        </div>
        <p className="text-gray-500 text-xs mt-0.5">{trend.player.team} &bull; {trend.stats.length} games</p>
      </div>
      {/* Mini sparkline */}
      <div className="hidden sm:flex items-end gap-0.5 h-8 shrink-0">
        {sparkData.map((s, i) => {
          const val = s[statType];
          const maxVal = Math.max(...sparkData.map(x => x[statType]), 1);
          const height = Math.max(4, Math.round((val / maxVal) * 28));
          const isRecent = i >= sparkData.length - 3;
          return (
            <div
              key={i}
              style={{ height }}
              className={`w-2 rounded-t-sm ${isRecent ? (trend.trend === 'declining' ? 'bg-red-500' : 'bg-emerald-500') : 'bg-gray-700'}`}
            />
          );
        })}
      </div>
      <div className="text-right shrink-0">
        <p className={`font-bold text-sm ${cfg.color}`}>
          {customDelta >= 0 ? '+' : ''}{customDelta.toFixed(1)}
        </p>
        <p className="text-gray-600 text-xs">
          {customRecent.toFixed(1)} vs {customBaseline.toFixed(1)}
        </p>
      </div>
      <ArrowRight className="w-4 h-4 text-gray-700 group-hover:text-emerald-400 transition shrink-0" />
    </Link>
  );
}
