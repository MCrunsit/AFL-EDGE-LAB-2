/**
 * DFS Australia CSV importer — genuine CBA, kick-in and time-on-ground data
 * into player_role_data.
 *
 * Reuses existing verified normalization (playerMatching.ts) rather than
 * reinventing player/team resolution. Never merges same-name players across
 * teams, never treats a blank CSV cell as zero, never derives CBA from
 * disposals or kick-ins from kicks.
 */
import { supabase } from './supabase';
import {
  normalizePlayerName, normalizeTeamToCanonical, buildPlayerMatchCache,
  type PlayerMatchCache,
} from './playerMatching';

// ── DFS Australia's 3-letter team codes -> canonical AFL team name ─────────
// None of the project's existing normalizers (teamNormalizer.ts,
// positionEdge.ts, playerMatching.ts) cover this exact code set — verified by
// direct lookup (ADE/BRL/CAR/PTA are missing from all three). Defined here,
// scoped to this importer only, rather than patching shared normalizers for
// a single CSV vendor's convention.
const DFS_TEAM_CODE_MAP: Record<string, string> = {
  ADE: 'Adelaide', BRL: 'Brisbane', CAR: 'Carlton', COL: 'Collingwood',
  ESS: 'Essendon', FRE: 'Fremantle', GCS: 'Gold Coast', GEE: 'Geelong',
  GWS: 'GWS', HAW: 'Hawthorn', MEL: 'Melbourne', NTH: 'North Melbourne',
  PTA: 'Port Adelaide', RIC: 'Richmond', STK: 'St Kilda', SYD: 'Sydney',
  WBD: 'Western Bulldogs', WCE: 'West Coast',
};

function resolveDfsTeamCode(code: string): string | null {
  return DFS_TEAM_CODE_MAP[code?.toUpperCase().trim()] ?? null;
}

export interface DfsRawRow {
  player: string;
  teamCode: string;
  opponentCode: string;
  year: number;
  round: string;
  cbas: number | null;
  kickins: number | null;
  kickinsPlayon: number | null;
  tog: number | null;
}

function numOrNull(s: string | undefined): number | null {
  if (s === undefined || s === null || s.trim() === '') return null;
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

/** Splits one CSV line, honouring simple double-quoted fields. Real AFL player
 * names/stats in this export don't need it, but it's a cheap safeguard. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQuotes = !inQuotes; continue; }
    if (c === ',' && !inQuotes) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

export interface DfsParseResult {
  rows: DfsRawRow[];
  headers: string[];
  parseErrors: string[];
}

/** DFS Australia's export has 2-3 leading attribution/blank lines before the
 * real header — find it by content, never assume a fixed line count. */
export function parseDfsAustraliaCsv(text: string): DfsParseResult {
  const lines = text.split(/\r?\n/);
  const headerIdx = lines.findIndex(l => l.trim().toLowerCase().startsWith('player,team,opponent'));
  if (headerIdx === -1) {
    return { rows: [], headers: [], parseErrors: ['Could not find a header row starting with "player,team,opponent" — is this a genuine DFS Australia export?'] };
  }
  const headers = splitCsvLine(lines[headerIdx]).map(h => h.trim());
  const idx = (name: string) => headers.indexOf(name);
  const iPlayer = idx('player'), iTeam = idx('team'), iOpp = idx('opponent'), iYear = idx('year'), iRound = idx('round');
  const iCba = idx('cbas'), iKickins = idx('kickins'), iKickinsPlayon = idx('kickinsPlayon'), iTog = idx('tog');

  const rows: DfsRawRow[] = [];
  const parseErrors: string[] = [];

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const vals = splitCsvLine(line);
    if (vals.length < headers.length) {
      parseErrors.push(`Line ${i + 1}: expected ${headers.length} fields, got ${vals.length} — skipped`);
      continue;
    }
    rows.push({
      player: (vals[iPlayer] ?? '').trim(),
      teamCode: (vals[iTeam] ?? '').trim(),
      opponentCode: (vals[iOpp] ?? '').trim(),
      year: Number(vals[iYear]),
      round: (vals[iRound] ?? '').trim(),
      cbas: numOrNull(vals[iCba]),
      kickins: numOrNull(vals[iKickins]),
      kickinsPlayon: numOrNull(vals[iKickinsPlayon]),
      tog: numOrNull(vals[iTog]),
    });
  }

  return { rows, headers, parseErrors };
}

