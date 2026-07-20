import { useState, useEffect, useMemo, useRef } from 'react';
import { Users, Search, Save, ChevronDown, RefreshCw, Upload, Download, AlertCircle, Zap } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { POSITION_GROUPS } from '../lib/types';
import { autoAssignPositionGroups } from '../lib/positionEdge';
import LoadingSpinner from '../components/LoadingSpinner';

interface Player {
  id: string;
  name: string;
  team: string;
  position: string | null;
  position_group: string | null;
}

const AFL_TEAMS = [
  'ADEL', 'BL', 'CARL', 'COL', 'ESS', 'FRE', 'GEE', 'GCS', 'GWS',
  'HAW', 'MEL', 'NTH', 'PORT', 'RICH', 'STK', 'SYD', 'WCE', 'WB',
];

const POSITION_GROUP_LABELS: Record<string, string> = {
  'DEF-USER': 'Defender - User',
  'DEF-KEY': 'Defender - Key',
  'DEF-GEN': 'Defender - General',
  'MID-IN': 'Midfield - Inside',
  'MID-OUT': 'Midfield - Outside',
  'MID-FWD': 'Midfield - Forward',
  'WING': 'Wing',
  'FWD-KEY': 'Forward - Key',
  'FWD-SML': 'Forward - Small',
  'FWD-GEN': 'Forward - General',
  'RUC-TAP': 'Ruck - Tap',
  'RUC-MOB': 'Ruck - Mobile',
  'RUC-FWD': 'Ruck - Forward',
  'UNKNOWN': 'Unknown',
};

type TabType = 'all' | 'currentRound';

