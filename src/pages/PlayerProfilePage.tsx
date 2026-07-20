import { useMemo, useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ArrowLeft, TrendingUp, TrendingDown, Activity, Target, Minus
} from 'lucide-react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip,
  CartesianGrid, ReferenceLine
} from 'recharts';
import { usePlayerStats } from '../hooks/usePlayerData';
import { supabase } from '../lib/supabase';
import type { Player } from '../lib/types';
import type { StatType } from '../lib/types';
import {
  calcAvgForStats, consistencyRating, sortStatsByDate
} from '../lib/analytics';
import LoadingSpinner from '../components/LoadingSpinner';
import EmptyState from '../components/EmptyState';

const STAT_COLORS: Record<StatType, string> = {
  disposals: '#10b981',
  goals: '#f59e0b',
  tackles: '#06b6d4',
  marks: '#8b5cf6',
  hitouts: '#f97316',
};

const STAT_LABELS: Record<StatType, string> = {
  disposals: 'Disposals',
  goals: 'Goals',
  tackles: 'Tackles',
  marks: 'Marks',
  hitouts: 'Hitouts',
};

const ALL_STATS: StatType[] = ['disposals', 'goals', 'tackles', 'marks', 'hitouts'];

function StatCard({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-4">
      <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">{label}</p>
      <p className={`text-2xl font-bold ${color ?? 'text-white'}`}>{value}</p>
      {sub && <p className="text-xs text-gray-600 mt-0.5">{sub}</p>}
    </div>
  );
}

