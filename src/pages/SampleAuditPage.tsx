/**
 * Global Sample Audit Page
 *
 * Debug tool: choose a player, stat, and line. See the exact canonical game log
 * the model uses, hit/miss table for every game, and window hit rates.
 * Zero model magic — just the raw, deduplicated, sorted game log.
 */

import { useState, useCallback, useEffect } from 'react';
import { Search, List, Loader2, AlertCircle, CheckCircle2, XCircle, BarChart3, AlertTriangle, HelpCircle, Link2, Wrench, ArrowRight } from 'lucide-react';
import { supabase } from '../lib/supabase';
import type { PlayerGameStat } from '../lib/types';
import { getCanonicalPlayerGameLog, detectGameLogGaps, interleaveGaps, annotateGameLog, computeWindowCounts, type CanonicalStat, type CanonicalGameRow, type GameGap, type GapReason, type GameLogRowOrGap } from '../lib/canonicalGameLog';

const STAT_OPTIONS: { value: CanonicalStat; label: string }[] = [
  { value: 'disposals', label: 'Disposals' },
  { value: 'marks', label: 'Marks' },
  { value: 'tackles', label: 'Tackles' },
  { value: 'goals', label: 'Goals' },
  { value: 'hitouts', label: 'Hitouts' },
];

interface PlayerOption {
  id: string;
  name: string;
  team: string | null;
  position_group: string | null;
}

