import { useState, useEffect, useMemo } from 'react';
import { Trophy, TrendingUp, TrendingDown, Minus, Loader2, AlertCircle } from 'lucide-react';
import { loadTeamDisposalStats, type TeamDisposalStats, type TeamMatchupEnvironment, type TeamStatsDiagnostics, getLabelDisplay } from '../lib/teamStatsService';
import { buildTeamEnvironmentMap } from '../lib/teamStatsService';
import { buildTeamMatchRecords, buildTeamFullStats, type TeamFullStats, type TeamMatchRecord } from '../lib/teamMatchAggregation';
import { CANONICAL_TEAMS } from '../lib/teamNormalizer';
import type { Match } from '../lib/types';
import { supabase } from '../lib/supabase';

type View = 'possessions' | 'rankings' | 'matchups' | 'history';

function PeriodRow({ label, period }: { label: string; period: TeamFullStats['season'] }) {
  return (
    <tr className="border-b border-gray-800/30">
      <td className="py-1.5 px-2 text-gray-400">{label} <span className="text-gray-600">({period.games}g)</span></td>
      <td className="py-1.5 px-2 text-right text-white">{period.disposalsFor}</td>
      <td className="py-1.5 px-2 text-right text-gray-400">{period.disposalsAllowed}</td>
      <td className="py-1.5 px-2 text-right text-white">{period.contestedFor ?? '—'}</td>
      <td className="py-1.5 px-2 text-right text-gray-400">{period.contestedAllowed ?? '—'}</td>
      <td className="py-1.5 px-2 text-right text-white">{period.uncontestedFor ?? '—'}</td>
      <td className="py-1.5 px-2 text-right text-gray-400">{period.uncontestedAllowed ?? '—'}</td>
      <td className="py-1.5 px-2 text-right text-white">{period.totalPossessionsFor ?? '—'}</td>
      <td className="py-1.5 px-2 text-right text-gray-400">{period.totalPossessionsAllowed ?? '—'}</td>
      <td className="py-1.5 px-2 text-right text-emerald-400">{period.pointsFor ?? '—'}</td>
      <td className="py-1.5 px-2 text-right text-red-400">{period.pointsAgainst ?? '—'}</td>
    </tr>
  );
}

function indexColor(idx: number | null): string {
  if (idx == null) return 'text-gray-500';
  if (idx >= 105) return 'text-emerald-400';
  if (idx <= 95) return 'text-red-400';
  return 'text-gray-300';
}

