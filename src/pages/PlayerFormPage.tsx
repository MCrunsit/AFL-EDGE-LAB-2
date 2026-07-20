import { useState, useMemo, useEffect } from 'react';
import { User, TrendingUp, TrendingDown, Minus, MapPin, Users, ChevronDown } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { comparePlayerForm, type FormAnalysis } from '../lib/evEngine';
import type { Player, PlayerGameStat, StatType } from '../lib/types';
import PlayerCombobox from '../components/PlayerCombobox';
import LoadingSpinner from '../components/LoadingSpinner';
import EmptyState from '../components/EmptyState';

const STAT_OPTIONS: { value: StatType; label: string }[] = [
  { value: 'disposals', label: 'Disposals' },
  { value: 'goals', label: 'Goals' },
  { value: 'tackles', label: 'Tackles' },
  { value: 'marks', label: 'Marks' },
  { value: 'hitouts', label: 'Hitouts' },
];

function SparkBar({ values, line }: { values: number[]; line?: number }) {
  if (values.length === 0) return null;
  const maxVal = Math.max(...values, line ?? 0, 1);
  return (
    <div className="flex items-end gap-1 h-12">
      {values.map((v, i) => {
        const height = Math.max(4, Math.round((v / maxVal) * 44));
        const isRecent = i >= values.length - 3;
        const hitLine = line != null ? v > line : false;
        return (
          <div key={i} className="flex flex-col items-center gap-0.5">
            <span className="text-gray-600 text-[9px] font-mono">{v}</span>
            <div
              style={{ height }}
              className={`w-5 rounded-t-sm ${
                isRecent
                  ? hitLine ? 'bg-emerald-500' : 'bg-red-500/70'
                  : 'bg-gray-600'
              }`}
            />
          </div>
        );
      })}
    </div>
  );
}

function AdjFactor({ label, icon: Icon, avg, baseline, games }: {
  label: string;
  icon: React.ElementType;
  avg: number | null;
  baseline: number;
  games: number;
}) {
  if (avg === null || games === 0) {
    return (
      <div className="bg-gray-800/50 border border-gray-700/50 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-2">
          <Icon className="w-4 h-4 text-gray-500" />
          <span className="text-xs text-gray-500 uppercase tracking-wider">{label}</span>
        </div>
        <p className="text-gray-600 text-sm">No data</p>
      </div>
    );
  }

  const delta = avg - baseline;
  const pct = baseline > 0 ? (delta / baseline) * 100 : 0;
  const isPositive = delta > 0.5;
  const isNegative = delta < -0.5;

  return (
    <div className={`border rounded-xl p-4 ${
      isPositive ? 'bg-emerald-500/10 border-emerald-500/25' :
      isNegative ? 'bg-red-500/10 border-red-500/25' :
      'bg-gray-800/50 border-gray-700/50'
    }`}>
      <div className="flex items-center gap-2 mb-2">
        <Icon className={`w-4 h-4 ${isPositive ? 'text-emerald-400' : isNegative ? 'text-red-400' : 'text-gray-500'}`} />
        <span className="text-xs text-gray-500 uppercase tracking-wider">{label}</span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className={`text-2xl font-bold ${isPositive ? 'text-emerald-400' : isNegative ? 'text-red-400' : 'text-white'}`}>
          {avg.toFixed(1)}
        </span>
        <span className={`text-xs font-semibold ${isPositive ? 'text-emerald-400' : isNegative ? 'text-red-400' : 'text-gray-500'}`}>
          {pct >= 0 ? '+' : ''}{pct.toFixed(1)}%
        </span>
      </div>
      <p className="text-gray-500 text-xs mt-1">{games} games · baseline {baseline.toFixed(1)}</p>
    </div>
  );
}

