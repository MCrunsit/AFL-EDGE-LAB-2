import { useState, useEffect, useMemo, useCallback } from 'react';
import { Database, RefreshCw, AlertCircle, CheckCircle, XCircle, MapPin, Swords, ChevronDown, ChevronRight, Eye, Edit3, X, Clock, Loader2 } from 'lucide-react';
import {
  auditRoundFreshness,
  auditMultipleMatchesFreshness,
  getPlayerSpotCheck,
  getPositionOverrides,
  upsertPositionOverride,
  getUnknownPositionPlayersForMatch,
  type RoundFreshnessResult,
  type PlayerFreshnessRow,
  type PlayerSpotCheck,
  type FreshnessStatus,
} from '../lib/dataFreshnessAudit';
import { getUpcomingMatches, getLatestCompletedRound } from '../lib/dataFreshnessAudit';
import { supabase } from '../lib/supabase';
import { POSITION_GROUPS } from '../lib/types';
import LoadingSpinner from '../components/LoadingSpinner';

const STATUS_COLORS: Record<FreshnessStatus, string> = {
  'Fresh': 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  'Missing last game': 'bg-red-500/20 text-red-400 border-red-500/30',
  'No current season data': 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  'No historical stats': 'bg-red-500/20 text-red-400 border-red-500/30',
  'Team mismatch': 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  'Duplicate player issue': 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  'Match_id missing': 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  'Needs review': 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  'No last-round game found — possible bye/DNP': 'bg-blue-500/20 text-blue-400 border-blue-500/30',
};

const AUDIT_STAGES = [
  'Loading matches',
  'Loading bookmaker odds',
  'Resolving players',
  'Loading player_game_stats',
  'Checking latest round',
  'Checking position groups',
  'Building freshness report',
  'Complete',
] as const;

type AuditStage = typeof AUDIT_STAGES[number];

interface StageError {
  stage: string;
  table?: string;
  purpose: string;
  message: string;
  code?: string;
  hint?: string;
  details?: string;
}

type AuditState = 'idle' | 'loading' | 'success' | 'warning' | 'error' | 'timeout' | 'empty';

