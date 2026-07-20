/**
 * LAYER 2 — Odds Normalizer (display transform only)
 *
 * Data source: bookmaker_odds table (3,143 rows, all upcoming matches)
 *
 * Field mapping from bookmaker_odds → NormalizedOddsRow:
 *   bookmaker_id          → bookmaker
 *   bookmaker_player_name → player_name
 *   raw_market            → raw_market (exact, never transformed)
 *   raw_line              → raw_line   (exact string)
 *   raw_api_response      → raw_payload
 *   market_type           → market_type ('ou_line' | 'alt_ladder')
 *   base_line             → base_line  (integer for alt_ladder)
 *   display_label         → display_label (e.g. "21+" for alt_ladder)
 *
 * Rules:
 *   - NEVER modifies raw_market or raw_line
 *   - NEVER collapses multiple lines into one
 *   - Only derives stat_type for UI grouping (regex, no data mutation)
 *   - market_type is read from DB; client-side classify() is a fallback
 *   - All rows preserved — no dedup, no filtering beyond match_id
 */

import { supabase } from './supabase';

export type MarketType = 'ou_line' | 'alt_ladder';

export interface RawOddsRow {
  id: string;
  match_id: string;
  player_name: string;
  player_id: string | null;
  bookmaker: string;
  raw_market: string;
  raw_line: string;
  line: number;
  over_odds: number;
  under_odds: number | null;
  fetched_at: string;
  raw_payload: Record<string, unknown> | null;
  market_type: MarketType;
  base_line: number | null;
  display_label: string | null;
}

export interface NormalizedOddsRow extends RawOddsRow {
  stat_type: string | null;
}

const STAT_PATTERNS: [RegExp, string][] = [
  [/disposal/i, 'disposals'],
  [/goal/i, 'goals'],
  [/tackle/i, 'tackles'],
  [/mark/i, 'marks'],
  [/hitout/i, 'hitouts'],
  [/kick/i, 'kicks'],
  [/handballs?/i, 'handballs'],
  [/clearance/i, 'clearances'],
  [/contested/i, 'contested'],
  [/intercept/i, 'intercepts'],
];

export function extractStatType(rawMarket: string): string | null {
  for (const [pattern, stat] of STAT_PATTERNS) {
    if (pattern.test(rawMarket)) return stat;
  }
  return null;
}

/**
 * Client-side fallback classification (used when DB market_type column is absent).
 *
 * RULE: integer line → alt_ladder (N+ market, any bookmaker)
 *       half-point line (.5) → ou_line
 *
 * This mirrors the DB migration logic exactly.
 */
function classifyMarketType(
  _bookmaker: string,
  _rawMarket: string,
  _rawLine: string,
  line: number
): { market_type: MarketType; base_line: number | null; display_label: string | null } {
  if (line === Math.floor(line)) {
    const base = Math.floor(line);
    return { market_type: 'alt_ladder', base_line: base, display_label: `${base}+` };
  }
  return { market_type: 'ou_line', base_line: null, display_label: null };
}

function mapBookmakerOddsRow(r: Record<string, unknown>): NormalizedOddsRow {
  const rawMarket = (r.raw_market as string) ?? (r.market as string) ?? '';
  const rawLine = (r.raw_line as string) ?? String(r.line ?? '');
  const playerName = (r.bookmaker_player_name as string) ?? '';
  const bookmaker = (r.bookmaker_id as string) ?? '';
  const line = Number(r.line);

  // Prefer DB-stored market_type; fall back to client-side classification
  const dbMarketType = r.market_type as MarketType | undefined;
  const marketFields = dbMarketType
    ? {
        market_type: dbMarketType,
        base_line: r.base_line != null ? Number(r.base_line) : null,
        display_label: (r.display_label as string | null) ?? null,
      }
    : classifyMarketType(bookmaker, rawMarket, rawLine, line);

  return {
    id: r.id as string,
    match_id: r.match_id as string,
    player_name: playerName,
    player_id: (r.player_id as string | null) ?? null,
    bookmaker,
    raw_market: rawMarket,
    raw_line: rawLine,
    line,
    over_odds: Number(r.over_odds),
    under_odds: r.under_odds != null ? Number(r.under_odds) : null,
    fetched_at: r.fetched_at as string,
    raw_payload: (r.raw_api_response as Record<string, unknown> | null) ?? null,
    stat_type: extractStatType(rawMarket),
    ...marketFields,
  };
}