export default function PlayerProfilePage() {
  const { id } = useParams<{ id: string }>();
  const [player, setPlayer] = useState<Player | null>(null);
  const [playerLoading, setPlayerLoading] = useState(true);
  const { stats, loading: statsLoading } = usePlayerStats(id ?? null);
  const [activeStat, setActiveStat] = useState<StatType>('disposals');
  const [window, setWindow] = useState<3 | 5 | 10 | 'all'>(10);

  useEffect(() => {
    if (!id) return;
    supabase.from('players').select('*').eq('id', id).maybeSingle().then(({ data }) => {
      setPlayer(data);
      setPlayerLoading(false);
    });
  }, [id]);

  const sorted = useMemo(() => sortStatsByDate(stats), [stats]);

  const displayStats = useMemo(() => {
    if (window === 'all') return sorted;
    return sorted.slice(0, window);
  }, [sorted, window]);

  const chartData = useMemo(() => {
    return [...displayStats].reverse().map((s, i) => ({
      game: i + 1,
      date: s.match_date,
      opponent: s.opponent ?? 'Unknown',
      disposals: s.disposals,
      goals: s.goals,
      tackles: s.tackles,
      marks: s.marks,
      hitouts: s.hitouts,
    }));
  }, [displayStats]);

  const seasonAvg = useMemo(() => calcAvgForStats(sorted, activeStat), [sorted, activeStat]);
  const last3Avg = useMemo(() => calcAvgForStats(sorted.slice(0, 3), activeStat), [sorted, activeStat]);
  const last5Avg = useMemo(() => calcAvgForStats(sorted.slice(0, 5), activeStat), [sorted, activeStat]);
  const last10Avg = useMemo(() => calcAvgForStats(sorted.slice(0, 10), activeStat), [sorted, activeStat]);
  const consistency = useMemo(() => consistencyRating(stats.map(s => s[activeStat])), [stats, activeStat]);

  const maxVal = useMemo(() => Math.max(...stats.map(s => s[activeStat]), 0), [stats, activeStat]);

  const trend = useMemo(() => {
    if (sorted.length < 4) return 'stable';
    const r3 = calcAvgForStats(sorted.slice(0, 3), activeStat);
    const r10 = calcAvgForStats(sorted.slice(3, 10), activeStat);
    if (r10 === 0) return 'stable';
    const delta = ((r3 - r10) / r10) * 100;
    if (delta >= 15) return 'up';
    if (delta <= -15) return 'down';
    return 'stable';
  }, [sorted, activeStat]);

  if (playerLoading || statsLoading) return <LoadingSpinner message="Loading player profile..." />;
  if (!player) return (
    <div className="text-center py-20">
      <p className="text-gray-500">Player not found.</p>
      <Link to="/players" className="text-emerald-400 hover:underline text-sm mt-2 inline-block">Back to search</Link>
    </div>
  );

  const positionColors: Record<string, string> = {
    Forward: 'text-red-400 bg-red-500/10 border-red-500/20',
    Midfielder: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20',
    Defender: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
    Ruck: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  };

  return (
    <div className="space-y-6">
      {/* Back + Header */}
      <div className="flex items-start gap-4">
        <Link to="/players" className="mt-1 p-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg transition">
          <ArrowLeft className="w-4 h-4 text-gray-400" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold text-white">{player.name}</h1>
            {player.position && (
              <span className={`text-xs px-2.5 py-1 rounded-lg border font-medium ${positionColors[player.position] ?? 'text-gray-400 bg-gray-800 border-gray-700'}`}>
                {player.position}
              </span>
            )}
            <div className="flex items-center gap-2">
              {trend === 'up' && <TrendingUp className="w-4 h-4 text-emerald-400" />}
              {trend === 'down' && <TrendingDown className="w-4 h-4 text-red-400" />}
              {trend === 'stable' && <Minus className="w-4 h-4 text-gray-500" />}
            </div>
          </div>
          <p className="text-gray-500 text-sm mt-1">{player.team} &bull; {stats.length} games recorded</p>
        </div>
        <Link
          to={`/props?player=${player.id}`}
          className="flex items-center gap-2 px-4 py-2 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 rounded-lg text-sm hover:bg-emerald-500/20 transition"
        >
          <Target className="w-4 h-4" />
          Analyze Prop
        </Link>
      </div>

      {stats.length === 0 ? (
        <EmptyState
          title="No Stats for This Player"
          message="Import player_game_stats data for this player to see their profile."
          icon="warning"
        />
      ) : (
        <>
          {/* Stat Selector */}
          <div className="flex items-center gap-2 flex-wrap">
            {ALL_STATS.map(st => (
              <button
                key={st}
                onClick={() => setActiveStat(st)}
                style={activeStat === st ? { borderColor: STAT_COLORS[st], color: STAT_COLORS[st], backgroundColor: `${STAT_COLORS[st]}15` } : {}}
                className={`px-3 py-1.5 text-sm rounded-lg border transition ${
                  activeStat === st
                    ? 'font-semibold'
                    : 'border-gray-700 text-gray-500 bg-gray-800 hover:text-white hover:border-gray-600'
                }`}
              >
                {STAT_LABELS[st]}
              </button>
            ))}
            <div className="ml-auto flex gap-1">
              {([3, 5, 10, 'all'] as const).map(w => (
                <button
                  key={w}
                  onClick={() => setWindow(w)}
                  className={`px-2.5 py-1.5 text-xs rounded-lg border transition ${
                    window === w
                      ? 'border-gray-500 text-white bg-gray-700'
                      : 'border-gray-800 text-gray-600 hover:text-gray-400'
                  }`}
                >
                  {w === 'all' ? 'All' : `L${w}`}
                </button>
              ))}
            </div>
          </div>

          {/* Key Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <StatCard label="Season Avg" value={seasonAvg.toFixed(1)} color="text-white" />
            <StatCard label="Last 3" value={last3Avg.toFixed(1)} color={last3Avg > seasonAvg ? 'text-emerald-400' : 'text-red-400'} />
            <StatCard label="Last 5" value={last5Avg.toFixed(1)} color={last5Avg > seasonAvg ? 'text-emerald-400' : 'text-red-400'} />
            <StatCard label="Last 10" value={last10Avg.toFixed(1)} />
            <StatCard label="Consistency" value={`${consistency}/100`} color={consistency >= 70 ? 'text-cyan-400' : consistency >= 50 ? 'text-amber-400' : 'text-red-400'} />
            <StatCard label="Season High" value={maxVal} color="text-amber-400" />
          </div>

          {/* Chart */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-gray-400" />
                <h3 className="text-white font-semibold text-sm">{STAT_LABELS[activeStat]} — Game by Game</h3>
              </div>
              <p className="text-gray-600 text-xs">{chartData.length} games shown</p>
            </div>
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={chartData} margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
                <XAxis
                  dataKey="opponent"
                  tick={{ fill: '#6b7280', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: '#6b7280', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: 8 }}
                  labelStyle={{ color: '#9ca3af', fontSize: 11 }}
                  itemStyle={{ color: '#fff' }}
                  formatter={(val) => [val, STAT_LABELS[activeStat]]}
                  labelFormatter={(_, payload) => payload?.[0]?.payload?.date ?? ''}
                />
                <ReferenceLine
                  y={seasonAvg}
                  stroke="#374151"
                  strokeDasharray="4 4"
                  label={{ value: `Avg ${seasonAvg.toFixed(1)}`, fill: '#6b7280', fontSize: 10, position: 'right' }}
                />
                <Line
                  type="monotone"
                  dataKey={activeStat}
                  stroke={STAT_COLORS[activeStat]}
                  strokeWidth={2}
                  dot={{ fill: STAT_COLORS[activeStat], r: 3, strokeWidth: 0 }}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Game Log */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl">
            <div className="px-5 py-4 border-b border-gray-800">
              <h3 className="text-white font-semibold text-sm">Game Log</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800">
                    {['Date', 'Opponent', 'Venue', 'Disp', 'Marks', 'Tackles', 'Goals', 'HO'].map(h => (
                      <th key={h} className="px-4 py-2.5 text-left text-xs text-gray-500 uppercase tracking-wider font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/50">
                  {sorted.slice(0, 20).map(s => (
                    <tr key={s.id} className="hover:bg-gray-800/40 transition">
                      <td className="px-4 py-2.5 text-gray-400 text-xs font-mono whitespace-nowrap">{s.match_date}</td>
                      <td className="px-4 py-2.5 text-gray-300 whitespace-nowrap">{s.opponent ?? '—'}</td>
                      <td className="px-4 py-2.5 text-gray-500 text-xs whitespace-nowrap">{s.venue ?? '—'}</td>
                      <td className="px-4 py-2.5 text-white font-semibold">{s.disposals}</td>
                      <td className="px-4 py-2.5 text-gray-300">{s.marks}</td>
                      <td className="px-4 py-2.5 text-gray-300">{s.tackles}</td>
                      <td className="px-4 py-2.5 text-amber-400 font-semibold">{s.goals}</td>
                      <td className="px-4 py-2.5 text-gray-300">{s.hitouts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
