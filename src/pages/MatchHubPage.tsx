import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Calendar, MapPin, ChevronRight, RefreshCw, AlertCircle, CheckCircle } from 'lucide-react';
import { getUpcomingFixtures, teamSlugToName, normalizeTeam } from '../lib/fixtures';
import { getRoundInfo } from '../lib/roundManager';
import type { Match } from '../lib/types';
import ErrorBoundary from '../components/ErrorBoundary';
import LoadingSpinner from '../components/LoadingSpinner';

function MatchCard({ match }: { match: Match }) {
  const timeSource = match.commence_time_utc || match.match_date;
  const matchDate = new Date(timeSource || '');

  const dateStr = matchDate.toLocaleDateString('en-AU', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Australia/Melbourne'
  });
  const timeStr = matchDate.toLocaleTimeString('en-AU', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Australia/Melbourne'
  });

  return (
    <Link
      to={`/matches/${match.id}`}
      className="block bg-gray-800/50 border border-gray-700/50 rounded-xl p-4 hover:border-emerald-500/50 hover:bg-gray-800 transition-all group"
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">Round {match.round || 'TBD'}</span>
        <span className="text-xs text-gray-600">{match.season}</span>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-white font-semibold text-sm">{match.home_team || 'TBD'}</span>
          <span className="text-gray-600 text-xs px-2">vs</span>
          <span className="text-white font-semibold text-sm">{match.away_team || 'TBD'}</span>
        </div>
      </div>
      <div className="flex items-center gap-3 mt-3 pt-3 border-t border-gray-700/30">
        <div className="flex items-center gap-1.5 text-gray-500 text-xs">
          <Calendar className="w-3 h-3" />
          {dateStr} {timeStr} AEST
        </div>
        {match.venue && (
          <div className="flex items-center gap-1.5 text-gray-500 text-xs">
            <MapPin className="w-3 h-3" />
            {match.venue}
          </div>
        )}
        <ChevronRight className="w-4 h-4 text-gray-600 group-hover:text-emerald-500 ml-auto transition-colors" />
      </div>
    </Link>
  );
}