// ── Strict, team-aware player resolution ────────────────────────────────
// ── Common given-name/nickname equivalence groups ──────────────────────
// DFS Australia and the existing players table disagree on which form they
// store (e.g. CSV "Cam Rayner" vs DB "Cameron Rayner"; CSV "Thomas Edwards"
// vs DB "Tom Edwards" — the mismatch runs in both directions). This is a
// finite, deterministic dictionary of full-name equivalence, not fuzzy
// matching — every group member must still resolve via the same exact
// normalized-name + canonical-team check as a direct match. Never used to
// match on surname alone.
const NICKNAME_GROUPS: string[][] = [
  ['cam', 'cameron'], ['chris', 'christopher'], ['dan', 'daniel'], ['harry', 'harrison'],
  ['jack', 'jackson'], ['jay', 'james'], ['joe', 'joseph'], ['josh', 'joshua'],
  ['lachie', 'lachlan'], ['leo', 'leonardo'], ['matt', 'matthew'], ['mitch', 'mitchell'],
  ['nick', 'nicholas'], ['nik', 'nikolas'], ['oliver', 'ollie'], ['sam', 'samuel'],
  ['thomas', 'tom'], ['tim', 'timothy'], ['will', 'william'], ['zac', 'zachary'],
  ['zach', 'zachary'], ['brad', 'bradley'], ['ben', 'benjamin'], ['alex', 'alexander'],
  ['andy', 'andrew'], ['rob', 'robert'], ['nathan', 'nate'], ['mick', 'michael'],
];
const firstNameToGroup = new Map<string, string[]>();
for (const group of NICKNAME_GROUPS) for (const n of group) firstNameToGroup.set(n, group);

// A small number of registered-name irregularities that don't fit a general
// pattern — verified against the live players table, not guessed.
const SPECIFIC_NAME_OVERRIDES: Record<string, string> = {
  'mitch owens': 'mitchito owens',
  'archer may': 'archie may',
};

/** Generates alternate normalized-name candidates for a CSV player name:
 * the direct normalized form, a specific override if one exists, first-name
 * nickname-family swaps, and a middle-initial-stripped variant (for names
 * like "Bailey J. Williams"). Every candidate still goes through the same
 * strict per-team lookup — this only widens which exact full name we try. */
function nameVariants(name: string): string[] {
  const variants = new Set<string>();
  const direct = normalizePlayerName(name);
  if (direct) variants.add(direct);

  const override = SPECIFIC_NAME_OVERRIDES[direct];
  if (override) variants.add(override);

  const tokens = direct.split(' ').filter(Boolean);
  if (tokens.length >= 2) {
    // Strip single-letter middle tokens (e.g. "bailey j williams" -> "bailey williams")
    const stripped = [tokens[0], ...tokens.slice(1, -1).filter(t => t.length > 1), tokens[tokens.length - 1]].join(' ');
    if (stripped) variants.add(stripped);

    // Swap the first token for every name in its nickname family, on both the
    // direct and middle-initial-stripped token lists.
    for (const tokenList of [tokens, stripped.split(' ')]) {
      const [first, ...rest] = tokenList;
      const family = firstNameToGroup.get(first);
      if (family) {
        for (const alt of family) {
          if (alt !== first) variants.add([alt, ...rest].join(' '));
        }
      }
    }
  }

  return [...variants];
}

function resolvePlayerStrict(
  name: string, canonicalTeam: string, cache: PlayerMatchCache,
): { playerId: string } | { reason: string } {
  const direct = normalizePlayerName(name);
  if (!direct) return { reason: 'Empty player name' };

  let anyCandidatesSeen = false;
  for (const variant of nameVariants(name)) {
    const candidates = cache.allCandidatesByName.get(variant) ?? [];
    if (candidates.length === 0) continue;
    anyCandidatesSeen = true;
    const teamMatches = candidates.filter(c => normalizeTeamToCanonical(c.team ?? '') === canonicalTeam);
    if (teamMatches.length === 1 && teamMatches[0].player_id) {
      return { playerId: teamMatches[0].player_id };
    }
    if (teamMatches.length > 1) {
      return { reason: `Ambiguous: multiple players named "${name}" resolve to team ${canonicalTeam}` };
    }
  }

  if (!anyCandidatesSeen) return { reason: `No player found matching name "${name}"` };

  const allCandidates = nameVariants(name).flatMap(v => cache.allCandidatesByName.get(v) ?? []);
  const otherTeams = [...new Set(allCandidates.map(c => normalizeTeamToCanonical(c.team ?? '') || 'unknown'))].join(', ');
  return { reason: `Player "${name}" found but not on team ${canonicalTeam} (found on: ${otherTeams})` };
}

// ── Strict match resolution: season + round + both team names ──────────
interface MatchIndexEntry { matchId: string; homeCanonical: string; awayCanonical: string }

async function buildMatchIndex(season: number): Promise<Map<string, MatchIndexEntry[]>> {
  const { data, error } = await supabase
    .from('matches')
    .select('id, round, home_team, away_team')
    .eq('season', season);
  if (error) throw new Error(`Failed to load matches: ${error.message}`);

  const map = new Map<string, MatchIndexEntry[]>();
  for (const m of data ?? []) {
    const key = String(m.round);
    const entry: MatchIndexEntry = {
      matchId: m.id,
      homeCanonical: normalizeTeamToCanonical(m.home_team),
      awayCanonical: normalizeTeamToCanonical(m.away_team),
    };
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(entry);
  }
  return map;
}