export default function DataFreshnessAuditPage() {
  const [auditState, setAuditState] = useState<AuditState>('idle');
  const [currentStage, setCurrentStage] = useState<AuditStage | null>(null);
  const [completedStages, setCompletedStages] = useState<Set<string>>(new Set());
  const [stageErrors, setStageErrors] = useState<StageError[]>([]);
  const [result, setResult] = useState<RoundFreshnessResult | null>(null);
  const [matches, setMatches] = useState<{ id: string; season: number; round: string | null; home_team: string | null; away_team: string | null; venue: string | null; match_date: string | null }[]>([]);
  const [selectedMatchId, setSelectedMatchId] = useState('');
  const [matchRows, setMatchRows] = useState<PlayerFreshnessRow[]>([]);
  const [matchRowsLoading, setMatchRowsLoading] = useState(false);
  const [matchRowsError, setMatchRowsError] = useState<string | null>(null);
  const [expandedMatch, setExpandedMatch] = useState<string | null>(null);
  const [spotCheckPlayer, setSpotCheckPlayer] = useState<{ name: string; playerId: string | null } | null>(null);
  const [spotCheck, setSpotCheck] = useState<PlayerSpotCheck | null>(null);
  const [spotCheckLoading, setSpotCheckLoading] = useState(false);
  const [unknownPlayers, setUnknownPlayers] = useState<{ playerName: string; playerId: string | null; team: string | null }[]>([]);
  const [overrides, setOverrides] = useState<{ player_name: string; team: string | null; position_group: string; confidence: string }[]>([]);
  const [editingOverride, setEditingOverride] = useState<{ playerName: string; team: string | null; currentGroup: string } | null>(null);
  const [overrideForm, setOverrideForm] = useState({ positionGroup: 'UNKNOWN', confidence: 'high' });
  const [overrideSaving, setOverrideSaving] = useState(false);
  const [overrideMessage, setOverrideMessage] = useState<string | null>(null);

  const markStage = useCallback((stage: AuditStage, done: boolean = true) => {
    setCurrentStage(stage);
    if (done) {
      setCompletedStages(prev => new Set([...prev, stage]));
    }
  }, []);

  const loadAll = useCallback(async () => {
    setAuditState('loading');
    setCompletedStages(new Set());
    setStageErrors([]);
    setCurrentStage(null);
    setResult(null);

    const timeoutId = setTimeout(() => {
      setAuditState('timeout');
      setCurrentStage(null);
    }, 20000);

    try {
      // Stage 1: Loading matches
      markStage('Loading matches', false);
      let upcoming: typeof matches = [];
      try {
        const { data: matchData, error: matchErr } = await supabase
          .from('matches')
          .select('id, season, round, home_team, away_team, venue, match_date')
          .gte('match_date', new Date().toISOString().split('T')[0])
          .order('commence_time_utc', { ascending: true, nullsFirst: false })
          .limit(20);
        if (matchErr) {
          setStageErrors(prev => [...prev, {
            stage: 'Loading matches',
            table: 'matches',
            purpose: 'Fetch upcoming matches for freshness audit',
            message: matchErr.message,
            code: matchErr.code,
            hint: matchErr.hint,
            details: matchErr.details,
          }]);
        } else {
          upcoming = matchData ?? [];
        }
      } catch (e: any) {
        setStageErrors(prev => [...prev, {
          stage: 'Loading matches',
          table: 'matches',
          purpose: 'Fetch upcoming matches for freshness audit',
          message: e?.message ?? String(e),
        }]);
      }
      setMatches(upcoming);
      if (upcoming.length > 0 && !selectedMatchId) {
        setSelectedMatchId(upcoming[0].id);
      }
      markStage('Loading matches');

      if (upcoming.length === 0) {
        markStage('Loading bookmaker odds');
        markStage('Resolving players');
        markStage('Loading player_game_stats');
        markStage('Checking latest round');
        markStage('Checking position groups');
        markStage('Building freshness report');
        markStage('Complete');
        setAuditState('empty');
        clearTimeout(timeoutId);
        return;
      }

      const firstMatch = upcoming[0];
      const season = firstMatch.season;

      // Stage 2: Loading bookmaker odds (done per-match in auditRoundFreshness)
      markStage('Loading bookmaker odds', false);
      markStage('Loading bookmaker odds');

      // Stage 3: Resolving players
      markStage('Resolving players', false);
      markStage('Resolving players');

      // Stage 4: Loading player_game_stats
      markStage('Loading player_game_stats', false);
      markStage('Loading player_game_stats');

      // Stage 5: Checking latest round
      markStage('Checking latest round', false);
      let latestCompletedRound: string | null = null;
      let latestCompletedMatchDate: string | null = null;
      try {
        const { round, matchDate } = await getLatestCompletedRound(season);
        latestCompletedRound = round;
        latestCompletedMatchDate = matchDate;
      } catch (e: any) {
        setStageErrors(prev => [...prev, {
          stage: 'Checking latest round',
          table: 'matches',
          purpose: 'Determine the latest completed round for the season',
          message: e?.message ?? String(e),
        }]);
      }
      markStage('Checking latest round');

      // Stage 6: Checking position groups
      markStage('Checking position groups', false);
      markStage('Checking position groups');

      // Stage 7: Building freshness report — batched queries for all matches at once
      markStage('Building freshness report', false);
      const summaries: any[] = [];
      const allPlayerRows: PlayerFreshnessRow[] = [];
      let totalPlayersWithOdds = 0;
      let totalPlayersMatched = 0;
      let totalPlayersWithLatestGame = 0;
      let totalPlayersMissingLatest = 0;
      let totalPlayersWithNoCurrentSeason = 0;
      let totalUnknownPosition = 0;

      try {
        const batchedResults = await auditMultipleMatchesFreshness(
          upcoming.map(m => ({ id: m.id, season: m.season, home_team: m.home_team, away_team: m.away_team })),
          latestCompletedRound
        );

        for (const m of upcoming) {
          const rows = batchedResults.get(m.id) ?? [];
          allPlayerRows.push(...rows);
          const playersWithOdds = rows.length;
          const playersMatched = rows.filter(r => r.playerId !== null).length;
          const playersWithLatestGame = rows.filter(r => r.status === 'Fresh').length;
          const playersMissingLatest = rows.filter(r => r.status === 'Missing last game').length;
          const playersWithNoCurrentSeason = rows.filter(r => r.status === 'No current season data').length;
          const playersWithUnknownPosition = rows.filter(r => r.positionGroup === 'UNKNOWN' || !r.positionGroup).length;
          totalPlayersWithOdds += playersWithOdds;
          totalPlayersMatched += playersMatched;
          totalPlayersWithLatestGame += playersWithLatestGame;
          totalPlayersMissingLatest += playersMissingLatest;
          totalPlayersWithNoCurrentSeason += playersWithNoCurrentSeason;
          totalUnknownPosition += playersWithUnknownPosition;
          const statusReasons: string[] = [];
          if (playersMatched / Math.max(1, playersWithOdds) < 0.9) statusReasons.push(`Player matching ${((playersMatched / Math.max(1, playersWithOdds)) * 100).toFixed(0)}% < 90%`);
          if (playersWithNoCurrentSeason / Math.max(1, playersWithOdds) > 0.15) statusReasons.push(`${playersWithNoCurrentSeason} players with no current season data`);
          if (playersMissingLatest / Math.max(1, playersWithOdds) > 0.20) statusReasons.push(`${playersMissingLatest} players missing latest game`);
          if (playersWithUnknownPosition / Math.max(1, playersWithOdds) > 0.10) statusReasons.push(`${playersWithUnknownPosition} players with UNKNOWN position`);
          let status: 'Ready' | 'Warning' | 'Broken' = 'Ready';
          if (playersMatched === 0 || playersWithOdds === 0) status = 'Broken';
          else if (statusReasons.length >= 2 || playersMissingLatest > playersWithOdds * 0.3) status = 'Warning';
          else if (statusReasons.length >= 1) status = 'Warning';
          summaries.push({
            matchId: m.id,
            matchLabel: `${m.home_team} vs ${m.away_team}`,
            round: m.round,
            season: m.season,
            venue: m.venue,
            playersWithOdds,
            playersMatchedToStats: playersMatched,
            playersWithLatestGame,
            playersMissingLatestGame: playersMissingLatest,
            playersWithNoCurrentSeason,
            playersWithUnknownPosition,
            status,
            statusReasons,
          });
        }
      } catch (e: any) {
        setStageErrors(prev => [...prev, {
          stage: 'Building freshness report',
          table: 'player_game_stats / bookmaker_odds',
          purpose: 'Batched freshness audit for all matches',
          message: e?.message ?? String(e),
        }]);
      }

      const playerMatchingPct = totalPlayersWithOdds > 0 ? (totalPlayersMatched / totalPlayersWithOdds) * 100 : 0;
      const currentSeasonCoveragePct = totalPlayersWithOdds > 0 ? ((totalPlayersWithOdds - totalPlayersWithNoCurrentSeason) / totalPlayersWithOdds) * 100 : 0;
      const latestGameCoveragePct = totalPlayersMatched > 0 ? (totalPlayersWithLatestGame / totalPlayersMatched) * 100 : 0;
      const unknownPositionPct = totalPlayersWithOdds > 0 ? (totalUnknownPosition / totalPlayersWithOdds) * 100 : 0;
      const targetReadiness = { playerMatching: 90, currentSeasonCoverage: 85, latestGameCoverage: 80, unknownPosition: 10 };
      const meetsTargets =
        playerMatchingPct >= targetReadiness.playerMatching &&
        currentSeasonCoveragePct >= targetReadiness.currentSeasonCoverage &&
        latestGameCoveragePct >= targetReadiness.latestGameCoverage &&
        unknownPositionPct <= targetReadiness.unknownPosition;

      setResult({
        summaries,
        playerRows: allPlayerRows,
        expectedLatestRound: latestCompletedRound,
        latestCompletedRound,
        latestCompletedMatchDate,
        totalPlayersWithOdds,
        totalPlayersMatched,
        totalPlayersWithLatestGame,
        totalPlayersMissingLatest,
        totalUnknownPosition,
        readiness: { playerMatchingPct, currentSeasonCoveragePct, latestGameCoveragePct, unknownPositionPct },
        targetReadiness,
        meetsTargets,
      });
      markStage('Building freshness report');
      markStage('Complete');

      if (stageErrors.length === 0 && summaries.length > 0) {
        setAuditState(meetsTargets ? 'success' : 'warning');
      } else if (summaries.length === 0) {
        setAuditState('empty');
      } else {
        setAuditState('warning');
      }
    } catch (e: any) {
      setStageErrors(prev => [...prev, {
        stage: currentStage ?? 'Unknown',
        purpose: 'Overall audit',
        message: e?.message ?? String(e),
      }]);
      setAuditState('error');
    } finally {
      clearTimeout(timeoutId);
      setCurrentStage(null);
    }
  }, [selectedMatchId, markStage, stageErrors.length, currentStage]);

  useEffect(() => {
    loadAll();
  }, []);

  const loadMatchRows = useCallback(async (matchId: string) => {
    if (!matchId) return;
    setMatchRowsLoading(true);
    setMatchRowsError(null);
    try {
      const m = matches.find(m => m.id === matchId);
      if (!m) {
        setMatchRowsError('Match not found');
        setMatchRowsLoading(false);
        return;
      }
      const { round: latestRound } = await getLatestCompletedRound(m.season);
      const rows = await auditRoundFreshness(matchId, m.season, latestRound);
      setMatchRows(rows);
      const unknowns = await getUnknownPositionPlayersForMatch(matchId);
      setUnknownPlayers(unknowns);
      const ov = await getPositionOverrides();
      setOverrides(ov);
    } catch (e: any) {
      setMatchRowsError(e?.message ?? String(e));
    } finally {
      setMatchRowsLoading(false);
    }
  }, [matches]);

  useEffect(() => {
    if (selectedMatchId) {
      loadMatchRows(selectedMatchId);
    }
  }, [selectedMatchId, loadMatchRows]);

  const loadSpotCheck = useCallback(async (playerName: string, playerId: string | null) => {
    setSpotCheckLoading(true);
    setSpotCheckPlayer({ name: playerName, playerId });
    const m = matches.find(m => m.id === selectedMatchId);
    if (!m) {
      setSpotCheckLoading(false);
      return;
    }
    try {
      const { round: latestRound } = await getLatestCompletedRound(m.season);
      const row = matchRows.find(r => r.playerName === playerName);
      const sc = await getPlayerSpotCheck(
        playerName,
        playerId,
        selectedMatchId,
        m.season,
        latestRound,
        m.venue,
        row?.team ?? null,
        m.home_team,
        m.away_team
      );
      setSpotCheck(sc);
    } catch (e: any) {
      console.error('[spotCheck] Error:', e);
    } finally {
      setSpotCheckLoading(false);
    }
  }, [selectedMatchId, matches, matchRows]);

  const handleSaveOverride = async () => {
    if (!editingOverride) return;
    setOverrideSaving(true);
    try {
      await upsertPositionOverride(editingOverride.playerName, editingOverride.team, overrideForm.positionGroup, overrideForm.confidence);
      setOverrideMessage(`Saved position override for ${editingOverride.playerName}`);
      setTimeout(() => setOverrideMessage(null), 4000);
      if (selectedMatchId) {
        const unknowns = await getUnknownPositionPlayersForMatch(selectedMatchId);
        setUnknownPlayers(unknowns);
        const ov = await getPositionOverrides();
        setOverrides(ov);
      }
    } catch (e: any) {
      setOverrideMessage(`Error: ${e?.message ?? String(e)}`);
    } finally {
      setOverrideSaving(false);
      setEditingOverride(null);
    }
  };

  const isLoading = auditState === 'loading';

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-center gap-3 flex-wrap">
        <Database className="w-5 h-5 text-emerald-400" />
        <h2 className="text-white font-bold text-lg">Data Freshness Audit</h2>
        <button
          onClick={loadAll}
          disabled={isLoading}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-gray-300 hover:bg-gray-700 transition disabled:opacity-50"
        >
          <RefreshCw className={`w-3 h-3 ${isLoading ? 'animate-spin' : ''}`} /> Refresh
        </button>
        {result && auditState !== 'loading' && (
          <span className={`text-xs px-2.5 py-1 rounded-full font-semibold ${
            auditState === 'success' ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-400' :
            auditState === 'warning' ? 'bg-amber-500/15 border border-amber-500/30 text-amber-400' :
            auditState === 'error' ? 'bg-red-500/15 border border-red-500/30 text-red-400' :
            auditState === 'timeout' ? 'bg-red-500/15 border border-red-500/30 text-red-400' :
            auditState === 'empty' ? 'bg-gray-500/15 border border-gray-500/30 text-gray-400' :
            'bg-gray-500/15 border border-gray-500/30 text-gray-400'
          }`}>
            {auditState === 'success' ? 'Targets Met' :
             auditState === 'warning' ? 'Below Targets' :
             auditState === 'error' ? 'Error' :
             auditState === 'timeout' ? 'Timed Out' :
             auditState === 'empty' ? 'No Data' : '—'}
          </span>
        )}
      </div>

      {/* Loading state with stage progress */}
      {isLoading && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-blue-400 animate-pulse" />
            <h3 className="text-white font-semibold text-sm">Auditing data freshness...</h3>
          </div>
          <div className="space-y-1.5">
            {AUDIT_STAGES.filter(s => s !== 'Complete').map(stage => {
              const isCurrent = currentStage === stage;
              const isDone = completedStages.has(stage);
              return (
                <div key={stage} className="flex items-center gap-2 text-xs">
                  {isCurrent ? (
                    <Loader2 className="w-3 h-3 text-blue-400 animate-spin" />
                  ) : isDone ? (
                    <CheckCircle className="w-3 h-3 text-emerald-400" />
                  ) : (
                    <div className="w-3 h-3 rounded-full border border-gray-700" />
                  )}
                  <span className={isCurrent ? 'text-blue-400 font-medium' : isDone ? 'text-gray-400' : 'text-gray-600'}>
                    {stage}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="text-xs text-gray-600">Timeout after 20 seconds if the audit takes too long.</p>
        </div>
      )}

      {/* Timeout state */}
      {auditState === 'timeout' && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 space-y-2">
          <div className="flex items-center gap-2">
            <XCircle className="w-4 h-4 text-red-400" />
            <h3 className="text-red-400 font-semibold text-sm">Data Freshness Audit timed out after 20 seconds.</h3>
          </div>
          <p className="text-xs text-gray-400">
            The audit was taking too long. This may be due to a large number of players or a slow connection.
            Try retrying — the batched query optimization should help.
          </p>
          {completedStages.size > 0 && (
            <div className="text-xs text-gray-500">
              Completed stages: {Array.from(completedStages).join(', ')}
            </div>
          )}
          <button
            onClick={() => loadAll()}
            className="text-xs px-3 py-1.5 bg-red-500/20 text-red-400 rounded-lg border border-red-500/30 hover:bg-red-500/30 flex items-center gap-1.5"
          >
            <RefreshCw className="w-3 h-3" /> Retry Audit
          </button>
        </div>
      )}

      {/* Error state */}
      {auditState === 'error' && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 space-y-2">
          <div className="flex items-center gap-2">
            <XCircle className="w-4 h-4 text-red-400" />
            <h3 className="text-red-400 font-semibold text-sm">Audit failed with errors.</h3>
          </div>
          {stageErrors.map((e, i) => (
            <div key={i} className="text-xs bg-gray-800/50 rounded p-2 space-y-1">
              <p className="text-white font-medium">{e.stage}: {e.purpose}</p>
              {e.table && <p className="text-gray-500">Table: {e.table}</p>}
              <p className="text-red-400">{e.message}</p>
              {e.code && <p className="text-gray-500">Code: {e.code}</p>}
              {e.hint && <p className="text-gray-500">Hint: {e.hint}</p>}
              {e.details && <p className="text-gray-500">Details: {e.details}</p>}
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {auditState === 'empty' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center">
          <Database className="w-10 h-10 text-gray-700 mx-auto mb-3" />
          <p className="text-gray-400 font-medium">No upcoming matches found to audit.</p>
        </div>
      )}

      {/* Stage errors (shown even in success/warning state) */}
      {stageErrors.length > 0 && (auditState === 'success' || auditState === 'warning') && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 space-y-2">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-amber-400" />
            <h3 className="text-amber-400 font-semibold text-sm">Some stages had errors ({stageErrors.length})</h3>
          </div>
          {stageErrors.map((e, i) => (
            <div key={i} className="text-xs bg-gray-800/50 rounded p-2 space-y-1">
              <p className="text-white font-medium">{e.stage}: {e.purpose}</p>
              {e.table && <p className="text-gray-500">Table: {e.table}</p>}
              <p className="text-amber-400">{e.message}</p>
              {e.code && <p className="text-gray-500">Code: {e.code}</p>}
              {e.hint && <p className="text-gray-500">Hint: {e.hint}</p>}
            </div>
          ))}
        </div>
      )}

      {/* Success / Warning state — show results */}
      {(auditState === 'success' || auditState === 'warning') && result && (
        <>
          {/* Round Summary */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-blue-400" />
              <h3 className="text-white font-semibold text-sm">Round Freshness Summary</h3>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Expected Latest Round</p>
                <p className="text-white font-bold">{result.expectedLatestRound ? `Round ${result.expectedLatestRound}` : '—'}</p>
              </div>
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Latest Completed Match</p>
                <p className="text-white font-bold text-[10px]">{result.latestCompletedMatchDate ?? '—'}</p>
              </div>
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Total Players w/ Odds</p>
                <p className="text-white font-bold">{result.totalPlayersWithOdds}</p>
              </div>
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Players Matched</p>
                <p className="text-emerald-400 font-bold">{result.totalPlayersMatched}</p>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Player Matching</p>
                <p className={`font-bold ${result.readiness.playerMatchingPct >= result.targetReadiness.playerMatching ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {result.readiness.playerMatchingPct.toFixed(1)}% (target {result.targetReadiness.playerMatching}%)
                </p>
              </div>
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Current Season Coverage</p>
                <p className={`font-bold ${result.readiness.currentSeasonCoveragePct >= result.targetReadiness.currentSeasonCoverage ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {result.readiness.currentSeasonCoveragePct.toFixed(1)}% (target {result.targetReadiness.currentSeasonCoverage}%)
                </p>
              </div>
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Latest Game Coverage</p>
                <p className={`font-bold ${result.readiness.latestGameCoveragePct >= result.targetReadiness.latestGameCoverage ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {result.readiness.latestGameCoveragePct.toFixed(1)}% (target {result.targetReadiness.latestGameCoverage}%)
                </p>
              </div>
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">UNKNOWN Position</p>
                <p className={`font-bold ${result.readiness.unknownPositionPct <= result.targetReadiness.unknownPosition ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {result.readiness.unknownPositionPct.toFixed(1)}% (max {result.targetReadiness.unknownPosition}%)
                </p>
              </div>
            </div>
          </div>

          {/* Per-Match Summaries */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-800">
              <h3 className="text-white font-semibold text-sm">Match-by-Match Freshness</h3>
            </div>
            <div className="divide-y divide-gray-800/50">
              {result.summaries.map(s => (
                <div key={s.matchId}>
                  <button
                    onClick={() => {
                      setExpandedMatch(expandedMatch === s.matchId ? null : s.matchId);
                      setSelectedMatchId(s.matchId);
                    }}
                    className="w-full px-4 py-3 flex items-center gap-3 hover:bg-gray-800/30 transition text-left"
                  >
                    {expandedMatch === s.matchId ? <ChevronDown className="w-4 h-4 text-gray-500" /> : <ChevronRight className="w-4 h-4 text-gray-500" />}
                    <div className="flex-1 min-w-0">
                      <p className="text-white text-sm font-medium truncate">{s.matchLabel}</p>
                      <p className="text-gray-500 text-xs">Round {s.round} {s.venue ? `@ ${s.venue}` : ''}</p>
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-gray-400">{s.playersWithOdds} odds</span>
                      <span className="text-emerald-400">{s.playersMatchedToStats} matched</span>
                      <span className={`px-2 py-0.5 rounded-full font-semibold border ${
                        s.status === 'Ready' ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' :
                        s.status === 'Warning' ? 'bg-amber-500/20 text-amber-400 border-amber-500/30' :
                        'bg-red-500/20 text-red-400 border-red-500/30'
                      }`}>{s.status}</span>
                    </div>
                  </button>
                  {expandedMatch === s.matchId && (
                    <div className="px-4 pb-3 bg-gray-900/50">
                      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs mb-2">
                        <div className="bg-gray-800/50 rounded p-2">
                          <p className="text-gray-500">Latest Game Included</p>
                          <p className="text-emerald-400 font-bold">{s.playersWithLatestGame}</p>
                        </div>
                        <div className="bg-gray-800/50 rounded p-2">
                          <p className="text-gray-500">Missing Latest Game</p>
                          <p className="text-red-400 font-bold">{s.playersMissingLatestGame}</p>
                        </div>
                        <div className="bg-gray-800/50 rounded p-2">
                          <p className="text-gray-500">No Current Season</p>
                          <p className="text-orange-400 font-bold">{s.playersWithNoCurrentSeason}</p>
                        </div>
                        <div className="bg-gray-800/50 rounded p-2">
                          <p className="text-gray-500">UNKNOWN Position</p>
                          <p className="text-amber-400 font-bold">{s.playersWithUnknownPosition}</p>
                        </div>
                        <div className="bg-gray-800/50 rounded p-2">
                          <p className="text-gray-500">Matched to Stats</p>
                          <p className="text-blue-400 font-bold">{s.playersMatchedToStats}/{s.playersWithOdds}</p>
                        </div>
                      </div>
                      {s.statusReasons.length > 0 && (
                        <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded p-2">
                          {s.statusReasons.map((r, i) => <p key={i}>• {r}</p>)}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Match Selector for Player Detail */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Select Match for Player Detail</label>
        <select
          value={selectedMatchId}
          onChange={e => setSelectedMatchId(e.target.value)}
          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm"
        >
          {matches.map(m => (
            <option key={m.id} value={m.id}>
              {m.home_team} vs {m.away_team} — Round {m.round} {m.venue ? `@ ${m.venue}` : ''}
            </option>
          ))}
        </select>
      </div>

      {/* Player Data Freshness Table */}
      {matchRowsLoading ? (
        <LoadingSpinner message="Loading player freshness..." />
      ) : matchRowsError ? (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <XCircle className="w-4 h-4 text-red-400" />
            <h3 className="text-red-400 font-semibold text-sm">Error loading player rows</h3>
          </div>
          <p className="text-xs text-gray-400">{matchRowsError}</p>
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-2">
            <h3 className="text-white font-semibold text-sm">Player Data Freshness — {matchRows.length} players</h3>
          </div>
          <div className="overflow-x-auto max-h-[600px]">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-gray-800">
                <tr className="text-gray-500 uppercase tracking-wider border-b border-gray-700/50">
                  <th className="text-left px-2 py-2 font-medium">Player</th>
                  <th className="text-left px-2 py-2 font-medium">Team</th>
                  <th className="text-left px-2 py-2 font-medium">Opp</th>
                  <th className="text-center px-2 py-2 font-medium">Latest Date</th>
                  <th className="text-center px-2 py-2 font-medium">Round</th>
                  <th className="text-center px-2 py-2 font-medium">Opp</th>
                  <th className="text-center px-2 py-2 font-medium">Venue</th>
                  <th className="text-center px-2 py-2 font-medium">D</th>
                  <th className="text-center px-2 py-2 font-medium">M</th>
                  <th className="text-center px-2 py-2 font-medium">T</th>
                  <th className="text-center px-2 py-2 font-medium">G</th>
                  <th className="text-center px-2 py-2 font-medium">HO</th>
                  <th className="text-center px-2 py-2 font-medium">Total</th>
                  <th className="text-center px-2 py-2 font-medium">Season</th>
                  <th className="text-center px-2 py-2 font-medium">Exp Rnd</th>
                  <th className="text-center px-2 py-2 font-medium">Pos</th>
                  <th className="text-center px-2 py-2 font-medium">Status</th>
                  <th className="text-center px-2 py-2 font-medium">Verify</th>
                </tr>
              </thead>
              <tbody>
                {matchRows.map((r, i) => (
                  <tr key={i} className="border-b border-gray-800/30 hover:bg-gray-800/30">
                    <td className="px-2 py-1.5 text-white font-medium">{r.playerName}</td>
                    <td className="px-2 py-1.5 text-gray-400">{r.team ?? '—'}</td>
                    <td className="px-2 py-1.5 text-gray-400">{r.opponent ?? '—'}</td>
                    <td className="px-2 py-1.5 text-center text-gray-300">{r.latestStatDate ?? '—'}</td>
                    <td className="px-2 py-1.5 text-center text-gray-300">{r.latestStatRound ?? '—'}</td>
                    <td className="px-2 py-1.5 text-center text-gray-400 text-[10px] truncate max-w-[80px]">{r.latestStatOpponent ?? '—'}</td>
                    <td className="px-2 py-1.5 text-center text-gray-400 text-[10px] truncate max-w-[80px]">{r.latestStatVenue ?? '—'}</td>
                    <td className="px-2 py-1.5 text-center text-gray-300">{r.latestDisposals ?? '—'}</td>
                    <td className="px-2 py-1.5 text-center text-gray-300">{r.latestMarks ?? '—'}</td>
                    <td className="px-2 py-1.5 text-center text-gray-300">{r.latestTackles ?? '—'}</td>
                    <td className="px-2 py-1.5 text-center text-gray-300">{r.latestGoals ?? '—'}</td>
                    <td className="px-2 py-1.5 text-center text-gray-300">{r.latestHitouts ?? '—'}</td>
                    <td className="px-2 py-1.5 text-center text-gray-300">{r.totalGames}</td>
                    <td className="px-2 py-1.5 text-center text-gray-300">{r.gamesThisSeason}</td>
                    <td className="px-2 py-1.5 text-center text-gray-400">{r.expectedLatestRound ? `R${r.expectedLatestRound}` : '—'}</td>
                    <td className="px-2 py-1.5 text-center">
                      <span className={`text-[10px] px-1 py-0.5 rounded ${r.positionGroup === 'UNKNOWN' || !r.positionGroup ? 'bg-red-500/20 text-red-400' : 'bg-gray-700 text-gray-300'}`}>
                        {r.positionGroup ?? 'UNKNOWN'}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border ${STATUS_COLORS[r.status]}`} title={r.statusReason}>
                        {r.status === 'Fresh' ? 'Fresh' : r.status === 'Missing last game' ? 'Missing' : r.status === 'No current season data' ? 'No Season' : r.status === 'No historical stats' ? 'No Stats' : r.status === 'Team mismatch' ? 'Team Mis' : r.status === 'Match_id missing' ? 'No Match' : r.status.includes('bye') ? 'Bye/DNP' : 'Review'}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-center">
                      <button
                        onClick={() => loadSpotCheck(r.playerName, r.playerId)}
                        className="p-1 bg-blue-500/20 text-blue-400 rounded hover:bg-blue-500/30"
                        title="Verify Stats"
                      >
                        <Eye className="w-3 h-3" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* UNKNOWN Position Audit */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-amber-400" />
          <h3 className="text-white font-semibold text-sm">UNKNOWN Position Audit — {unknownPlayers.length} players</h3>
        </div>
        {unknownPlayers.length === 0 ? (
          <p className="text-emerald-400 text-xs">All players with current-round odds have mapped positions.</p>
        ) : (
          <div className="space-y-1.5 max-h-60 overflow-y-auto">
            {unknownPlayers.map((p, i) => (
              <div key={i} className="flex items-center gap-2 text-xs bg-gray-800/50 rounded p-2">
                <span className="text-white font-medium flex-1">{p.playerName}</span>
                <span className="text-gray-500">{p.team ?? '—'}</span>
                <button
                  onClick={() => {
                    setEditingOverride({ playerName: p.playerName, team: p.team, currentGroup: 'UNKNOWN' });
                    setOverrideForm({ positionGroup: 'UNKNOWN', confidence: 'high' });
                  }}
                  className="p-1 bg-amber-500/20 text-amber-400 rounded hover:bg-amber-500/30"
                >
                  <Edit3 className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        {overrides.length > 0 && (
          <div className="mt-2">
            <p className="text-xs text-gray-500 mb-1">Existing Overrides ({overrides.length})</p>
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {overrides.map((o, i) => (
                <div key={i} className="flex items-center gap-2 text-xs bg-gray-800/30 rounded p-1.5">
                  <span className="text-white flex-1">{o.player_name}</span>
                  <span className="text-gray-500">{o.team ?? '—'}</span>
                  <span className="text-blue-400">{o.position_group}</span>
                  <span className="text-gray-500">{o.confidence}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {overrideMessage && (
          <div className="text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded p-2">
            {overrideMessage}
          </div>
        )}
      </div>

      {/* Override Editor Modal */}
      {editingOverride && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => setEditingOverride(null)}>
          <div className="absolute inset-0 bg-black/60" />
          <div className="relative bg-gray-900 border border-gray-700 rounded-xl p-5 w-full max-w-md space-y-3" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-white font-bold text-sm">Set Position — {editingOverride.playerName}</h3>
              <button onClick={() => setEditingOverride(null)} className="text-gray-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Position Group</label>
              <select
                value={overrideForm.positionGroup}
                onChange={e => setOverrideForm({ ...overrideForm, positionGroup: e.target.value })}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm"
              >
                {POSITION_GROUPS.map(g => <option key={g} value={g}>{g}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Confidence</label>
              <select
                value={overrideForm.confidence}
                onChange={e => setOverrideForm({ ...overrideForm, confidence: e.target.value })}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm"
              >
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>
            <button
              onClick={handleSaveOverride}
              disabled={overrideSaving}
              className="w-full bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 rounded-lg py-2 text-sm font-medium hover:bg-emerald-500/30 disabled:opacity-50"
            >
              {overrideSaving ? 'Saving...' : 'Save Override'}
            </button>
          </div>
        </div>
      )}

      {/* Spot Check Drawer */}
      {spotCheckPlayer && (
        <div className="fixed inset-0 z-50 flex justify-end" onClick={() => { setSpotCheckPlayer(null); setSpotCheck(null); }}>
          <div className="absolute inset-0 bg-black/60" />
          <div className="relative w-full max-w-lg h-full bg-gray-900 border-l border-gray-700 shadow-2xl overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="sticky top-0 bg-gray-900 border-b border-gray-800 px-5 py-4 flex items-center justify-between">
              <h2 className="text-white font-bold text-sm flex items-center gap-2">
                <Eye className="w-4 h-4 text-emerald-400" />
                Verify Stats — {spotCheckPlayer.name}
              </h2>
              <button onClick={() => { setSpotCheckPlayer(null); setSpotCheck(null); }} className="text-gray-400 hover:text-white p-1 rounded hover:bg-gray-800">
                <X className="w-4 h-4" />
              </button>
            </div>
            {spotCheckLoading ? (
              <div className="p-5"><LoadingSpinner message="Loading spot check..." /></div>
            ) : spotCheck ? (
              <div className="p-5 space-y-4">
                {/* Player info */}
                <div className="space-y-1">
                  <div className="flex flex-wrap gap-2 text-xs">
                    <span className="px-2 py-0.5 rounded bg-gray-800 text-gray-300">Team: {spotCheck.team ?? '—'}</span>
                    <span className="px-2 py-0.5 rounded bg-gray-800 text-gray-300">Pos: {spotCheck.positionGroup ?? 'UNKNOWN'}</span>
                    <span className={`px-2 py-0.5 rounded ${spotCheck.latestGameIsFromLastCompletedRound ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}`}>
                      {spotCheck.latestGameIsFromLastCompletedRound ? 'Latest game from last round' : 'Latest game NOT from last round'}
                    </span>
                  </div>
                </div>

                {/* Model Sample Summary */}
                <div className="bg-blue-500/10 border border-blue-500/30 rounded p-3 space-y-1.5 text-xs">
                  <h4 className="text-blue-400 font-semibold uppercase tracking-wide">Model Sample Used</h4>
                  <div className="flex justify-between"><span className="text-gray-500">Sample size</span><span className="text-white">{spotCheck.modelSample.sampleSize} games</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">First game date</span><span className="text-white">{spotCheck.modelSample.firstGameDate ?? '—'}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Latest game date</span><span className="text-white">{spotCheck.modelSample.latestGameDate ?? '—'}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Latest round</span><span className="text-white">{spotCheck.modelSample.latestRound ?? '—'}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Latest opponent</span><span className="text-white">{spotCheck.modelSample.latestOpponent ?? '—'}</span></div>
                  <div className="flex justify-between"><span className="text-gray-500">Latest disposals</span><span className="text-white">{spotCheck.modelSample.latestDisposals ?? '—'}</span></div>
                </div>

                {/* Latest Game */}
                <div className="bg-gray-800/50 rounded p-3 space-y-1.5 text-xs">
                  <h4 className="text-gray-400 font-semibold uppercase tracking-wide">Latest Game in Database</h4>
                  {spotCheck.latestGame ? (
                    <>
                      <div className="flex justify-between"><span className="text-gray-500">Date</span><span className="text-white">{spotCheck.latestGame.match_date}</span></div>
                      <div className="flex justify-between"><span className="text-gray-500">Round</span><span className="text-white">{spotCheck.latestGame.round ?? '—'}</span></div>
                      <div className="flex justify-between"><span className="text-gray-500">Opponent</span><span className="text-white">{spotCheck.latestGame.opponent ?? '—'}</span></div>
                      <div className="flex justify-between"><span className="text-gray-500">Venue</span><span className="text-white">{spotCheck.latestGame.venue ?? '—'}</span></div>
                      <div className="flex justify-between"><span className="text-gray-500">D / M / T / G / HO</span><span className="text-white">{spotCheck.latestGame.disposals} / {spotCheck.latestGame.marks} / {spotCheck.latestGame.tackles} / {spotCheck.latestGame.goals} / {spotCheck.latestGame.hitouts}</span></div>
                    </>
                  ) : (
                    <p className="text-red-400">No games found</p>
                  )}
                </div>

                {/* Games used in each model */}
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="bg-gray-800/50 rounded p-2">
                    <p className="text-gray-500">Last 5 games</p>
                    <p className="text-white font-bold">{spotCheck.last5Games.length}</p>
                  </div>
                  <div className="bg-gray-800/50 rounded p-2">
                    <p className="text-gray-500">Last 10 games</p>
                    <p className="text-white font-bold">{spotCheck.last10Games.length}</p>
                  </div>
                  <div className="bg-gray-800/50 rounded p-2">
                    <p className="text-gray-500">Current season games</p>
                    <p className="text-white font-bold">{spotCheck.currentSeasonGames.length}</p>
                  </div>
                  <div className="bg-gray-800/50 rounded p-2">
                    <p className="text-gray-500">Venue sample</p>
                    <p className="text-blue-400 font-bold">{spotCheck.venueSampleGames.length}</p>
                  </div>
                  <div className="bg-gray-800/50 rounded p-2">
                    <p className="text-gray-500">Opponent sample</p>
                    <p className="text-amber-400 font-bold">{spotCheck.opponentSampleGames.length}</p>
                  </div>
                </div>

                {/* Last 5 Games Detail */}
                <div className="bg-gray-800/50 rounded p-3 space-y-1.5 text-xs">
                  <h4 className="text-gray-400 font-semibold uppercase tracking-wide">Last 5 Games (used in Last 5 model)</h4>
                  {spotCheck.last5Games.length === 0 ? (
                    <p className="text-gray-500">No games</p>
                  ) : (
                    <div className="space-y-1">
                      {spotCheck.last5Games.map((g, i) => (
                        <div key={i} className="flex justify-between text-[11px]">
                          <span className="text-gray-400">R{g.round ?? '?'} {g.match_date} vs {g.opponent ?? '?'}</span>
                          <span className="text-white">{g.disposals}D {g.marks}M {g.tackles}T {g.goals}G {g.hitouts}HO</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Last 10 Games Detail */}
                <div className="bg-gray-800/50 rounded p-3 space-y-1.5 text-xs">
                  <h4 className="text-gray-400 font-semibold uppercase tracking-wide">Last 10 Games (used in Last 10 model)</h4>
                  {spotCheck.last10Games.length === 0 ? (
                    <p className="text-gray-500">No games</p>
                  ) : (
                    <div className="space-y-1">
                      {spotCheck.last10Games.map((g, i) => (
                        <div key={i} className="flex justify-between text-[11px]">
                          <span className="text-gray-400">R{g.round ?? '?'} {g.match_date} vs {g.opponent ?? '?'}</span>
                          <span className="text-white">{g.disposals}D {g.marks}M {g.tackles}T {g.goals}G {g.hitouts}HO</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Current Season Games */}
                <div className="bg-gray-800/50 rounded p-3 space-y-1.5 text-xs">
                  <h4 className="text-gray-400 font-semibold uppercase tracking-wide">Current Season Games (used in Current Season model)</h4>
                  {spotCheck.currentSeasonGames.length === 0 ? (
                    <p className="text-red-400">No current season games — this is why Current Season shows "—"</p>
                  ) : (
                    <div className="space-y-1 max-h-40 overflow-y-auto">
                      {spotCheck.currentSeasonGames.map((g, i) => (
                        <div key={i} className="flex justify-between text-[11px]">
                          <span className="text-gray-400">R{g.round ?? '?'} {g.match_date} vs {g.opponent ?? '?'}</span>
                          <span className="text-white">{g.disposals}D {g.marks}M {g.tackles}T {g.goals}G {g.hitouts}HO</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Venue Sample Games */}
                <div className="bg-blue-500/10 border border-blue-500/30 rounded p-3 space-y-1.5 text-xs">
                  <h4 className="text-blue-400 font-semibold uppercase tracking-wide flex items-center gap-1">
                    <MapPin className="w-3 h-3" /> Venue Edge Sample ({spotCheck.venueSampleGames.length} games)
                  </h4>
                  {spotCheck.venueSampleGames.length === 0 ? (
                    <p className="text-gray-500">No games at this venue</p>
                  ) : (
                    <div className="space-y-1 max-h-40 overflow-y-auto">
                      {spotCheck.venueSampleGames.map((g, i) => (
                        <div key={i} className="flex justify-between text-[11px]">
                          <span className="text-gray-400">R{g.round ?? '?'} {g.match_date}</span>
                          <span className="text-white">{g.disposals}D {g.marks}M {g.tackles}T {g.goals}G {g.hitouts}HO</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Opponent Sample Games */}
                <div className="bg-amber-500/10 border border-amber-500/30 rounded p-3 space-y-1.5 text-xs">
                  <h4 className="text-amber-400 font-semibold uppercase tracking-wide flex items-center gap-1">
                    <Swords className="w-3 h-3" /> Opponent Edge Sample ({spotCheck.opponentSampleGames.length} games)
                  </h4>
                  {spotCheck.opponentSampleGames.length === 0 ? (
                    <p className="text-gray-500">No games vs this opponent</p>
                  ) : (
                    <div className="space-y-1 max-h-40 overflow-y-auto">
                      {spotCheck.opponentSampleGames.map((g, i) => (
                        <div key={i} className="flex justify-between text-[11px]">
                          <span className="text-gray-400">R{g.round ?? '?'} {g.match_date}</span>
                          <span className="text-white">{g.disposals}D {g.marks}M {g.tackles}T {g.goals}G {g.hitouts}HO</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="p-5 text-gray-400 text-sm">No data found for this player.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
