import { useState, useEffect, useCallback } from 'react';
import { Users, Loader2, AlertCircle, Upload, Info } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { normalizeTeam } from '../lib/teamNormalizer';

interface RoleDataRow {
  player_id: string | null;
  player_name: string;
  team: string;
  cba_percentage: number;
  cba_count: number;
  team_cba_total: number;
  kick_in_count: number;
  kick_in_play_on_count: number;
  kick_in_share: number;
  round: string;
  match_date: string;
  source: string;
  updated_at: string;
}

interface PlayerRoleSummary {
  playerId: string;
  playerName: string;
  team: string;
  cbaSeasonAvg: number;
  cbaLast5: number;
  cbaLast3: number;
  cbaTrend: string;
  kickInSeasonShare: number;
  kickInLast5Share: number;
  kickInLast3Share: number;
  kickInTrend: string;
  source: string;
  lastUpdated: string;
  recordCount: number;
}

export default function RoleTrendsPage() {
  const [data, setData] = useState<RoleDataRow[]>([]);
  const [summaries, setSummaries] = useState<PlayerRoleSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const [csvText, setCsvText] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data: rows, error } = await supabase
        .from('player_role_data')
        .select('player_id, round, cba_percentage, cba_count, team_cba_total, kick_in_count, kick_in_play_on_count, kick_in_share, source, updated_at')
        .order('updated_at', { ascending: false });

      if (error) throw error;
      // Query selects a subset of player_role_data columns; RoleDataRow is the
      // display shape. Cast preserves existing runtime behaviour.
      setData((rows ?? []) as unknown as RoleDataRow[]);

      // Build player summaries
      const byPlayer = new Map<string, RoleDataRow[]>();
      for (const row of (rows ?? [])) {
        const key = row.player_id ?? 'unknown';
        if (!byPlayer.has(key)) byPlayer.set(key, []);
        byPlayer.get(key)!.push(row as any);
      }

      const playerSummaries: PlayerRoleSummary[] = [];
      for (const [playerId, records] of byPlayer) {
        const sorted = records.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
        const last5 = sorted.slice(0, 5);
        const last3 = sorted.slice(0, 3);

        const cbaSeasonAvg = records.reduce((acc, r) => acc + (r.cba_percentage ?? 0), 0) / Math.max(1, records.length);
        const cbaLast5 = last5.reduce((acc, r) => acc + (r.cba_percentage ?? 0), 0) / Math.max(1, last5.length);
        const cbaLast3 = last3.reduce((acc, r) => acc + (r.cba_percentage ?? 0), 0) / Math.max(1, last3.length);
        const cbaChange = cbaLast3 - cbaSeasonAvg;

        const kickInSeasonShare = records.reduce((acc, r) => acc + (r.kick_in_share ?? 0), 0) / Math.max(1, records.length);
        const kickInLast5Share = last5.reduce((acc, r) => acc + (r.kick_in_share ?? 0), 0) / Math.max(1, last5.length);
        const kickInLast3Share = last3.reduce((acc, r) => acc + (r.kick_in_share ?? 0), 0) / Math.max(1, last3.length);
        const kickInChange = kickInLast3Share - kickInSeasonShare;

        const cbaTrend = cbaChange >= 10 ? 'Positive' : cbaChange <= -10 ? 'Negative' : 'Stable';
        const kickInTrend = kickInChange >= 0.08 ? 'Positive' : kickInChange <= -0.08 ? 'Negative' : 'Stable';

        playerSummaries.push({
          playerId,
          playerName: sorted[0]?.player_name ?? 'Unknown',
          team: normalizeTeam(sorted[0]?.team) ?? '—',
          cbaSeasonAvg,
          cbaLast5,
          cbaLast3,
          cbaTrend,
          kickInSeasonShare,
          kickInLast5Share,
          kickInLast3Share,
          kickInTrend,
          source: sorted[0]?.source ?? 'unknown',
          lastUpdated: sorted[0]?.updated_at ?? '—',
          recordCount: records.length,
        });
      }

      setSummaries(playerSummaries);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  async function handleImport() {
    if (!csvText.trim()) return;
    setImporting(true);
    setImportResult(null);
    try {
      const lines = csvText.trim().split('\n');
      const header = lines[0].split(',').map(h => h.trim().toLowerCase());
      const rows: any[] = [];

      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(',').map(v => v.trim());
        const row: Record<string, string> = {};
        for (let j = 0; j < header.length; j++) {
          row[header[j]] = parts[j] ?? '';
        }

        // Resolve player ID by name + team
        const teamNorm = normalizeTeam(row.team) ?? row.team;
        const { data: player } = await supabase
          .from('players')
          .select('id, name')
          .ilike('name', row.player_name)
          .limit(1)
          .maybeSingle();

        rows.push({
          player_id: player?.id ?? null,
          round: row.round ?? null,
          season: parseInt(row.season) || 2026,
          cba_percentage: parseFloat(row.cba_percentage) || 0,
          cba_count: parseInt(row.cba_count) || 0,
          team_cba_total: parseInt(row.team_cba_total) || 0,
          kick_in_count: parseInt(row.kick_in_count) || 0,
          kick_in_play_on_count: parseInt(row.kick_in_play_on_count) || 0,
          kick_in_share: parseFloat(row.kick_in_share) || 0,
          source: row.source || 'csv_import',
        });
      }

      const { error: insertError } = await supabase
        .from('player_role_data')
        .upsert(rows, { onConflict: 'player_id,match_id' });

      if (insertError) throw insertError;
      setImportResult(`Imported ${rows.length} rows. Players resolved: ${rows.filter(r => r.player_id).length}/${rows.length}.`);
      setCsvText('');
      loadData();
    } catch (e) {
      setImportResult(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setImporting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-emerald-400" />
        <span className="ml-3 text-gray-400 text-sm">Loading role trends…</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-gray-900 border border-emerald-500/20 rounded-xl p-4">
        <div className="flex items-center gap-3">
          <Users className="w-5 h-5 text-emerald-400" />
          <div>
            <h2 className="text-white font-semibold text-sm">Role Trends</h2>
            <p className="text-gray-500 text-xs">CBA and Kick-in trends · Display Only mode</p>
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-900/20 border border-red-500/30 rounded-xl p-3">
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      {summaries.length === 0 && !error && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 text-center">
          <Info className="w-8 h-8 text-cyan-400 mx-auto mb-2" />
          <p className="text-cyan-400 font-medium text-sm">No CBA or kick-in data imported yet.</p>
          <p className="text-gray-600 text-xs mt-1">Import role data from the import section below.</p>
        </div>
      )}

      {/* Import section */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <h3 className="text-white font-semibold text-sm mb-2 flex items-center gap-2">
          <Upload className="w-4 h-4 text-emerald-400" /> Import Player Role Data
        </h3>
        <p className="text-gray-500 text-xs mb-2">
          CSV columns: season, round, match_date, player_name, team, opponent, cba_count, team_cba_total, cba_percentage, kick_in_count, kick_in_play_on_count, kick_in_share, source
        </p>
        <textarea
          value={csvText}
          onChange={e => setCsvText(e.target.value)}
          placeholder="season,round,match_date,player_name,team,opponent,cba_count,team_cba_total,cba_percentage,kick_in_count,kick_in_play_on_count,kick_in_share,source&#10;2026,R18,2026-07-04,Bailey Smith,Geelong,St Kilda,8,12,66.7,0,0,0,manual_import"
          rows={4}
          className="w-full bg-gray-800 border border-gray-700 text-white text-xs rounded-lg p-2 font-mono"
        />
        <button
          onClick={handleImport}
          disabled={importing || !csvText.trim()}
          className="mt-2 flex items-center gap-2 px-4 py-2 bg-emerald-500 hover:bg-emerald-400 disabled:bg-gray-700 text-gray-950 font-bold rounded-lg text-sm transition"
        >
          {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          {importing ? 'Importing…' : 'Import CSV'}
        </button>
        {importResult && (
          <p className="mt-2 text-xs text-gray-400">{importResult}</p>
        )}
      </div>

      {/* Data table */}
      {summaries.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-gray-800 text-gray-500">
                <th className="text-left py-2 px-3">Player</th>
                <th className="text-left py-2 px-3">Team</th>
                <th className="text-right py-2 px-3">CBA Season</th>
                <th className="text-right py-2 px-3">CBA L5</th>
                <th className="text-right py-2 px-3">CBA L3</th>
                <th className="text-center py-2 px-3">CBA Trend</th>
                <th className="text-right py-2 px-3">Kick-in Season</th>
                <th className="text-right py-2 px-3">Kick-in L5</th>
                <th className="text-right py-2 px-3">Kick-in L3</th>
                <th className="text-center py-2 px-3">Kick-in Trend</th>
                <th className="text-left py-2 px-3">Source</th>
                <th className="text-right py-2 px-3">Records</th>
              </tr>
            </thead>
            <tbody>
              {summaries.map(s => (
                <tr key={s.playerId} className="border-b border-gray-800/30 hover:bg-gray-800/30">
                  <td className="py-2 px-3 text-white font-medium">{s.playerName}</td>
                  <td className="py-2 px-3 text-gray-400">{s.team}</td>
                  <td className="py-2 px-3 text-right text-gray-300">{s.cbaSeasonAvg.toFixed(1)}</td>
                  <td className="py-2 px-3 text-right text-gray-300">{s.cbaLast5.toFixed(1)}</td>
                  <td className="py-2 px-3 text-right text-gray-300">{s.cbaLast3.toFixed(1)}</td>
                  <td className="py-2 px-3 text-center">
                    <span className={s.cbaTrend === 'Positive' ? 'text-emerald-400' : s.cbaTrend === 'Negative' ? 'text-red-400' : 'text-gray-500'}>{s.cbaTrend}</span>
                  </td>
                  <td className="py-2 px-3 text-right text-gray-300">{(s.kickInSeasonShare * 100).toFixed(0)}%</td>
                  <td className="py-2 px-3 text-right text-gray-300">{(s.kickInLast5Share * 100).toFixed(0)}%</td>
                  <td className="py-2 px-3 text-right text-gray-300">{(s.kickInLast3Share * 100).toFixed(0)}%</td>
                  <td className="py-2 px-3 text-center">
                    <span className={s.kickInTrend === 'Positive' ? 'text-emerald-400' : s.kickInTrend === 'Negative' ? 'text-red-400' : 'text-gray-500'}>{s.kickInTrend}</span>
                  </td>
                  <td className="py-2 px-3 text-gray-500">{s.source}</td>
                  <td className="py-2 px-3 text-right text-gray-500">{s.recordCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