function resolveMatchStrict(
  round: string, teamA: string, teamB: string, index: Map<string, MatchIndexEntry[]>,
): { matchId: string } | { reason: string } {
  const candidates = index.get(round) ?? [];
  const matches = candidates.filter(c =>
    (c.homeCanonical === teamA && c.awayCanonical === teamB) ||
    (c.homeCanonical === teamB && c.awayCanonical === teamA)
  );
  if (matches.length === 0) return { reason: `No match found for round ${round}: ${teamA} vs ${teamB}` };
  if (matches.length > 1) return { reason: `Ambiguous: multiple matches found for round ${round}: ${teamA} vs ${teamB}` };
  return { matchId: matches[0].matchId };
}

// ── Team-level CBA/kick-in totals (same aggregation approach as
// teamStatsService.ts's complete-match team totals — sum genuine player
// rows for that team+round, never estimated) ────────────────────────────
function buildTeamAggregates(rows: DfsRawRow[]): Map<string, { cbaTotal: number; kickInTotal: number }> {
  const map = new Map<string, { cbaTotal: number; kickInTotal: number }>();
  for (const r of rows) {
    const key = `${r.teamCode}|${r.round}`;
    const agg = map.get(key) ?? { cbaTotal: 0, kickInTotal: 0 };
    agg.cbaTotal += r.cbas ?? 0;
    agg.kickInTotal += r.kickins ?? 0;
    map.set(key, agg);
  }
  return map;
}

export interface DfsResolvedRow {
  row: DfsRawRow;
  playerId: string;
  matchId: string;
  canonicalTeam: string;
  canonicalOpponent: string;
  cbaCount: number | null;
  teamCbaTotal: number | null;
  cbaPercentage: number | null;
  kickInCount: number | null;
  kickInPlayOnCount: number | null;
  kickInShare: number | null;
  timeOnGround: number | null;
}

export interface DfsRejectedRow {
  row: DfsRawRow;
  reason: string;
}

export interface DfsProcessReport {
  totalRows: number;
  rowsWithCba: number;
  rowsWithKickIns: number;
  playersResolved: number;
  matchesResolved: number;
  readyToImport: number;
  rejectedCount: number;
  rejectionReasons: Record<string, number>;
  earliestRound: string;
  latestRound: string;
  season: number | null;
}

export interface DfsProcessResult {
  resolved: DfsResolvedRow[];
  rejected: DfsRejectedRow[];
  report: DfsProcessReport;
}

/** Parses, resolves and validates every row — performs no database writes.
 * Used for both the dry run and as the first phase of the real import. */