function MatchHubInner() {
  const [matches, setMatches] = useState<Match[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [roundInfo, setRoundInfo] = useState<Awaited<ReturnType<typeof getRoundInfo>> | null>(null);

  async function loadFixtures() {
    setLoading(true);
    setError(null);
    try {
      const data = await getUpcomingFixtures(50);
      setMatches(data);
      const info = await getRoundInfo(2026);
      setRoundInfo(info);
    } catch (e: any) {
      setError(e.message ?? 'Failed to load fixtures');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadFixtures(); }, []);

  if (loading) return <LoadingSpinner message="Loading upcoming fixtures..." />;

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4">
        <AlertCircle className="w-10 h-10 text-red-500" />
        <p className="text-red-400 font-medium">{error}</p>
        <button onClick={loadFixtures} className="px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm hover:bg-gray-700">
          Try again
        </button>
      </div>
    );
  }

  // No upcoming fixtures — show next round status
  if (matches.length === 0) {
    const nextRound = roundInfo?.nextBettingRound;
    const nextRoundLabel = nextRound ? `Round ${nextRound}` : 'Next round';
    const fixturesReady = roundInfo?.fixturesReady;
    const statsRound = roundInfo?.latestCompletedStatsRound;

    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">Match Hub</h1>
            <p className="text-gray-500 text-sm mt-1">No upcoming fixtures found</p>
          </div>
          <button onClick={loadFixtures} className="p-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700 transition-colors">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        {/* Next round status panel */}
        {roundInfo && nextRound && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
            <h3 className="text-white font-semibold text-sm flex items-center gap-2">
              <Calendar className="w-4 h-4 text-cyan-400" />
              {nextRoundLabel} Status
            </h3>
            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between py-1.5 border-b border-gray-800">
                <span className="text-gray-400">Latest completed stats round</span>
                <span className="text-white font-bold">{statsRound ? `R${statsRound}` : '—'}</span>
              </div>
              <div className="flex items-center justify-between py-1.5 border-b border-gray-800">
                <span className="text-gray-400">Next betting round</span>
                <span className="text-cyan-400 font-bold">{nextRoundLabel}</span>
              </div>
              <div className="flex items-center justify-between py-1.5 border-b border-gray-800">
                <span className="text-gray-400">{nextRoundLabel} fixtures</span>
                {fixturesReady ? (
                  <span className="text-emerald-400 font-medium flex items-center gap-1"><CheckCircle className="w-3.5 h-3.5" /> Ready</span>
                ) : (
                  <span className="text-red-400 font-medium flex items-center gap-1"><AlertCircle className="w-3.5 h-3.5" /> Missing</span>
                )}
              </div>
              <div className="flex items-center justify-between py-1.5">
                <span className="text-gray-400">{nextRoundLabel} player prop odds</span>
                {roundInfo.oddsReady ? (
                  <span className="text-emerald-400 font-medium flex items-center gap-1"><CheckCircle className="w-3.5 h-3.5" /> Ready</span>
                ) : (
                  <span className="text-red-400 font-medium flex items-center gap-1"><AlertCircle className="w-3.5 h-3.5" /> Missing</span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Missing fixtures message */}
        {(!roundInfo || !roundInfo.fixturesReady) && (
          <div className="flex flex-col items-center justify-center py-12 gap-4">
            <AlertCircle className="w-10 h-10 text-amber-500" />
            <div className="text-center space-y-2">
              <p className="text-amber-400 font-medium text-lg">
                {roundInfo?.nextBettingRound ? `Round ${roundInfo.nextBettingRound} fixtures are missing.` : 'No upcoming fixtures found.'}
              </p>
              <p className="text-gray-600 text-sm max-w-md">
                Import or sync {roundInfo?.nextBettingRound ? `Round ${roundInfo.nextBettingRound}` : 'upcoming'} fixtures first.
                Stats are complete through {statsRound ? `Round ${statsRound}` : 'the latest round'} — use those as the model base.
              </p>
            </div>
            <div className="flex gap-3">
              <Link to="/import" className="px-4 py-2 bg-emerald-600 border border-emerald-500 rounded-lg text-white text-sm hover:bg-emerald-500">
                Import {roundInfo?.nextBettingRound ? `Round ${roundInfo.nextBettingRound}` : ''} Fixtures
              </Link>
              <button onClick={loadFixtures} className="px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm hover:bg-gray-700 flex items-center gap-2">
                <RefreshCw className="w-4 h-4" /> Refresh
              </button>
            </div>
          </div>
        )}

        {/* Fixtures exist but no odds */}
        {roundInfo?.fixturesReady && !roundInfo.oddsReady && roundInfo.nextRoundFixtures.length > 0 && (
          <div className="space-y-4">
            <div className="flex flex-col items-center justify-center py-8 gap-4">
              <AlertCircle className="w-8 h-8 text-amber-500" />
              <div className="text-center space-y-1">
                <p className="text-amber-400 font-medium">
                  {nextRoundLabel} fixtures found, but player prop odds are missing.
                </p>
                <p className="text-gray-600 text-sm">Run Sync Player Props on the Import Data page.</p>
              </div>
              <Link to="/import" className="px-4 py-2 bg-cyan-600 border border-cyan-500 rounded-lg text-white text-sm hover:bg-cyan-500">
                Sync {nextRoundLabel} Player Props
              </Link>
            </div>

            {/* Show the fixtures even without odds */}
            <div>
              <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">{nextRoundLabel}</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {roundInfo.nextRoundFixtures.map(m => <MatchCard key={m.id} match={m} />)}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Group by round
  const byRound = new Map<string, Match[]>();
  for (const m of matches) {
    const key = m.round ? `Round ${m.round}` : 'Upcoming';
    if (!byRound.has(key)) byRound.set(key, []);
    byRound.get(key)!.push(m);
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Match Hub</h1>
          <p className="text-gray-500 text-sm mt-1">
            {matches.length} upcoming fixture{matches.length !== 1 ? 's' : ''}
            {roundInfo?.latestCompletedStatsRound && (
              <span className="text-gray-600"> · Stats through R{roundInfo.latestCompletedStatsRound}</span>
            )}
          </p>
        </div>
        <button onClick={loadFixtures} className="p-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-400 hover:text-white hover:bg-gray-700 transition-colors">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {Array.from(byRound.entries()).map(([roundLabel, roundMatches]) => (
        <div key={roundLabel}>
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">{roundLabel}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {roundMatches.map(m => <MatchCard key={m.id} match={m} />)}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function MatchHubPage() {
  return (
    <ErrorBoundary fallbackLabel="Match Hub">
      <MatchHubInner />
    </ErrorBoundary>
  );
}
