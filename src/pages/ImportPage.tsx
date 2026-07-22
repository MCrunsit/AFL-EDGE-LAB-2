import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Upload, CheckCircle, XCircle, AlertTriangle, Download, ChevronDown, ChevronUp, RefreshCw, BarChart3, X, TrendingUp, Clock, Database, Wifi, WifiOff, AlertCircle, Zap, Eye, ShieldAlert, Loader2, AlertOctagon, Satellite, Activity, Link as LinkIcon, Calendar } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { syncOddsFromApi, getLastOddsSyncTime, formatSyncAge, syncPlayerPropsFromApi, type OddsSyncResult, type PlayerPropsSyncResult } from '../lib/syncPlayerPropOdds';
import { getLastBookmakerFetch, type BookmakerFetchResult } from '../lib/liveBookmakerOddsService';
import { dryRunStatsCheck, backfillMissingRounds, importValidatedStats, deduplicateStats, getDataStatus, recalculatePositionEdges, type StatsSyncDiagnostics, type BackfillDiagnostics, type StatsImportValidation } from '../lib/playerStatsSync';
import { getRoundInfo } from '../lib/roundManager';
import { testKaliConnection, syncPlayerGameStatsFromKali, syncAllMissingFromKali, dryRunKaliSync, type KaliSyncResult, type KaliConnectionTest, type SyncPriority } from '../lib/syncPlayerGameStatsFromKali';
import { processDfsRows, importDfsRows, type DfsProcessResult, type DfsImportReport } from '../lib/dfsAustraliaImportService';
import { loadRoleTrends } from '../lib/roleTrendService';

type ImportTarget = 'players' | 'matches' | 'player_game_stats' | 'player_prop_odds' | 'fixtures';

interface ImportResult {
  success: number;
  errors: string[];
  total: number;
}

/**
 * Normalize a string for matching:
 * - lowercase
 * - trim whitespace
 * - remove duplicate spaces
 */
function normalizeForMatch(str: string): string {
  return (str ?? '')
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Convert date string to ISO format (YYYY-MM-DD)
 * Handles formats like: "Saturday, 25th September 2021" -> "2021-09-25"
 */
function parseDateToISO(dateStr: string): string | undefined {
  if (!dateStr) return undefined;

  // Already in ISO format
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return dateStr;
  }

  // Parse format like "Saturday, 25th September 2021"
  const monthNames: Record<string, string> = {
    'january': '01', 'february': '02', 'march': '03', 'april': '04',
    'may': '05', 'june': '06', 'july': '07', 'august': '08',
    'september': '09', 'october': '10', 'november': '11', 'december': '12',
  };

  // Match day, month, year from various formats
  // Pattern: "Day, Nth Month YYYY" or "Nth Month YYYY"
  const match = dateStr.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([a-zA-Z]+)\s+(\d{4})/i);

  if (match) {
    const day = match[1].padStart(2, '0');
    const month = monthNames[match[2].toLowerCase()];
    const year = match[3];

    if (month) {
      return `${year}-${month}-${day}`;
    }
  }

  // Try parsing with Date as fallback
  const parsed = new Date(dateStr);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().split('T')[0];
  }

  console.warn(`[Date Parser] Could not parse date: "${dateStr}"`);
  return undefined;
}

const TEMPLATES: Record<ImportTarget, { headers: string[]; example: string[] }> = {
  players: {
    headers: ['name', 'team', 'position'],
    example: ['Clayton Oliver', 'Melbourne', 'Midfielder'],
  },
  matches: {
    headers: ['season', 'round', 'home_team', 'away_team', 'venue', 'match_date', 'home_score', 'away_score'],
    example: ['2024', 'Round 1', 'Melbourne', 'Collingwood', 'MCG', '2024-03-22', '102', '88'],
  },
  player_game_stats: {
    headers: ['player_name', 'match_date', 'team', 'opponent', 'venue', 'disposals', 'marks', 'tackles', 'goals', 'hitouts'],
    example: ['Clayton Oliver', '2024-03-22', 'Melbourne', 'Collingwood', 'MCG', '32', '6', '4', '1', '0'],
  },
  player_prop_odds: {
    headers: ['player_name', 'team', 'match_date', 'market', 'line', 'over_odds', 'under_odds', 'bookmaker'],
    example: ['Isaac Heeney', 'Sydney', '2026-07-12', 'disposals', '25', '1.35', '', 'Sportsbet'],
  },
  fixtures: {
    headers: ['season', 'round', 'home_team', 'away_team', 'venue', 'match_date', 'api_match_id'],
    example: ['2026', '18', 'Collingwood', 'Carlton', 'MCG', '2026-07-12', '12345'],
  },
};

function parseCSV(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''));
  const rows = lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.trim());
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = vals[i] ?? ''; });
    return row;
  });
  return { headers, rows };
}

function downloadTemplate(target: ImportTarget) {
  const t = TEMPLATES[target];
  const csv = [t.headers.join(','), t.example.join(',')].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${target}_template.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importPlayers(rows: Record<string, string>[]): Promise<ImportResult> {
  let success = 0;
  const errors: string[] = [];
  for (const row of rows) {
    if (!row.name || !row.team) { errors.push(`Row missing name/team: ${JSON.stringify(row)}`); continue; }
    const { error } = await supabase.from('players').insert({ name: row.name, team: row.team, position: row.position || null });
    if (error) errors.push(`${row.name}: ${error.message}`);
    else success++;
  }
  return { success, errors, total: rows.length };
}

async function importMatches(rows: Record<string, string>[]): Promise<ImportResult> {
  let success = 0;
  const errors: string[] = [];
  for (const row of rows) {
    if (!row.season) { errors.push(`Row missing season: ${JSON.stringify(row)}`); continue; }
    const isoDate = parseDateToISO(row.match_date);
    const { error } = await supabase.from('matches').insert({
      season: parseInt(row.season),
      round: row.round || null,
      home_team: row.home_team || null,
      away_team: row.away_team || null,
      venue: row.venue || null,
      ...(isoDate && { match_date: isoDate }),
      home_score: row.home_score ? parseInt(row.home_score) : null,
      away_score: row.away_score ? parseInt(row.away_score) : null,
    });
    if (error) errors.push(`Row (${row.round}): ${error.message}`);
    else success++;
  }
  return { success, errors, total: rows.length };
}

async function importFixtures(rows: Record<string, string>[]): Promise<ImportResult> {
  let success = 0;
  const errors: string[] = [];

  const toInsert: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (!row.season || !row.home_team || !row.away_team || !row.match_date) {
      errors.push(`Row missing required fields (season, home_team, away_team, match_date): ${JSON.stringify(row)}`);
      continue;
    }
    const isoDate = parseDateToISO(row.match_date);
    if (!isoDate) {
      errors.push(`Invalid match_date: "${row.match_date}" — skipping`);
      continue;
    }
    toInsert.push({
      season: parseInt(row.season),
      round: row.round || null,
      home_team: row.home_team.trim(),
      away_team: row.away_team.trim(),
      venue: row.venue?.trim() || null,
      match_date: isoDate,
      home_score: null,
      away_score: null,
      api_match_id: row.api_match_id ? parseInt(row.api_match_id) : null,
    });
  }

  // Batch upsert by (season, round, home_team, away_team) to avoid duplicates
  const BATCH_SIZE = 500;
  for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
    const batch = toInsert.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('matches').upsert(batch, {
      onConflict: 'season,round,home_team,away_team',
    });
    if (error) {
      errors.push(`Batch ${Math.floor(i / BATCH_SIZE) + 1} error: ${error.message}`);
    } else {
      success += batch.length;
    }
  }
  return { success, errors, total: rows.length };
}

async function importPlayerGameStats(rows: Record<string, string>[]): Promise<ImportResult> {
  let success = 0;
  const errors: string[] = [];

  const { fetchAllPlayers } = await import('../lib/playerMatching');
  const players = await fetchAllPlayers();
  const playerMap = new Map<string, string>();
  players.forEach(p => playerMap.set(p.name.toLowerCase().trim(), p.id));

  for (const row of rows) {
    const playerName = (row.player_name ?? row.name ?? '').toLowerCase().trim();
    if (!playerName || !row.match_date || !row.team) {
      errors.push(`Row missing player_name/match_date/team: ${JSON.stringify(row)}`);
      continue;
    }
    const playerId = playerMap.get(playerName);
    if (!playerId) {
      errors.push(`Player not found: "${row.player_name ?? row.name}" — import player first`);
      continue;
    }
    const isoDate = parseDateToISO(row.match_date);
    const { error } = await supabase.from('player_game_stats').insert({
      player_id: playerId,
      ...(isoDate && { match_date: isoDate }),
      team: row.team,
      opponent: row.opponent || null,
      venue: row.venue || null,
      disposals: parseInt(row.disposals ?? '0') || 0,
      marks: parseInt(row.marks ?? '0') || 0,
      tackles: parseInt(row.tackles ?? '0') || 0,
      goals: parseInt(row.goals ?? '0') || 0,
      hitouts: parseInt(row.hitouts ?? '0') || 0,
    });
    if (error) errors.push(`${row.player_name} on ${row.match_date}: ${error.message}`);
    else success++;
  }
  return { success, errors, total: rows.length };
}

