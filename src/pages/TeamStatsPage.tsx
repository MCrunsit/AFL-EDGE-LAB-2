import { useState, useEffect } from 'react';
import { Trophy, TrendingUp, TrendingDown, Minus, Loader2, AlertCircle } from 'lucide-react';
import { loadTeamDisposalStats, type TeamDisposalStats, type TeamMatchupEnvironment, type TeamStatsDiagnostics, getLabelDisplay } from '../lib/teamStatsService';
import { buildTeamEnvironmentMap } from '../lib/teamStatsService';
import type { Match } from '../lib/types';
import { supabase } from '../lib/supabase';

type View = 'rankings' | 'matchups' | 'history';

export default function TeamStatsPage() {
  const [view, setView] = useState<View>('rankings');
  const [stats, setStats] = useState<TeamDisposalStats[]>([]);
  const [teamDiag, setTeamDiag] = useState<TeamStatsDiagnostics | null>(null);
  const [matchups, setMatchups] = useState<TeamMatchupEnvironment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [upcomingMatches, setUpcomingMatches] = useState<Match[]>([]);
  const [historyMatches, setHistoryMatches] = useState<Match[]>([]);
  const [selectedHistoryMatch, setSelectedHistoryMatch] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const { data: fixtures } = await supabase
          .from('matches')
          .select('*')
          .eq('season', 2026)
          .order('match_date', { ascending: true });

        const allMatches = (fixtures ?? []) as Match[];
        const today = new Date().toISOString().split('T')[0];
        const upcoming = allMatches.filter(m => m.match_date != null && m.match_date >= today);
        const completed = allMatches.filter(m => m.match_date != null && m.match_date < today).reverse();
        setUpcomingMatches(upcoming);
        setHistoryMatches(completed);

        const { stats: teamStats, matchups: teamMatchups } = await buildTeamEnvironmentMap(upcoming, 2026);
        const { stats: rawStats, diagnostics: rawDiag } = await loadTeamDisposalStats(2026);
        setTeamDiag(rawDiag);
        setStats(teamStats);
        setMatchups(teamMatchups);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-emerald-400" />
        <span className="ml-3 text-gray-400 text-sm">Loading team stats…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-900/20 border border-red-500/30 rounded-xl p-4">
        <div className="flex items-center gap-2 text-red-400 font-medium">
          <AlertCircle className="w-4 h-4" /> Error loading team stats
        </div>
        <p className="text-red-400 text-sm mt-1">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="bg-gray-900 border border-emerald-500/20 rounded-xl p-4">
        <div className="flex items-center gap-3">
          <Trophy className="w-5 h-5 text-emerald-400" />
          <div>
            <h2 className="text-white font-semibold text-sm">Team Stats</h2>
            <p className="text-gray-500 text-xs">Team Disposal Environment · Complete matches only · Display Only mode</p>
          </div>
        </div>
      </div>

      {/* View tabs */}
      <div className="flex gap-2">
        {(['rankings', 'matchups', 'history'] as View[]).map(v => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`px-4 py-2 text-xs font-medium rounded-lg transition capitalize ${view === v ? 'bg-emerald-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}
          >
            {v === 'rankings' ? 'Team Rankings' : v === 'matchups' ? 'Upcoming Matchups' : 'Matchup History'}
          </button>
        ))}
      </div>

      {/* Rankings view */}
      {view === 'rankings' && stats.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-800 text-gray-500">
                <th className="text-left py-2 px-3">Team</th>
                <th className="text-right py-2 px-3">Season For</th>
                <th className="text-right py-2 px-3">Season Conceded</th>
                <th className="text-right py-2 px-3">Last 5 For</th>
                <th className="text-right py-2 px-3">Last 5 Conceded</th>
                <th className="text-right py-2 px-3">Home For</th>
                <th className="text-right py-2 px-3">Away For</th>
                <th className="text-right py-2 px-3">For Rank</th>
                <th className="text-right py-2 px-3">Conceded Rank</th>
                <th className="text-center py-2 px-3">Trend</th>
                <th className="text-right py-2 px-3">Games</th>
              </tr>
            </thead>
            <tbody>
              {stats.map(s => (
                <tr key={s.team} className="border-b border-gray-800/30 hover:bg-gray-800/30">
                  <td className="py-2 px-3 text-white font-medium">{s.team}</td>
                  <td className="py-2 px-3 text-right text-gray-300">{s.seasonFor}</td>
                  <td className="py-2 px-3 text-right text-gray-300">{s.seasonConceded}</td>
                  <td className="py-2 px-3 text-right text-cyan-400">{s.last5For}</td>
                  <td className="py-2 px-3 text-right text-amber-400">{s.last5Conceded}</td>
                  <td className="py-2 px-3 text-right text-gray-400">{s.homeFor > 0 ? s.homeFor : '—'}</td>
                  <td className="py-2 px-3 text-right text-gray-400">{s.awayFor > 0 ? s.awayFor : '—'}</td>
                  <td className="py-2 px-3 text-right text-emerald-400 font-bold">{s.forRank}</td>
                  <td className="py-2 px-3 text-right text-emerald-400 font-bold">{s.concededRank}</td>
                  <td className="py-2 px-3 text-center">
                    {s.trend === 'up' && <TrendingUp className="w-3.5 h-3.5 text-emerald-400 inline" />}
                    {s.trend === 'down' && <TrendingDown className="w-3.5 h-3.5 text-red-400 inline" />}
                    {s.trend === 'stable' && <Minus className="w-3.5 h-3.5 text-gray-500 inline" />}
                  </td>
                  <td className="py-2 px-3 text-right text-gray-500">{s.seasonGames}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {teamDiag && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mt-3">
              <h4 className="text-xs font-semibold text-gray-500 uppercase mb-2">Coverage Diagnostics</h4>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs mb-3">
                <div className="bg-gray-800 rounded p-2"><p className="text-[10px] text-gray-500 uppercase">Completed Matches</p><p className="text-white font-bold">{teamDiag.totalCompletedMatches}</p></div>
                <div className="bg-gray-800 rounded p-2"><p className="text-[10px] text-gray-500 uppercase">Accepted</p><p className="text-emerald-400 font-bold">{teamDiag.matchesAccepted}</p></div>
                <div className="bg-gray-800 rounded p-2"><p className="text-[10px] text-gray-500 uppercase">Rejected</p><p className="text-red-400 font-bold">{teamDiag.matchesRejected}</p></div>
                <div className="bg-gray-800 rounded p-2"><p className="text-[10px] text-gray-500 uppercase">Too Few Players</p><p className="text-amber-400 font-bold">{teamDiag.rejectedReasons.tooFewHomePlayers + teamDiag.rejectedReasons.tooFewAwayPlayers}</p></div>
              </div>
              {teamDiag.rejectedMatches.length > 0 && (
                <div className="max-h-32 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead><tr className="text-gray-500 border-b border-gray-800"><th className="text-left py-1 px-2">Match</th><th className="text-left py-1 px-2">Reason</th><th className="text-right py-1 px-2">H</th><th className="text-right py-1 px-2">A</th></tr></thead>
                    <tbody>
                      {teamDiag.rejectedMatches.slice(0, 30).map((m, i) => (
                        <tr key={i} className="border-b border-gray-800/30"><td className="py-1 px-2 text-gray-300">{m.match}</td><td className="py-1 px-2 text-amber-400">{m.reason}</td><td className="py-1 px-2 text-right text-gray-500">{m.homePlayers}</td><td className="py-1 px-2 text-right text-gray-500">{m.awayPlayers}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Upcoming matchups view */}
      {view === 'matchups' && (
        <div className="space-y-3">
          {matchups.length === 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 text-center">
              <p className="text-gray-500 text-sm">No upcoming matchups with team stats available.</p>
            </div>
          )}
          {matchups.map((m, i) => (
            <div key={i} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <h3 className="text-white font-semibold text-sm mb-3">{m.homeTeam} vs {m.awayTeam}</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="bg-gray-800/50 rounded-lg p-3">
                  <p className="text-xs text-gray-500 uppercase mb-1">{m.homeTeam} (Home)</p>
                  <p className="text-white font-bold text-lg">{m.homeExpected > 0 ? m.homeExpected : 'N/A'}</p>
                  <p className="text-xs text-gray-400">Expected team disposals</p>
                  <p className={`text-xs font-medium mt-1 ${m.homeLabel === 'POSITIVE' || m.homeLabel === 'VERY_POSITIVE' ? 'text-emerald-400' : m.homeLabel === 'NEGATIVE' || m.homeLabel === 'VERY_NEGATIVE' ? 'text-red-400' : 'text-gray-400'}`}>
                    Environment: {getLabelDisplay(m.homeLabel)}
                    {m.homeEnvironmentDiff !== 0 && ` (${m.homeEnvironmentDiff > 0 ? '+' : ''}${m.homeEnvironmentDiff})`}
                  </p>
                </div>
                <div className="bg-gray-800/50 rounded-lg p-3">
                  <p className="text-xs text-gray-500 uppercase mb-1">{m.awayTeam} (Away)</p>
                  <p className="text-white font-bold text-lg">{m.awayExpected > 0 ? m.awayExpected : 'N/A'}</p>
                  <p className="text-xs text-gray-400">Expected team disposals</p>
                  <p className={`text-xs font-medium mt-1 ${m.awayLabel === 'POSITIVE' || m.awayLabel === 'VERY_POSITIVE' ? 'text-emerald-400' : m.awayLabel === 'NEGATIVE' || m.awayLabel === 'VERY_NEGATIVE' ? 'text-red-400' : 'text-gray-400'}`}>
                    Environment: {getLabelDisplay(m.awayLabel)}
                    {m.awayEnvironmentDiff !== 0 && ` (${m.awayEnvironmentDiff > 0 ? '+' : ''}${m.awayEnvironmentDiff})`}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* History view */}
      {view === 'history' && (
        <div className="space-y-3">
          {historyMatches.length === 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 text-center">
              <p className="text-gray-500 text-sm">No completed matches found.</p>
            </div>
          )}
          {historyMatches.slice(0, 20).map(m => {
            const statsForMatch = stats.filter(s => s.team === m.home_team || s.team === m.away_team);
            return (
              <div key={m.id} className="bg-gray-900 border border-gray-800 rounded-xl p-3">
                <p className="text-white font-medium text-sm">{m.home_team} vs {m.away_team}</p>
                <p className="text-gray-500 text-xs">Round {m.round} · {m.match_date}</p>
                <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                  {statsForMatch.map(s => (
                    <div key={s.team} className="text-gray-400">
                      <span className="text-white font-medium">{s.team}:</span> {s.seasonFor} for / {s.seasonConceded} conceded
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