export default function PositionGroupsPage() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [currentRoundPlayerIds, setCurrentRoundPlayerIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [teamFilter, setTeamFilter] = useState('all');
  const [positionFilter, setPositionFilter] = useState('all');
  const [unknownOnly, setUnknownOnly] = useState(false);
  const [activeTab, setActiveTab] = useState<TabType>('all');
  const [message, setMessage] = useState<string | null>(null);
  const [csvMessage, setCsvMessage] = useState<string | null>(null);
  const [autoAssigning, setAutoAssigning] = useState(false);
  const [autoAssignMessage, setAutoAssignMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadAll();
  }, []);

  async function loadAll() {
    setLoading(true);
    await Promise.all([loadPlayers(), loadCurrentRoundPlayerIds()]);
    setLoading(false);
  }

  async function loadPlayers() {
    const { data } = await supabase
      .from('players')
      .select('id, name, team, position, position_group')
      .order('name');
    setPlayers(data ?? []);
  }

  async function loadCurrentRoundPlayerIds() {
    const { data } = await supabase
      .from('bookmaker_odds')
      .select('player_id')
      .not('player_id', 'is', null);

    if (data) {
      const ids = new Set(data.map(d => d.player_id).filter(Boolean) as string[]);
      setCurrentRoundPlayerIds(ids);
    }
  }

  const filtered = useMemo(() => {
    let pool = players;

    if (activeTab === 'currentRound') {
      pool = pool.filter(p => currentRoundPlayerIds.has(p.id));
    }

    return pool.filter(p => {
      if (teamFilter !== 'all' && p.team !== teamFilter) return false;
      if (positionFilter !== 'all' && (p.position_group ?? 'UNKNOWN') !== positionFilter) return false;
      if (unknownOnly && (p.position_group ?? 'UNKNOWN') !== 'UNKNOWN') return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        if (!p.name.toLowerCase().includes(q) && !p.team.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [players, search, teamFilter, positionFilter, unknownOnly, activeTab, currentRoundPlayerIds]);

  async function savePositionGroup(playerId: string, positionGroup: string) {
    setSaving(playerId);
    const { error } = await supabase
      .from('players')
      .update({ position_group: positionGroup })
      .eq('id', playerId);

    setSaving(null);
    if (!error) {
      setPlayers(prev => prev.map(p => p.id === playerId ? { ...p, position_group: positionGroup } : p));
      setMessage('Saved');
      setTimeout(() => setMessage(null), 2000);
    } else {
      setMessage('Error saving');
      setTimeout(() => setMessage(null), 3000);
    }
  }

  const stats = useMemo(() => {
    const byGroup: Record<string, number> = {};
    for (const p of players) {
      const group = p.position_group ?? 'UNKNOWN';
      byGroup[group] = (byGroup[group] ?? 0) + 1;
    }
    return byGroup;
  }, [players]);

  const mappingStats = useMemo(() => {
    const total = players.length;
    const mapped = players.filter(p => p.position_group && p.position_group !== 'UNKNOWN').length;
    const unknown = total - mapped;
    const pct = total > 0 ? Math.round((mapped / total) * 100) : 0;
    return { total, mapped, unknown, pct };
  }, [players]);

  const currentRoundStats = useMemo(() => {
    const roundPlayers = players.filter(p => currentRoundPlayerIds.has(p.id));
    const total = roundPlayers.length;
    const mapped = roundPlayers.filter(p => p.position_group && p.position_group !== 'UNKNOWN').length;
    const unknown = total - mapped;
    const pct = total > 0 ? Math.round((mapped / total) * 100) : 0;
    return { total, mapped, unknown, pct };
  }, [players, currentRoundPlayerIds]);

  function exportCSV() {
    const rows = filtered.map(p =>
      `${p.name},${p.team},${p.position_group ?? 'UNKNOWN'}`
    );
    const csv = 'player_name,team,position_group\n' + rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'position_groups.csv';
    a.click();
    URL.revokeObjectURL(url);
    setMessage('CSV exported');
    setTimeout(() => setMessage(null), 2000);
  }

  async function handleCSVImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const text = await file.text();
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length < 2) {
      setCsvMessage('CSV must have a header row and at least one data row');
      setTimeout(() => setCsvMessage(null), 4000);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    const header = lines[0].toLowerCase().split(',').map(h => h.trim());
    const nameIdx = header.indexOf('player_name');
    const teamIdx = header.indexOf('team');
    const posIdx = header.indexOf('position_group');

    if (nameIdx === -1 || posIdx === -1) {
      setCsvMessage('CSV must have columns: player_name,team,position_group');
      setTimeout(() => setCsvMessage(null), 4000);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    let updated = 0;
    let skipped = 0;

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.trim());
      const name = cols[nameIdx];
      const team = teamIdx >= 0 ? cols[teamIdx] : null;
      const posGroup = cols[posIdx];

      if (!name || !posGroup) { skipped++; continue; }

      let query = supabase.from('players').update({ position_group: posGroup }).ilike('name', name);
      if (team) query = query.eq('team', team);
      const { error } = await query;
      if (error) { skipped++; } else { updated++; }
    }

    await loadPlayers();
    setCsvMessage(`Imported: ${updated} updated, ${skipped} skipped`);
    setTimeout(() => setCsvMessage(null), 5000);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function handleAutoAssign() {
    setAutoAssigning(true);
    setAutoAssignMessage(null);
    try {
      const result = await autoAssignPositionGroups();
      setAutoAssignMessage(`Auto-assigned ${result.updated} players (${result.skipped} skipped — UNKNOWN or insufficient games)`);
      await loadPlayers();
    } catch (err) {
      setAutoAssignMessage(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
    setAutoAssigning(false);
    setTimeout(() => setAutoAssignMessage(null), 6000);
  }

  if (loading) return <LoadingSpinner message="Loading players..." />;

  const activeStats = activeTab === 'currentRound' ? currentRoundStats : mappingStats;

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center gap-3 flex-wrap">
        <Users className="w-5 h-5 text-emerald-400" />
        <h2 className="text-white font-bold text-lg">Player Position Groups</h2>
        <span className="text-xs text-gray-500">{activeStats.total} players</span>
        {message && (
          <span className="text-xs px-2.5 py-1 bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 rounded-full">
            {message}
          </span>
        )}
      </div>

      {/* Mapping Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-3">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider">Total Players</p>
          <p className="text-white font-bold text-xl">{activeStats.total}</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-3">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider">Mapped</p>
          <p className="text-emerald-400 font-bold text-xl">{activeStats.mapped}</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-3">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider">UNKNOWN</p>
          <p className="text-amber-400 font-bold text-xl">{activeStats.unknown}</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-3">
          <p className="text-[10px] text-gray-500 uppercase tracking-wider">% Mapped</p>
          <p className="text-white font-bold text-xl">{activeStats.pct}%</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2">
        <button
          onClick={() => { setActiveTab('all'); setUnknownOnly(false); }}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
            activeTab === 'all'
              ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
              : 'bg-gray-800 text-gray-400 border border-gray-700 hover:bg-gray-700'
          }`}
        >
          All Players
        </button>
        <button
          onClick={() => setActiveTab('currentRound')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
            activeTab === 'currentRound'
              ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
              : 'bg-gray-800 text-gray-400 border border-gray-700 hover:bg-gray-700'
          }`}
        >
          Current Round Players ({currentRoundStats.total})
        </button>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-3 sm:grid-cols-7 gap-2">
        {POSITION_GROUPS.filter(g => (stats[g] ?? 0) > 0).map(group => (
          <div key={group} className="bg-gray-900 border border-gray-800 rounded-lg p-2 text-center">
            <p className="text-white font-bold text-sm">{stats[group] ?? 0}</p>
            <p className="text-[10px] text-gray-500 truncate">{group}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search player or team..."
            className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500"
          />
        </div>
        <select
          value={teamFilter}
          onChange={e => setTeamFilter(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
        >
          <option value="all">All Teams</option>
          {AFL_TEAMS.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select
          value={positionFilter}
          onChange={e => setPositionFilter(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
        >
          <option value="all">All Positions</option>
          {POSITION_GROUPS.map(g => (
            <option key={g} value={g}>{POSITION_GROUP_LABELS[g] ?? g}</option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
          <input
            type="checkbox"
            checked={unknownOnly}
            onChange={e => setUnknownOnly(e.target.checked)}
            className="accent-amber-500"
          />
          UNKNOWN only
        </label>
        <button
          onClick={loadAll}
          className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-400 hover:bg-gray-700 transition flex items-center gap-2"
        >
          <RefreshCw className="w-4 h-4" />
          Refresh
        </button>
        <button
          onClick={exportCSV}
          className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-400 hover:bg-gray-700 transition flex items-center gap-2"
        >
          <Download className="w-4 h-4" />
          Export CSV
        </button>
        <button
          onClick={() => fileInputRef.current?.click()}
          className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-400 hover:bg-gray-700 transition flex items-center gap-2"
        >
          <Upload className="w-4 h-4" />
          Import CSV
        </button>
        <button
          onClick={handleAutoAssign}
          disabled={autoAssigning}
          className="px-3 py-2 bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded-lg text-sm hover:bg-emerald-500/30 disabled:opacity-50 flex items-center gap-2"
        >
          <Zap className="w-4 h-4" />
          {autoAssigning ? 'Assigning...' : 'Auto Assign All'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv"
          onChange={handleCSVImport}
          className="hidden"
        />
      </div>

      {csvMessage && (
        <div className="flex items-center gap-2 text-xs text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {csvMessage}
        </div>
      )}

      {autoAssignMessage && (
        <div className="flex items-center gap-2 text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">
          <Zap className="w-4 h-4 shrink-0" />
          {autoAssignMessage}
        </div>
      )}

      {/* Player List */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto max-h-[600px]">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-800">
              <tr className="text-xs text-gray-500 uppercase tracking-wider border-b border-gray-700">
                <th className="text-left px-4 py-3 font-medium">Player</th>
                <th className="text-left px-3 py-3 font-medium">Team</th>
                <th className="text-left px-3 py-3 font-medium">Position</th>
                <th className="text-left px-3 py-3 font-medium">Position Group</th>
                <th className="text-center px-3 py-3 font-medium">Save</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(player => {
                const isUnknown = !player.position_group || player.position_group === 'UNKNOWN';
                const inCurrentRound = currentRoundPlayerIds.has(player.id);
                return (
                  <tr key={player.id} className="border-b border-gray-800/30 hover:bg-gray-800/30 transition">
                    <td className="px-4 py-2.5 text-white font-medium">
                      <div className="flex items-center gap-2">
                        {player.name}
                        {inCurrentRound && (
                          <span className="text-[9px] px-1.5 py-0.5 bg-blue-500/20 text-blue-400 rounded-full border border-blue-500/30">ROUND</span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-gray-400">{player.team}</td>
                    <td className="px-3 py-2.5 text-gray-500">{player.position ?? '—'}</td>
                    <td className="px-3 py-2.5">
                      <div className="relative">
                        <select
                          defaultValue={player.position_group ?? 'UNKNOWN'}
                          onChange={e => {
                            savePositionGroup(player.id, e.target.value);
                          }}
                          disabled={saving === player.id}
                          className={`w-full bg-gray-800 border rounded-lg px-3 py-1.5 text-sm text-white appearance-none pr-8 disabled:opacity-50 focus:outline-none ${
                            isUnknown ? 'border-amber-500/50' : 'border-gray-700 focus:border-emerald-500'
                          }`}
                        >
                          {POSITION_GROUPS.map(g => (
                            <option key={g} value={g}>{POSITION_GROUP_LABELS[g] ?? g}</option>
                          ))}
                        </select>
                        <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      {saving === player.id ? (
                        <span className="text-xs text-gray-500">Saving...</span>
                      ) : (
                        <button
                          onClick={(e) => {
                            const select = e.currentTarget.closest('tr')?.querySelector('select') as HTMLSelectElement;
                            if (select) savePositionGroup(player.id, select.value);
                          }}
                          className="p-1.5 bg-emerald-500/20 text-emerald-400 rounded hover:bg-emerald-500/30 transition"
                          title="Save"
                        >
                          <Save className="w-4 h-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                    No players match filters
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