export function groupByStatType(rows: NormalizedOddsRow[]): Map<string, NormalizedOddsRow[]> {
  const groups = new Map<string, NormalizedOddsRow[]>();
  for (const row of rows) {
    const key = row.stat_type ?? 'other';
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return groups;
}

export function groupByPlayer(rows: NormalizedOddsRow[]): Map<string, NormalizedOddsRow[]> {
  const groups = new Map<string, NormalizedOddsRow[]>();
  for (const row of rows) {
    const key = row.player_name || 'Unknown';
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return groups;
}

const BOOKMAKER_ODDS_COLS = [
  'id',
  'match_id',
  'bookmaker_id',
  'player_id',
  'bookmaker_player_name',
  'market',
  'raw_market',
  'line',
  'raw_line',
  'over_odds',
  'under_odds',
  'fetched_at',
  'raw_api_response',
  'market_type',
  'base_line',
  'display_label',
].join(', ');

export async function getRawOddsForMatch(matchId: string): Promise<NormalizedOddsRow[]> {
  console.log('[oddsNormalizer] getRawOddsForMatch matchId=', matchId);

  const { data, error } = await supabase
    .from('bookmaker_odds')
    .select(BOOKMAKER_ODDS_COLS)
    .eq('match_id', matchId)
    .not('line', 'is', null)
    .order('bookmaker_player_name')
    .order('raw_market')
    .order('line');

  if (error) {
    console.error('[oddsNormalizer] getRawOddsForMatch error:', error.message);
    return [];
  }

  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  console.log('[oddsNormalizer] ODDS ROWS:', rows.length, 'SAMPLE ROW:', rows[0]);
  return rows.map(mapBookmakerOddsRow);
}

/**
 * Query ONLY alt_ladder rows for a match (server-side filter).
 * These are the integer-line markets: "21+", "22+", "23+" etc.
 * No O/U (.5 line) rows are returned.
 */
export interface OddsFetchDiagnostics {
  totalRowsLoaded: number;
  queryPages: number;
  queryCapped: boolean;
}

export async function getAltLadderOddsForMatch(
  matchId: string
): Promise<NormalizedOddsRow[]> {
  const { rows } = await getAltLadderOddsForMatchWithDiagnostics(matchId);
  return rows;
}

export async function getAltLadderOddsForMatchWithDiagnostics(
  matchId: string
): Promise<{ rows: NormalizedOddsRow[]; diagnostics: OddsFetchDiagnostics }> {
  console.log('[oddsNormalizer] getAltLadderOddsForMatch matchId=', matchId);

  const allRaw: Record<string, unknown>[] = [];
  const pageSize = 1000;
  let page = 0;
  let hasMore = true;

  while (hasMore) {
    const { data: pageData, error } = await supabase
      .from('bookmaker_odds')
      .select(BOOKMAKER_ODDS_COLS)
      .eq('match_id', matchId)
      .eq('market_type', 'alt_ladder')
      .not('line', 'is', null)
      .order('bookmaker_player_name')
      .order('raw_market')
      .order('line')
      .order('bookmaker_id')
      .range(page * pageSize, (page + 1) * pageSize - 1);

    if (error) {
      console.error('[oddsNormalizer] getAltLadderOddsForMatch error:', error.message);
      break;
    }

    if (pageData && pageData.length > 0) {
      allRaw.push(...(pageData as unknown as Record<string, unknown>[]));
      hasMore = pageData.length === pageSize;
      page++;
    } else {
      hasMore = false;
    }
  }

  const mapped = allRaw.map(mapBookmakerOddsRow);
  const diagnostics: OddsFetchDiagnostics = {
    totalRowsLoaded: mapped.length,
    queryPages: page,
    queryCapped: page > 0 && allRaw.length === page * pageSize,
  };

  console.log('[oddsNormalizer] ALT_LADDER ROWS:', mapped.length, 'pages:', page, 'capped:', diagnostics.queryCapped);
  console.log('[oddsNormalizer] UNIQUE PLAYERS:', new Set(mapped.map(r => r.player_name)).size);

  // Unique ladder labels per player
  const playerLabels = new Map<string, Set<string>>();
  for (const r of mapped) {
    const set = playerLabels.get(r.player_name) ?? new Set<string>();
    set.add(r.display_label ?? String(r.line));
    playerLabels.set(r.player_name, set);
  }
  for (const [player, labels] of playerLabels) {
    console.log(`  [player] ${player}: ${[...labels].sort((a, b) => parseFloat(a) - parseFloat(b)).join(', ')}`);
  }

  // Sample 10 rows exactly as stored in DB
  console.log('[oddsNormalizer] SAMPLE 10 ROWS (exact DB values):');
  for (const raw of allRaw.slice(0, 10)) {
    console.log('  ', JSON.stringify({
      bookmaker: raw.bookmaker_id,
      player: raw.bookmaker_player_name,
      market: raw.raw_market,
      line: raw.line,
      display_label: raw.display_label,
      market_type: raw.market_type,
      over_odds: raw.over_odds,
      under_odds: raw.under_odds,
    }));
  }

  return { rows: mapped, diagnostics };
}

/**
 * Query ONLY ou_line rows for a match (genuine Over/Under disposal lines).
 * These are half-point markets (e.g. 28.5) with real over_odds and under_odds.
 */
export async function getOULinesForMatch(matchId: string): Promise<NormalizedOddsRow[]> {
  const { data, error } = await supabase
    .from('bookmaker_odds')
    .select(BOOKMAKER_ODDS_COLS)
    .eq('match_id', matchId)
    .eq('market_type', 'ou_line')
    .not('line', 'is', null)
    .order('bookmaker_player_name')
    .order('line');

  if (error) {
    console.error('[oddsNormalizer] getOULinesForMatch error:', error.message);
    return [];
  }

  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  return rows.map(mapBookmakerOddsRow);
}

export async function getRawOddsForPlayer(
  playerName: string,
  matchId?: string
): Promise<NormalizedOddsRow[]> {
  let query = supabase
    .from('bookmaker_odds')
    .select(BOOKMAKER_ODDS_COLS)
    .ilike('bookmaker_player_name', `%${playerName}%`)
    .not('line', 'is', null)
    .order('fetched_at', { ascending: false });

  if (matchId) query = query.eq('match_id', matchId);

  const { data, error } = await query;
  if (error) {
    console.error('[oddsNormalizer] getRawOddsForPlayer:', error.message);
    return [];
  }

  return ((data ?? []) as unknown as Record<string, unknown>[]).map(mapBookmakerOddsRow);
}

export async function getRawOddsForMatchAndPlayer(
  matchId: string,
  playerId: string
): Promise<NormalizedOddsRow[]> {
  const { data, error } = await supabase
    .from('bookmaker_odds')
    .select(BOOKMAKER_ODDS_COLS)
    .eq('match_id', matchId)
    .eq('player_id', playerId)
    .not('line', 'is', null)
    .order('raw_market')
    .order('line');

  if (error) {
    console.error('[oddsNormalizer] getRawOddsForMatchAndPlayer:', error.message);
    return [];
  }

  return ((data ?? []) as unknown as Record<string, unknown>[]).map(mapBookmakerOddsRow);
}

// ============================================================================
// Shared bookmaker field extraction helpers
// Used by Matchup Debug, EV Calculator, Multi Builder, and Odds Screen
// These safely try multiple possible field names from bookmaker_odds rows
// ============================================================================

export function getBookmakerPlayerName(row: Record<string, unknown>): string {
  return (
    (row.bookmaker_player_name as string) ??
    (row.player_name as string) ??
    (row.outcome_description as string) ??
    (row.description as string) ??
    (row.name as string) ??
    (row.player as string) ??
    (row.participant_name as string) ??
    'Unknown Player'
  );
}

export function getBookmakerStatType(row: Record<string, unknown>): string | null {
  const rawMarket = (row.raw_market as string) ?? (row.market as string) ?? '';
  return extractStatType(rawMarket);
}

export function getBookmakerLine(row: Record<string, unknown>): number {
  const line = Number(row.line ?? row.raw_line ?? 0);
  return isNaN(line) ? 0 : line;
}

export function getBookmakerOdds(row: Record<string, unknown>): { over: number; under: number | null } {
  return {
    over: Number(row.over_odds ?? 0),
    under: row.under_odds != null ? Number(row.under_odds) : null,
  };
}

export function getBookmakerTeam(row: Record<string, unknown>): string | null {
  return (row.team as string) ?? (row.bookmaker_team as string) ?? null;
}

export function getBookmakerBookmaker(row: Record<string, unknown>): string {
  return (row.bookmaker_id as string) ?? (row.bookmaker as string) ?? 'unknown';
}

export function getBookmakerMarketType(row: Record<string, unknown>): MarketType {
  return (row.market_type as MarketType) ?? 'alt_ladder';
}

export function getBookmakerDisplayLabel(row: Record<string, unknown>): string | null {
  return (row.display_label as string) ?? null;
}
