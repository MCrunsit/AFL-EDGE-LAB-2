/**
 * Model Review — retrospective analysis built entirely from leakage-safe
 * backfilled predictions (probabilityCalibration.ts), not a persisted
 * forward-looking prediction log. Two tabs:
 *  - Probability Calibration: are the model's stated probabilities
 *    actually right, bucketed by confidence range, against real outcomes.
 *  - Post-Round Review: what Game Get-Up / Round Multi would have
 *    recommended for completed matches, graded against real results.
 *
 * Every number here is a rolling, honestly-labeled sample — this project's
 * bookmaker_odds history only goes back to 2026-07-07, so early reports
 * will legitimately be thin. Never overstate confidence past what the
 * sample supports.
 */
import { useState } from 'react';
import { Loader2, AlertTriangle, BarChart3, History } from 'lucide-react';
import {
  runCalibrationBackfill, buildCalibrationReport, getCompletedMatchesWithGenuineOdds,
  type CalibrationReport, type CompletedMatchInput,
} from '../lib/probabilityCalibration';
import {
  runPostRoundBackfill, buildPostRoundReport,
  type PostRoundReport,
} from '../lib/postRoundReview';

type Tab = 'calibration' | 'postRound';

function CalibrationTab() {
  const [matches, setMatches] = useState<CompletedMatchInput[] | null>(null);
  const [loadingMatches, setLoadingMatches] = useState(false);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<CalibrationReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadMatches() {
    setLoadingMatches(true);
    setError(null);
    try {
      const m = await getCompletedMatchesWithGenuineOdds();
      setMatches(m);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMatches(false);
    }
  }

  async function runBackfill() {
    if (!matches || matches.length === 0) return;
    setRunning(true);
    setError(null);
    setReport(null);
    try {
      const predictions = await runCalibrationBackfill(matches);
      setReport(buildCalibrationReport(predictions));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <h3 className="text-white font-semibold text-sm mb-1">Probability Calibration</h3>
        <p className="text-gray-500 text-xs mb-3">
          Recomputes every genuine disposals prediction for completed matches using only stats dated before that match,
          then checks whether the model's stated probability actually matches what happened.
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={loadMatches}
            disabled={loadingMatches}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-gray-200 text-xs font-medium rounded-lg transition"
          >
            {loadingMatches ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <History className="w-3.5 h-3.5" />}
            Find Completed Matches
          </button>
          <button
            onClick={runBackfill}
            disabled={!matches || matches.length === 0 || running}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white text-xs font-bold rounded-lg transition"
          >
            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BarChart3 className="w-3.5 h-3.5" />}
            Run Calibration Backfill
          </button>
        </div>
        {matches && (
          <p className="text-[10px] text-gray-500 mt-2">
            {matches.length} completed matches found with genuine bookmaker odds
            {matches.length > 0 && ` (${matches[0].matchDate} to ${matches[matches.length - 1].matchDate})`}.
            This is a small, growing sample — early results should be read as provisional, not conclusive.
          </p>
        )}
        {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
      </div>

      {report && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
            <h4 className="text-white font-semibold text-sm">Calibration Buckets</h4>
            <span className="text-xs text-gray-400">
              {report.totalPredictions} predictions across {report.matchesUsed} matches ·
              Overall Brier score: <span className="text-white font-semibold">{report.overallBrierScore?.toFixed(3) ?? '—'}</span>
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 text-left border-b border-gray-800">
                  <th className="py-1.5 pr-3">Bucket</th>
                  <th className="py-1.5 pr-3">Predictions</th>
                  <th className="py-1.5 pr-3">Expected Hit Rate</th>
                  <th className="py-1.5 pr-3">Actual Hit Rate</th>
                  <th className="py-1.5 pr-3">Calibration Diff</th>
                  <th className="py-1.5 pr-3">Brier Score</th>
                </tr>
              </thead>
              <tbody>
                {report.buckets.map(b => (
                  <tr key={b.label} className="border-b border-gray-800/50">
                    <td className="py-1.5 pr-3 text-white font-medium">{b.label}</td>
                    <td className="py-1.5 pr-3 text-gray-300">{b.predictionsMade}</td>
                    {b.provisional ? (
                      <td colSpan={4} className="py-1.5 text-amber-400 italic">
                        Provisional — insufficient sample ({b.predictionsMade} &lt; 5 predictions)
                      </td>
                    ) : (
                      <>
                        <td className="py-1.5 pr-3 text-gray-300">{((b.expectedHitRate ?? 0) * 100).toFixed(1)}%</td>
                        <td className="py-1.5 pr-3 text-gray-300">{((b.actualHitRate ?? 0) * 100).toFixed(1)}%</td>
                        <td className={`py-1.5 pr-3 font-medium ${Math.abs(b.calibrationDifference ?? 0) > 0.10 ? 'text-amber-400' : 'text-emerald-400'}`}>
                          {b.calibrationDifference !== null ? `${b.calibrationDifference >= 0 ? '+' : ''}${(b.calibrationDifference * 100).toFixed(1)}%` : '—'}
                        </td>
                        <td className="py-1.5 pr-3 text-gray-300">{b.brierScore?.toFixed(3) ?? '—'}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[9px] text-gray-600 mt-3 flex items-start gap-1">
            <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-0.5" />
            Based on a rolling sample since the earliest genuine bookmaker odds capture — do not treat one round's results as conclusive.
          </p>
        </div>
      )}
    </div>
  );
}

function PostRoundTab() {
  const [matches, setMatches] = useState<CompletedMatchInput[] | null>(null);
  const [loadingMatches, setLoadingMatches] = useState(false);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<PostRoundReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadMatches() {
    setLoadingMatches(true);
    setError(null);
    try {
      const m = await getCompletedMatchesWithGenuineOdds();
      setMatches(m);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMatches(false);
    }
  }

  async function runReview() {
    if (!matches || matches.length === 0) return;
    setRunning(true);
    setError(null);
    setReport(null);
    try {
      const backfillResults = await runPostRoundBackfill(matches);
      setReport(buildPostRoundReport(backfillResults));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <h3 className="text-white font-semibold text-sm mb-1">Post-Round Review</h3>
        <p className="text-gray-500 text-xs mb-3">
          Reconstructs what Game Get-Up and Round Multi would have recommended for each completed match, using the same
          leakage-safe backfilled predictions as Calibration, then grades those reconstructed recommendations against
          what actually happened. There is no persisted log of live recommendations — this is a retrospective simulation,
          not a record of bets actually placed.
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={loadMatches}
            disabled={loadingMatches}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-gray-200 text-xs font-medium rounded-lg transition"
          >
            {loadingMatches ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <History className="w-3.5 h-3.5" />}
            Find Completed Matches
          </button>
          <button
            onClick={runReview}
            disabled={!matches || matches.length === 0 || running}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-bold rounded-lg transition"
          >
            {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BarChart3 className="w-3.5 h-3.5" />}
            Run Post-Round Review
          </button>
        </div>
        {matches && (
          <p className="text-[10px] text-gray-500 mt-2">{matches.length} completed matches found with genuine bookmaker odds.</p>
        )}
        {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
      </div>

      {report && (
        <div className="space-y-3">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <span className="text-gray-400">Matches reviewed: <span className="text-white font-bold">{report.matchesReviewed}</span></span>
            <span className="text-gray-400">Get-Up multis reconstructed: <span className="text-white font-bold">{report.gameGetUpMultisGenerated}</span></span>
            <span className="text-gray-400">Get-Up multis "won": <span className="text-white font-bold">{report.gameGetUpMultisWon}</span></span>
            <span className="text-gray-400">Overall leg hit rate: <span className="text-white font-bold">{report.overallLegHitRate !== null ? `${(report.overallLegHitRate * 100).toFixed(1)}%` : '—'}</span></span>
            <span className="text-gray-400">Return on turnover: <span className="text-white font-bold">{report.returnOnTurnover !== null ? `${(report.returnOnTurnover * 100).toFixed(1)}%` : '—'}</span></span>
            <span className="text-gray-400">Max losing streak (legs): <span className="text-white font-bold">{report.maxLosingStreak}</span></span>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <h4 className="text-white font-semibold text-sm mb-2">Hit Rate By Quality Tier</h4>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              {report.hitRateByTier.map(t => (
                <div key={t.tier} className="bg-gray-800 rounded p-2">
                  <p className="text-[10px] text-gray-500 uppercase">{t.tier}</p>
                  <p className="text-white font-bold">{t.hitRate !== null ? `${(t.hitRate * 100).toFixed(0)}%` : '—'} <span className="text-gray-500 font-normal">({t.legCount})</span></p>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <h4 className="text-white font-semibold text-sm mb-2">Hit Rate By Probability Bucket</h4>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-xs">
              {report.hitRateByProbabilityBucket.map(b => (
                <div key={b.label} className="bg-gray-800 rounded p-2">
                  <p className="text-[10px] text-gray-500 uppercase">{b.label}</p>
                  <p className="text-white font-bold">{b.hitRate !== null ? `${(b.hitRate * 100).toFixed(0)}%` : '—'} <span className="text-gray-500 font-normal">({b.legCount})</span></p>
                </div>
              ))}
            </div>
          </div>

          {report.mostCommonFailureReasons.length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <h4 className="text-white font-semibold text-sm mb-2">Most Common Failure Reasons</h4>
              <ul className="text-xs text-gray-300 space-y-1">
                {report.mostCommonFailureReasons.map((r, i) => (
                  <li key={i}>{r.reason} <span className="text-gray-500">({r.count})</span></li>
                ))}
              </ul>
            </div>
          )}

          {(report.overratedPlayers.length > 0 || report.underratedPlayers.length > 0) && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {report.overratedPlayers.length > 0 && (
                <div className="bg-gray-900 border border-red-500/20 rounded-xl p-4">
                  <h4 className="text-red-400 font-semibold text-sm mb-2">Repeatedly Overrated</h4>
                  <ul className="text-xs text-gray-300 space-y-1">
                    {report.overratedPlayers.map((p, i) => (
                      <li key={i}>{p.playerName} — predicted {(p.avgPredictedProb * 100).toFixed(0)}% avg, hit {(p.actualHitRate * 100).toFixed(0)}% ({p.appearances} legs)</li>
                    ))}
                  </ul>
                </div>
              )}
              {report.underratedPlayers.length > 0 && (
                <div className="bg-gray-900 border border-emerald-500/20 rounded-xl p-4">
                  <h4 className="text-emerald-400 font-semibold text-sm mb-2">Repeatedly Underrated</h4>
                  <ul className="text-xs text-gray-300 space-y-1">
                    {report.underratedPlayers.map((p, i) => (
                      <li key={i}>{p.playerName} — predicted {(p.avgPredictedProb * 100).toFixed(0)}% avg, hit {(p.actualHitRate * 100).toFixed(0)}% ({p.appearances} legs)</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <p className="text-[9px] text-gray-600 flex items-start gap-1">
            <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-0.5" />
            Rolling sample of {report.matchesReviewed} completed matches — do not overreact to any single round's results.
          </p>
        </div>
      )}
    </div>
  );
}

export default function ModelReviewPage() {
  const [tab, setTab] = useState<Tab>('calibration');

  return (
    <div className="p-6 space-y-4 max-w-5xl mx-auto">
      <div>
        <h1 className="text-white font-bold text-xl">Model Review</h1>
        <p className="text-gray-500 text-sm">Retrospective probability calibration and post-round performance — built from leakage-safe backfilled predictions, never live-recorded bets.</p>
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => setTab('calibration')}
          className={`px-3 py-1.5 text-xs font-medium rounded-lg transition ${tab === 'calibration' ? 'bg-cyan-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}
        >
          Probability Calibration
        </button>
        <button
          onClick={() => setTab('postRound')}
          className={`px-3 py-1.5 text-xs font-medium rounded-lg transition ${tab === 'postRound' ? 'bg-emerald-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}
        >
          Post-Round Review
        </button>
      </div>
      {tab === 'calibration' ? <CalibrationTab /> : <PostRoundTab />}
    </div>
  );
}
