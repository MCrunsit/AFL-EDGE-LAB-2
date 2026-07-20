import { useState, useEffect, useCallback, useRef } from 'react';
import { Database, Search, AlertTriangle, CheckCircle, XCircle, Eye, RotateCcw, Play, FileText, ArrowRight, Info, DownloadCloud, Wifi, ChevronDown, ChevronRight, Activity, Pause, Square, PlayCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import {
  auditMissingStats,
  dryRunRepair,
  applySafeRepair,
  backfillMissingFromKali,
  testKaliConnectionForBackfill,
  getDatabaseHealth,
  relinkBrokenBookmakerOdds,
  completeCoverageForMatches,
  type CoverageCompletionResult,
  fetchMatches,
  type AuditEntry,
  type AuditResult,
  type DryRunResult,
  type ApplyResult,
  type BackfillResult,
  type DatabaseHealth,
  type RelinkResult,
  type AuditReason,
} from '../lib/missingStatsRepair';
import LoadingSpinner from '../components/LoadingSpinner';

interface MatchOption {
  id: string;
  season: number;
  round: string | null;
  home_team: string | null;
  away_team: string | null;
  match_date: string | null;
}

const REASON_COLORS: Record<AuditReason, string> = {
  'OK_HAS_STATS': 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  'PLAYER_ID_HAS_ZERO_STATS': 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  'DUPLICATE_PLAYER_WITH_STATS_FOUND': 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  'RAW_KALI_ROWS_AVAILABLE': 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
  'NAME_MISMATCH': 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  'TEAM_MISMATCH': 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  'NO_PLAYER_ROW': 'bg-red-500/20 text-red-400 border-red-500/30',
  'BROKEN_PLAYER_ID': 'bg-red-500/20 text-red-400 border-red-500/30',
  'NO_STATS_ANYWHERE': 'bg-red-500/20 text-red-400 border-red-500/30',
  'INSUFFICIENT_MARKET_SAMPLE': 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  'KALI_PLAYER_NOT_FOUND': 'bg-red-500/20 text-red-400 border-red-500/30',
  'TEAM_UNKNOWN': 'bg-gray-500/20 text-gray-400 border-gray-500/30',
};

export default function MissingStatsRepairPage() {
  const [matches, setMatches] = useState<MatchOption[]>([]);
  const [selectedMatchIds, setSelectedMatchIds] = useState<string[]>([]);
  const [loadingMatches, setLoadingMatches] = useState(true);

  const [auditRunning, setAuditRunning] = useState(false);
  const [auditResult, setAuditResult] = useState<AuditResult | null>(null);

  const [dryRunRunning, setDryRunRunning] = useState(false);
  const [dryRunResult, setDryRunResult] = useState<DryRunResult | null>(null);

  const [applyRunning, setApplyRunning] = useState(false);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);

  const [backfillRunning, setBackfillRunning] = useState(false);
  const [backfillResult, setBackfillResult] = useState<BackfillResult | null>(null);
  const [batchSize, setBatchSize] = useState(5);

  const [connTestRunning, setConnTestRunning] = useState(false);
  const [connTestResult, setConnTestResult] = useState<BackfillResult | null>(null);


  const [dbHealth, setDbHealth] = useState<DatabaseHealth | null>(null);
  const [dbHealthLoading, setDbHealthLoading] = useState(false);

  const [relinkRunning, setRelinkRunning] = useState(false);
  const [relinkResult, setRelinkResult] = useState<RelinkResult | null>(null);
  const [coverageResult, setCoverageResult] = useState<CoverageCompletionResult | null>(null);
  const [coverageLoading, setCoverageLoading] = useState(false);

  const [fullBackfillRunning, setFullBackfillRunning] = useState(false);
  const [fullBackfillPaused, setFullBackfillPaused] = useState(false);
  const [fullBackfillProgress, setFullBackfillProgress] = useState<{ processed: number; total: number; statsInserted: number; oddsRelinked: number; alreadyFixed: number; currentBatch: number; errors: string[] } | null>(null);
  const [fullBackfillBatchResults, setFullBackfillBatchResults] = useState<BackfillResult[]>([]);

  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadMatches() {
      setLoadingMatches(true);
      const today = new Date().toISOString().split('T')[0];
      const { data } = await supabase
        .from('matches')
        .select('id, season, round, home_team, away_team, match_date')
        .gte('match_date', today)
        .order('match_date', { ascending: true })
        .limit(30);
      setMatches((data ?? []) as MatchOption[]);
      setLoadingMatches(false);
    }
    loadMatches();
  }, []);

  const toggleMatch = useCallback((id: string) => {
    setSelectedMatchIds(prev =>
      prev.includes(id) ? prev.filter(m => m !== id) : [...prev, id]
    );
  }, []);

  const selectAll = useCallback(() => {
    setSelectedMatchIds(matches.map(m => m.id));
  }, [matches]);

  const selectNone = useCallback(() => {
    setSelectedMatchIds([]);
  }, []);

  const handleAudit = useCallback(async () => {
    if (selectedMatchIds.length === 0) return;
    setAuditRunning(true);
    setError(null);
    setAuditResult(null);
    setDryRunResult(null);
    setApplyResult(null);
    setBackfillResult(null);
    setConnTestResult(null);
    setRelinkResult(null);
    try {
      const result = await auditMissingStats(selectedMatchIds);
      setAuditResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Audit failed');
    } finally {
      setAuditRunning(false);
    }
  }, [selectedMatchIds]);

  const handleDryRun = useCallback(async () => {
    if (selectedMatchIds.length === 0) return;
    setDryRunRunning(true);
    setError(null);
    setDryRunResult(null);
    setApplyResult(null);
    setBackfillResult(null);
    setConnTestResult(null);
    setRelinkResult(null);
    try {
      const result = await dryRunRepair(selectedMatchIds);
      setDryRunResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Dry run failed');
    } finally {
      setDryRunRunning(false);
    }
  }, [selectedMatchIds]);

  const handleApply = useCallback(async () => {
    if (selectedMatchIds.length === 0) return;
    setApplyRunning(true);
    setError(null);
    setApplyResult(null);
    setBackfillResult(null);
    setConnTestResult(null);
    setRelinkResult(null);
    try {
      const result = await applySafeRepair(selectedMatchIds);
      setApplyResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Apply repair failed');
    } finally {
      setApplyRunning(false);
    }
  }, [selectedMatchIds]);

  const handleBackfill = useCallback(async () => {
    if (selectedMatchIds.length === 0) return;
    setBackfillRunning(true);
    setError(null);
    setBackfillResult(null);
    try {
      const result = await backfillMissingFromKali(selectedMatchIds, batchSize);
      setBackfillResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Backfill failed');
    } finally {
      setBackfillRunning(false);
    }
  }, [selectedMatchIds, batchSize]);

  const handleTestConnection = useCallback(async () => {
    setConnTestRunning(true);
    setConnTestResult(null);
    try {
      const result = await testKaliConnectionForBackfill();
      setConnTestResult(result);
    } finally {
      setConnTestRunning(false);
    }
  }, []);

  const handleLoadDbHealth = useCallback(async () => {
    setDbHealthLoading(true);
    try {
      const health = await getDatabaseHealth();
      setDbHealth(health);
    } finally {
      setDbHealthLoading(false);
    }
  }, []);

  const handleRelinkBroken = useCallback(async () => {
    if (selectedMatchIds.length === 0) return;
    setRelinkRunning(true);
    setError(null);
    setRelinkResult(null);
    try {
      const result = await relinkBrokenBookmakerOdds(selectedMatchIds);
      setRelinkResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Relink failed');
    } finally {
      setRelinkRunning(false);
    }
  }, [selectedMatchIds]);

  const handleCompleteCoverage = useCallback(async () => {
    if (selectedMatchIds.length === 0) return;
    setCoverageLoading(true);
    setError(null);
    setCoverageResult(null);
    try {
      const result = await completeCoverageForMatches(selectedMatchIds);
      setCoverageResult(result);
      // Refresh DB health + audit
      const health = await getDatabaseHealth();
      setDbHealth(health);
      await runAudit();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Coverage completion failed');
    } finally {
      setCoverageLoading(false);
    }
  }, [selectedMatchIds]);

  const fullBackfillAbortRef = useRef(false);

  const handleStartFullBackfill = useCallback(async () => {
    if (selectedMatchIds.length === 0) return;
    setFullBackfillRunning(true);
    setFullBackfillPaused(false);
    setFullBackfillBatchResults([]);
    fullBackfillAbortRef.current = false;

    // Build the full missing players list
    try {
      const audit = await auditMissingStats(selectedMatchIds);
      const missingEntries = audit.auditEntries.filter(
        e => e.reason !== 'OK_HAS_STATS' && e.reason !== 'INSUFFICIENT_MARKET_SAMPLE'
      );
      const total = missingEntries.length;
      if (total === 0) {
        setFullBackfillProgress({ processed: 0, total: 0, statsInserted: 0, oddsRelinked: 0, errors: [] });
        setFullBackfillRunning(false);
        return;
      }

      // Build payload
      const { missingPlayers } = await (async () => {
        const missingPlayers = missingEntries.map(e => ({
          bookmaker_player_name: e.playerName,
          current_player_id: e.currentPlayerId,
          match_id: e.matchId,
          home_team: null as string | null,
          away_team: null as string | null,
          season: e.season ?? new Date().getFullYear(),
          round: e.round,
          player_team: e.team || null,
          odds_rows: e.oddsRowsCount,
        }));
        const matchMap = await fetchMatches(selectedMatchIds);
        for (const mp of missingPlayers) {
          const m = matchMap.get(mp.match_id);
          if (m) {
            mp.home_team = m.home_team;
            mp.away_team = m.away_team;
          }
        }
        return { missingPlayers };
      })();

      const batchSize = 10;
      let processed = 0;
      let totalStats = 0;
      let totalOdds = 0;
      let totalAlreadyFixed = 0;
      const allErrors: string[] = [];
      let batchCount = 0;
      const failedBatches: { batch: typeof missingPlayers; batchIndex: number; lastError: string }[] = [];

      for (let i = 0; i < missingPlayers.length; i += batchSize) {
        if (fullBackfillAbortRef.current) break;

        // Check if paused — wait
        while (fullBackfillPaused && !fullBackfillAbortRef.current) {
          await new Promise(r => setTimeout(r, 500));
        }
        if (fullBackfillAbortRef.current) break;

        const batch = missingPlayers.slice(i, i + batchSize);
        let batchSuccess = false;
        let batchRetries = 0;
        const maxRetries = 3;

        while (!batchSuccess && batchRetries < maxRetries && !fullBackfillAbortRef.current) {
          try {
            const { data: invokeResult, error: invokeError } = await supabase.functions.invoke(
              'backfill-missing-player-stats',
              {
                body: JSON.stringify({
                  action: 'backfill',
                  missingPlayers: batch,
                  seasons: [2024, 2025, 2026],
                  batchSize: batch.length,
                }),
              }
            );

            if (invokeError) {
              batchRetries++;
              if (batchRetries >= maxRetries) {
                allErrors.push(`Batch ${batchCount + 1} failed after ${maxRetries} retries: ${invokeError.message}`);
                failedBatches.push({ batch, batchIndex: batchCount, lastError: invokeError.message });
              } else {
                await new Promise(r => setTimeout(r, 2000 * batchRetries));
              }
            } else {
              batchSuccess = true;
              const batchResult = invokeResult as BackfillResult;
              totalStats += batchResult.playerGameStatsRowsInserted ?? 0;
              totalOdds += batchResult.bookmakerOddsRowsRelinked ?? 0;
              const alreadyFixed = (batchResult.details ?? []).filter((d: any) => d.action === 'UPDATED' && d.statsInserted === 0 && d.message?.includes('already has')).length;
              totalAlreadyFixed += alreadyFixed;
              allErrors.push(...(batchResult.errors ?? []));
              setFullBackfillBatchResults(prev => [...prev, batchResult]);

              // Auto-pause if rate limit low
              if (batchResult.rateLimitRemaining !== null && batchResult.rateLimitRemaining < 20) {
                allErrors.push(`Auto-paused — rate limit low (${batchResult.rateLimitRemaining} remaining)`);
                setFullBackfillPaused(true);
              }

              // Auto-pause if more than 50% of batch errored
              const batchErrors = batchResult.errors?.length ?? 0;
              if (batch.length > 0 && batchErrors > batch.length * 0.5) {
                allErrors.push(`Auto-paused — ${batchErrors}/${batch.length} players errored in batch ${batchCount + 1}`);
                setFullBackfillPaused(true);
              }
            }
          } catch (err) {
            batchRetries++;
            const errMsg = err instanceof Error ? err.message : String(err);
            if (batchRetries >= maxRetries) {
              allErrors.push(`Batch ${batchCount + 1} failed after ${maxRetries} retries: ${errMsg}`);
              failedBatches.push({ batch, batchIndex: batchCount, lastError: errMsg });
            } else {
              await new Promise(r => setTimeout(r, 2000 * batchRetries));
            }
          }
        }

        batchCount++;
        // Only count as processed if the batch succeeded
        if (batchSuccess) {
          processed = Math.min(i + batchSize, total);
        }
        setFullBackfillProgress({ processed, total, statsInserted: totalStats, oddsRelinked: totalOdds, alreadyFixed: totalAlreadyFixed, currentBatch: batchCount, errors: [...allErrors] });

        // Re-audit every 10 batches (not every batch)
        if (batchCount % 10 === 0 && !fullBackfillAbortRef.current) {
          try {
            await runAudit();
            const health = await getDatabaseHealth();
            setDbHealth(health);
          } catch {
            // Skip audit errors
          }
        }
      }

      // Show failed batches if any
      if (failedBatches.length > 0) {
        const names = failedBatches.flatMap(fb => fb.batch.map(p => p.bookmaker_player_name));
        allErrors.push(`${failedBatches.length} batches failed permanently. ${names.length} players still pending: ${names.slice(0, 10).join(', ')}${names.length > 10 ? '...' : ''}`);
        setFullBackfillProgress(prev => ({ ...prev, errors: [...allErrors] }));
      }

      // Final audit after all batches
      if (!fullBackfillAbortRef.current) {
        try {
          await runAudit();
          const health = await getDatabaseHealth();
          setDbHealth(health);
        } catch {
          // Skip audit errors
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Full backfill failed');
    } finally {
      setFullBackfillRunning(false);
      setFullBackfillPaused(false);
    }
  }, [selectedMatchIds]);

  const handlePauseFullBackfill = useCallback(() => {
    setFullBackfillPaused(true);
  }, []);

  const handleResumeFullBackfill = useCallback(() => {
    setFullBackfillPaused(false);
  }, []);

  const handleStopFullBackfill = useCallback(() => {
    fullBackfillAbortRef.current = true;
    setFullBackfillRunning(false);
    setFullBackfillPaused(false);
  }, []);

  const summaryStats = auditResult ? {
    ok: auditResult.auditEntries.filter(e => e.reason === 'OK_HAS_STATS').length,
    noStats: auditResult.auditEntries.filter(e => e.reason === 'PLAYER_ID_HAS_ZERO_STATS' || e.reason === 'NO_STATS_ANYWHERE' || e.reason === 'NO_PLAYER_ROW' || e.reason === 'BROKEN_PLAYER_ID').length,
    duplicate: auditResult.auditEntries.filter(e => e.reason === 'DUPLICATE_PLAYER_WITH_STATS_FOUND').length,
    kali: auditResult.auditEntries.filter(e => e.reason === 'RAW_KALI_ROWS_AVAILABLE').length,
    mismatch: auditResult.auditEntries.filter(e => e.reason === 'TEAM_MISMATCH' || e.reason === 'NAME_MISMATCH' || e.reason === 'TEAM_UNKNOWN' || e.reason === 'BROKEN_PLAYER_ID').length,
    lowSample: auditResult.auditEntries.filter(e => e.reason === 'INSUFFICIENT_MARKET_SAMPLE').length,
  } : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-white font-bold text-xl flex items-center gap-2">
          <Database className="w-5 h-5 text-emerald-400" />
          Missing Stats Repair
        </h1>
        <p className="text-gray-500 text-sm mt-1">
          Audit and repair bookmaker odds rows where players have no <code className="text-gray-400">player_game_stats</code>.
          This is a data-level fix — Multi Builder reads the cleaned data afterwards.
        </p>
      </div>

      {/* Match selector */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-white font-semibold text-sm">Select Matches</h2>
          <div className="flex gap-2">
            <button onClick={selectAll} className="text-[11px] text-blue-400 hover:text-blue-300">Select All</button>
            <span className="text-gray-700">|</span>
            <button onClick={selectNone} className="text-[11px] text-gray-500 hover:text-gray-300">Clear</button>
          </div>
        </div>
        {loadingMatches ? (
          <LoadingSpinner message="Loading matches..." />
        ) : matches.length === 0 ? (
          <p className="text-gray-500 text-sm">No upcoming matches found.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {matches.map(m => {
              const selected = selectedMatchIds.includes(m.id);
              return (
                <button
                  key={m.id}
                  onClick={() => toggleMatch(m.id)}
                  className={`text-left px-3 py-2 rounded-lg border text-xs transition ${
                    selected
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                      : 'bg-gray-800/50 border-gray-800 text-gray-400 hover:border-gray-700'
                  }`}
                >
                  <div className="font-medium">
                    {m.home_team ?? '?'} vs {m.away_team ?? '?'}
                  </div>
                  <div className="text-[10px] text-gray-600 mt-0.5">
                    R{m.round ?? '?'} · {m.match_date ?? ''}
                  </div>
                </button>
              );
            })}
          </div>
        )}
        <p className="text-[11px] text-gray-500">{selectedMatchIds.length} match(es) selected</p>
      </div>

      {/* Action buttons */}
      <div className="flex flex-wrap gap-3">
        <button
          onClick={handleAudit}
          disabled={auditRunning || selectedMatchIds.length === 0}
          className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium rounded-lg text-sm transition"
        >
          {auditRunning ? <LoadingSpinner /> : <Search className="w-4 h-4" />}
          Audit Missing Player Stats
        </button>
        <button
          onClick={handleDryRun}
          disabled={dryRunRunning || selectedMatchIds.length === 0}
          className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium rounded-lg text-sm transition"
        >
          {dryRunRunning ? <LoadingSpinner /> : <Eye className="w-4 h-4" />}
          Dry Run Repair
        </button>
        <button
          onClick={handleApply}
          disabled={applyRunning || selectedMatchIds.length === 0}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium rounded-lg text-sm transition"
        >
          {applyRunning ? <LoadingSpinner /> : <RotateCcw className="w-4 h-4" />}
          Apply Safe Repair
        </button>
        <button
          onClick={handleBackfill}
          disabled={backfillRunning || selectedMatchIds.length === 0}
          className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium rounded-lg text-sm transition"
        >
          {backfillRunning ? <LoadingSpinner /> : <DownloadCloud className="w-4 h-4" />}
          Backfill Missing Players + Stats from Kali
        </button>
        <div className="flex items-center gap-2 text-xs text-gray-500">
          Batch:
          <select
            value={batchSize}
            onChange={(e) => setBatchSize(Number(e.target.value))}
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white text-xs"
          >
            <option value={1}>1</option>
            <option value={5}>5</option>
            <option value={10}>10</option>
          </select>
        </div>
      </div>

      {/* Run Full Backfill Safely row */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={handleStartFullBackfill}
          disabled={fullBackfillRunning || selectedMatchIds.length === 0}
          className="flex items-center gap-2 px-4 py-2 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium rounded-lg text-sm transition"
        >
          {fullBackfillRunning ? <LoadingSpinner /> : <PlayCircle className="w-4 h-4" />}
          Run Full Backfill Safely
        </button>
        {fullBackfillRunning && (
          <>
            {fullBackfillPaused ? (
              <button
                onClick={handleResumeFullBackfill}
                className="flex items-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-lg text-sm transition"
              >
                <Play className="w-4 h-4" /> Resume
              </button>
            ) : (
              <button
                onClick={handlePauseFullBackfill}
                className="flex items-center gap-2 px-3 py-2 bg-amber-600 hover:bg-amber-500 text-white font-medium rounded-lg text-sm transition"
              >
                <Pause className="w-4 h-4" /> Pause
              </button>
            )}
            <button
              onClick={handleStopFullBackfill}
              className="flex items-center gap-2 px-3 py-2 bg-red-600 hover:bg-red-500 text-white font-medium rounded-lg text-sm transition"
            >
              <Square className="w-4 h-4" /> Stop
            </button>
          </>
        )}
      </div>

      {/* Full backfill progress */}
      {fullBackfillProgress && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
          <h3 className="text-white font-semibold text-sm flex items-center gap-2">
            <PlayCircle className="w-4 h-4 text-emerald-400" />
            Full Backfill Progress
            {fullBackfillPaused && <span className="text-amber-400 text-xs">(Paused)</span>}
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div className="bg-gray-800/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-white">{fullBackfillProgress.processed} / {fullBackfillProgress.total}</p>
              <p className="text-[10px] text-gray-500">Processed</p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-emerald-400">{fullBackfillProgress.statsInserted.toLocaleString()}</p>
              <p className="text-[10px] text-gray-500">Stats Inserted</p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-blue-400">{fullBackfillProgress.oddsRelinked}</p>
              <p className="text-[10px] text-gray-500">Odds Relinked</p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-amber-400">{fullBackfillProgress.alreadyFixed}</p>
              <p className="text-[10px] text-gray-500">Already Fixed Skipped</p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-purple-400">{fullBackfillProgress.currentBatch}</p>
              <p className="text-[10px] text-gray-500">Current Batch</p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-white">{fullBackfillProgress.total - fullBackfillProgress.processed}</p>
              <p className="text-[10px] text-gray-500">Remaining</p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-red-400">{fullBackfillProgress.errors.length}</p>
              <p className="text-[10px] text-gray-500">Errors</p>
            </div>
          </div>
          <div className="w-full bg-gray-800 rounded-full h-2 overflow-hidden">
            <div
              className="bg-emerald-500 h-full transition-all"
              style={{ width: `${fullBackfillProgress.total > 0 ? (fullBackfillProgress.processed / fullBackfillProgress.total) * 100 : 0}%` }}
            />
          </div>
          {fullBackfillProgress.errors.length > 0 && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2 text-xs text-red-400 space-y-1 max-h-32 overflow-y-auto">
              {fullBackfillProgress.errors.slice(-10).map((e, i) => <p key={i}>{e}</p>)}
            </div>
          )}
        </div>
      )}

      {/* Test Connection + Test One Player row */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={handleTestConnection}
          disabled={connTestRunning}
          className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white font-medium rounded-lg text-sm transition"
        >
          {connTestRunning ? <LoadingSpinner /> : <Wifi className="w-4 h-4" />}
          Test Kali Connection
        </button>
        <button
          onClick={handleLoadDbHealth}
          disabled={dbHealthLoading}
          className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white font-medium rounded-lg text-sm transition"
        >
          {dbHealthLoading ? <LoadingSpinner /> : <Activity className="w-4 h-4" />}
          Database Health
        </button>
        <button
          onClick={handleRelinkBroken}
          disabled={relinkRunning || selectedMatchIds.length === 0}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white font-medium rounded-lg text-sm transition"
        >
          {relinkRunning ? <LoadingSpinner /> : <RotateCcw className="w-4 h-4" />}
          Relink Broken Bookmaker Odds
        </button>
        <button
          onClick={handleCompleteCoverage}
          disabled={coverageLoading || selectedMatchIds.length === 0}
          className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-bold rounded-lg text-sm transition"
        >
          {coverageLoading ? <LoadingSpinner /> : <CheckCircle className="w-4 h-4" />}
          Complete Coverage for Selected Matches
        </button>
      </div>

      {/* Database Health panel */}
      {dbHealth && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
          <h3 className="text-white font-semibold text-sm flex items-center gap-2">
            <Activity className="w-4 h-4 text-blue-400" />
            Database Health
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            <div className="bg-gray-800/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-white">{dbHealth.playersTotal.toLocaleString()}</p>
              <p className="text-[10px] text-gray-500">Players</p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-white">{dbHealth.playerGameStatsTotal.toLocaleString()}</p>
              <p className="text-[10px] text-gray-500">Player Game Stats</p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-white">{dbHealth.bookmakerOddsTotal.toLocaleString()}</p>
              <p className="text-[10px] text-gray-500">Bookmaker Odds</p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-red-400">{dbHealth.brokenPlayerIdCount.toLocaleString()}</p>
              <p className="text-[10px] text-gray-500">Broken Player ID</p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-orange-400">{dbHealth.zeroStatsOddsCount}</p>
              <p className="text-[10px] text-gray-500">0-Stats Players</p>
            </div>
          </div>
          <div className="flex items-center gap-4 text-xs">
            <span className="text-gray-500">Stats by season:</span>
            {dbHealth.statsBySeason.map(s => (
              <span key={s.season} className={`${s.count > 0 ? 'text-emerald-400' : 'text-red-400'} font-mono`}>
                {s.season}: {s.count.toLocaleString()}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Relink result */}
      {relinkResult && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
          <h3 className="text-white font-semibold text-sm flex items-center gap-2">
            <RotateCcw className="w-4 h-4 text-blue-400" />
            Relink Broken Bookmaker Odds — Complete
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            <div className="bg-gray-800/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-white">{relinkResult.totalOddsRows.toLocaleString()}</p>
              <p className="text-[10px] text-gray-500">Total Odds</p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-emerald-400">{relinkResult.relinked.toLocaleString()}</p>
              <p className="text-[10px] text-gray-500">Relinked</p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-amber-400">{relinkResult.ambiguous}</p>
              <p className="text-[10px] text-gray-500">Ambiguous</p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-red-400">{relinkResult.playerNotFound}</p>
              <p className="text-[10px] text-gray-500">Not Found</p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-gray-400">{relinkResult.alreadyLinked}</p>
              <p className="text-[10px] text-gray-500">Already OK</p>
            </div>
          </div>
          {relinkResult.details.filter(d => d.action === 'RELINKED' || d.action === 'AMBIGUOUS' || d.action === 'PLAYER_NOT_FOUND').length > 0 && (
            <div className="overflow-x-auto max-h-64">
              <table className="w-full text-xs">
                <thead className="bg-gray-800/30 border-b border-gray-800 sticky top-0">
                  <tr>
                    <th className="px-2 py-2 text-left text-gray-500 font-medium">Player</th>
                    <th className="px-2 py-2 text-left text-gray-500 font-medium">Match</th>
                    <th className="px-2 py-2 text-left text-gray-500 font-medium">Action</th>
                    <th className="px-2 py-2 text-left text-gray-500 font-medium">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {relinkResult.details.filter(d => d.action !== 'ALREADY_LINKED').slice(0, 50).map((d, i) => (
                    <tr key={i} className="border-b border-gray-800/30">
                      <td className="px-2 py-1.5 text-white whitespace-nowrap">{d.playerName}</td>
                      <td className="px-2 py-1.5 text-gray-500 whitespace-nowrap">{d.matchName}</td>
                      <td className="px-2 py-1.5">
                        <span className={`text-[10px] px-1 py-0.5 rounded ${
                          d.action === 'RELINKED' ? 'bg-emerald-500/20 text-emerald-400' :
                          d.action === 'AMBIGUOUS' ? 'bg-amber-500/20 text-amber-400' :
                          'bg-red-500/20 text-red-400'
                        }`}>
                          {d.action}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-gray-500 text-[10px]">{d.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {relinkResult.errors.length > 0 && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2 text-xs text-red-400 space-y-1">
              {relinkResult.errors.slice(0, 10).map((e, i) => <p key={i}>{e}</p>)}
            </div>
          )}
        </div>
      )}

      {/* Test Connection result */}
      {coverageResult && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
          <h3 className="text-white font-semibold text-sm flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-emerald-400" />
            Coverage Completion Result
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <div className="bg-gray-800/50 rounded-lg p-2">
              <p className="text-xs text-gray-500">Total Odds Rows</p>
              <p className="text-lg font-bold text-white">{coverageResult.totalOddsRows}</p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2">
              <p className="text-xs text-gray-500">Unique Players</p>
              <p className="text-lg font-bold text-white">{coverageResult.uniquePlayers}</p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2">
              <p className="text-xs text-gray-500">Already Has Stats</p>
              <p className="text-lg font-bold text-emerald-400">{coverageResult.alreadyHasStats}</p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2">
              <p className="text-xs text-gray-500">Relinked Locally</p>
              <p className="text-lg font-bold text-blue-400">{coverageResult.relinkedLocally}</p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2">
              <p className="text-xs text-gray-500">Needed Backfill</p>
              <p className="text-lg font-bold text-amber-400">{coverageResult.needsBackfill}</p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2">
              <p className="text-xs text-gray-500">Players Created</p>
              <p className="text-lg font-bold text-cyan-400">{coverageResult.playersCreated}</p>
            </div>
            {coverageResult.backfillResult && (
              <>
                <div className="bg-gray-800/50 rounded-lg p-2">
                  <p className="text-xs text-gray-500">Stats Inserted</p>
                  <p className="text-lg font-bold text-emerald-400">{coverageResult.backfillResult.playerGameStatsRowsInserted}</p>
                </div>
                <div className="bg-gray-800/50 rounded-lg p-2">
                  <p className="text-xs text-gray-500">Odds Relinked</p>
                  <p className="text-lg font-bold text-blue-400">{coverageResult.backfillResult.bookmakerOddsRowsRelinked}</p>
                </div>
              </>
            )}
          </div>
          {coverageResult.errors.length > 0 && (
            <div className="bg-red-950/30 border border-red-900 rounded-lg p-2 max-h-32 overflow-y-auto">
              <p className="text-xs text-red-400 font-semibold mb-1">Errors ({coverageResult.errors.length})</p>
              {coverageResult.errors.slice(0, 10).map((e, i) => (
                <p key={i} className="text-xs text-red-300">{e}</p>
              ))}
            </div>
          )}
        </div>
      )}

      {connTestResult && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
          <h3 className="text-white font-semibold text-sm flex items-center gap-2">
            <Wifi className="w-4 h-4 text-blue-400" />
            Kali Connection Test
          </h3>
          {connTestResult.envCheck ? (
            <div className="space-y-2">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="bg-gray-800/50 rounded-lg p-2 text-xs">
                  <span className="text-gray-500">KALI_API_KEY: </span>
                  <span className={connTestResult.envCheck.KALI_API_KEY ? 'text-emerald-400' : 'text-red-400'}>
                    {connTestResult.envCheck.KALI_API_KEY ? 'EXISTS' : 'MISSING'}
                  </span>
                </div>
                <div className="bg-gray-800/50 rounded-lg p-2 text-xs">
                  <span className="text-gray-500">SUPABASE_URL: </span>
                  <span className={connTestResult.envCheck.SUPABASE_URL ? 'text-emerald-400' : 'text-red-400'}>
                    {connTestResult.envCheck.SUPABASE_URL ? 'EXISTS' : 'MISSING'}
                  </span>
                </div>
                <div className="bg-gray-800/50 rounded-lg p-2 text-xs">
                  <span className="text-gray-500">SUPABASE_SERVICE_ROLE_KEY: </span>
                  <span className={connTestResult.envCheck.SUPABASE_SERVICE_ROLE_KEY ? 'text-emerald-400' : 'text-red-400'}>
                    {connTestResult.envCheck.SUPABASE_SERVICE_ROLE_KEY ? 'EXISTS' : 'MISSING'}
                  </span>
                </div>
                <div className="bg-gray-800/50 rounded-lg p-2 text-xs">
                  <span className="text-gray-500">Kali Base URL: </span>
                  <span className="text-gray-400 font-mono">{connTestResult.envCheck.kaliBaseUrl}</span>
                </div>
              </div>
              {connTestResult.envCheck.testHttpStatus !== undefined && (
                <div className="bg-gray-800/50 rounded-lg p-2 text-xs">
                  <span className="text-gray-500">Test endpoint: </span>
                  <span className="text-gray-400 font-mono">{connTestResult.envCheck.testEndpoint}</span>
                  <span className="text-gray-500"> → HTTP </span>
                  <span className={connTestResult.envCheck.testHttpStatus === 200 ? 'text-emerald-400' : 'text-red-400'}>
                    {connTestResult.envCheck.testHttpStatus}
                  </span>
                </div>
              )}
              {connTestResult.envCheck.rateLimitRemaining !== undefined && (
                <div className="bg-gray-800/50 rounded-lg p-2 text-xs">
                  <span className="text-gray-500">Rate limit remaining: </span>
                  <span className={connTestResult.envCheck.rateLimitRemaining < 50 ? 'text-amber-400' : 'text-emerald-400'}>
                    {connTestResult.envCheck.rateLimitRemaining}
                  </span>
                </div>
              )}
              {connTestResult.envCheck.testResponseSample && (
                <div className="bg-gray-800/50 rounded-lg p-2 text-xs">
                  <span className="text-gray-500">Response sample: </span>
                  <span className="text-gray-400 font-mono text-[10px]">{connTestResult.envCheck.testResponseSample}</span>
                </div>
              )}
              {connTestResult.envCheck.error && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2 text-xs text-red-400">
                  {connTestResult.envCheck.error}
                </div>
              )}
            </div>
          ) : (
            <div className="text-red-400 text-xs">
              {connTestResult.errors.join('; ')}
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Audit result */}
      {auditResult && (
        <div className="space-y-4">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <h3 className="text-white font-semibold text-sm mb-3 flex items-center gap-2">
              <FileText className="w-4 h-4 text-blue-400" />
              Audit Result
            </h3>
            {summaryStats && (
              <div className="grid grid-cols-2 sm:grid-cols-7 gap-2 mb-4">
                <div className="bg-gray-800/50 rounded-lg p-2 text-center">
                  <p className="text-lg font-bold text-white">{auditResult.uniquePlayers}</p>
                  <p className="text-[10px] text-gray-500">Players</p>
                </div>
                <div className="bg-gray-800/50 rounded-lg p-2 text-center">
                  <p className="text-lg font-bold text-white">{auditResult.totalOddsRows}</p>
                  <p className="text-[10px] text-gray-500">Odds Rows</p>
                </div>
                <div className="bg-gray-800/50 rounded-lg p-2 text-center">
                  <p className="text-lg font-bold text-emerald-400">{summaryStats.ok}</p>
                  <p className="text-[10px] text-gray-500">OK</p>
                </div>
                <div className="bg-gray-800/50 rounded-lg p-2 text-center">
                  <p className="text-lg font-bold text-orange-400">{summaryStats.noStats}</p>
                  <p className="text-[10px] text-gray-500">No Stats</p>
                </div>
                <div className="bg-gray-800/50 rounded-lg p-2 text-center">
                  <p className="text-lg font-bold text-blue-400">{summaryStats.duplicate}</p>
                  <p className="text-[10px] text-gray-500">Duplicate</p>
                </div>
                <div className="bg-gray-800/50 rounded-lg p-2 text-center">
                  <p className="text-lg font-bold text-cyan-400">{summaryStats.kali}</p>
                  <p className="text-[10px] text-gray-500">Kali Available</p>
                </div>
                <div className="bg-gray-800/50 rounded-lg p-2 text-center">
                  <p className="text-lg font-bold text-yellow-400">{summaryStats.lowSample}</p>
                  <p className="text-[10px] text-gray-500">Low Sample</p>
                </div>
              </div>
            )}
            {auditResult.errors.length > 0 && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2 text-xs text-red-400 mb-3">
                {auditResult.errors.slice(0, 5).map((e, i) => <p key={i}>{e}</p>)}
              </div>
            )}
            {auditResult.auditEntries.length > 0 && (
              <AuditTable entries={auditResult.auditEntries} />
            )}
          </div>
        </div>
      )}

      {/* Dry run result */}
      {dryRunResult && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-4">
          <h3 className="text-white font-semibold text-sm flex items-center gap-2">
            <Eye className="w-4 h-4 text-amber-400" />
            Dry Run Result (no changes made)
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-6 gap-2">
            <div className="bg-gray-800/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-white">{dryRunResult.bookmakerRowsChecked}</p>
              <p className="text-[10px] text-gray-500">Rows Checked</p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-white">{dryRunResult.uniquePlayersChecked}</p>
              <p className="text-[10px] text-gray-500">Players</p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-orange-400">{dryRunResult.rowsWithNoStats}</p>
              <p className="text-[10px] text-gray-500">No Stats</p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-emerald-400">{dryRunResult.duplicateRepairsPossible}</p>
              <p className="text-[10px] text-gray-500">Relinks</p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-cyan-400">{dryRunResult.rawKaliPromotionsPossible}</p>
              <p className="text-[10px] text-gray-500">Kali Promos</p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-red-400">{dryRunResult.playersStillMissingAfterRepair}</p>
              <p className="text-[10px] text-gray-500">Still Missing</p>
            </div>
          </div>

          {dryRunResult.repairs.length > 0 && (
            <div>
              <h4 className="text-emerald-400 font-semibold text-xs mb-2">Planned Repairs ({dryRunResult.repairs.length})</h4>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-gray-800/30 border-b border-gray-800">
                    <tr>
                      <th className="px-2 py-2 text-left text-gray-500 font-medium">Type</th>
                      <th className="px-2 py-2 text-left text-gray-500 font-medium">Player</th>
                      <th className="px-2 py-2 text-left text-gray-500 font-medium">Match</th>
                      <th className="px-2 py-2 text-right text-gray-500 font-medium">Odds Rows</th>
                      <th className="px-2 py-2 text-left text-gray-500 font-medium">From → To</th>
                      <th className="px-2 py-2 text-left text-gray-500 font-medium">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dryRunResult.repairs.map((r, i) => (
                      <tr key={i} className="border-b border-gray-800/30">
                        <td className="px-2 py-1.5">
                          <span className={`text-[10px] px-1 py-0.5 rounded ${r.type === 'RELINK' ? 'bg-blue-500/20 text-blue-400' : 'bg-cyan-500/20 text-cyan-400'}`}>
                            {r.type}
                          </span>
                        </td>
                        <td className="px-2 py-1.5 text-white font-medium whitespace-nowrap">{r.playerName}</td>
                        <td className="px-2 py-1.5 text-gray-400 whitespace-nowrap">{r.matchName}</td>
                        <td className="px-2 py-1.5 text-right text-gray-400 font-mono">{r.oddsRows}</td>
                        <td className="px-2 py-1.5 text-gray-500 font-mono text-[10px]">
                          {(r.fromPlayerId ?? 'null').slice(0, 8)} <ArrowRight className="w-3 h-3 inline" /> {r.toPlayerId.slice(0, 8)}
                        </td>
                        <td className="px-2 py-1.5 text-gray-500 text-[10px]">{r.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {dryRunResult.ambiguous.length > 0 && (
            <div>
              <h4 className="text-amber-400 font-semibold text-xs mb-2">Ambiguous — Skipped ({dryRunResult.ambiguous.length})</h4>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-gray-800/30 border-b border-gray-800">
                    <tr>
                      <th className="px-2 py-2 text-left text-gray-500 font-medium">Player</th>
                      <th className="px-2 py-2 text-left text-gray-500 font-medium">Match</th>
                      <th className="px-2 py-2 text-left text-gray-500 font-medium">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dryRunResult.ambiguous.map((a, i) => (
                      <tr key={i} className="border-b border-gray-800/30">
                        <td className="px-2 py-1.5 text-white font-medium whitespace-nowrap">{a.playerName}</td>
                        <td className="px-2 py-1.5 text-gray-400 whitespace-nowrap">{a.matchName}</td>
                        <td className="px-2 py-1.5 text-amber-400 text-[10px]">{a.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {dryRunResult.stillMissing.length > 0 && (
            <div>
              <h4 className="text-red-400 font-semibold text-xs mb-2">Still Missing After Repair ({dryRunResult.stillMissing.length})</h4>
              <AuditTable entries={dryRunResult.stillMissing} />
            </div>
          )}
        </div>
      )}

      {/* Apply result */}
      {applyResult && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-4">
          <h3 className="text-white font-semibold text-sm flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-emerald-400" />
            Apply Safe Repair — Complete
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            <div className="bg-gray-800/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-white">{applyResult.bookmakerRowsChecked}</p>
              <p className="text-[10px] text-gray-500">Rows Checked</p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-emerald-400">{applyResult.relinked}</p>
              <p className="text-[10px] text-gray-500">Relinked</p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-cyan-400">{applyResult.rawKaliPromoted}</p>
              <p className="text-[10px] text-gray-500">Kali Promoted</p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-amber-400">{applyResult.ambiguous}</p>
              <p className="text-[10px] text-gray-500">Ambiguous</p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-red-400">{applyResult.stillMissing}</p>
              <p className="text-[10px] text-gray-500">Still Missing</p>
            </div>
          </div>
          {applyResult.errors.length > 0 && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2 text-xs text-red-400">
              {applyResult.errors.slice(0, 10).map((e, i) => <p key={i}>{e}</p>)}
            </div>
          )}
          {applyResult.missingQueue.length > 0 && (
            <div>
              <h4 className="text-amber-400 font-semibold text-xs mb-2">Missing Stats Queue ({applyResult.missingQueue.length})</h4>
              <AuditTable entries={applyResult.missingQueue} />
            </div>
          )}
          <div className="flex items-center gap-2 text-[11px] text-gray-500">
            <Info className="w-3.5 h-3.5" />
            Repair complete. Return to Multi Builder and reload odds to see updated model statuses.
          </div>
        </div>
      )}

      {/* Backfill result */}
      {backfillResult && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-4">
          <h3 className="text-white font-semibold text-sm flex items-center gap-2">
            <DownloadCloud className="w-4 h-4 text-emerald-400" />
            Backfill from Kali — Complete
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-7 gap-2">
            <div className="bg-gray-800/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-white">{backfillResult.missingPlayersChecked}</p>
              <p className="text-[10px] text-gray-500">Checked</p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-emerald-400">{backfillResult.playersFoundInKali}</p>
              <p className="text-[10px] text-gray-500">Found in Kali</p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-blue-400">{backfillResult.playersCreated}</p>
              <p className="text-[10px] text-gray-500">Created</p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-cyan-400">{backfillResult.existingPlayersUpdated}</p>
              <p className="text-[10px] text-gray-500">Updated</p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-emerald-400">{backfillResult.playerGameStatsRowsInserted}</p>
              <p className="text-[10px] text-gray-500">Stats Inserted</p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-blue-400">{backfillResult.bookmakerOddsRowsRelinked}</p>
              <p className="text-[10px] text-gray-500">Odds Relinked</p>
            </div>
            <div className="bg-gray-800/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold text-red-400">{backfillResult.playersStillMissing}</p>
              <p className="text-[10px] text-gray-500">Still Missing</p>
            </div>
          </div>

          {backfillResult.errors.length > 0 && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-2 text-xs text-red-400 space-y-1">
              {backfillResult.errors.slice(0, 10).map((e, i) => <p key={i}>{e}</p>)}
            </div>
          )}

          {backfillResult.details.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-800/30 border-b border-gray-800">
                  <tr>
                    <th className="px-2 py-2 text-left text-gray-500 font-medium">Player</th>
                    <th className="px-2 py-2 text-left text-gray-500 font-medium">Team</th>
                    <th className="px-2 py-2 text-left text-gray-500 font-medium">Action</th>
                    <th className="px-2 py-2 text-right text-gray-500 font-medium">Stats</th>
                    <th className="px-2 py-2 text-left text-gray-500 font-medium">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {backfillResult.details.map((d, i) => (
                    <tr key={i} className="border-b border-gray-800/30">
                      <td className="px-2 py-1.5 text-white font-medium whitespace-nowrap">{d.playerName}</td>
                      <td className="px-2 py-1.5 text-gray-400 whitespace-nowrap">{d.team || '—'}</td>
                      <td className="px-2 py-1.5">
                        <span className={`text-[10px] px-1 py-0.5 rounded ${
                          d.action === 'CREATED' ? 'bg-blue-500/20 text-blue-400' :
                          d.action === 'UPDATED' ? 'bg-cyan-500/20 text-cyan-400' :
                          d.action === 'RELINKED' ? 'bg-emerald-500/20 text-emerald-400' :
                          d.action === 'NOT_FOUND' ? 'bg-red-500/20 text-red-400' :
                          'bg-red-500/20 text-red-400'
                        }`}>
                          {d.action}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-right text-gray-400 font-mono">{d.statsInserted}</td>
                      <td className="px-2 py-1.5 text-gray-500 text-[10px] max-w-[300px]">{d.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex items-center gap-2 text-[11px] text-gray-500">
            <Info className="w-3.5 h-3.5" />
            Backfill complete. Re-run Audit to verify. Return to Multi Builder and reload odds to see updated model statuses.
          </div>
        </div>
      )}
    </div>
  );
}

function AuditTable({ entries }: { entries: AuditEntry[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="bg-gray-800/30 border-b border-gray-800">
          <tr>
            <th className="px-2 py-2 text-left text-gray-500 font-medium">Player</th>
            <th className="px-2 py-2 text-left text-gray-500 font-medium">Team</th>
            <th className="px-2 py-2 text-left text-gray-500 font-medium">Match</th>
            <th className="px-2 py-2 text-right text-gray-500 font-medium">Odds Rows</th>
            <th className="px-2 py-2 text-left text-gray-500 font-medium">Player ID</th>
            <th className="px-2 py-2 text-right text-gray-500 font-medium">Stats</th>
            <th className="px-2 py-2 text-center text-gray-500 font-medium">Dup?</th>
            <th className="px-2 py-2 text-center text-gray-500 font-medium">Kali?</th>
            <th className="px-2 py-2 text-left text-gray-500 font-medium">Reason</th>
            <th className="px-2 py-2 text-left text-gray-500 font-medium">Recommended Action</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e, i) => (
            <tr key={i} className="border-b border-gray-800/30 hover:bg-gray-800/20">
              <td className="px-2 py-1.5 text-white font-medium whitespace-nowrap">{e.playerName || 'Unknown'}</td>
              <td className="px-2 py-1.5 text-gray-400 whitespace-nowrap">{e.team || '—'}</td>
              <td className="px-2 py-1.5 text-gray-400 whitespace-nowrap">{e.matchName || '—'}</td>
              <td className="px-2 py-1.5 text-right text-gray-400 font-mono">{e.oddsRowsCount}</td>
              <td className="px-2 py-1.5 text-gray-500 font-mono text-[10px]">{e.currentPlayerId ? e.currentPlayerId.slice(0, 8) + '…' : 'null'}</td>
              <td className="px-2 py-1.5 text-right text-gray-400 font-mono">{e.currentStatsCount}</td>
              <td className="px-2 py-1.5 text-center">
                {e.duplicateWithStatsFound ? (
                  <CheckCircle className="w-3.5 h-3.5 text-emerald-400 inline" />
                ) : (
                  <XCircle className="w-3.5 h-3.5 text-gray-700 inline" />
                )}
              </td>
              <td className="px-2 py-1.5 text-center">
                {e.rawKaliRowsFound ? (
                  <CheckCircle className="w-3.5 h-3.5 text-cyan-400 inline" />
                ) : (
                  <XCircle className="w-3.5 h-3.5 text-gray-700 inline" />
                )}
              </td>
              <td className="px-2 py-1.5">
                <span className={`text-[10px] px-1 py-0.5 rounded border whitespace-nowrap ${REASON_COLORS[e.reason] ?? 'bg-gray-700/30 text-gray-400 border-gray-700/40'}`}>
                  {e.reason}
                </span>
              </td>
              <td className="px-2 py-1.5 text-gray-500 text-[10px] max-w-[250px]">{e.recommendedAction}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