export async function processDfsRows(csvText: string): Promise<DfsProcessResult> {
  const { rows, parseErrors } = parseDfsAustraliaCsv(csvText);

  const seasonValues = [...new Set(rows.map(r => r.year).filter(y => !Number.isNaN(y)))];
  const season = seasonValues.length === 1 ? seasonValues[0] : (seasonValues[0] ?? null);

  const [playerCache, matchIndex] = await Promise.all([
    buildPlayerMatchCache(),
    season != null ? buildMatchIndex(season) : Promise.resolve(new Map<string, MatchIndexEntry[]>()),
  ]);
  const teamAggs = buildTeamAggregates(rows);

  const resolved: DfsResolvedRow[] = [];
  const rejected: DfsRejectedRow[] = [];
  const rejectionReasons: Record<string, number> = {};

  const reject = (row: DfsRawRow, reason: string) => {
    rejected.push({ row, reason });
    rejectionReasons[reason] = (rejectionReasons[reason] ?? 0) + 1;
  };

  for (const err of parseErrors) reject({ player: '', teamCode: '', opponentCode: '', year: NaN, round: '', cbas: null, kickins: null, kickinsPlayon: null, tog: null }, err);

  for (const row of rows) {
    if (row.round === '0') { reject(row, 'Round 0 (pre-season) — excluded, consistent with the rest of the app'); continue; }
    if (!row.player) { reject(row, 'Missing player name'); continue; }

    const canonicalTeam = resolveDfsTeamCode(row.teamCode);
    const canonicalOpponent = resolveDfsTeamCode(row.opponentCode);
    if (!canonicalTeam) { reject(row, `Unrecognised team code "${row.teamCode}"`); continue; }
    if (!canonicalOpponent) { reject(row, `Unrecognised opponent code "${row.opponentCode}"`); continue; }

    const playerResult = resolvePlayerStrict(row.player, canonicalTeam, playerCache);
    if ('reason' in playerResult) { reject(row, playerResult.reason); continue; }

    const matchResult = resolveMatchStrict(row.round, canonicalTeam, canonicalOpponent, matchIndex);
    if ('reason' in matchResult) { reject(row, matchResult.reason); continue; }

    const agg = teamAggs.get(`${row.teamCode}|${row.round}`);
    const cbaPercentage = (row.cbas != null && agg && agg.cbaTotal > 0) ? row.cbas / agg.cbaTotal : null;
    const kickInShare = (row.kickins != null && agg && agg.kickInTotal > 0) ? row.kickins / agg.kickInTotal : null;

    resolved.push({
      row,
      playerId: playerResult.playerId,
      matchId: matchResult.matchId,
      canonicalTeam,
      canonicalOpponent,
      cbaCount: row.cbas,
      teamCbaTotal: agg ? agg.cbaTotal : null,
      cbaPercentage,
      kickInCount: row.kickins,
      kickInPlayOnCount: row.kickinsPlayon,
      kickInShare,
      timeOnGround: row.tog,
    });
  }

  const numericRounds = rows.map(r => Number(r.round)).filter(n => !Number.isNaN(n) && n > 0);
  const earliestRound = numericRounds.length ? String(Math.min(...numericRounds)) : '';
  const latestRound = numericRounds.length ? String(Math.max(...numericRounds)) : '';

  const report: DfsProcessReport = {
    totalRows: rows.length,
    rowsWithCba: rows.filter(r => r.cbas != null && r.cbas > 0).length,
    rowsWithKickIns: rows.filter(r => r.kickins != null && r.kickins > 0).length,
    playersResolved: new Set(resolved.map(r => r.playerId)).size,
    matchesResolved: new Set(resolved.map(r => r.matchId)).size,
    readyToImport: resolved.length,
    rejectedCount: rejected.length,
    rejectionReasons,
    earliestRound,
    latestRound,
    season,
  };

  return { resolved, rejected, report };
}

export interface DfsImportReport extends DfsProcessReport {
  inserted: number;
  updated: number;
}

/** Note: time_on_ground is parsed and reported, but NOT yet persisted —
 * player_role_data has no time_on_ground column, and this environment has no
 * DB-admin/migration-execution access to add one. The migration file is
 * checked in ready to apply; see docs note in the migration itself. */
export async function importDfsRows(csvText: string): Promise<DfsImportReport> {
  const { resolved, report } = await processDfsRows(csvText);

  const matchIds = [...new Set(resolved.map(r => r.matchId))];
  let existingByKey = new Map<string, any>();
  if (matchIds.length > 0) {
    const { data: existingRows, error } = await supabase
      .from('player_role_data')
      .select('*')
      .in('match_id', matchIds);
    if (error) throw new Error(`Failed to load existing player_role_data rows: ${error.message}`);
    existingByKey = new Map((existingRows ?? []).map(r => [`${r.player_id}|${r.match_id}`, r]));
  }

  const pick = (newVal: number | null, oldVal: number | null | undefined) => (newVal != null ? newVal : (oldVal ?? null));

  let inserted = 0;
  let updated = 0;
  const payload = resolved.map(r => {
    const key = `${r.playerId}|${r.matchId}`;
    const existing = existingByKey.get(key);
    if (existing) updated++; else inserted++;

    return {
      player_id: r.playerId,
      match_id: r.matchId,
      round: r.row.round,
      season: r.row.year,
      cba_percentage: pick(r.cbaPercentage, existing?.cba_percentage),
      cba_count: pick(r.cbaCount, existing?.cba_count),
      team_cba_total: pick(r.teamCbaTotal, existing?.team_cba_total),
      kick_in_count: pick(r.kickInCount, existing?.kick_in_count),
      kick_in_play_on_count: pick(r.kickInPlayOnCount, existing?.kick_in_play_on_count),
      kick_in_share: pick(r.kickInShare, existing?.kick_in_share),
      source: 'DFS Australia',
      updated_at: new Date().toISOString(),
    };
  });

  const batchSize = 200;
  for (let i = 0; i < payload.length; i += batchSize) {
    const batch = payload.slice(i, i + batchSize);
    const { error } = await supabase
      .from('player_role_data')
      .upsert(batch, { onConflict: 'player_id,match_id' });
    if (error) {
      if (error.code === '42501') {
        throw new Error(
          'Import blocked by database permissions: player_role_data only grants INSERT/UPDATE to the ' +
          '"authenticated" role, unlike every other writable table in this app. Apply migration ' +
          '20260722200000_add_time_on_ground_to_player_role_data.sql (via the Supabase SQL editor) to fix ' +
          'this, then retry.'
        );
      }
      throw new Error(`Import failed on batch starting row ${i}: ${error.message}`);
    }
  }

  return { ...report, inserted, updated };
}