export default function PlayerFormPage() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [playersLoading, setPlayersLoading] = useState(true);
  const [selectedPlayerId, setSelectedPlayerId] = useState('');
  const [statType, setStatType] = useState<StatType>('disposals');
  const [stats, setStats] = useState<PlayerGameStat[]>([]);
  const [opponentStats, setOpponentStats] = useState<PlayerGameStat[]>([]);
  const [venueStats, setVenueStats] = useState<PlayerGameStat[]>([]);
  const [statsLoading, setStatsLoading] = useState(false);
  const [opponentFilter, setOpponentFilter] = useState('');
  const [venueFilter, setVenueFilter] = useState('');
  const [lineInput, setLineInput] = useState('');

  useEffect(() => {
    supabase.from('current_players').select('*').order('name').then(({ data }) => {
      setPlayers(data ?? []);
      setPlayersLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!selectedPlayerId) { setStats([]); return; }
    setStatsLoading(true);
    supabase
      .from('player_game_stats')
      .select('*')
      .eq('player_id', selectedPlayerId)
      .order('match_date', { ascending: false })
      .then(({ data }) => {
        setStats(data ?? []);
        setStatsLoading(false);
      });
  }, [selectedPlayerId]);

  useEffect(() => {
    if (!selectedPlayerId || !opponentFilter) { setOpponentStats([]); return; }
    supabase
      .from('player_game_stats')
      .select('*')
      .eq('player_id', selectedPlayerId)
      .ilike('opponent', `%${opponentFilter}%`)
      .order('match_date', { ascending: false })
      .then(({ data }) => setOpponentStats(data ?? []));
  }, [selectedPlayerId, opponentFilter]);

  useEffect(() => {
    if (!selectedPlayerId || !venueFilter) { setVenueStats([]); return; }
    supabase
      .from('player_game_stats')
      .select('*')
      .eq('player_id', selectedPlayerId)
      .ilike('venue', `%${venueFilter}%`)
      .order('match_date', { ascending: false })
      .then(({ data }) => setVenueStats(data ?? []));
  }, [selectedPlayerId, venueFilter]);

  const form = useMemo((): FormAnalysis | null => {
    if (stats.length === 0) return null;
    return comparePlayerForm(stats, statType, {
      opponentStats: opponentStats.length > 0 ? opponentStats : undefined,
      venueStats: venueStats.length > 0 ? venueStats : undefined,
    });
  }, [stats, statType, opponentStats, venueStats]);

  const sorted = useMemo(() => [...stats].sort((a, b) => new Date(b.match_date).getTime() - new Date(a.match_date).getTime()), [stats]);
  const last5Values = useMemo(() => sorted.slice(0, 5).reverse().map(s => Number((s as Record<string, unknown>)[statType]) || 0), [sorted, statType]);
  const allValues = useMemo(() => sorted.map(s => Number((s as Record<string, unknown>)[statType]) || 0), [sorted, statType]);
  const line = parseFloat(lineInput) || undefined;

  const hitRateLast5 = useMemo(() => {
    if (!line || last5Values.length === 0) return null;
    return last5Values.filter(v => v > line).length / last5Values.length;
  }, [last5Values, line]);

  const hitRateSeason = useMemo(() => {
    if (!line || allValues.length === 0) return null;
    return allValues.filter(v => v > line).length / allValues.length;
  }, [allValues, line]);

  const adjustedProb = useMemo(() => {
    if (!form || !line) return null;
    return form.adjusted_prob_over(line);
  }, [form, line]);

  const trendDir = form
    ? form.last5_avg > form.season_avg * 1.1 ? 'up'
    : form.last5_avg < form.season_avg * 0.9 ? 'down'
    : 'stable'
    : null;

  const opponents = useMemo(() => [...new Set(stats.map(s => s.opponent).filter(Boolean))].sort(), [stats]);
  const venues = useMemo(() => [...new Set(stats.map(s => s.venue).filter(Boolean))].sort(), [stats]);

  if (playersLoading) return <LoadingSpinner message="Loading players..." />;
  if (players.length === 0) return <EmptyState title="No Players" message="Import player data first." />;

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center gap-3">
        <User className="w-5 h-5 text-emerald-400" />
        <h2 className="text-white font-bold text-lg">Player Form Module</h2>
      </div>

      {/* Controls */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="sm:col-span-1">
          <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Player</label>
          <PlayerCombobox players={players} value={selectedPlayerId} onChange={setSelectedPlayerId} placeholder="Search player..." />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Stat Type</label>
          <div className="relative">
            <select
              value={statType}
              onChange={e => setStatType(e.target.value as StatType)}
              className="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-3 text-white text-sm focus:outline-none focus:border-emerald-500 appearance-none"
            >
              {STAT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Bookmaker Line (optional)</label>
          <input
            type="number"
            value={lineInput}
            onChange={e => setLineInput(e.target.value)}
            placeholder="e.g. 27.5"
            step="0.5"
            className="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-3 text-white text-sm focus:outline-none focus:border-emerald-500"
          />
        </div>
      </div>

      {selectedPlayerId && statsLoading && <LoadingSpinner message="Loading stats..." />}

      {form && (
        <>
          {/* Form Score + Trend */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Form Score</p>
              <p className={`text-3xl font-bold ${form.form_score >= 70 ? 'text-emerald-400' : form.form_score >= 50 ? 'text-amber-400' : 'text-red-400'}`}>
                {form.form_score}
              </p>
              <p className="text-gray-600 text-xs mt-0.5">/ 100</p>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Last 5 Avg</p>
              <div className="flex items-center gap-2">
                <p className="text-2xl font-bold text-white">{form.last5_avg.toFixed(1)}</p>
                {trendDir === 'up' && <TrendingUp className="w-4 h-4 text-emerald-400" />}
                {trendDir === 'down' && <TrendingDown className="w-4 h-4 text-red-400" />}
                {trendDir === 'stable' && <Minus className="w-4 h-4 text-gray-500" />}
              </div>
              <p className="text-gray-600 text-xs mt-0.5">Season: {form.season_avg.toFixed(1)}</p>
            </div>
            {hitRateLast5 !== null && (
              <div className={`border rounded-xl p-4 ${hitRateLast5 >= 0.6 ? 'bg-emerald-500/10 border-emerald-500/25' : hitRateLast5 >= 0.4 ? 'bg-gray-900 border-gray-800' : 'bg-red-500/10 border-red-500/25'}`}>
                <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Hit Rate L5</p>
                <p className={`text-2xl font-bold ${hitRateLast5 >= 0.6 ? 'text-emerald-400' : hitRateLast5 >= 0.4 ? 'text-white' : 'text-red-400'}`}>
                  {(hitRateLast5 * 100).toFixed(0)}%
                </p>
                <p className="text-gray-600 text-xs mt-0.5">over {line?.toFixed(1)}</p>
              </div>
            )}
            {hitRateSeason !== null && (
              <div className={`border rounded-xl p-4 ${hitRateSeason >= 0.6 ? 'bg-emerald-500/10 border-emerald-500/25' : hitRateSeason >= 0.4 ? 'bg-gray-900 border-gray-800' : 'bg-red-500/10 border-red-500/25'}`}>
                <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Hit Rate Season</p>
                <p className={`text-2xl font-bold ${hitRateSeason >= 0.6 ? 'text-emerald-400' : hitRateSeason >= 0.4 ? 'text-white' : 'text-red-400'}`}>
                  {(hitRateSeason * 100).toFixed(0)}%
                </p>
                <p className="text-gray-600 text-xs mt-0.5">{allValues.length} games</p>
              </div>
            )}
            {adjustedProb !== null && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Adjusted Prob</p>
                <p className={`text-2xl font-bold ${adjustedProb >= 0.55 ? 'text-emerald-400' : adjustedProb >= 0.45 ? 'text-white' : 'text-red-400'}`}>
                  {(adjustedProb * 100).toFixed(1)}%
                </p>
                <p className="text-gray-600 text-xs mt-0.5">opponent + venue adj.</p>
              </div>
            )}
          </div>

          {/* Sparkline: Last 5 */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-4">Last 5 Games — {statType}</p>
            <SparkBar values={last5Values} line={line} />
            {line && (
              <div className="flex items-center gap-2 mt-3">
                <div className="w-3 h-px bg-amber-400" />
                <span className="text-xs text-gray-500">Line: {line.toFixed(1)}</span>
              </div>
            )}
          </div>

          {/* Context Filters */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Opponent Filter</label>
              <div className="relative">
                <select
                  value={opponentFilter}
                  onChange={e => setOpponentFilter(e.target.value)}
                  className="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-3 text-white text-sm focus:outline-none focus:border-emerald-500 appearance-none"
                >
                  <option value="">All opponents</option>
                  {opponents.map(o => <option key={o} value={o!}>{o}</option>)}
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Venue Filter</label>
              <div className="relative">
                <select
                  value={venueFilter}
                  onChange={e => setVenueFilter(e.target.value)}
                  className="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-3 text-white text-sm focus:outline-none focus:border-emerald-500 appearance-none"
                >
                  <option value="">All venues</option>
                  {venues.map(v => <option key={v} value={v!}>{v}</option>)}
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
              </div>
            </div>
          </div>

          {/* Adjustment Factors */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <AdjFactor
              label="vs Opponent"
              icon={Users}
              avg={form.opponent_avg}
              baseline={form.season_avg}
              games={form.opponent_games}
            />
            <AdjFactor
              label="At Venue"
              icon={MapPin}
              avg={form.venue_avg}
              baseline={form.season_avg}
              games={form.venue_games}
            />
          </div>

          {/* Recent Game Log */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-800 flex items-center justify-between">
              <h3 className="text-white font-semibold text-sm">Last 5 Games</h3>
              <span className="text-xs text-gray-500">{statType}</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-gray-500 border-b border-gray-700/30">
                    <th className="text-left px-4 py-2.5 font-medium">Date</th>
                    <th className="text-left px-4 py-2.5 font-medium">Opponent</th>
                    <th className="text-left px-4 py-2.5 font-medium">Venue</th>
                    <th className="text-center px-4 py-2.5 font-medium">{statType}</th>
                    {line && <th className="text-center px-4 py-2.5 font-medium">vs Line</th>}
                  </tr>
                </thead>
                <tbody>
                  {sorted.slice(0, 5).map(s => {
                    const val = Number((s as Record<string, unknown>)[statType]) || 0;
                    const hit = line ? val > line : null;
                    return (
                      <tr key={s.id} className="border-b border-gray-800/30 hover:bg-gray-800/30 transition">
                        <td className="px-4 py-2.5 text-gray-400 text-xs font-mono">{s.match_date}</td>
                        <td className="px-4 py-2.5 text-gray-300">{s.opponent ?? '—'}</td>
                        <td className="px-4 py-2.5 text-gray-500 text-xs">{s.venue ?? '—'}</td>
                        <td className={`px-4 py-2.5 text-center font-bold ${hit === true ? 'text-emerald-400' : hit === false ? 'text-red-400' : 'text-white'}`}>{val}</td>
                        {line && (
                          <td className="px-4 py-2.5 text-center">
                            {hit === true
                              ? <span className="text-emerald-400 text-xs font-bold">HIT</span>
                              : <span className="text-red-400 text-xs font-bold">MISS</span>
                            }
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {selectedPlayerId && !statsLoading && stats.length === 0 && (
        <EmptyState title="No Stats for This Player" message="Import player_game_stats CSV for this player to enable the Form Module." />
      )}
    </div>
  );
}