async function importPlayerPropOdds(rows: Record<string, string>[]): Promise<ImportResult> {
  let success = 0;
  const errors: string[] = [];
  const today = new Date().toISOString().split('T')[0];

  // Load current players
  const { data: players } = await supabase.from('current_players').select('id, name, team');
  const playerMap = new Map<string, { id: string; team: string }>();
  ((players ?? []) as { id: string; name: string; team: string }[]).forEach(p =>
    playerMap.set(p.name.toLowerCase().trim(), { id: p.id, team: p.team })
  );

  // Load upcoming matches
  const { data: matches } = await supabase
    .from('matches')
    .select('id, match_date, home_team, away_team')
    .gte('match_date', today);

  const matchesByDate = new Map<string, { id: string; home_team: string; away_team: string }[]>();
  ((matches ?? []) as { id: string; match_date: string; home_team: string; away_team: string }[]).forEach(m => {
    const dateKey = m.match_date?.split('T')[0];
    if (!dateKey) return;
    if (!matchesByDate.has(dateKey)) matchesByDate.set(dateKey, []);
    matchesByDate.get(dateKey)!.push(m);
  });

  const BATCH_SIZE = 500;
  const toInsert: Record<string, unknown>[] = [];

  for (const row of rows) {
    const playerNameRaw = (row.player_name ?? '').trim();
    const playerName = playerNameRaw.toLowerCase().trim();
    const team = (row.team ?? '').trim();
    const matchDate = row.match_date?.trim();

    if (!playerName || !matchDate || !row.market) {
      errors.push(`Row missing player_name/match_date/market: ${JSON.stringify(row)}`);
      continue;
    }

    // Resolve current player
    const player = playerMap.get(playerName);
    if (!player) {
      errors.push(`Player not found: "${row.player_name}"`);
      continue;
    }

    // Parse line - must be positive number
    const line = parseFloat(row.line);
    if (isNaN(line) || line <= 0) {
      errors.push(`Invalid line for ${row.player_name}: "${row.line}"`);
      continue;
    }

    // Determine market_type and display_label
    // Integer line = alt_ladder (21+), half-point line = ou_line (21.5)
    const isIntegerLine = line === Math.floor(line);
    const marketType = isIntegerLine ? 'alt_ladder' : 'ou_line';
    const displayLabel = isIntegerLine ? `${Math.floor(line)}+` : null;
    const baseLine = isIntegerLine ? Math.floor(line) : null;

    // Support flexible input formats:
    // 1. Traditional: over_odds + under_odds
    // 2. Side-based: side + odds (new format)
    let overOdds: number | null = null;
    let underOdds: number | null = null;

    if (row.side && row.odds) {
      // New format: separate rows for Over/Under
      const side = (row.side ?? '').toLowerCase().trim();
      const odds = parseFloat(row.odds);
      if (isNaN(odds) || odds <= 1.01 || !isFinite(odds)) {
        errors.push(`Invalid odds for ${row.player_name}: "${row.odds}"`);
        continue;
      }
      if (side === 'over') overOdds = odds;
      else if (side === 'under') underOdds = odds;
      else {
        errors.push(`Invalid side for ${row.player_name}: "${row.side}" — must be "over" or "under"`);
        continue;
      }
    } else {
      // Traditional format: over_odds + under_odds in one row
      const over = parseFloat(row.over_odds);
      const under = parseFloat(row.under_odds);

      if (!isNaN(over) && over > 1.01 && isFinite(over)) overOdds = over;
      if (!isNaN(under) && under > 1.01 && isFinite(under)) underOdds = under;
    }

    // Must have at least one valid odds
    if (overOdds === null && underOdds === null) {
      errors.push(`No valid odds for ${row.player_name}: provide either (over_odds+under_odds) or (side+odds)`);
      continue;
    }

    // For alt_ladder, we only need over_odds (the price for achieving the threshold)
    // Under is not typically meaningful for "X+" markets
    if (marketType === 'alt_ladder' && overOdds === null) {
      errors.push(`Alt-ladder markets require over_odds (price for ${displayLabel}) for ${row.player_name}`);
      continue;
    }

    // Resolve match
    const isoDate = parseDateToISO(matchDate);
    if (!isoDate) {
      errors.push(`Invalid match_date for ${row.player_name}: "${matchDate}"`);
      continue;
    }
    if (isoDate < today) {
      errors.push(`Past match for ${row.player_name} on "${isoDate}"`);
      continue;
    }

    const dateKey = isoDate.split('T')[0];
    const dayMatches = matchesByDate.get(dateKey) ?? [];
    const teamSlug = team.toLowerCase().replace(/\s+/g, '-');
    const matched = dayMatches.find(m =>
      m.home_team.toLowerCase().replace(/\s+/g, '-') === teamSlug ||
      m.away_team.toLowerCase().replace(/\s+/g, '-') === teamSlug
    );

    if (!matched) {
      errors.push(`No match for ${row.player_name} on ${isoDate} team "${team}"`);
      continue;
    }

    const bookmakerId = (row.bookmaker ?? '').toLowerCase().trim() || 'imported';
    const market = row.market.trim().toLowerCase();
    const rawMarket = row.raw_market ?? row.market ?? '';

    toInsert.push({
      match_id: matched.id,
      bookmaker_id: bookmakerId,
      bookmaker_player_name: playerNameRaw,
      player_id: player.id,
      market,
      raw_market: rawMarket,
      line,
      raw_line: String(line),
      over_odds: overOdds ?? 0,
      under_odds: underOdds ?? 0,
      market_type: marketType,
      base_line: baseLine,
      display_label: displayLabel,
      source: 'csv_import',
      fetched_at: new Date().toISOString(),
    });
  }

  // Batch upsert to bookmaker_odds
  for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
    const batch = toInsert.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('bookmaker_odds')
      .upsert(batch, { onConflict: 'bookmaker_id,bookmaker_player_name,match_id,market,line' });
    if (error) {
      errors.push(`Batch ${Math.floor(i / BATCH_SIZE) + 1} error: ${error.message}`);
    } else {
      success += batch.length;
    }
  }

  console.log(`[importPlayerPropOdds] Imported ${success} rows to bookmaker_odds`);
  return { success, errors, total: rows.length };
}

interface ImportSectionProps {
  target: ImportTarget;
  title: string;
  description: string;
  note?: string;
}