export default function SampleAuditPage() {
  const [playerSearch, setPlayerSearch] = useState('');
  const [playerOptions, setPlayerOptions] = useState<PlayerOption[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedPlayer, setSelectedPlayer] = useState<PlayerOption | null>(null);
  const [stat, setStat] = useState<CanonicalStat>('disposals');
  const [line, setLine] = useState<string>('20');
  const [season, setSeason] = useState<string>(String(new Date().getFullYear()));

  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<ReturnType<typeof annotateGameLog>>([]);
  const [gaps, setGaps] = useState<GameGap[]>([]);
  const [rowsWithGaps, setRowsWithGaps] = useState<GameLogRowOrGap[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [auditDone, setAuditDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Player Stats Link Debug ──
  const [linkDebug, setLinkDebug] = useState<{
    loading: boolean;
    statsCount: number;
    duplicates: Array<{ id: string; name: string; team: string | null; statsCount: number }>;
    rawKaliCount: number;
    rawKaliRows: Array<{ id: string; season: number; round: string | null; team: string | null; disposals: number | null; marks: number | null; tackles: number | null }>;
    bookmakerOddsCount: number;
    error: string | null;
  } | null>(null);

  const [repairRunning, setRepairRunning] = useState(false);
  const [repairResult, setRepairResult] = useState<{ type: 'success' | 'info' | 'error'; message: string } | null>(null);

  const loadLinkDebug = useCallback(async (player: { id: string; name: string; team: string | null }) => {
    setLinkDebug({ loading: true, statsCount: 0, duplicates: [], rawKaliCount: 0, rawKaliRows: [], bookmakerOddsCount: 0, error: null });
    setRepairResult(null);
    try {
      // 1. Stats count for selected player
      const { count: statsCount } = await supabase
        .from('player_game_stats')
        .select('*', { count: 'exact', head: true })
        .eq('player_id', player.id);

      // 2. Find duplicate players with same normalized name
      const normName = (player.name || '').toLowerCase().replace(/[^a-z\s'-]/g, '').replace(/\s+/g, ' ').trim();
      const { data: allPlayers } = await supabase
        .from('players')
        .select('id, name, team')
        .ilike('name', player.name);

      const duplicates: Array<{ id: string; name: string; team: string | null; statsCount: number }> = [];
      if (allPlayers) {
        for (const p of allPlayers as Array<{ id: string; name: string; team: string | null }>) {
          if (p.id === player.id) continue;
          const pNorm = (p.name || '').toLowerCase().replace(/[''.\-]/g, '').replace(/\s+/g, ' ').trim();
          if (pNorm !== normName) continue;
          const { count: dupStats } = await supabase
            .from('player_game_stats')
            .select('*', { count: 'exact', head: true })
            .eq('player_id', p.id);
          duplicates.push({ id: p.id, name: p.name, team: p.team, statsCount: dupStats ?? 0 });
        }
      }

      // 3. Raw Kali rows
      const { data: kaliData } = await supabase
        .from('raw_kali_player_game_stats')
        .select('id, season, round, team, disposals, marks, tackles')
        .eq('normalized_player_name', normName);

      const rawKaliRows = (kaliData as Array<{ id: string; season: number; round: string | null; team: string | null; disposals: number | null; marks: number | null; tackles: number | null }>) ?? [];
      const rawKaliCount = rawKaliRows.length;

      // 4. Bookmaker odds count
      const { count: oddsCount } = await supabase
        .from('bookmaker_odds')
        .select('*', { count: 'exact', head: true })
        .eq('player_id', player.id);

      setLinkDebug({
        loading: false,
        statsCount: statsCount ?? 0,
        duplicates,
        rawKaliCount,
        rawKaliRows: rawKaliRows.slice(0, 10),
        bookmakerOddsCount: oddsCount ?? 0,
        error: null,
      });
    } catch (err) {
      setLinkDebug({
        loading: false,
        statsCount: 0,
        duplicates: [],
        rawKaliCount: 0,
        rawKaliRows: [],
        bookmakerOddsCount: 0,
        error: err instanceof Error ? err.message : 'Failed to load debug data',
      });
    }
  }, []);

  // Auto-load debug when player is selected
  useEffect(() => {
    if (selectedPlayer) {
      loadLinkDebug(selectedPlayer);
    } else {
      setLinkDebug(null);
      setRepairResult(null);
    }
  }, [selectedPlayer, loadLinkDebug]);

  const handleRepairPlayerLink = useCallback(async () => {
    if (!selectedPlayer) return;
    setRepairRunning(true);
    setRepairResult(null);
    try {
      const normName = (selectedPlayer.name || '').toLowerCase().replace(/[^a-z\s'-]/g, '').replace(/\s+/g, ' ').trim();
      const normTeam = (selectedPlayer.team || '').toLowerCase().trim();

      // Check if selected player has stats
      const { count: myStats } = await supabase
        .from('player_game_stats')
        .select('*', { count: 'exact', head: true })
        .eq('player_id', selectedPlayer.id);

      if ((myStats ?? 0) > 0) {
        setRepairResult({ type: 'info', message: `Player already has ${myStats} stats rows. No repair needed.` });
        setRepairRunning(false);
        return;
      }

      // Find duplicate players with same normalized name + team that have stats
      const { data: allPlayers } = await supabase
        .from('players')
        .select('id, name, team')
        .ilike('name', selectedPlayer.name);

      const candidatesWithStats: Array<{ id: string; name: string; team: string | null; statsCount: number }> = [];
      if (allPlayers) {
        for (const p of allPlayers as Array<{ id: string; name: string; team: string | null }>) {
          if (p.id === selectedPlayer.id) continue;
          const pNorm = (p.name || '').toLowerCase().replace(/[''.\-]/g, '').replace(/\s+/g, ' ').trim();
          if (pNorm !== normName) continue;
          const { count: dupStats } = await supabase
            .from('player_game_stats')
            .select('*', { count: 'exact', head: true })
            .eq('player_id', p.id);
          if ((dupStats ?? 0) > 0) {
            candidatesWithStats.push({ id: p.id, name: p.name, team: p.team, statsCount: dupStats ?? 0 });
          }
        }
      }

      // Safe case A: exactly one duplicate with stats
      if (candidatesWithStats.length === 1) {
        const target = candidatesWithStats[0];
        const { error: updateError } = await supabase
          .from('bookmaker_odds')
          .update({
            player_id: target.id,
            resolved_player_name: selectedPlayer.name,
            resolution_status: 'relinked',
            resolution_reason: 'sample_audit_repair_duplicate_stats',
          })
          .eq('player_id', selectedPlayer.id);

        if (updateError) {
          setRepairResult({ type: 'error', message: `Relink failed: ${updateError.message}` });
        } else {
          setRepairResult({
            type: 'success',
            message: `Relinked ${selectedPlayer.name}'s bookmaker odds to ${target.name} (${target.id.slice(0, 8)}…) — ${target.statsCount} stats rows. Re-run Sample Audit to verify.`,
          });
          // Reload debug
          await loadLinkDebug({ ...selectedPlayer, id: target.id });
        }
        setRepairRunning(false);
        return;
      }

      if (candidatesWithStats.length > 1) {
        setRepairResult({
          type: 'error',
          message: `Ambiguous: ${candidatesWithStats.length} duplicate players with stats found. Cannot auto-relink. Use Data → Missing Stats Repair for manual review.`,
        });
        setRepairRunning(false);
        return;
      }

      // Safe case B: check raw_kali for this player
      const { data: kaliRows } = await supabase
        .from('raw_kali_player_game_stats')
        .select('id, player_id, normalized_player_name, normalized_team, team, match_id, season, round, match_date, opponent, venue, disposals, marks, tackles, goals, hitouts')
        .eq('normalized_player_name', normName);

      const teamMatchedKali = (kaliRows as Array<Record<string, unknown>> ?? []).filter(r => {
        const kaliTeam = String(r.team ?? '').toLowerCase().trim();
        const kaliNormTeam = String(r.normalized_team ?? '').toLowerCase().trim();
        return kaliTeam === normTeam || kaliNormTeam === normTeam;
      });

      if (teamMatchedKali.length > 0) {
        // Promote raw_kali rows to player_game_stats
        let promoted = 0;
        for (const r of teamMatchedKali) {
          const insertData = {
            player_id: selectedPlayer.id,
            match_id: r.match_id as string | null,
            match_date: r.match_date as string | null,
            season: r.season as number,
            round: r.round as string | null,
            team: String(r.team ?? ''),
            opponent: String(r.opponent ?? ''),
            venue: String(r.venue ?? ''),
            disposals: (r.disposals as number) ?? null,
            marks: (r.marks as number) ?? null,
            tackles: (r.tackles as number) ?? null,
            goals: (r.goals as number) ?? null,
            hitouts: (r.hitouts as number) ?? null,
            source: 'promoted_sample_audit_repair',
          };
          const { error: insertError } = await supabase
            .from('player_game_stats')
            // insertData is assembled from loosely-typed raw_kali staging rows;
            // cast preserves the existing promotion behaviour.
            .upsert(insertData as unknown as PlayerGameStat, { onConflict: 'player_id,match_id' });
          if (!insertError) promoted++;
        }
        setRepairResult({
          type: 'success',
          message: `Promoted ${promoted} raw_kali rows to player_game_stats for ${selectedPlayer.name}. Re-run Sample Audit to verify.`,
        });
        await loadLinkDebug(selectedPlayer);
        setRepairRunning(false);
        return;
      }

      // No stats anywhere
      setRepairResult({
        type: 'error',
        message: 'NO STATS FOUND ANYWHERE — import/backfill required. No duplicate player with stats, no raw_kali rows. Sync from Kali API or manually import stats.',
      });
    } catch (err) {
      setRepairResult({ type: 'error', message: err instanceof Error ? err.message : 'Repair failed' });
    } finally {
      setRepairRunning(false);
    }
  }, [selectedPlayer, loadLinkDebug]);

  const searchPlayers = useCallback(async (q: string) => {
    if (q.trim().length < 2) { setPlayerOptions([]); return; }
    setSearchLoading(true);
    const { data } = await supabase
      .from('players')
      .select('id, name, team, position_group')
      .ilike('name', `%${q}%`)
      .order('name')
      .limit(20);
    setPlayerOptions((data ?? []) as PlayerOption[]);
    setSearchLoading(false);
  }, []);

  const runAudit = useCallback(async () => {
    if (!selectedPlayer) return;
    const lineNum = parseFloat(line);
    if (isNaN(lineNum) || lineNum <= 0) { setError('Invalid line value'); return; }
    const seasonNum = parseInt(season, 10);
    setError(null);
    setRunning(true);
    setAuditDone(false);
    setRows([]);
    setGaps([]);
    setRowsWithGaps([]);

    const result = await getCanonicalPlayerGameLog(selectedPlayer.id, stat, seasonNum, 40);
    const annotated = annotateGameLog(result.rows, lineNum);
    setRows(annotated);
    setTotalRows(result.totalSample);

    const gapResult = selectedPlayer.team
      ? await detectGameLogGaps(selectedPlayer.team, result.rows, seasonNum)
      : [];
    setGaps(gapResult);

    // Interleave gaps into the game log for unified display
    const interleaved = interleaveGaps(result.rows, gapResult);
    setRowsWithGaps(interleaved);

    setRunning(false);
    setAuditDone(true);
  }, [selectedPlayer, stat, line, season]);

  const lineNum = parseFloat(line);
  const currentSeason = parseInt(season, 10);
  const plainRows: CanonicalGameRow[] = rows.map(({ isHit: _h, index: _i, ...rest }) => rest);
  const windows = auditDone && !isNaN(lineNum) ? computeWindowCounts(plainRows, lineNum, currentSeason) : null;

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2 bg-violet-500/20 rounded-lg">
          <BarChart3 className="w-5 h-5 text-violet-400" />
        </div>
        <div>
          <h1 className="text-white font-bold text-xl">Global Sample Audit</h1>
          <p className="text-gray-400 text-sm">Inspect the exact game log rows used in every model calculation.</p>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-4">
        {/* Player Search */}
        <div className="space-y-1">
          <label className="text-xs text-gray-400 font-medium">Player</label>
          {selectedPlayer ? (
            <div className="flex items-center justify-between bg-gray-800 border border-gray-700 rounded-lg px-3 py-2">
              <div>
                <span className="text-white text-sm font-medium">{selectedPlayer.name}</span>
                <span className="text-gray-500 text-xs ml-2">{selectedPlayer.team ?? 'Unknown team'} · {selectedPlayer.position_group ?? 'Unknown pos'}</span>
              </div>
              <button onClick={() => { setSelectedPlayer(null); setAuditDone(false); setRows([]); setPlayerSearch(''); }} className="text-gray-500 hover:text-white">
                <XCircle className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div className="relative">
              <div className="flex items-center gap-2 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2">
                <Search className="w-4 h-4 text-gray-500 shrink-0" />
                <input
                  type="text"
                  value={playerSearch}
                  onChange={e => { setPlayerSearch(e.target.value); searchPlayers(e.target.value); }}
                  placeholder="Search by name..."
                  className="flex-1 bg-transparent text-white text-sm outline-none placeholder-gray-600"
                />
                {searchLoading && <Loader2 className="w-3.5 h-3.5 text-gray-500 animate-spin" />}
              </div>
              {playerOptions.length > 0 && (
                <div className="absolute top-full mt-1 left-0 right-0 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-20 max-h-48 overflow-y-auto">
                  {playerOptions.map(p => (
                    <button
                      key={p.id}
                      onClick={() => { setSelectedPlayer(p); setPlayerOptions([]); setPlayerSearch(''); }}
                      className="w-full text-left px-3 py-2 hover:bg-gray-700 text-sm text-white border-b border-gray-700/50 last:border-0"
                    >
                      {p.name}
                      <span className="text-gray-500 text-xs ml-2">{p.team ?? ''}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Stat / Line / Season row */}
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1">
            <label className="text-xs text-gray-400 font-medium">Stat</label>
            <select
              value={stat}
              onChange={e => setStat(e.target.value as CanonicalStat)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm"
            >
              {STAT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-gray-400 font-medium">Line</label>
            <input
              type="number"
              value={line}
              onChange={e => setLine(e.target.value)}
              step="0.5"
              min="0"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm"
              placeholder="e.g. 20.5"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-gray-400 font-medium">Season</label>
            <input
              type="number"
              value={season}
              onChange={e => setSeason(e.target.value)}
              min="2020"
              max="2030"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm"
            />
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2 text-red-400 text-xs bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />{error}
          </div>
        )}

        <button
          onClick={runAudit}
          disabled={!selectedPlayer || running}
          className="w-full bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold text-sm py-2.5 rounded-lg transition flex items-center justify-center gap-2"
        >
          {running ? <><Loader2 className="w-4 h-4 animate-spin" />Running audit...</> : <><List className="w-4 h-4" />Run Sample Audit</>}
        </button>
      </div>

      {/* Results */}
      {auditDone && (
        <>
          {/* Window Summary */}
          {windows && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <h2 className="text-white font-semibold text-sm mb-3 flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-violet-400" />
                Hit Rate by Window — {selectedPlayer?.name} · {stat} ≥ {line}
              </h2>
              <div className="grid grid-cols-3 sm:grid-cols-7 gap-2">
                {([
                  ['Last 5', windows.last5],
                  ['Last 10', windows.last10],
                  ['Last 15', windows.last15],
                  ['Last 20', windows.last20],
                  ['Last 30', windows.last30],
                  [`Season ${season}`, windows.currentSeason],
                ] as [string, typeof windows.last5][]).map(([label, w]) => (
                  <div key={label} className="bg-gray-800/60 rounded-lg p-2 text-center">
                    <p className="text-[10px] text-gray-500 mb-1">{label}</p>
                    {w ? (
                      <>
                        <p className="text-white font-mono font-bold text-sm">{w.hits}/{w.sample}</p>
                        <p className={`text-xs font-semibold mt-0.5 ${w.hitRate >= 0.6 ? 'text-emerald-400' : w.hitRate >= 0.4 ? 'text-amber-400' : 'text-red-400'}`}>
                          {(w.hitRate * 100).toFixed(0)}%
                        </p>
                      </>
                    ) : (
                      <p className="text-gray-600 text-sm">—</p>
                    )}
                  </div>
                ))}
                {windows.weighted && (
                  <div className="bg-violet-500/10 border border-violet-500/20 rounded-lg p-2 text-center">
                    <p className="text-[10px] text-violet-400 mb-1">Weighted</p>
                    <p className="text-white font-mono font-bold text-sm">{(windows.weighted.probability * 100).toFixed(1)}%</p>
                    <p className="text-[10px] text-gray-500 mt-0.5">{windows.weighted.sample} games</p>
                  </div>
                )}
              </div>
              <p className="text-xs text-gray-600 mt-3">
                {totalRows} total games in log (capped at 40) · {rows.filter(r => r.isHit).length} hits · {rows.filter(r => !r.isHit).length} misses
              </p>
            </div>
          )}

          {/* Gap Audit: Missing Rounds */}
          {gaps.length > 0 && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4">
              <h2 className="text-amber-400 font-semibold text-sm mb-3 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4" />
                Missing Round Audit — {gaps.length} rounds absent from game log
              </h2>
              <div className="space-y-1 text-xs">
                {gaps.map(g => (
                  <div key={g.round_num} className="flex items-center gap-2 bg-gray-900/50 rounded px-2 py-1.5">
                    <span className="font-mono text-amber-400 font-semibold w-10">R{g.round_num}</span>
                    <span className="text-gray-400 flex-1">{g.match_date} vs {g.opponent ?? 'TBD'}</span>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                      g.reason === 'DNP' ? 'bg-gray-600/30 text-gray-400' :
                      g.reason === 'TEAM_MATCH_STATS_MISSING' ? 'bg-red-500/20 text-red-400' :
                      g.reason === 'ROUND_NOT_IMPORTED' ? 'bg-orange-500/20 text-orange-400' :
                      'bg-amber-500/20 text-amber-400'
                    }`}>
                      {g.reason.replace(/_/g, ' ')}
                    </span>
                    {g.details && (
                      <span className="text-gray-500 text-[10px] italic max-w-[200px] truncate" title={g.details}>{g.details}</span>
                    )}
                  </div>
                ))}
              </div>
              <p className="text-xs text-gray-500 mt-2">
                DNP = team played but player did not participate · Missing = match exists but stats need sync · Not Imported = match not in DB
              </p>
            </div>
          )}

          {/* Game Log Table with interleaved gap rows */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-2">
              <List className="w-4 h-4 text-gray-400" />
              <span className="text-white font-semibold text-sm">Canonical Game Log</span>
              <span className="text-xs text-gray-500 ml-1">— {rows.length} game rows + {gaps.length} gap rows</span>
              {gaps.length > 0 && (
                <span className="text-xs text-amber-400 ml-1">· {gaps.length} missing rounds shown inline</span>
              )}
            </div>
            {rows.length === 0 ? (
              <div className="px-4 py-8 text-center text-gray-500 text-sm">No game log data found for this player/stat combination.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-gray-800/50 border-b border-gray-800 sticky top-0">
                    <tr>
                      {['#', 'Date', 'Rnd', 'Season', 'Team', 'Opponent', 'Venue', 'D', 'M', 'T', 'G', 'HO', stat.charAt(0).toUpperCase() + stat.slice(1), 'Hit?'].map(h => (
                        <th key={h} className="px-2 py-2 text-left text-gray-500 font-medium whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const displayList = rowsWithGaps.length > 0 ? rowsWithGaps : rows.map(r => ({ kind: 'game' as const, data: r }));
                      let gameIndex = 0;
                      return displayList.map((entry, i) => {
                        if (entry.kind === 'gap') {
                          const g = entry.data;
                          const reasonColor = g.reason === 'DNP' ? 'text-gray-400' :
                            g.reason === 'TEAM_MATCH_STATS_MISSING' ? 'text-red-400' :
                            g.reason === 'ROUND_NOT_IMPORTED' ? 'text-orange-400' :
                            g.reason === 'BYE' ? 'text-blue-400' : 'text-amber-400';
                          return (
                            <tr key={`gap-${i}`} className="border-b border-amber-500/20 bg-amber-500/5">
                              <td className="px-2 py-1.5 text-amber-600 text-[10px]">GAP</td>
                              <td className="px-2 py-1.5 font-mono text-[11px] text-amber-400">{g.match_date || '—'}</td>
                              <td className="px-2 py-1.5 text-amber-400 font-bold">R{g.round_num}</td>
                              <td className="px-2 py-1.5 text-gray-600">—</td>
                              <td className="px-2 py-1.5 text-gray-600">—</td>
                              <td className="px-2 py-1.5 text-gray-400 max-w-[100px] truncate">{g.opponent ?? '—'}</td>
                              <td className="px-2 py-1.5 text-gray-600 max-w-[80px] truncate">{g.venue ?? '—'}</td>
                              <td colSpan={5} className="px-2 py-1.5 text-gray-600 text-center">—</td>
                              <td className="px-2 py-1.5 text-gray-600 text-center">—</td>
                              <td className="px-2 py-1.5 text-center">
                                <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-gray-800/60 ${reasonColor}`}>
                                  {g.reason.replace(/_/g, ' ')}
                                </span>
                              </td>
                            </tr>
                          );
                        } else {
                          const r = entry.data;
                          const line = parseFloat(lineNum.toString());
                          const isHitVal = r.statValue >= (isNaN(line) ? 0 : line);
                          gameIndex++;
                          return (
                            <tr key={`game-${i}`} className={`border-b border-gray-800/40 ${isHitVal ? 'bg-emerald-500/5 hover:bg-emerald-500/10' : 'bg-red-500/5 hover:bg-red-500/10'}`}>
                              <td className="px-2 py-1.5 text-gray-600">{gameIndex}</td>
                              <td className="px-2 py-1.5 text-gray-300 font-mono text-[11px] whitespace-nowrap">{r.match_date}</td>
                              <td className="px-2 py-1.5 text-gray-400">{r.round ?? '—'}</td>
                              <td className="px-2 py-1.5 text-gray-400">{r.season}</td>
                              <td className="px-2 py-1.5 text-gray-300 max-w-[80px] truncate" title={r.team ?? ''}>{r.team ?? '—'}</td>
                              <td className="px-2 py-1.5 text-gray-300 max-w-[100px] truncate" title={r.opponent ?? ''}>{r.opponent ?? '—'}</td>
                              <td className="px-2 py-1.5 text-gray-400 max-w-[80px] truncate" title={r.venue ?? ''}>{r.venue ?? '—'}</td>
                              <td className="px-2 py-1.5 text-gray-400 text-center">{r.disposals}</td>
                              <td className="px-2 py-1.5 text-gray-400 text-center">{r.marks}</td>
                              <td className="px-2 py-1.5 text-gray-400 text-center">{r.tackles}</td>
                              <td className="px-2 py-1.5 text-gray-400 text-center">{r.goals}</td>
                              <td className="px-2 py-1.5 text-gray-400 text-center">{r.hitouts}</td>
                              <td className={`px-2 py-1.5 text-center font-mono font-bold ${isHitVal ? 'text-emerald-400' : 'text-red-400'}`}>{r.statValue}</td>
                              <td className="px-2 py-1.5 text-center">
                                {isHitVal
                                  ? <span className="inline-flex items-center gap-0.5 text-emerald-400 font-bold text-[10px]"><CheckCircle2 className="w-3 h-3" />HIT</span>
                                  : <span className="inline-flex items-center gap-0.5 text-red-400 text-[10px]"><XCircle className="w-3 h-3" />miss</span>}
                              </td>
                            </tr>
                          );
                        }
                      });
                    })()}
                  </tbody>
                </table>
              </div>
            )}
            <div className="px-4 py-2 border-t border-gray-800 text-[10px] text-gray-600">
              Source: player_game_stats — deduplicated · sorted match_date DESC · future excluded · canonical engine ·{' '}
              <span className="text-amber-400">GAP rows = rounds played by team but absent from this player's log</span>
            </div>
          </div>
        </>
      )}

      {/* Player Stats Link Debug */}
      {selectedPlayer && linkDebug && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-4">
          <h3 className="text-white font-semibold text-sm flex items-center gap-2">
            <Link2 className="w-4 h-4 text-blue-400" />
            Player Stats Link Debug
          </h3>

          {linkDebug.loading ? (
            <div className="flex items-center gap-2 text-gray-500 text-sm">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading debug data...
            </div>
          ) : linkDebug.error ? (
            <div className="text-red-400 text-sm">{linkDebug.error}</div>
          ) : (
            <>
              {/* Selected player info */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div className="bg-gray-800/50 rounded-lg p-2">
                  <p className="text-[10px] text-gray-500">Selected Player</p>
                  <p className="text-white text-sm font-medium truncate">{selectedPlayer.name}</p>
                </div>
                <div className="bg-gray-800/50 rounded-lg p-2">
                  <p className="text-[10px] text-gray-500">Team</p>
                  <p className="text-white text-sm">{selectedPlayer.team ?? '—'}</p>
                </div>
                <div className="bg-gray-800/50 rounded-lg p-2">
                  <p className="text-[10px] text-gray-500">Player ID</p>
                  <p className="text-gray-400 font-mono text-[10px] truncate">{selectedPlayer.id}</p>
                </div>
                <div className="bg-gray-800/50 rounded-lg p-2">
                  <p className="text-[10px] text-gray-500">Stats Rows</p>
                  <p className={`text-lg font-bold ${linkDebug.statsCount > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {linkDebug.statsCount}
                  </p>
                </div>
              </div>

              {/* Bookmaker odds count */}
              <div className="bg-gray-800/50 rounded-lg p-2">
                <p className="text-[10px] text-gray-500">Bookmaker Odds Rows (linked to this player_id)</p>
                <p className="text-white text-sm font-mono">{linkDebug.bookmakerOddsCount}</p>
              </div>

              {/* Duplicates */}
              <div>
                <h4 className="text-gray-400 text-xs font-medium mb-2">Duplicate Players (same normalized name)</h4>
                {linkDebug.duplicates.length === 0 ? (
                  <p className="text-gray-600 text-xs">No duplicate player records found.</p>
                ) : (
                  <table className="w-full text-xs">
                    <thead className="bg-gray-800/30 border-b border-gray-800">
                      <tr>
                        <th className="px-2 py-1.5 text-left text-gray-500 font-medium">Name</th>
                        <th className="px-2 py-1.5 text-left text-gray-500 font-medium">Team</th>
                        <th className="px-2 py-1.5 text-left text-gray-500 font-medium">Player ID</th>
                        <th className="px-2 py-1.5 text-right text-gray-500 font-medium">Stats Count</th>
                      </tr>
                    </thead>
                    <tbody>
                      {linkDebug.duplicates.map(d => (
                        <tr key={d.id} className="border-b border-gray-800/30">
                          <td className="px-2 py-1.5 text-white">{d.name}</td>
                          <td className="px-2 py-1.5 text-gray-400">{d.team ?? '—'}</td>
                          <td className="px-2 py-1.5 text-gray-500 font-mono text-[10px]">{d.id.slice(0, 8)}…</td>
                          <td className={`px-2 py-1.5 text-right font-mono font-bold ${d.statsCount > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {d.statsCount}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              {/* Raw Kali */}
              <div>
                <h4 className="text-gray-400 text-xs font-medium mb-2">
                  Raw Kali Rows <span className="text-gray-600">({linkDebug.rawKaliCount} total)</span>
                </h4>
                {linkDebug.rawKaliCount === 0 ? (
                  <p className="text-gray-600 text-xs">No raw_kali_player_game_stats rows found for this player.</p>
                ) : (
                  <table className="w-full text-xs">
                    <thead className="bg-gray-800/30 border-b border-gray-800">
                      <tr>
                        <th className="px-2 py-1.5 text-left text-gray-500 font-medium">Season</th>
                        <th className="px-2 py-1.5 text-left text-gray-500 font-medium">Round</th>
                        <th className="px-2 py-1.5 text-left text-gray-500 font-medium">Team</th>
                        <th className="px-2 py-1.5 text-right text-gray-500 font-medium">Disp</th>
                        <th className="px-2 py-1.5 text-right text-gray-500 font-medium">Marks</th>
                        <th className="px-2 py-1.5 text-right text-gray-500 font-medium">Tack</th>
                      </tr>
                    </thead>
                    <tbody>
                      {linkDebug.rawKaliRows.map(r => (
                        <tr key={r.id} className="border-b border-gray-800/30">
                          <td className="px-2 py-1.5 text-gray-400">{r.season}</td>
                          <td className="px-2 py-1.5 text-gray-400">{r.round ?? '—'}</td>
                          <td className="px-2 py-1.5 text-gray-400">{r.team ?? '—'}</td>
                          <td className="px-2 py-1.5 text-right text-gray-400 font-mono">{r.disposals ?? 0}</td>
                          <td className="px-2 py-1.5 text-right text-gray-400 font-mono">{r.marks ?? 0}</td>
                          <td className="px-2 py-1.5 text-right text-gray-400 font-mono">{r.tackles ?? 0}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              {/* Diagnosis */}
              <div className={`rounded-lg p-3 text-sm ${
                linkDebug.statsCount > 0
                  ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'
                  : linkDebug.duplicates.some(d => d.statsCount > 0)
                    ? 'bg-blue-500/10 border border-blue-500/20 text-blue-400'
                    : linkDebug.rawKaliCount > 0
                      ? 'bg-cyan-500/10 border border-cyan-500/20 text-cyan-400'
                      : 'bg-red-500/10 border border-red-500/20 text-red-400'
              }`}>
                {linkDebug.statsCount > 0 ? (
                  <span className="flex items-center gap-2"><CheckCircle2 className="w-4 h-4" /> Player has {linkDebug.statsCount} stats rows. Model should work.</span>
                ) : linkDebug.duplicates.some(d => d.statsCount > 0) ? (
                  <span className="flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> Player has 0 stats, but a duplicate player record has stats. Click repair to relink bookmaker odds.</span>
                ) : linkDebug.rawKaliCount > 0 ? (
                  <span className="flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> Player has 0 stats, but {linkDebug.rawKaliCount} raw_kali rows exist. Click repair to promote them.</span>
                ) : (
                  <span className="flex items-center gap-2"><XCircle className="w-4 h-4" /> NO STATS FOUND ANYWHERE — no player_game_stats, no duplicate with stats, no raw_kali rows. Import/backfill required.</span>
                )}
              </div>

              {/* Repair button */}
              <div className="flex items-center gap-3">
                <button
                  onClick={handleRepairPlayerLink}
                  disabled={repairRunning || linkDebug.statsCount > 0}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium rounded-lg text-sm transition"
                >
                  {repairRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wrench className="w-4 h-4" />}
                  Repair This Player Stats Link
                </button>
                <span className="text-[11px] text-gray-500">
                  Relinks odds to duplicate player with stats, or promotes raw_kali rows.
                </span>
              </div>

              {/* Repair result */}
              {repairResult && (
                <div className={`rounded-lg p-3 text-sm flex items-start gap-2 ${
                  repairResult.type === 'success' ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400' :
                  repairResult.type === 'info' ? 'bg-blue-500/10 border border-blue-500/20 text-blue-400' :
                  'bg-red-500/10 border border-red-500/20 text-red-400'
                }`}>
                  {repairResult.type === 'success' ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" /> :
                   repairResult.type === 'info' ? <HelpCircle className="w-4 h-4 mt-0.5 shrink-0" /> :
                   <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />}
                  <span>{repairResult.message}</span>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