export default function TeamStatsPage() {
  const [view, setView] = useState<View>('possessions');
  const [stats, setStats] = useState<TeamDisposalStats[]>([]);
  const [teamDiag, setTeamDiag] = useState<TeamStatsDiagnostics | null>(null);
  const [matchups, setMatchups] = useState<TeamMatchupEnvironment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [upcomingMatches, setUpcomingMatches] = useState<Match[]>([]);
  const [historyMatches, setHistoryMatches] = useState<Match[]>([]);
  const [selectedHistoryMatch, setSelectedHistoryMatch] = useState<string | null>(null);

  // Possession stats (contested/uncontested/total possessions, points for/against)
  const [teamMatchRecords, setTeamMatchRecords] = useState<TeamMatchRecord[]>([]);
  const [possAggMeta, setPossAggMeta] = useState<{ matchesConsidered: number; matchesWithStandardData: number; matchesWithAdvancedData: number; mirrorMismatches: number } | null>(null);
  const [selectedTeamA, setSelectedTeamA] = useState<string>('Adelaide');
  const [selectedTeamB, setSelectedTeamB] = useState<string>('Collingwood');

  const fullStats = useMemo(() => buildTeamFullStats(teamMatchRecords), [teamMatchRecords]);
  const teamAStats = fullStats.find(t => t.team === selectedTeamA);
  const teamBStats = fullStats.find(t => t.team === selectedTeamB);
  const teamAHistory = useMemo(() => teamMatchRecords.filter(r => r.team === selectedTeamA).sort((a, b) => b.matchDate.localeCompare(a.matchDate)), [teamMatchRecords, selectedTeamA]);

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

        const possResult = await buildTeamMatchRecords(2026);
        setTeamMatchRecords(possResult.records);
        setPossAggMeta({
          matchesConsidered: possResult.matchesConsidered,
          matchesWithStandardData: possResult.matchesWithStandardData,
          matchesWithAdvancedData: possResult.matchesWithAdvancedData,
          mirrorMismatches: possResult.mirrorMismatches.length,
        });
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
      <div className="flex gap-2 flex-wrap">
        {(['possessions', 'rankings', 'matchups', 'history'] as View[]).map(v => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`px-4 py-2 text-xs font-medium rounded-lg transition capitalize ${view === v ? 'bg-emerald-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}
          >
            {v === 'possessions' ? 'Possession Stats' : v === 'rankings' ? 'Team Rankings (Disposals)' : v === 'matchups' ? 'Upcoming Matchups' : 'Matchup History'}
          </button>
        ))}
      </div>

      {/* Possession stats view — contested/uncontested/total possessions, points for/against */}
      {view === 'possessions' && (
        <div className="space-y-4">
          {possAggMeta && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[10px]">
              <div className="bg-gray-800 rounded p-1.5"><p className="text-gray-500 uppercase">Matches Considered</p><p className="text-white font-bold">{possAggMeta.matchesConsidered}</p></div>
              <div className="bg-gray-800 rounded p-1.5"><p className="text-gray-500 uppercase">Standard Complete</p><p className="text-emerald-400 font-bold">{possAggMeta.matchesWithStandardData}</p></div>
              <div className="bg-gray-800 rounded p-1.5"><p className="text-gray-500 uppercase">Advanced (CP/UP) Complete</p><p className="text-cyan-400 font-bold">{possAggMeta.matchesWithAdvancedData}</p></div>
              <div className="bg-gray-800 rounded p-1.5"><p className="text-gray-500 uppercase">Mirror Mismatches</p><p className={possAggMeta.mirrorMismatches === 0 ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>{possAggMeta.mirrorMismatches}</p></div>
            </div>
          )}

          {/* Matchup comparison panel */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <h3 className="text-white font-semibold text-sm mb-3">Matchup Comparison</h3>
            <div className="flex items-center gap-3 mb-4 flex-wrap">
              <select value={selectedTeamA} onChange={e => setSelectedTeamA(e.target.value)} className="bg-gray-800 border border-gray-700 text-white text-xs rounded px-2 py-1.5">
                {CANONICAL_TEAMS.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <span className="text-gray-500 text-xs">vs</span>
              <select value={selectedTeamB} onChange={e => setSelectedTeamB(e.target.value)} className="bg-gray-800 border border-gray-700 text-white text-xs rounded px-2 py-1.5">
                {CANONICAL_TEAMS.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            {teamAStats && teamBStats ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {[{ team: selectedTeamA, stats: teamAStats, opp: teamBStats }, { team: selectedTeamB, stats: teamBStats, opp: teamAStats }].map(({ team, stats: s, opp }) => (
                  <div key={team} className="bg-gray-800/50 rounded-lg p-3 space-y-1.5 text-xs">
                    <p className="text-white font-semibold mb-2">{team} <span className="text-gray-500 font-normal">({s.season.games} games)</span></p>
                    <p className="text-gray-400">Disposals for: <span className="text-white font-bold">{s.season.disposalsFor}</span> <span className={indexColor(s.disposalForIndex)}>({s.disposalForIndex ?? '—'} idx)</span> · rank {s.disposalForRank}</p>
                    <p className="text-gray-400">Disposals allowed: <span className="text-white font-bold">{s.season.disposalsAllowed}</span> <span className={indexColor(s.disposalAllowedIndex)}>({s.disposalAllowedIndex ?? '—'} idx)</span></p>
                    <p className="text-gray-400">Uncontested for: <span className="text-white font-bold">{s.season.uncontestedFor ?? '—'}</span> <span className={indexColor(s.uncontestedForIndex)}>({s.uncontestedForIndex ?? '—'} idx)</span> · rank {s.uncontestedForRank}</p>
                    <p className="text-gray-400">Contested for: <span className="text-white font-bold">{s.season.contestedFor ?? '—'}</span> <span className={indexColor(s.contestedForIndex)}>({s.contestedForIndex ?? '—'} idx)</span> · rank {s.contestedForRank}</p>
                    <p className="text-gray-400">Total possessions for/allowed: <span className="text-white font-bold">{s.season.totalPossessionsFor ?? '—'}</span> / <span className="text-gray-300">{s.season.totalPossessionsAllowed ?? '—'}</span></p>
                    <p className="text-gray-400">Points for/against: <span className="text-emerald-400 font-bold">{s.season.pointsFor ?? '—'}</span> / <span className="text-red-400 font-bold">{s.season.pointsAgainst ?? '—'}</span> · rank {s.pointsForRank}/{s.pointsAllowedRank}</p>
                    <p className="text-[10px] text-gray-500 pt-1 border-t border-gray-700/50 mt-2">vs {opp === teamAStats ? selectedTeamA : selectedTeamB}'s allowed figures — {team === selectedTeamA ? selectedTeamA : selectedTeamB} disposals for ({s.season.disposalsFor}) vs opponent disposals allowed ({opp.season.disposalsAllowed}): {s.season.disposalsFor > opp.season.disposalsAllowed ? 'positive environment' : s.season.disposalsFor < opp.season.disposalsAllowed ? 'negative environment' : 'neutral'}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-gray-500 text-xs">Select two teams with available data.</p>
            )}
          </div>

          {/* Selected team detail: season/L5/L3/home/away breakdown */}
          {teamAStats && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 overflow-x-auto">
              <h3 className="text-white font-semibold text-sm mb-3">{selectedTeamA} — Period Breakdown</h3>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-800 text-gray-500">
                    <th className="text-left py-1.5 px-2">Period</th>
                    <th className="text-right py-1.5 px-2">Disp For</th>
                    <th className="text-right py-1.5 px-2">Disp Allowed</th>
                    <th className="text-right py-1.5 px-2">CP For</th>
                    <th className="text-right py-1.5 px-2">CP Allowed</th>
                    <th className="text-right py-1.5 px-2">UP For</th>
                    <th className="text-right py-1.5 px-2">UP Allowed</th>
                    <th className="text-right py-1.5 px-2">Poss For</th>
                    <th className="text-right py-1.5 px-2">Poss Allowed</th>
                    <th className="text-right py-1.5 px-2">Pts For</th>
                    <th className="text-right py-1.5 px-2">Pts Against</th>
                  </tr>
                </thead>
                <tbody>
                  <PeriodRow label="Season" period={teamAStats.season} />
                  <PeriodRow label="Last 5" period={teamAStats.last5} />
                  <PeriodRow label="Last 3" period={teamAStats.last3} />
                  <PeriodRow label="Home" period={teamAStats.home} />
                  <PeriodRow label="Away" period={teamAStats.away} />
                </tbody>
              </table>
            </div>
          )}

          {/* Match-by-match history for selected team */}
          {teamAHistory.length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 overflow-x-auto">
              <h3 className="text-white font-semibold text-sm mb-3">{selectedTeamA} — Match History ({teamAHistory.length} games)</h3>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-800 text-gray-500">
                    <th className="text-left py-1.5 px-2">Round</th>
                    <th className="text-left py-1.5 px-2">Opponent</th>
                    <th className="text-right py-1.5 px-2">Disp For</th>
                    <th className="text-right py-1.5 px-2">Disp Allowed</th>
                    <th className="text-right py-1.5 px-2">CP</th>
                    <th className="text-right py-1.5 px-2">UP</th>
                    <th className="text-right py-1.5 px-2">Pts For</th>
                    <th className="text-right py-1.5 px-2">Pts Against</th>
                  </tr>
                </thead>
                <tbody>
                  {teamAHistory.map(r => (
                    <tr key={r.matchId} className="border-b border-gray-800/30">
                      <td className="py-1.5 px-2 text-gray-400">R{r.round}</td>
                      <td className="py-1.5 px-2 text-white">{r.isHome ? 'vs' : '@'} {r.opponent}</td>
                      <td className="py-1.5 px-2 text-right text-white">{r.disposalsFor}</td>
                      <td className="py-1.5 px-2 text-right text-gray-400">{r.disposalsAllowed}</td>
                      <td className="py-1.5 px-2 text-right text-white">{r.contestedPossessionsFor ?? '—'}</td>
                      <td className="py-1.5 px-2 text-right text-white">{r.uncontestedPossessionsFor ?? '—'}</td>
                      <td className="py-1.5 px-2 text-right text-emerald-400">{r.pointsFor ?? '—'}</td>
                      <td className="py-1.5 px-2 text-right text-red-400">{r.pointsAgainst ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

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