function ImportSection({ target, title, description, note }: ImportSectionProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<'idle' | 'parsing' | 'importing' | 'done' | 'error'>('idle');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [previewRows, setPreviewRows] = useState<Record<string, string>[] | null>(null);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus('parsing');
    const text = await file.text();
    const { rows } = parseCSV(text);
    setPreviewRows(rows.slice(0, 3));
    setStatus('idle');
  }

  async function handleImport() {
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setStatus('importing');
    const text = await file.text();
    const { rows } = parseCSV(text);

    let res: ImportResult;
    if (target === 'players') res = await importPlayers(rows);
    else if (target === 'matches') res = await importMatches(rows);
    else if (target === 'fixtures') res = await importFixtures(rows);
    else if (target === 'player_prop_odds') res = await importPlayerPropOdds(rows);
    else res = await importPlayerGameStats(rows);

    setResult(res);
    setStatus(res.errors.length > 0 && res.success === 0 ? 'error' : 'done');
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl">
      <div className="px-5 py-4 border-b border-gray-800">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-white font-semibold text-sm">{title}</h3>
            <p className="text-gray-500 text-xs mt-0.5">{description}</p>
            {note && <p className="text-amber-400/80 text-xs mt-1">{note}</p>}
          </div>
          <button
            onClick={() => downloadTemplate(target)}
            className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-emerald-400 transition shrink-0"
          >
            <Download className="w-3.5 h-3.5" /> Template
          </button>
        </div>
        <div className="mt-3 text-xs text-gray-600">
          Required columns: <span className="text-gray-400 font-mono">{TEMPLATES[target].headers.join(', ')}</span>
        </div>
      </div>

      <div className="p-5 space-y-4">
        <div
          className="border-2 border-dashed border-gray-700 hover:border-emerald-500/50 rounded-xl p-8 text-center cursor-pointer transition"
          onClick={() => fileRef.current?.click()}
        >
          <Upload className="w-8 h-8 text-gray-600 mx-auto mb-2" />
          <p className="text-gray-400 text-sm">Click to upload CSV</p>
          <p className="text-gray-600 text-xs mt-1">UTF-8 encoded, comma-separated</p>
          <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleFile} />
        </div>

        {previewRows && previewRows.length > 0 && (
          <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-3 overflow-x-auto">
            <p className="text-xs text-gray-500 mb-2">Preview (first 3 rows):</p>
            <table className="w-full text-xs">
              <thead>
                <tr>
                  {Object.keys(previewRows[0]).map(h => (
                    <th key={h} className="text-left text-gray-600 pr-4 pb-1 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {previewRows.map((row, i) => (
                  <tr key={i}>
                    {Object.values(row).map((v, j) => (
                      <td key={j} className="text-gray-300 pr-4 py-0.5">{v}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {fileRef.current?.files?.[0] && (
          <button
            onClick={handleImport}
            disabled={status === 'importing'}
            className="w-full py-2.5 bg-emerald-500 hover:bg-emerald-400 disabled:bg-gray-700 disabled:text-gray-500 text-gray-950 font-semibold rounded-lg text-sm transition"
          >
            {status === 'importing' ? 'Importing...' : 'Import CSV'}
          </button>
        )}

        {status === 'importing' && (
          <div className="flex items-center gap-3 text-gray-400 text-sm py-2">
            <div className="w-4 h-4 border-2 border-gray-700 border-t-emerald-500 rounded-full animate-spin" />
            Importing records...
          </div>
        )}

        {result && (
          <div className="space-y-2">
            <div className={`flex items-center gap-3 p-3 rounded-lg border text-sm ${
              result.errors.length === 0
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                : result.success > 0
                ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                : 'bg-red-500/10 border-red-500/30 text-red-400'
            }`}>
              {result.errors.length === 0
                ? <CheckCircle className="w-4 h-4 shrink-0" />
                : result.success > 0
                ? <AlertTriangle className="w-4 h-4 shrink-0" />
                : <XCircle className="w-4 h-4 shrink-0" />
              }
              <span>
                {result.success} of {result.total} rows imported successfully
                {result.errors.length > 0 && ` — ${result.errors.length} errors`}
              </span>
            </div>
            {result.errors.length > 0 && (
              <div className="bg-gray-800 border border-gray-700 rounded-lg overflow-hidden">
                <button
                  onClick={() => setShowErrors(!showErrors)}
                  className="flex items-center justify-between w-full px-3 py-2 text-xs text-gray-400 hover:text-white transition"
                >
                  <span>View errors ({result.errors.length})</span>
                  {showErrors ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                </button>
                {showErrors && (
                  <div className="border-t border-gray-700 p-3 space-y-1 max-h-48 overflow-y-auto">
                    {result.errors.map((e, i) => (
                      <p key={i} className="text-red-400 text-xs font-mono">{e}</p>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function PrepareNextRoundPanel() {
  const [roundInfo, setRoundInfo] = useState<ReturnType<typeof getRoundInfo extends () => Promise<infer T> ? () => T : never> | null>(null);
  const [loading, setLoading] = useState(false);

  async function runCheck() {
    setLoading(true);
    try {
      const info = await getRoundInfo(2026);
      setRoundInfo(info as any);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { runCheck(); }, []);

  if (loading && !roundInfo) {
    return (
      <div className="bg-gray-900 border border-cyan-500/20 rounded-xl p-5">
        <div className="flex items-center gap-3 text-gray-400 text-sm">
          <div className="w-4 h-4 border-2 border-gray-700 border-t-cyan-500 rounded-full animate-spin" />
          Checking round status...
        </div>
      </div>
    );
  }

  if (!roundInfo) return null;

  const info = roundInfo as any;
  const statsRound = info.latestCompletedStatsRound ? `R${info.latestCompletedStatsRound}` : '—';
  const nextRound = info.nextBettingRound ? `R${info.nextBettingRound}` : '—';

  return (
    <div className="bg-gray-900 border border-cyan-500/20 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-white font-semibold text-sm flex items-center gap-2">
          <Calendar className="w-4 h-4 text-cyan-400" />
          Prepare Next Round
        </h3>
        <button
          onClick={runCheck}
          disabled={loading}
          className="text-xs px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white font-medium rounded-lg transition flex items-center gap-1.5"
        >
          {loading ? <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          Recheck
        </button>
      </div>

      <div className="space-y-2 text-sm">
        <div className="flex items-center justify-between py-1.5 border-b border-gray-800">
          <span className="text-gray-400">Latest completed stats round</span>
          <span className="text-white font-bold">{statsRound}</span>
        </div>
        <div className="flex items-center justify-between py-1.5 border-b border-gray-800">
          <span className="text-gray-400">Next betting round</span>
          <span className="text-cyan-400 font-bold">{nextRound}</span>
        </div>
        <div className="flex items-center justify-between py-1.5 border-b border-gray-800">
          <span className="text-gray-400">{nextRound} fixtures</span>
          {info.fixturesReady ? (
            <span className="text-emerald-400 font-medium flex items-center gap-1"><CheckCircle className="w-3.5 h-3.5" /> Ready ({info.nextRoundFixtures.length} matches)</span>
          ) : (
            <span className="text-red-400 font-medium flex items-center gap-1"><AlertCircle className="w-3.5 h-3.5" /> Missing</span>
          )}
        </div>
        <div className="flex items-center justify-between py-1.5 border-b border-gray-800">
          <span className="text-gray-400">{nextRound} player prop odds</span>
          {info.oddsReady ? (
            <span className="text-emerald-400 font-medium flex items-center gap-1"><CheckCircle className="w-3.5 h-3.5" /> Ready ({info.nextRoundOddsCount} rows)</span>
          ) : (
            <span className="text-red-400 font-medium flex items-center gap-1"><AlertCircle className="w-3.5 h-3.5" /> Missing</span>
          )}
        </div>
        <div className="flex items-center justify-between py-1.5 border-b border-gray-800">
          <span className="text-gray-400">Stats source</span>
          <span className="text-gray-300">Using {statsRound} and earlier</span>
        </div>
        <div className="flex items-center justify-between py-1.5">
          <span className="text-gray-400">Ready for Multi Builder</span>
          {info.readyForMultiBuilder ? (
            <span className="text-emerald-400 font-bold flex items-center gap-1"><CheckCircle className="w-4 h-4" /> Yes</span>
          ) : (
            <span className="text-amber-400 font-bold flex items-center gap-1"><AlertCircle className="w-4 h-4" /> No — {info.fixturesReady ? 'odds missing' : 'fixtures missing'}</span>
          )}
        </div>
      </div>

      {!info.fixturesReady && info.nextBettingRound && (
        <div className="mt-3 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg text-xs text-amber-300">
          <p className="font-semibold mb-1">{nextRound} fixtures are missing.</p>
          <p>Import or sync {nextRound} fixtures first. Use the Fixtures CSV import above or run Sync Player Props to fetch from The Odds API.</p>
        </div>
      )}
      {info.fixturesReady && !info.oddsReady && info.nextBettingRound && (
        <div className="mt-3 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg text-xs text-amber-300">
          <p className="font-semibold mb-1">{nextRound} fixtures found, but player prop odds are missing.</p>
          <p>Run Sync Player Props below to fetch {nextRound} odds from The Odds API.</p>
        </div>
      )}
    </div>
  );
}

export default function ImportPage() {
  const [oddsSyncing, setOddsSyncing] = useState(false);
  const [oddsSyncResult, setOddsSyncResult] = useState<OddsSyncResult | null>(null);
  const [lastOddsSyncAge, setLastOddsSyncAge] = useState<string>('Never');
  const [oddsApiCredits, setOddsApiCredits] = useState<number | null>(null);

  // Player props sync state
  const [propsSyncing, setPropsSyncing] = useState(false);
  const [propsSyncResult, setPropsSyncResult] = useState<PlayerPropsSyncResult | null>(null);
  const [propsLastSyncAge, setPropsLastSyncAge] = useState<string>('Never');

  // Bookmaker odds state
  const [bookmakerSyncing, setBookmakerSyncing] = useState(false);
  const [bookmakerFeeds, setBookmakerFeeds] = useState<{
    bookmaker_id: string;
    name: string;
    last_fetch_at: string | null;
  }[]>([]);

  // Confirmation dialog state
  const [showConfirm, setShowConfirm] = useState<'match-odds' | 'player-props' | null>(null);
  const [dryRunResult, setDryRunResult] = useState<{
    type: 'match-odds' | 'player-props';
    existing: number;
    stale: boolean;
    lastSync: string | null;
  } | null>(null);
  const [dryRunning, setDryRunning] = useState(false);

  useEffect(() => {
    getLastOddsSyncTime().then(({ fetchedAt, requestsRemaining }) => {
      setLastOddsSyncAge(formatSyncAge(fetchedAt));
      setOddsApiCredits(requestsRemaining);
    });

    getLastBookmakerFetch().then(feeds => setBookmakerFeeds(feeds));

    // Check last player props sync time
    supabase
      .from('odds_cache')
      .select('fetched_at')
      .eq('sport', 'aussierules_afl_props')
      .maybeSingle()
      .then(({ data }) => setPropsLastSyncAge(formatSyncAge(data?.fetched_at ?? null)));
  }, []);

  async function handlePropsSync(force = false) {
    setPropsSyncing(true);
    setPropsSyncResult(null);
    const result = await syncPlayerPropsFromApi(force);
    setPropsSyncResult(result);
    setPropsLastSyncAge(formatSyncAge(result.fetched_at));
    if (result.requests_remaining != null) setOddsApiCredits(result.requests_remaining);
    setPropsSyncing(false);
  }

  async function handleOddsSync(force = false) {
    setOddsSyncing(true);
    setOddsSyncResult(null);
    const result = await syncOddsFromApi(force);
    setOddsSyncResult(result);
    setLastOddsSyncAge(formatSyncAge(result.synced_at));
    if (result.requests_remaining != null) setOddsApiCredits(result.requests_remaining);
    setOddsSyncing(false);
    setShowConfirm(null);
  }

  async function runDryRun(type: 'match-odds' | 'player-props') {
    setDryRunning(true);
    setDryRunResult(null);

    if (type === 'match-odds') {
      const { data: existing } = await supabase
        .from('odds_cache')
        .select('fetched_at')
        .eq('sport', 'aussierules_afl')
        .maybeSingle();

      const lastSync = (existing as { fetched_at: string | null } | null)?.fetched_at ?? null;
      const stale = !lastSync || (Date.now() - new Date(lastSync).getTime()) > 6 * 60 * 60 * 1000;

      setDryRunResult({ type, existing: existing ? 1 : 0, stale, lastSync });
    } else {
      const { count } = await supabase
        .from('bookmaker_odds')
        .select('*', { count: 'exact', head: true });

      const { data: cache } = await supabase
        .from('odds_cache')
        .select('fetched_at')
        .eq('sport', 'aussierules_afl_props')
        .maybeSingle();

      const lastSync = (cache as { fetched_at: string | null } | null)?.fetched_at ?? null;
      const stale = !lastSync || (Date.now() - new Date(lastSync).getTime()) > 1 * 60 * 60 * 1000;

      setDryRunResult({ type, existing: count ?? 0, stale, lastSync });
    }

    setDryRunning(false);
  }

  function confirmForceRefresh(type: 'match-odds' | 'player-props') {
    setShowConfirm(type);
  }

  function handleConfirmedSync() {
    if (showConfirm === 'match-odds') {
      handleOddsSync(true);
    } else if (showConfirm === 'player-props') {
      handlePropsSync(true);
    }
  }

  // Player Stats Sync state
  const [statsDryRunning, setStatsDryRunning] = useState(false);
  const [statsDryRunResult, setStatsDryRunResult] = useState<StatsSyncDiagnostics | null>(null);
  const [statsBackfilling, setStatsBackfilling] = useState(false);
  const [statsBackfillResult, setStatsBackfillResult] = useState<BackfillDiagnostics | null>(null);
  const [statsDedupRunning, setStatsDedupRunning] = useState(false);
  const [statsDedupResult, setStatsDedupResult] = useState<{ duplicatesRemoved: number; errors: string[] } | null>(null);
  const [statsFileRef, setStatsFileRef] = useState<File | null>(null);
  const [statsImporting, setStatsImporting] = useState(false);
  const [statsImportResult, setStatsImportResult] = useState<StatsImportValidation | null>(null);
  const [dataStatus, setDataStatus] = useState<{ status: string; latestCompletedRound: string | null; latestStatRound: string | null; isStale: boolean; reasons: string[] } | null>(null);
  // DFS Australia role-data (CBA / kick-in) import state
  const [dfsFileRef, setDfsFileRef] = useState<File | null>(null);
  const [dfsDryRunning, setDfsDryRunning] = useState(false);
  const [dfsImporting, setDfsImporting] = useState(false);
  const [dfsDryRunResult, setDfsDryRunResult] = useState<DfsProcessResult | null>(null);
  const [dfsImportResult, setDfsImportResult] = useState<DfsImportReport | null>(null);
  const [dfsError, setDfsError] = useState<string | null>(null);
  const [dfsRefreshMsg, setDfsRefreshMsg] = useState<string | null>(null);
  // Kali sync state
  const [kaliTesting, setKaliTesting] = useState(false);
  const [kaliTestResult, setKaliTestResult] = useState<KaliConnectionTest | null>(null);
  const [kaliSyncing, setKaliSyncing] = useState(false);
  const [kaliSyncResult, setKaliSyncResult] = useState<KaliSyncResult | null>(null);
  const [kaliDryRunResult, setKaliDryRunResult] = useState<KaliSyncResult | null>(null);
  const [kaliPriority, setKaliPriority] = useState<SyncPriority>('round_17');
  const [kaliSyncAllRunning, setKaliSyncAllRunning] = useState(false);
  const [promoteStagedRunning, setPromoteStagedRunning] = useState(false);
  const [promoteStagedResult, setPromoteStagedResult] = useState<{
    staged_rows: number;
    resolved_players: number;
    promoted_rows: number;
    empty_before: number;
    incomplete_before: number;
    empty_after: number;
    incomplete_after: number;
    complete_matches: number;
  } | null>(null);
  const [repairOddsRunning, setRepairOddsRunning] = useState(false);
  const [repairOddsResult, setRepairOddsResult] = useState<{
    odds_rows_checked: number;
    already_correct: number;
    relinked_to_canonical: number;
    still_no_stats: number;
    errors: number;
  } | null>(null);

  async function handleRepairOddsPlayerLinks() {
    setRepairOddsRunning(true);
    setRepairOddsResult(null);
    try {
      const { data, error } = await supabase.rpc('repair_bookmaker_player_links');
      if (error) throw error;
      // data is an array with one row
      const result = Array.isArray(data) ? data[0] : data;
      setRepairOddsResult({
        odds_rows_checked: result?.odds_rows_checked ?? 0,
        already_correct: result?.already_correct ?? 0,
        relinked_to_canonical: result?.relinked_to_canonical ?? 0,
        still_no_stats: result?.still_no_stats ?? 0,
        errors: result?.errors ?? 0,
      });
    } catch (err: any) {
      console.error('Repair odds player links failed:', err);
      setRepairOddsResult({
        odds_rows_checked: 0,
        already_correct: 0,
        relinked_to_canonical: 0,
        still_no_stats: 0,
        errors: 1,
      });
    } finally {
      setRepairOddsRunning(false);
    }
  }

  async function handlePromoteStagedRows() {
    setPromoteStagedRunning(true);
    setPromoteStagedResult(null);
    try {
      // Call the edge function to promote staged rows
      const { data, error } = await supabase.functions.invoke('promote-staged-kali', {
        body: { action: 'promote' }
      });
      if (error) throw error;
      setPromoteStagedResult(data);
    } catch (err: any) {
      console.error('Promote staged failed:', err);
    } finally {
      setPromoteStagedRunning(false);
      // Refresh data status
      const season = new Date().getFullYear();
      const status = await getDataStatus(season);
      setDataStatus(status);
    }
  }

  async function handleStatsDryRun() {
    setStatsDryRunning(true);
    setStatsDryRunResult(null);
    try {
      const season = new Date().getFullYear();
      const result = await dryRunStatsCheck(season);
      setStatsDryRunResult(result);
    } catch (e: any) {
      setStatsDryRunResult({ ...{} as StatsSyncDiagnostics, errors: [e?.message ?? String(e)] });
    } finally {
      setStatsDryRunning(false);
    }
  }

  async function handleStatsBackfill() {
    setStatsBackfilling(true);
    setStatsBackfillResult(null);
    try {
      const season = new Date().getFullYear();
      const result = await backfillMissingRounds(season);
      setStatsBackfillResult(result);
    } catch (e: any) {
      setStatsBackfillResult({ ...{} as BackfillDiagnostics, errors: [e?.message ?? String(e)] });
    } finally {
      setStatsBackfilling(false);
    }
  }

  async function handleStatsDedup() {
    setStatsDedupRunning(true);
    setStatsDedupResult(null);
    try {
      const result = await deduplicateStats();
      setStatsDedupResult(result);
    } catch (e: any) {
      setStatsDedupResult({ duplicatesRemoved: 0, errors: [e?.message ?? String(e)] });
    } finally {
      setStatsDedupRunning(false);
    }
  }

  async function handleStatsFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatsFileRef(file);
  }

  async function handleStatsImport() {
    if (!statsFileRef) return;
    setStatsImporting(true);
    setStatsImportResult(null);
    try {
      const text = await statsFileRef.text();
      const { rows } = parseCSV(text);
      const result = await importValidatedStats(rows);
      setStatsImportResult(result);
      // Refresh data status
      const season = new Date().getFullYear();
      const status = await getDataStatus(season);
      setDataStatus(status);
    } catch (e: any) {
      setStatsImportResult({ ...{} as StatsImportValidation, errors: [{ row: 0, message: e?.message ?? String(e) }], totalRows: 0, validRows: 0, invalidRows: 0, inserted: 0, updated: 0, skipped: 0, duplicates: 0, latestRoundImported: null });
    } finally {
      setStatsImporting(false);
    }
  }

  useEffect(() => {
    const season = new Date().getFullYear();
    getDataStatus(season).then(setDataStatus);
  }, []);

  function handleDfsFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setDfsFileRef(file);
    setDfsDryRunResult(null);
    setDfsImportResult(null);
    setDfsError(null);
  }

  async function handleDfsDryRun() {
    if (!dfsFileRef) return;
    setDfsDryRunning(true);
    setDfsError(null);
    setDfsImportResult(null);
    try {
      const text = await dfsFileRef.text();
      const result = await processDfsRows(text);
      setDfsDryRunResult(result);
    } catch (e: any) {
      setDfsError(e?.message ?? String(e));
    } finally {
      setDfsDryRunning(false);
    }
  }

  async function handleDfsImport() {
    if (!dfsFileRef) return;
    setDfsImporting(true);
    setDfsError(null);
    try {
      const text = await dfsFileRef.text();
      const result = await importDfsRows(text);
      setDfsImportResult(result);
    } catch (e: any) {
      setDfsError(e?.message ?? String(e));
    } finally {
      setDfsImporting(false);
    }
  }

  async function handleRefreshPlayerIntelligence() {
    setDfsRefreshMsg('Refreshing…');
    try {
      const map = await loadRoleTrends(2026);
      setDfsRefreshMsg(`Role trends reloaded — ${map.size} players now have CBA/kick-in data cached. Revisit Multi Builder to see updated Player Intelligence.`);
    } catch (e: any) {
      setDfsRefreshMsg(`Refresh failed: ${e?.message ?? String(e)}`);
    }
  }

  async function handleKaliTest() {
    setKaliTesting(true);
    setKaliTestResult(null);
    try {
      const result = await testKaliConnection();
      setKaliTestResult(result);
    } catch (e: any) {
      setKaliTestResult({ connected: false, status: 'api_error', requests_remaining: null, message: e?.message ?? String(e) });
    } finally {
      setKaliTesting(false);
    }
  }

  async function handleKaliSync() {
    setKaliSyncing(true);
    setKaliSyncResult(null);
    try {
      const result = await syncPlayerGameStatsFromKali(kaliPriority);
      setKaliSyncResult(result);
      // Refresh data status after sync
      const season = new Date().getFullYear();
      const status = await getDataStatus(season);
      setDataStatus(status);
      // Recalculate Position Edge if rows were inserted/updated
      if (result.success && (result.rows_inserted > 0 || result.rows_updated > 0)) {
        try {
          await recalculatePositionEdges();
        } catch {
          // Position Edge recalc is best-effort — edge function may not be deployed
        }
      }
    } catch (e: any) {
      setKaliSyncResult({ ...defaultKaliResult(), errors: [e?.message ?? String(e)] });
    } finally {
      setKaliSyncing(false);
    }
  }

  async function handleKaliSyncAll() {
    setKaliSyncAllRunning(true);
    setKaliSyncResult(null);
    try {
      const result = await syncAllMissingFromKali();
      setKaliSyncResult(result);
      // Refresh data status after sync
      const season = new Date().getFullYear();
      const status = await getDataStatus(season);
      setDataStatus(status);
      // Recalculate Position Edge if rows were inserted/updated
      if (result.success && (result.rows_inserted > 0 || result.rows_updated > 0)) {
        try {
          await recalculatePositionEdges();
        } catch {
          // Position Edge recalc is best-effort — edge function may not be deployed
        }
      }
    } catch (e: any) {
      setKaliSyncResult({ ...defaultKaliResult(), errors: [e?.message ?? String(e)] });
    } finally {
      setKaliSyncAllRunning(false);
    }
  }

  function defaultKaliResult(): KaliSyncResult {
    return {
      success: false, action: 'sync', kali_connected: false, kali_status: 'unknown',
      requests_used: 0, requests_remaining: null, matches_fetched: 0, player_rows_fetched: 0,
      rows_inserted: 0, rows_updated: 0, rows_skipped: 0, rows_unresolved: 0, duplicates_removed: 0, failed_rows: 0,
      latest_stat_round_before: null, latest_stat_round_after: null, missing_matches_remaining: 0,
      rows_to_backfill: 0, matches_processed: [], failed_matches: [], errors: [], debug_log: [],
    };
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h2 className="text-white font-bold text-lg">Import Data</h2>
        <p className="text-gray-500 text-sm mt-1">Sync live odds from The Odds API or manually upload CSV files.</p>
      </div>

      {/* Data Source Status Panel */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <Database className="w-4 h-4 text-gray-400" />
          <h3 className="text-white font-semibold text-sm">Data Source Status</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700/50">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle className="w-4 h-4 text-emerald-400" />
              <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">bookmaker_odds</span>
            </div>
            <p className="text-white text-sm font-semibold">Active</p>
            <p className="text-gray-500 text-xs mt-1">Source of truth for player props</p>
          </div>
          <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700/50">
            <div className="flex items-center gap-2 mb-2">
              <Wifi className="w-4 h-4 text-emerald-400" />
              <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">The Odds API</span>
            </div>
            <p className="text-white text-sm font-semibold">Connected</p>
            <p className="text-emerald-400 text-xs mt-1">AFL player props available</p>
          </div>
          <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700/50">
            <div className="flex items-center gap-2 mb-2">
              <WifiOff className="w-4 h-4 text-gray-500" />
              <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Sportsbet</span>
            </div>
            <p className="text-gray-400 text-sm font-semibold">Not Connected</p>
            <p className="text-gray-600 text-xs mt-1">No public API available</p>
          </div>
          <div className="bg-gray-800/50 rounded-lg p-4 border border-gray-700/50">
            <div className="flex items-center gap-2 mb-2">
              <Upload className="w-4 h-4 text-cyan-400" />
              <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">CSV Import</span>
            </div>
            <p className="text-white text-sm font-semibold">Available</p>
            <p className="text-gray-500 text-xs mt-1">Manual ladder ingestion</p>
          </div>
        </div>
        <div className="mt-4 pt-4 border-t border-gray-800">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            <div className="text-xs text-gray-400">
              <p className="font-medium text-emerald-300">AFL player props now syncing from The Odds API.</p>
              <p className="mt-1">Fetching player_disposals_over, player_marks_over, player_tackles_over, player_goals_scored_over from Sportsbet via The Odds API. Each ladder threshold (21+, 22+, 23+...) stored as separate rows in bookmaker_odds.</p>
            </div>
          </div>
        </div>
      </div>

      {/* Prepare Next Round Workflow */}
      <PrepareNextRoundPanel />

      {/* Player Game Stats Sync Section */}
      <div className="bg-gradient-to-r from-amber-500/10 to-orange-500/10 border border-amber-500/30 rounded-xl p-6 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-2">
              <Database className="w-5 h-5 text-amber-400" />
              <h3 className="text-white font-semibold">Player Game Stats Sync</h3>
              {dataStatus && (
                <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${
                  dataStatus.status === 'READY' ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-400' :
                  dataStatus.status === 'WARNING' ? 'bg-amber-500/15 border border-amber-500/30 text-amber-400' :
                  'bg-red-500/15 border border-red-500/30 text-red-400'
                }`}>
                  {dataStatus.status}
                </span>
              )}
            </div>
            <p className="text-gray-400 text-sm mb-1">
              Backfill player_game_stats through the latest completed AFL round. This data feeds EV Calculator, Final Card, Position Edge, and Venue/Opponent Edge.
            </p>
            <p className="text-gray-600 text-xs">
              Uses Kali AFL Stats API (kaliaflstats.com) for automated backfill, or CSV import as fallback. Does NOT use The Odds API for stats.
            </p>
          </div>
        </div>

        {/* Data Status Summary */}
        {dataStatus && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Latest Completed Round</p>
              <p className="text-white font-bold">{dataStatus.latestCompletedRound ? `R${dataStatus.latestCompletedRound}` : '—'}</p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Latest Stat Round</p>
              <p className={`font-bold ${dataStatus.isStale ? 'text-red-400' : 'text-emerald-400'}`}>
                {dataStatus.latestStatRound ? `R${dataStatus.latestStatRound}` : '—'}
              </p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Stale Status</p>
              <p className={`font-bold ${dataStatus.isStale ? 'text-red-400' : 'text-emerald-400'}`}>
                {dataStatus.isStale ? 'STALE' : 'Fresh'}
              </p>
            </div>
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500">Data Status</p>
              <p className={`font-bold ${
                dataStatus.status === 'READY' ? 'text-emerald-400' :
                dataStatus.status === 'WARNING' ? 'text-amber-400' :
                'text-red-400'
              }`}>{dataStatus.status}</p>
            </div>
          </div>
        )}

        {dataStatus?.isStale && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-xs text-red-400">
            <AlertOctagon className="w-4 h-4 inline mr-2" />
            Player stats need to be imported through Round {dataStatus.latestCompletedRound} before the app is ready.
            Latest stats are only at Round {dataStatus.latestStatRound}.
            {dataStatus.status === 'BROKEN' && (
              <span className="block mt-1 font-semibold">KALI SYNC REQUIRED — FINAL CARD BLOCKED</span>
            )}
          </div>
        )}

        {/* Kali AFL Stats API Connection */}
        <div className="bg-gray-800/30 border border-gray-700/50 rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Satellite className="w-4 h-4 text-cyan-400" />
            <h4 className="text-white font-medium text-sm">Kali AFL Stats API</h4>
            {kaliTestResult && (
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${
                kaliTestResult.connected
                  ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-400'
                  : 'bg-red-500/15 border border-red-500/30 text-red-400'
              }`}>
                {kaliTestResult.connected ? 'Connected' : kaliTestResult.status === 'missing_key' ? 'Missing Key' : kaliTestResult.status === 'auth_failed' ? 'Auth Failed' : kaliTestResult.status === 'rate_limited' ? 'Rate Limited' : 'API Error'}
              </span>
            )}
            {kaliTestResult?.requests_remaining !== null && kaliTestResult?.requests_remaining !== undefined && (
              <span className="text-[10px] text-gray-500">Remaining: {kaliTestResult.requests_remaining}</span>
            )}
          </div>
          <p className="text-xs text-gray-500">
            Fetches player game stats from kaliaflstats.com (5,000 requests/day). Uses server-side KALI_API_KEY secret — never exposed to the browser.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleKaliTest}
              disabled={kaliTesting}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium rounded-lg text-xs transition"
            >
              {kaliTesting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Activity className="w-3 h-3" />}
              Test Kali Connection
            </button>
          </div>
          {kaliTestResult && !kaliTestResult.connected && (
            <p className="text-xs text-red-400">{kaliTestResult.message}</p>
          )}
          {kaliTestResult && kaliTestResult.connected && (
            <p className="text-xs text-emerald-400">{kaliTestResult.message}</p>
          )}
        </div>

        {/* Kali Sync Controls */}
        <div className="bg-gray-800/30 border border-gray-700/50 rounded-lg p-4 space-y-3">
          <div className="flex items-center gap-2">
            <RefreshCw className="w-4 h-4 text-blue-400" />
            <h4 className="text-white font-medium text-sm">Backfill from Kali</h4>
          </div>
          <p className="text-xs text-gray-500">
            Fetches missing player stats from Kali and upserts into player_game_stats. Only fetches matches that are missing stats — saves API quota.
          </p>

          {/* Prominent Sync All Missing Button */}
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 space-y-2">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400" />
              <span className="text-xs text-amber-400 font-medium">Backfill ALL Missing Completed Matches</span>
            </div>
            <p className="text-xs text-gray-500">
              Syncs all missing matches from R0 to latest completed — no priority filter. This is the recommended action to get data ready for EV Calculator and Final Card.
            </p>
            <button
              onClick={handleKaliSyncAll}
              disabled={kaliSyncAllRunning}
              className="flex items-center gap-1.5 px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold rounded-lg text-xs transition w-full justify-center"
            >
              {kaliSyncAllRunning ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              Backfill ALL Missing Matches
            </button>
          </div>

          {/* Promote Staged Kali Rows */}
          <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 space-y-2">
            <div className="flex items-center gap-2">
              <Database className="w-4 h-4 text-emerald-400" />
              <span className="text-xs text-emerald-400 font-medium">Promote Staged Kali Rows</span>
            </div>
            <p className="text-xs text-gray-500">
              Promotes unresolved rows from raw_kali_player_game_stats into player_game_stats. Resolves player_id by name matching and creates missing players automatically. No API calls — uses existing staged data.
            </p>
            <button
              onClick={handlePromoteStagedRows}
              disabled={promoteStagedRunning}
              className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold rounded-lg text-xs transition w-full justify-center"
            >
              {promoteStagedRunning ? <Loader2 className="w-3 h-3 animate-spin" /> : <Database className="w-3 h-3" />}
              Promote Staged Kali Rows
            </button>
          </div>

          {/* Repair Odds Player Links */}
          <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-3 space-y-2">
            <div className="flex items-center gap-2">
              <LinkIcon className="w-4 h-4 text-blue-400" />
              <span className="text-xs text-blue-400 font-medium">Repair Odds Player Links</span>
            </div>
            <p className="text-xs text-gray-500">
              Fixes bookmaker_odds rows where player_id points to a player record with no stats. Relinks to canonical player with historical stats.
            </p>
            <button
              onClick={handleRepairOddsPlayerLinks}
              disabled={repairOddsRunning}
              className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold rounded-lg text-xs transition w-full justify-center"
            >
              {repairOddsRunning ? <Loader2 className="w-3 h-3 animate-spin" /> : <LinkIcon className="w-3 h-3" />}
              Repair Odds Player Links
            </button>
          </div>

          {/* Priority-based sync (collapsible) */}
          <details className="text-xs">
            <summary className="cursor-pointer text-gray-500 hover:text-gray-400 flex items-center gap-1">
              <ChevronDown className="w-3 h-3" />
              Advanced: Priority-based sync
            </summary>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <select
                value={kaliPriority}
                onChange={e => setKaliPriority(e.target.value as SyncPriority)}
                className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-white"
              >
                <option value="round_17">Backfill Round 17 only</option>
                <option value="critical">Backfill critical R13-R17 (R18 odds teams)</option>
                <option value="all">Backfill all missing completed matches</option>
              </select>
              <button
                onClick={handleKaliSync}
                disabled={kaliSyncing}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-medium rounded-lg text-xs transition"
              >
                {kaliSyncing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Satellite className="w-3 h-3" />}
                Sync with Priority
              </button>
            </div>
          </details>

          {/* Kali Sync Results */}
          {kaliSyncResult && (
            <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-3 space-y-2 text-xs">
              <div className={`font-medium ${
                !kaliSyncResult.success ? 'text-red-400' :
                kaliSyncResult.missing_matches_remaining > 0 ? 'text-amber-400' :
                'text-emerald-400'
              }`}>
                {!kaliSyncResult.success ? 'KALI BACKFILL FAILED' :
                 kaliSyncResult.missing_matches_remaining > 0
                   ? `DATA INCOMPLETE — ${kaliSyncResult.missing_matches_remaining} missing matches remaining`
                   : 'BACKFILL COMPLETE — All stats imported'}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div><span className="text-gray-500">Matches Fetched:</span> <span className="text-white font-bold">{kaliSyncResult.matches_fetched}</span></div>
                <div><span className="text-gray-500">Player Rows:</span> <span className="text-white font-bold">{kaliSyncResult.player_rows_fetched}</span></div>
                <div><span className="text-gray-500">Inserted:</span> <span className="text-emerald-400 font-bold">{kaliSyncResult.rows_inserted}</span></div>
                <div><span className="text-gray-500">Duplicates Removed:</span> <span className="text-amber-400 font-bold">{kaliSyncResult.duplicates_removed}</span></div>
                <div><span className="text-gray-500">Unresolved Players:</span> <span className="text-orange-400 font-bold">{kaliSyncResult.rows_unresolved}</span></div>
                <div><span className="text-gray-500">API Requests:</span> <span className="text-cyan-400 font-bold">{kaliSyncResult.requests_used}</span></div>
                <div><span className="text-gray-500">Remaining:</span> <span className="text-cyan-400 font-bold">{kaliSyncResult.requests_remaining ?? '—'}</span></div>
                <div><span className="text-gray-500">Stat Round Before:</span> <span className="text-white font-bold">R{kaliSyncResult.latest_stat_round_before ?? '?'}</span></div>
                <div><span className="text-gray-500">Stat Round After:</span> <span className={`font-bold ${kaliSyncResult.latest_stat_round_after && kaliSyncResult.latest_stat_round_before && parseInt(kaliSyncResult.latest_stat_round_after) > parseInt(kaliSyncResult.latest_stat_round_before) ? 'text-emerald-400' : 'text-white'}`}>R{kaliSyncResult.latest_stat_round_after ?? '?'}</span></div>
                <div><span className="text-gray-500">Missing Matches:</span> <span className={`font-bold ${kaliSyncResult.missing_matches_remaining === 0 ? 'text-emerald-400' : 'text-red-400'}`}>{kaliSyncResult.missing_matches_remaining}</span></div>
                <div><span className="text-gray-500">Rows to Backfill:</span> <span className={`font-bold ${kaliSyncResult.rows_to_backfill === 0 ? 'text-emerald-400' : 'text-amber-400'}`}>{kaliSyncResult.rows_to_backfill}</span></div>
              </div>
              {kaliSyncResult.matches_processed.length > 0 && (
                <div>
                  <p className="text-gray-500 mb-1">Matches processed ({kaliSyncResult.matches_processed.length}):</p>
                  <div className="max-h-32 overflow-y-auto space-y-0.5">
                    {kaliSyncResult.matches_processed.slice(0, 50).map((m, i) => (
                      <div key={i} className="text-gray-400">{m}</div>
                    ))}
                    {kaliSyncResult.matches_processed.length > 50 && <p className="text-gray-600">...and {kaliSyncResult.matches_processed.length - 50} more</p>}
                  </div>
                </div>
              )}
              {kaliSyncResult.failed_matches && kaliSyncResult.failed_matches.length > 0 && (
                <div className="bg-red-500/10 border border-red-500/30 rounded p-2">
                  <p className="text-red-400 font-medium mb-1">Failed Matches ({kaliSyncResult.failed_matches.length}):</p>
                  <div className="max-h-40 overflow-y-auto space-y-1">
                    {kaliSyncResult.failed_matches.map((m, i) => (
                      <div key={i} className="text-xs text-gray-400">
                        <span className="text-red-400">R{m.round}</span> {m.home_team} vs {m.away_team}
                        <span className="text-gray-600"> — {m.failure_reason}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {kaliSyncResult.errors.length > 0 && (
                <div className="text-red-400">
                  {kaliSyncResult.errors.slice(0, 5).map((e, i) => <div key={i}>{e}</div>)}
                </div>
              )}
            </div>
          )}

          {/* Promote Staged Results */}
          {promoteStagedResult && (
            <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 space-y-2 text-xs">
              <div className="font-medium text-emerald-400">Promote Staged Kali Rows Complete</div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div><span className="text-gray-500">Staged Rows Found:</span> <span className="text-white font-bold">{promoteStagedResult.staged_rows}</span></div>
                <div><span className="text-gray-500">Players Resolved:</span> <span className="text-emerald-400 font-bold">{promoteStagedResult.resolved_players}</span></div>
                <div><span className="text-gray-500">Rows Promoted:</span> <span className="text-emerald-400 font-bold">{promoteStagedResult.promoted_rows}</span></div>
                <div><span className="text-gray-500">Complete Matches:</span> <span className="text-emerald-400 font-bold">{promoteStagedResult.complete_matches}</span></div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div><span className="text-gray-500">Empty Matches Before:</span> <span className="text-amber-400 font-bold">{promoteStagedResult.empty_before}</span></div>
                <div><span className="text-gray-500">Empty Matches After:</span> <span className={`font-bold ${promoteStagedResult.empty_after === 0 ? 'text-emerald-400' : 'text-red-400'}`}>{promoteStagedResult.empty_after}</span></div>
                <div><span className="text-gray-500">Incomplete Before:</span> <span className="text-amber-400 font-bold">{promoteStagedResult.incomplete_before}</span></div>
                <div><span className="text-gray-500">Incomplete After:</span> <span className={`font-bold ${promoteStagedResult.incomplete_after < promoteStagedResult.incomplete_before ? 'text-emerald-400' : 'text-amber-400'}`}>{promoteStagedResult.incomplete_after}</span></div>
              </div>
            </div>
          )}

          {/* Repair Odds Player Links Results */}
          {repairOddsResult && (
            <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-3 space-y-2 text-xs">
              <div className="font-medium text-blue-400">Repair Odds Player Links Complete</div>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                <div><span className="text-gray-500">Rows Checked:</span> <span className="text-white font-bold">{repairOddsResult.odds_rows_checked}</span></div>
                <div><span className="text-gray-500">Already Correct:</span> <span className="text-emerald-400 font-bold">{repairOddsResult.already_correct}</span></div>
                <div><span className="text-gray-500">Relinked:</span> <span className="text-blue-400 font-bold">{repairOddsResult.relinked_to_canonical}</span></div>
                <div><span className="text-gray-500">Still No Stats:</span> <span className="text-amber-400 font-bold">{repairOddsResult.still_no_stats}</span></div>
                <div><span className="text-gray-500">Errors:</span> <span className="text-red-400 font-bold">{repairOddsResult.errors}</span></div>
              </div>
            </div>
          )}

          {/* Kali Sync Debug Log */}
          {kaliSyncResult && kaliSyncResult.debug_log && kaliSyncResult.debug_log.length > 0 && (
            <details className="text-xs text-gray-600">
              <summary className="cursor-pointer hover:text-gray-400">Debug log ({kaliSyncResult.debug_log.length} lines)</summary>
              <div className="max-h-40 overflow-y-auto mt-1 space-y-0.5">
                {kaliSyncResult.debug_log.map((l, i) => <div key={i}>{l}</div>)}
              </div>
            </details>
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap gap-3">
          <button
            onClick={handleStatsDryRun}
            disabled={statsDryRunning}
            className="flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold rounded-lg text-sm transition"
          >
            {statsDryRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />}
            Dry Run Stats Check
          </button>
          <button
            onClick={handleStatsBackfill}
            disabled={statsBackfilling}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold rounded-lg text-sm transition"
          >
            {statsBackfilling ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Backfill Missing Rounds
          </button>
          <button
            onClick={handleStatsDedup}
            disabled={statsDedupRunning}
            className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-500 text-white font-semibold rounded-lg text-sm transition"
          >
            {statsDedupRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <AlertTriangle className="w-4 h-4" />}
            Deduplicate Stats
          </button>
        </div>

        {/* Dry Run Results */}
        {statsDryRunResult && (
          <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-3 space-y-2 text-xs">
            <p className="text-white font-medium">Dry Run Results:</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div><span className="text-gray-500">Latest Completed:</span> <span className="text-white font-bold">{statsDryRunResult.latestCompletedRound ? `R${statsDryRunResult.latestCompletedRound}` : '—'}</span></div>
              <div><span className="text-gray-500">Latest Stat:</span> <span className={`font-bold ${statsDryRunResult.latestStatRound && statsDryRunResult.latestCompletedRound && parseInt(statsDryRunResult.latestStatRound) < parseInt(statsDryRunResult.latestCompletedRound) ? 'text-red-400' : 'text-emerald-400'}`}>{statsDryRunResult.latestStatRound ? `R${statsDryRunResult.latestStatRound}` : '—'}</span></div>
              <div><span className="text-gray-500">Missing Matches:</span> <span className="text-amber-400 font-bold">{statsDryRunResult.missingMatches.length}</span></div>
              <div><span className="text-gray-500">Missing Rounds:</span> <span className="text-amber-400 font-bold">{statsDryRunResult.missingRounds.length}</span></div>
            </div>
            {statsDryRunResult.missingMatches.length > 0 && (
              <div>
                <p className="text-gray-500 mb-1">Missing matches (no player_game_stats):</p>
                <div className="max-h-32 overflow-y-auto space-y-0.5">
                  {statsDryRunResult.missingMatches.slice(0, 20).map((m, i) => (
                    <div key={i} className="text-gray-400">R{m.round} {m.home_team} vs {m.away_team} — {m.match_date}</div>
                  ))}
                  {statsDryRunResult.missingMatches.length > 20 && <p className="text-gray-600">...and {statsDryRunResult.missingMatches.length - 20} more</p>}
                </div>
              </div>
            )}
            {statsDryRunResult.errors.length > 0 && (
              <div className="text-red-400">{statsDryRunResult.errors.join(', ')}</div>
            )}
          </div>
        )}

        {/* Backfill Results */}
        {statsBackfillResult && (
          <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-3 space-y-2 text-xs">
            <p className="text-white font-medium">Backfill Analysis:</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div><span className="text-gray-500">Matches Found:</span> <span className="text-white font-bold">{statsBackfillResult.matchesFound}</span></div>
              <div><span className="text-gray-500">Missing Stats:</span> <span className="text-amber-400 font-bold">{statsBackfillResult.matchesMissingStats}</span></div>
              <div><span className="text-gray-500">Rounds Checked:</span> <span className="text-white font-bold">{statsBackfillResult.roundsChecked.length}</span></div>
              <div><span className="text-gray-500">Rows to Backfill:</span> <span className="text-amber-400 font-bold">{statsBackfillResult.rowsToBackfill}</span></div>
            </div>
            {statsBackfillResult.perRound.length > 0 && (
              <div>
                <p className="text-gray-500 mb-1">Per-round breakdown:</p>
                <div className="max-h-32 overflow-y-auto space-y-0.5">
                  {statsBackfillResult.perRound.map((r, i) => (
                    <div key={i} className={`flex justify-between ${r.missingStats > 0 ? 'text-amber-400' : 'text-gray-500'}`}>
                      <span>Round {r.round}</span>
                      <span>{r.matches} matches, {r.missingStats} missing</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {statsBackfillResult.matchesMissingStats > 0 && (
              <p className="text-amber-400">
                {statsBackfillResult.matchesMissingStats} matches have no player_game_stats. Use CSV import below to add stats for these matches.
              </p>
            )}
            {statsBackfillResult.errors.length > 0 && (
              <div className="text-red-400">{statsBackfillResult.errors.join(', ')}</div>
            )}
          </div>
        )}

        {/* Dedup Results */}
        {statsDedupResult && (
          <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-3 text-xs">
            {statsDedupResult.duplicatesRemoved > 0 ? (
              <p className="text-emerald-400">Removed {statsDedupResult.duplicatesRemoved} duplicate rows.</p>
            ) : (
              <p className="text-gray-400">No duplicates found.</p>
            )}
            {statsDedupResult.errors.length > 0 && (
              <p className="text-red-400 mt-1">{statsDedupResult.errors.join(', ')}</p>
            )}
          </div>
        )}

        {/* CSV Import for Stats */}
        <div className="border-t border-gray-700/50 pt-4 space-y-3">
          <p className="text-xs text-gray-500">Import Latest Player Stats CSV:</p>
          <div className="flex items-center gap-3">
            <input
              type="file"
              accept=".csv"
              onChange={handleStatsFile}
              className="text-xs text-gray-400 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-gray-700 file:text-gray-300 hover:file:bg-gray-600 file:cursor-pointer"
            />
            <button
              onClick={handleStatsImport}
              disabled={!statsFileRef || statsImporting}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold rounded-lg text-sm transition"
            >
              {statsImporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              Import Stats CSV
            </button>
          </div>
          <p className="text-[10px] text-gray-600">
            Required columns: player_name, match_date, team, opponent, venue, disposals, marks, tackles, goals, hitouts.
            Uses upsert by player_id + match_id (or player_id + match_date fallback). Deduplicates existing rows.
          </p>

          {/* Import Results */}
          {statsImportResult && (
            <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-3 space-y-2 text-xs">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div><span className="text-gray-500">Total Rows:</span> <span className="text-white font-bold">{statsImportResult.totalRows}</span></div>
                <div><span className="text-gray-500">Inserted:</span> <span className="text-emerald-400 font-bold">{statsImportResult.inserted}</span></div>
                <div><span className="text-gray-500">Updated:</span> <span className="text-blue-400 font-bold">{statsImportResult.updated}</span></div>
                <div><span className="text-gray-500">Skipped:</span> <span className="text-amber-400 font-bold">{statsImportResult.skipped}</span></div>
                <div><span className="text-gray-500">Duplicates:</span> <span className="text-amber-400 font-bold">{statsImportResult.duplicates}</span></div>
                <div><span className="text-gray-500">Failed:</span> <span className="text-red-400 font-bold">{statsImportResult.failedRows}</span></div>
                <div><span className="text-gray-500">Latest Round:</span> <span className="text-white font-bold">{statsImportResult.latestRoundImported ?? '—'}</span></div>
              </div>
              {statsImportResult.errors.length > 0 && (
                <details>
                  <summary className="cursor-pointer text-red-400">View errors ({statsImportResult.errors.length})</summary>
                  <div className="max-h-32 overflow-y-auto mt-1 space-y-0.5">
                    {statsImportResult.errors.slice(0, 50).map((e, i) => (
                      <p key={i} className="text-red-400 text-[10px]">Row {e.row}: {e.message}</p>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}
        </div>
      </div>
      {oddsApiCredits != null && oddsApiCredits < 450 && (
        <div className={`flex items-start gap-3 p-4 rounded-xl border ${
          oddsApiCredits <= 50
            ? 'bg-red-500/10 border-red-500/30'
            : oddsApiCredits <= 150
            ? 'bg-amber-500/10 border-amber-500/30'
            : 'bg-blue-500/10 border-blue-500/30'
        }`}>
          <ShieldAlert className={`w-5 h-5 shrink-0 ${
            oddsApiCredits <= 50 ? 'text-red-400' : oddsApiCredits <= 150 ? 'text-amber-400' : 'text-blue-400'
          }`} />
          <div className="flex-1 text-sm">
            <p className={`font-semibold ${
              oddsApiCredits <= 50 ? 'text-red-300' : oddsApiCredits <= 150 ? 'text-amber-300' : 'text-blue-300'
            }`}>
              API Credit Budget: {oddsApiCredits} of 500 remaining this month
            </p>
            <p className="text-gray-400 mt-1 text-xs">
              The Odds API credits are limited. Use <strong>Force Refresh</strong> only when lines are stale or missing.
              The normal Sync button respects cache and avoids unnecessary API calls.
            </p>
          </div>
        </div>
      )}

      {/* DFS Australia Role Data (CBA / Kick-In) Import */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-3">
        <div>
          <h3 className="text-white font-semibold text-sm">DFS Australia CSV Import — CBA / Kick-In Data</h3>
          <p className="text-xs text-gray-500 mt-1">
            Upload the official DFS Australia player-game CSV to populate genuine centre-bounce attendance
            and kick-in evidence for Player Intelligence. Never estimated from disposals or kicks — rows that
            can't be resolved to a real player and match are rejected, not guessed.
          </p>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <input
            type="file"
            accept=".csv"
            onChange={handleDfsFile}
            className="text-xs text-gray-400 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-gray-700 file:text-gray-300 hover:file:bg-gray-600 file:cursor-pointer"
          />
          <button
            onClick={handleDfsDryRun}
            disabled={!dfsFileRef || dfsDryRunning}
            className="flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold rounded-lg text-sm transition"
          >
            {dfsDryRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />}
            Dry Run
          </button>
          <button
            onClick={handleDfsImport}
            disabled={!dfsFileRef || dfsImporting}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold rounded-lg text-sm transition"
          >
            {dfsImporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            Import Valid Rows
          </button>
          <button
            onClick={handleRefreshPlayerIntelligence}
            className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white font-semibold rounded-lg text-sm transition"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh Player Intelligence
          </button>
        </div>
        {dfsRefreshMsg && <p className="text-xs text-cyan-400">{dfsRefreshMsg}</p>}
        {dfsError && <p className="text-xs text-red-400">{dfsError}</p>}

        {dfsDryRunResult && (
          <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-3 space-y-2 text-xs">
            <p className="text-white font-medium">Dry Run Results:</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div><span className="text-gray-500">Total Rows:</span> <span className="text-white font-bold">{dfsDryRunResult.report.totalRows}</span></div>
              <div><span className="text-gray-500">Rows w/ CBA:</span> <span className="text-white font-bold">{dfsDryRunResult.report.rowsWithCba}</span></div>
              <div><span className="text-gray-500">Rows w/ Kick-Ins:</span> <span className="text-white font-bold">{dfsDryRunResult.report.rowsWithKickIns}</span></div>
              <div><span className="text-gray-500">Players Resolved:</span> <span className="text-emerald-400 font-bold">{dfsDryRunResult.report.playersResolved}</span></div>
              <div><span className="text-gray-500">Matches Resolved:</span> <span className="text-emerald-400 font-bold">{dfsDryRunResult.report.matchesResolved}</span></div>
              <div><span className="text-gray-500">Ready to Import:</span> <span className="text-emerald-400 font-bold">{dfsDryRunResult.report.readyToImport}</span></div>
              <div><span className="text-gray-500">Rejected:</span> <span className="text-amber-400 font-bold">{dfsDryRunResult.report.rejectedCount}</span></div>
              <div><span className="text-gray-500">Round Range:</span> <span className="text-white font-bold">{dfsDryRunResult.report.earliestRound}–{dfsDryRunResult.report.latestRound}</span></div>
            </div>
            {Object.keys(dfsDryRunResult.report.rejectionReasons).length > 0 && (
              <div>
                <p className="text-gray-500 mb-1">Rejection reasons:</p>
                <div className="space-y-0.5">
                  {Object.entries(dfsDryRunResult.report.rejectionReasons).sort((a, b) => b[1] - a[1]).map(([reason, count]) => (
                    <div key={reason} className="flex justify-between text-amber-400">
                      <span className="truncate pr-2">{reason}</span>
                      <span className="shrink-0">{count}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {dfsDryRunResult.rejected.length > 0 && (
              <details>
                <summary className="cursor-pointer text-red-400">View rejected rows ({dfsDryRunResult.rejected.length})</summary>
                <div className="max-h-40 overflow-y-auto mt-1 space-y-0.5">
                  {dfsDryRunResult.rejected.slice(0, 100).map((r, i) => (
                    <p key={i} className="text-red-400 text-[10px]">
                      R{r.row.round} {r.row.player} ({r.row.teamCode} vs {r.row.opponentCode}): {r.reason}
                    </p>
                  ))}
                  {dfsDryRunResult.rejected.length > 100 && <p className="text-gray-600 text-[10px]">...and {dfsDryRunResult.rejected.length - 100} more</p>}
                </div>
              </details>
            )}
          </div>
        )}

        {dfsImportResult && (
          <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-3 space-y-2 text-xs">
            <p className="text-white font-medium">Import Results:</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div><span className="text-gray-500">Total Rows:</span> <span className="text-white font-bold">{dfsImportResult.totalRows}</span></div>
              <div><span className="text-gray-500">Inserted:</span> <span className="text-emerald-400 font-bold">{dfsImportResult.inserted}</span></div>
              <div><span className="text-gray-500">Updated:</span> <span className="text-blue-400 font-bold">{dfsImportResult.updated}</span></div>
              <div><span className="text-gray-500">Rejected:</span> <span className="text-amber-400 font-bold">{dfsImportResult.rejectedCount}</span></div>
              <div><span className="text-gray-500">Latest Round:</span> <span className="text-white font-bold">{dfsImportResult.latestRound || '—'}</span></div>
            </div>
          </div>
        )}

        <p className="text-[10px] text-gray-600">
          Expected headers: player, team, opponent, year, round, ..., cbas, kickins, kickinsPlayon, tog.
          Upserts by player_id + match_id into player_role_data; source recorded as "DFS Australia".
          Blank cells are stored as null, never zero. Round 0 (pre-season) is excluded.
        </p>
      </div>

      {/* Match Odds Sync Section */}
      <div className="bg-gradient-to-r from-blue-500/10 to-cyan-500/10 border border-blue-500/30 rounded-xl p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-2">
              <BarChart3 className="w-5 h-5 text-blue-400" />
              <h3 className="text-white font-semibold">Match Odds Sync (h2h, spreads, totals)</h3>
              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-700 border border-gray-600 text-gray-400">Optional</span>
            </div>
            <div className="flex flex-wrap items-center gap-3 mb-3">
              <span className="text-xs text-gray-500">Last synced: <span className="text-gray-400">{lastOddsSyncAge}</span></span>
              {oddsApiCredits != null && (
                <span className={`text-xs px-2 py-0.5 rounded-full border ${
                  oddsApiCredits > 100 ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                  : oddsApiCredits > 20  ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                  : 'bg-red-500/10 border-red-500/30 text-red-400'
                }`}>
                  {oddsApiCredits} API credits left
                </span>
              )}
            </div>
            <p className="text-gray-400 text-sm mb-1">
              Fetches match-level odds (head-to-head, spreads, totals) from The Odds API for upcoming AFL games.
            </p>
            <p className="text-gray-600 text-xs">
              <strong>Note:</strong> Match odds are <span className="text-amber-400">optional</span> for player prop EV analysis.
              Player prop odds come from Player Props Sync below.
            </p>
          </div>
          <div className="flex flex-col gap-2 shrink-0">
            <button
              onClick={() => handleOddsSync(false)}
              disabled={oddsSyncing}
              className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold rounded-lg text-sm transition"
            >
              {oddsSyncing ? (
                <><RefreshCw className="w-4 h-4 animate-spin" /> Syncing...</>
              ) : (
                <><RefreshCw className="w-4 h-4" /> Sync Match Odds</>
              )}
            </button>
            <div className="flex gap-2">
              <button
                onClick={() => runDryRun('match-odds')}
                disabled={dryRunning}
                className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-gray-400 rounded-lg text-xs transition"
                title="Check cache status without API call"
              >
                <Eye className="w-3 h-3" /> Dry Run
              </button>
              <button
                onClick={() => confirmForceRefresh('match-odds')}
                disabled={oddsSyncing}
                className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 bg-red-900/30 hover:bg-red-800/40 disabled:opacity-40 text-red-400 rounded-lg text-xs transition border border-red-800/30"
                title="Bypass 6-hour cache and call API now (uses 1 credit)"
              >
                <Zap className="w-3 h-3" /> Force
              </button>
            </div>
          </div>
        </div>

        {dryRunResult && dryRunResult.type === 'match-odds' && (
          <div className="mt-4 rounded-lg px-4 py-3 text-sm border bg-gray-800/60 border-gray-700/40">
            <p className="text-gray-300 font-medium flex items-center gap-2">
              <Eye className="w-4 h-4 text-gray-400" />
              Dry Run Result: Match Odds Cache
            </p>
            <div className="mt-2 flex flex-wrap gap-4 text-xs text-gray-400">
              <span>Last sync: <strong className="text-gray-300">{dryRunResult.lastSync ? formatSyncAge(dryRunResult.lastSync) : 'Never'}</strong></span>
              <span>Cache status: <strong className={dryRunResult.stale ? 'text-amber-400' : 'text-emerald-400'}>{dryRunResult.stale ? 'Stale (older than 6h)' : 'Fresh'}</strong></span>
            </div>
            <p className="mt-2 text-xs text-gray-500">
              {dryRunResult.stale
                ? 'Cache is stale. Force Refresh will call the API (uses 1 credit).'
                : 'Cache is fresh. Normal Sync will use cache. Force Refresh will waste a credit.'}
            </p>
          </div>
        )}

        {oddsSyncResult && (
          <div className={`mt-4 rounded-lg px-4 py-3 text-sm border ${
            oddsSyncResult.error
              ? 'bg-red-500/10 border-red-500/30 text-red-400'
              : oddsSyncResult.cached
              ? 'bg-gray-800/60 border-gray-700/40 text-gray-400'
              : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
          }`}>
            {oddsSyncResult.error ? (
              <p className="font-medium">
                {oddsSyncResult.code === 'MISSING_ODDS_API_KEY'
                  ? 'ODDS_API_KEY not configured — add it in Supabase Dashboard → Project Settings → Edge Functions → Secrets.'
                  : oddsSyncResult.error}
              </p>
            ) : oddsSyncResult.cached ? (
              <p>Cache hit — data is fresh (last fetch: {formatSyncAge(oddsSyncResult.synced_at)}). No API call was made.</p>
            ) : (
              <div className="flex flex-wrap gap-4">
                <span>Inserted: <strong>{oddsSyncResult.inserted}</strong></span>
                <span>Skipped: <strong>{oddsSyncResult.skipped}</strong></span>
                {oddsSyncResult.requests_remaining != null && (
                  <span className="text-gray-400">Credits remaining: {oddsSyncResult.requests_remaining}</span>
                )}
                {(oddsSyncResult.errors?.length ?? 0) > 0 && (
                  <span className="text-amber-400">{oddsSyncResult.errors.length} unresolved rows (see console)</span>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Player Props Live Sync — The Odds API */}
      <div className="bg-gradient-to-r from-emerald-500/10 to-teal-500/10 border border-emerald-500/30 rounded-xl p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-2">
              <TrendingUp className="w-5 h-5 text-emerald-400" />
              <h3 className="text-white font-semibold">Player Prop Odds Sync (Live API)</h3>
              <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-emerald-300">NEW</span>
            </div>
            <div className="flex flex-wrap items-center gap-3 mb-3">
              <span className="text-xs text-gray-500">Last synced: <span className="text-gray-400">{propsLastSyncAge}</span></span>
              {oddsApiCredits != null && (
                <span className={`text-xs px-2 py-0.5 rounded-full border ${
                  oddsApiCredits > 100 ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                  : oddsApiCredits > 20  ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                  : 'bg-red-500/10 border-red-500/30 text-red-400'
                }`}>
                  {oddsApiCredits} API credits left
                </span>
              )}
            </div>
            <p className="text-gray-400 text-sm mb-1">
              Fetches AFL player prop ladders (21+, 22+, 23+...) from Sportsbet via The Odds API.
            </p>
            <p className="text-gray-600 text-xs">
              Markets: player_disposals_over, player_marks_over, player_tackles_over, player_goals_scored_over.
            </p>
          </div>
          <div className="flex flex-col gap-2 shrink-0">
            <button
              onClick={() => handlePropsSync(false)}
              disabled={propsSyncing}
              className="flex items-center gap-2 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold rounded-lg text-sm transition"
            >
              {propsSyncing ? (
                <><RefreshCw className="w-4 h-4 animate-spin" /> Syncing Props...</>
              ) : (
                <><RefreshCw className="w-4 h-4" /> Sync Player Props</>
              )}
            </button>
            <div className="flex gap-2">
              <button
                onClick={() => runDryRun('player-props')}
                disabled={dryRunning}
                className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-gray-400 rounded-lg text-xs transition"
                title="Check database coverage without API call"
              >
                <Eye className="w-3 h-3" /> Dry Run
              </button>
              <button
                onClick={() => confirmForceRefresh('player-props')}
                disabled={propsSyncing}
                className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 bg-red-900/30 hover:bg-red-800/40 disabled:opacity-40 text-red-400 rounded-lg text-xs transition border border-red-800/30"
                title="Bypass 1-hour cache and call API now (uses 1-4 credits)"
              >
                <Zap className="w-3 h-3" /> Force
              </button>
            </div>
          </div>
        </div>

        {dryRunResult && dryRunResult.type === 'player-props' && (
          <div className="mt-4 rounded-lg px-4 py-3 text-sm border bg-gray-800/60 border-gray-700/40">
            <p className="text-gray-300 font-medium flex items-center gap-2">
              <Eye className="w-4 h-4 text-gray-400" />
              Dry Run Result: Player Props Coverage
            </p>
            <div className="mt-2 flex flex-wrap gap-4 text-xs text-gray-400">
              <span>Rows in bookmaker_odds: <strong className="text-gray-300">{dryRunResult.existing}</strong></span>
              <span>Last sync: <strong className="text-gray-300">{dryRunResult.lastSync ? formatSyncAge(dryRunResult.lastSync) : 'Never'}</strong></span>
              <span>Cache status: <strong className={dryRunResult.stale ? 'text-amber-400' : 'text-emerald-400'}>{dryRunResult.stale ? 'Stale (older than 1h)' : 'Fresh'}</strong></span>
            </div>
            <p className="mt-2 text-xs text-gray-500">
              {dryRunResult.stale
                ? 'Cache is stale. Force Refresh will fetch fresh odds (uses 1-4 credits).'
                : 'Cache is fresh. Normal Sync will use cache. Force Refresh will waste credits.'}
            </p>
          </div>
        )}

        {propsSyncResult && (
          <div className={`mt-4 rounded-lg px-4 py-3 text-sm border ${
            !propsSyncResult.success && propsSyncResult.errors.length > 0
              ? 'bg-red-500/10 border-red-500/30 text-red-400'
              : propsSyncResult.cached
              ? 'bg-gray-800/60 border-gray-700/40 text-gray-400'
              : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
          }`}>
            {propsSyncResult.cached ? (
              <p>Cache hit — data is fresh (last fetch: {propsLastSyncAge}). No API call made.</p>
            ) : (
              <div className="space-y-3">
                {/* Summary stats */}
                <div className="flex flex-wrap gap-4 text-sm">
                  <span>Events: <strong>{propsSyncResult.events_fetched ?? 0}</strong></span>
                  <span>Matched: <strong className="text-emerald-300">{propsSyncResult.events_matched ?? 0}</strong></span>
                  <span>Fixtures updated: <strong>{propsSyncResult.fixtures_updated ?? 0}</strong></span>
                  <span>Fixtures created: <strong className="text-blue-300">{propsSyncResult.fixtures_created ?? 0}</strong></span>
                  <span>Players: <strong>{propsSyncResult.players_found ?? 0}</strong></span>
                  <span>Rows: <strong className="text-emerald-300">{propsSyncResult.rows_inserted ?? 0}</strong></span>
                  {propsSyncResult.requests_remaining != null && (
                    <span className="text-gray-400">API credits: {propsSyncResult.requests_remaining}</span>
                  )}
                </div>

                {/* Sample rows */}
                {(propsSyncResult.sample_rows?.length ?? 0) > 0 && (
                  <div className="text-xs">
                    <p className="text-gray-400 mb-1">Sample player ladders (Sportsbet):</p>
                    <div className="bg-gray-800/50 rounded p-2 max-h-32 overflow-y-auto">
                      {propsSyncResult.sample_rows?.slice(0, 8).map((row, i) => (
                        <div key={i} className="font-mono text-gray-300">
                          {row.player_name} | {row.market} | {row.display_label} | {row.odds}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Debug log */}
                {(propsSyncResult.debug_log?.length ?? 0) > 0 && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-gray-400 hover:text-white">Debug log ({propsSyncResult.debug_log?.length} entries)</summary>
                    <div className="mt-2 max-h-48 overflow-y-auto bg-gray-800/50 p-2 rounded font-mono text-gray-400">
                      {propsSyncResult.debug_log?.map((line, i) => (
                        <div key={i} className={line.includes('ERROR') || line.includes('FATAL') ? 'text-red-400' : line.includes('Matched') ? 'text-emerald-400' : ''}>{line}</div>
                      ))}
                    </div>
                  </details>
                )}

                {propsSyncResult.errors.length > 0 && (
                  <p className="text-xs text-red-400">{propsSyncResult.errors.length} error(s)</p>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Divider */}
      <div className="flex items-center gap-4">
        <div className="flex-1 h-px bg-gray-800" />
        <span className="text-xs text-gray-600 uppercase tracking-wider">Player Props Ingestion</span>
        <div className="flex-1 h-px bg-gray-800" />
      </div>

      {/* Bookmaker Odds Ingest Panel */}
      <div className="bg-gradient-to-r from-emerald-500/10 to-cyan-500/10 border border-emerald-500/30 rounded-xl p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-2">
              <TrendingUp className="w-5 h-5 text-emerald-400" />
              <h3 className="text-white font-semibold">Bookmaker Player Props</h3>
              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-700 border border-gray-600 text-gray-400">{bookmakerFeeds.length} configured</span>
            </div>
            <p className="text-gray-400 text-sm mb-1">
              Player prop odds (disposals, goals, tackles, marks, hitouts) from licensed bookmaker feeds.
            </p>
            <p className="text-gray-600 text-xs mb-3">
              Raw bookmaker odds only — no EV, no implied probability, no model projections.
            </p>
          </div>
          <Link
            to="/props-analyzer"
            className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs rounded-lg transition-colors"
          >
            View Analyzer
          </Link>
        </div>

        {/* Bookmaker Status Grid */}
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-2">
          {bookmakerFeeds.map(feed => (
            <div key={feed.bookmaker_id} className="bg-gray-800/50 border border-gray-700/50 rounded-lg px-3 py-2">
              <div className="flex items-center justify-between">
                <span className="text-white text-xs font-medium capitalize">{feed.name}</span>
                {feed.last_fetch_at ? (
                  <Clock className="w-3 h-3 text-gray-500" />
                ) : (
                  <span className="text-xs text-gray-600">—</span>
                )}
              </div>
              <div className="text-xs text-gray-500 mt-0.5">
                {feed.last_fetch_at ? formatSyncAge(feed.last_fetch_at) : 'Never'}
              </div>
            </div>
          ))}
        </div>

        <p className="mt-4 text-xs text-gray-500">
          Bookmaker odds require API integration or CSV import. Use the player-props-ingest endpoint for live data ingestion.
        </p>

        {/* API Endpoint Info */}
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-gray-400 hover:text-white">API Ingestion Endpoint</summary>
          <div className="mt-2 p-3 bg-gray-800 rounded-lg text-xs font-mono">
            <p className="text-gray-400 mb-2">POST to /functions/v1/player-props-ingest</p>
            <pre className="text-gray-300 overflow-x-auto">{`{
  "player_name": "Isaac Heeney",
  "team": "Sydney",
  "match_date": "2026-07-12",
  "market": "disposals",
  "line": 25,
  "side": "Over",
  "odds": 1.35,
  "bookmaker": "Sportsbet"
}`}</pre>
            <p className="text-gray-500 mt-2">Each ladder threshold (21+, 22+, 23+...) is a separate row.</p>
          </div>
        </details>
      </div>

      {/* Divider */}
      <div className="flex items-center gap-4">
        <div className="flex-1 h-px bg-gray-800" />
        <span className="text-xs text-gray-600 uppercase tracking-wider">Manual CSV Import (Fallback)</span>
        <div className="flex-1 h-px bg-gray-800" />
      </div>

      {/* Manual Import Sections */}
      <div className="flex items-start gap-3 p-4 bg-amber-500/10 border border-amber-500/30 rounded-xl">
        <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
        <div className="text-sm text-amber-300">
          <p className="font-medium mb-1">CSV import is for manual corrections</p>
          <p className="text-amber-400/70">All AFL data (players, matches, stats) is already stored in the database. Use CSV import for manual corrections or supplementary data only.</p>
        </div>
      </div>

      <ImportSection
        target="players"
        title="Import Players"
        description="Manually add players via CSV."
      />
      <ImportSection
        target="matches"
        title="Import Matches"
        description="Manually add match records."
      />
      <ImportSection
        target="player_game_stats"
        title="Import Player Game Stats"
        description="Manually add per-game performance data."
        note="Player names must match exactly."
      />
      <ImportSection
        target="fixtures"
        title="Import Fixtures (Upcoming Matches)"
        description="Import AFL fixtures for current and upcoming rounds. Required before odds can appear in Props Analyzer."
        note="Columns: season, round, home_team, away_team, venue, match_date, api_match_id. Future fixtures must exist before odds can appear."
      />
      <ImportSection
        target="player_prop_odds"
        title="Import Player Prop Ladder (CSV)"
        description="Import Sportsbet-style alternate ladders (21+, 22+, 23+...) via CSV. Each threshold = 1 row."
        note="Format: player_name, team, match_date, market, line, over_odds, bookmaker. For ladders use integer lines (21, 22, 23) — stored with display_label '21+'. Data imports to bookmaker_odds table."
      />

      {/* Force Refresh Confirmation Modal */}
      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="bg-gray-900 border border-red-800/50 rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-red-500/20 rounded-lg flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <h3 className="text-white font-semibold">Force Refresh?</h3>
                <p className="text-gray-400 text-xs mt-0.5">This will call The Odds API and consume credits</p>
              </div>
            </div>

            <div className="bg-gray-800/60 rounded-lg p-4 mb-4 space-y-2 text-sm">
              {showConfirm === 'match-odds' && (
                <>
                  <p className="text-gray-300">Force refresh will bypass the 6-hour cache and fetch fresh match odds.</p>
                  <p className="text-amber-400 font-medium">Estimated cost: 1 API credit</p>
                  <p className="text-gray-500 text-xs mt-2">Match odds are optional for player prop EV analysis.</p>
                </>
              )}
              {showConfirm === 'player-props' && (
                <>
                  <p className="text-gray-300">Force refresh will bypass the 1-hour cache and fetch fresh player prop ladders.</p>
                  <p className="text-amber-400 font-medium">Estimated cost: 1-4 API credits (depends on number of events)</p>
                  <p className="text-gray-500 text-xs mt-2">Player props are required for EV Calculator and Multi Builder.</p>
                </>
              )}
              {oddsApiCredits != null && (
                <p className={`text-xs ${oddsApiCredits <= 50 ? 'text-red-400' : oddsApiCredits <= 150 ? 'text-amber-400' : 'text-gray-400'}`}>
                  Current credits remaining: <strong>{oddsApiCredits}</strong> of 500 monthly
                </p>
              )}
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setShowConfirm(null)}
                className="flex-1 py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg text-sm font-medium transition"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmedSync}
                className="flex-1 py-2.5 bg-red-600 hover:bg-red-500 text-white rounded-lg text-sm font-semibold transition"
              >
                Confirm Force Refresh
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
