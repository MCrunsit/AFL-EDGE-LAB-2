import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Search, User, ChevronRight, Filter } from 'lucide-react';
import { usePlayers } from '../hooks/usePlayerData';
import LoadingSpinner from '../components/LoadingSpinner';
import EmptyState from '../components/EmptyState';

const POSITIONS = ['All', 'Forward', 'Midfielder', 'Defender', 'Ruck'];

export default function PlayerSearchPage() {
  const { players, loading } = usePlayers();
  const [query, setQuery] = useState('');
  const [teamFilter, setTeamFilter] = useState('All');
  const [posFilter, setPosFilter] = useState('All');

  const teams = useMemo(() => {
    const t = Array.from(new Set(players.map(p => p.team))).sort();
    return ['All', ...t];
  }, [players]);

  const filtered = useMemo(() => {
    return players.filter(p => {
      const matchesQuery = query === '' ||
        p.name.toLowerCase().includes(query.toLowerCase()) ||
        p.team.toLowerCase().includes(query.toLowerCase());
      const matchesTeam = teamFilter === 'All' || p.team === teamFilter;
      const matchesPos = posFilter === 'All' || p.position === posFilter;
      return matchesQuery && matchesTeam && matchesPos;
    });
  }, [players, query, teamFilter, posFilter]);

  if (loading) return <LoadingSpinner message="Loading players..." />;

  const positionColors: Record<string, string> = {
    Forward: 'text-red-400 bg-red-500/10 border-red-500/20',
    Midfielder: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20',
    Defender: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
    Ruck: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  };

  return (
    <div className="space-y-5">
      {/* Search & Filter */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search by player name or team..."
            className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-10 pr-4 py-3 text-white placeholder-gray-600 text-sm focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/30 transition"
          />
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <Filter className="w-4 h-4 text-gray-500 shrink-0" />
          <div className="flex flex-wrap gap-2">
            <select
              value={teamFilter}
              onChange={e => setTeamFilter(e.target.value)}
              className="bg-gray-800 border border-gray-700 text-gray-300 text-xs rounded-lg px-3 py-1.5 focus:outline-none focus:border-emerald-500"
            >
              {teams.map(t => <option key={t}>{t}</option>)}
            </select>
            {POSITIONS.map(pos => (
              <button
                key={pos}
                onClick={() => setPosFilter(pos)}
                className={`px-3 py-1.5 text-xs rounded-lg border transition ${
                  posFilter === pos
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                    : 'bg-gray-800 border-gray-700 text-gray-500 hover:text-white'
                }`}
              >
                {pos}
              </button>
            ))}
          </div>
          <span className="ml-auto text-xs text-gray-600">{filtered.length} players</span>
        </div>
      </div>

      {players.length === 0 ? (
        <EmptyState title="No Players Imported" message="Import a players CSV to begin." />
      ) : filtered.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-gray-500">No players match your search.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map(player => (
            <Link
              key={player.id}
              to={`/players/${player.id}`}
              className="bg-gray-900 border border-gray-800 rounded-xl p-4 hover:border-emerald-500/30 hover:bg-gray-800/50 transition group"
            >
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 bg-gray-800 border border-gray-700 rounded-lg flex items-center justify-center shrink-0">
                  <User className="w-5 h-5 text-gray-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-white font-semibold text-sm truncate group-hover:text-emerald-400 transition">{player.name}</p>
                  <p className="text-gray-500 text-xs mt-0.5">{player.team}</p>
                  {player.position && (
                    <span className={`inline-block mt-1.5 text-xs px-2 py-0.5 rounded border ${positionColors[player.position] ?? 'text-gray-400 bg-gray-800 border-gray-700'}`}>
                      {player.position}
                    </span>
                  )}
                </div>
                <ChevronRight className="w-4 h-4 text-gray-600 group-hover:text-emerald-400 transition mt-1 shrink-0" />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
