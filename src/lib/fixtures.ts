import { supabase } from './supabase';
import type {
  UpcomingGame, BookmakerOdds, EnrichedStat, StatType,
  FixtureSyncResult, Match, Player,
} from './types';

// ---------------------------------------------------------------------------
// Team name normalisation
// ---------------------------------------------------------------------------

const TEAM_ALIASES: Record<string, string> = {
  // Adelaide
  'adelaide': 'adelaide', 'adelaide crows': 'adelaide', 'crows': 'adelaide', 'afc': 'adelaide',
  // Brisbane
  'brisbane': 'brisbane', 'brisbane lions': 'brisbane', 'lions': 'brisbane',
  // Carlton
  'carlton': 'carlton', 'carlton blues': 'carlton', 'blues': 'carlton',
  // Collingwood
  'collingwood': 'collingwood', 'collingwood magpies': 'collingwood', 'magpies': 'collingwood', 'pies': 'collingwood',
  // Essendon
  'essendon': 'essendon', 'essendon bombers': 'essendon', 'bombers': 'essendon', 'dons': 'essendon',
  // Fremantle
  'fremantle': 'fremantle', 'fremantle dockers': 'fremantle', 'dockers': 'fremantle', 'freo': 'fremantle',
  // Geelong
  'geelong': 'geelong', 'geelong cats': 'geelong', 'cats': 'geelong',
  // Gold Coast
  'gold coast': 'gold-coast', 'gold-coast': 'gold-coast', 'gold coast suns': 'gold-coast', 'suns': 'gold-coast',
  // GWS
  'gws': 'gws', 'greater western sydney': 'gws', 'greater western sydney giants': 'gws', 'giants': 'gws', 'gwssydney': 'gws',
  // Hawthorn
  'hawthorn': 'hawthorn', 'hawthorn hawks': 'hawthorn', 'hawks': 'hawthorn',
  // Melbourne
  'melbourne': 'melbourne', 'melbourne demons': 'melbourne', 'demons': 'melbourne', 'dees': 'melbourne',
  // North Melbourne
  'north melbourne': 'north-melbourne', 'north-melbourne': 'north-melbourne',
  'north melbourne kangaroos': 'north-melbourne',
  'north': 'north-melbourne', 'kangaroos': 'north-melbourne', 'roos': 'north-melbourne',
  // Port Adelaide
  'port adelaide': 'port-adelaide', 'port-adelaide': 'port-adelaide',
  'port adelaide power': 'port-adelaide',
  'port': 'port-adelaide', 'power': 'port-adelaide',
  // Richmond
  'richmond': 'richmond', 'richmond tigers': 'richmond', 'tigers': 'richmond',
  // St Kilda
  'st kilda': 'st-kilda', 'st-kilda': 'st-kilda', 'st kilda saints': 'st-kilda', 'saints': 'st-kilda',
  // Sydney
  'sydney': 'sydney', 'sydney swans': 'sydney', 'swans': 'sydney',
  // West Coast
  'west coast': 'west-coast', 'west-coast': 'west-coast', 'west coast eagles': 'west-coast', 'eagles': 'west-coast',
  // Western Bulldogs
  'western bulldogs': 'western-bulldogs', 'western-bulldogs': 'western-bulldogs',
  'bulldogs': 'western-bulldogs', 'dogs': 'western-bulldogs', 'footscray': 'western-bulldogs',
};

/** Normalise any team name/alias to canonical slug. Returns lowercase input if no match. */
export function normalizeTeam(name: string | null | undefined): string {
  if (!name) return '';
  const key = name.trim().toLowerCase();
  return TEAM_ALIASES[key] ?? key;
}

const SLUG_TO_DISPLAY: Record<string, string> = {
  'adelaide': 'Adelaide',
  'brisbane': 'Brisbane',
  'carlton': 'Carlton',
  'collingwood': 'Collingwood',
  'essendon': 'Essendon',
  'fremantle': 'Fremantle',
  'geelong': 'Geelong',
  'gold-coast': 'Gold Coast',
  'gws': 'GWS',
  'hawthorn': 'Hawthorn',
  'melbourne': 'Melbourne',
  'north-melbourne': 'North Melbourne',
  'port-adelaide': 'Port Adelaide',
  'richmond': 'Richmond',
  'st-kilda': 'St Kilda',
  'sydney': 'Sydney',
  'west-coast': 'West Coast',
  'western-bulldogs': 'Western Bulldogs',
};

/** Convert a slug back to display name, or title-case the input as fallback. */
export function teamSlugToName(slug: string): string {
  return SLUG_TO_DISPLAY[slug] ?? slug;
}

// ---------------------------------------------------------------------------
// Ladder / top-bottom teams helper
// ---------------------------------------------------------------------------

interface LadderEntry { team: string; wins?: number; losses?: number; points?: number }

export function getTopBottomTeams(ladder: LadderEntry[], n = 3) {
  const top = new Set(ladder.slice(0, n).map(l => l.team));
  const bottom = new Set(ladder.slice(-n).map(l => l.team));
  return { top, bottom };
}

// ---------------------------------------------------------------------------
// Upcoming games for a team (used by Props Analyzer via useUpcomingGames hook)
// ---------------------------------------------------------------------------

/**
 * Get upcoming games for a team (slug or display name).
 * Uses current_players-friendly team matching: slug stored in players.team column.
 */
export async function getUpcomingGames(teamSlug: string, limit = 5): Promise<UpcomingGame[]> {
  if (!teamSlug) return [];
  const today = new Date().toISOString().split('T')[0];
  const slug = normalizeTeam(teamSlug);
  const displayName = teamSlugToName(slug);

  console.debug(`[getUpcomingGames] team="${teamSlug}" → slug="${slug}", display="${displayName}"`);

  // Try matching by display name OR normalized slug pattern
  // The matches table may have "Collingwood Magpies" or "Collingwood"
  const { data, error } = await supabase
    .from('matches')
    .select('id, season, round, home_team, away_team, venue, match_date')
    .gte('match_date', today)
    .or(`home_team.ilike.%${displayName}%,away_team.ilike.%${displayName}%`)
    .order('match_date', { ascending: true })
    .limit(limit);

  if (error) {
    console.error('[getUpcomingGames] Error:', error.message);
    return [];
  }

  const rows = data ?? [];
  console.debug(`[getUpcomingGames] found ${rows.length} matches for ${displayName}`);

  return rows.map(m => ({
    match_id: m.id,
    season: m.season,
    round: m.round,
    venue: m.venue,
    match_date: m.match_date,
    is_home: normalizeTeam(m.home_team) === slug,
    opponent: normalizeTeam(m.home_team) === slug ? (m.away_team ?? '') : (m.home_team ?? ''),
  }));
}

// ---------------------------------------------------------------------------
// Upcoming player odds (used by Props Analyzer via usePlayerOdds hook)
// ---------------------------------------------------------------------------

export type UpcomingOdd = { odds: BookmakerOdds; match_date: string; opponent: string; venue: string | null };

/**
 * Get upcoming prop odds for a player from bookmaker_odds table.
 * Uses player_id matching whenever possible, falls back to name matching.
 */
export async function getUpcomingPlayerOdds(
  playerId: string,
  market?: string
): Promise<UpcomingOdd[]> {
  if (!playerId) return [];
  const today = new Date().toISOString().split('T')[0];

  // 1. Get player's team and name — only current players
  const { data: playerRow } = await supabase
    .from('current_players')
    .select('team, name')
    .eq('id', playerId)
    .maybeSingle();

  if (!playerRow?.team) {
    console.debug(`[getUpcomingPlayerOdds] No team for player ${playerId}`);
    return [];
  }

  const teamSlug = normalizeTeam(playerRow.team);
  const displayName = teamSlugToName(teamSlug);
  const playerName = playerRow.name;

  // 2. Get upcoming match IDs for this team
  const { data: matches } = await supabase
    .from('matches')
    .select('id, match_date, home_team, away_team, venue')
    .gte('match_date', today)
    .or(`home_team.eq.${displayName},away_team.eq.${displayName}`);

  const upcomingMatchIds = (matches ?? []).map(m => m.id);
  console.debug(`[getUpcomingPlayerOdds] player=${playerId} team=${displayName} upcoming matches=${upcomingMatchIds.length}`);

  if (upcomingMatchIds.length === 0) return [];

  // 3. Get odds from bookmaker_odds table by player_id OR player name match
  let query = supabase
    .from('bookmaker_odds')
    .select('*')
    .in('match_id', upcomingMatchIds)
    .not('line', 'is', null)
    .gt('line', 0)
    .gt('over_odds', 1); // Only require over_odds > 1; under_odds can be null for alt_ladder

  // Prefer player_id match, fall back to name match
  const orFilter = `player_id.eq.${playerId},bookmaker_player_name.ilike.%${playerName}%`;
  query = query.or(orFilter);

  if (market) query = query.ilike('market', `%${market}%`);

  const { data: oddsData, error } = await query.order('fetched_at', { ascending: false });

  if (error) {
    console.error('[getUpcomingPlayerOdds] Error:', error.message);
    return [];
  }

  const matchMap = new Map((matches ?? []).map(m => [m.id, m]));

  return (oddsData ?? [])
    .filter(o => {
      const overOk = isFinite(Number(o.over_odds)) && Number(o.over_odds) > 1;
      const underOk = o.under_odds == null || (isFinite(Number(o.under_odds)) && Number(o.under_odds) > 1);
      return overOk && underOk;
    })
    .map(o => {
      const m = matchMap.get(o.match_id ?? '');
      const isHome = normalizeTeam(m?.home_team ?? '') === teamSlug;
      return {
        odds: o as BookmakerOdds,
        match_date: m?.match_date ?? '',
        opponent: isHome ? (m?.away_team ?? '') : (m?.home_team ?? ''),
        venue: m?.venue ?? null,
      };
    });
}

// ---------------------------------------------------------------------------
// Props Analyzer helpers (getPlayerVsOpponent + getPlayerVenueSplit)
// ---------------------------------------------------------------------------

/**
 * Get player's stats against a specific opponent team, for a given stat type.
 */
export async function getPlayerVsOpponent(
  playerId: string,
  opponentTeamSlug: string,
  statType: StatType
): Promise<{ avg: number; games: number; values: number[] }> {
  if (!playerId || !opponentTeamSlug) return { avg: 0, games: 0, values: [] };

  const opponentDisplay = teamSlugToName(normalizeTeam(opponentTeamSlug));

  // Find all match IDs where opponent played
  const { data: matchRows } = await supabase
    .from('matches')
    .select('id')
    .or(`home_team.eq.${opponentDisplay},away_team.eq.${opponentDisplay}`);

  if (!matchRows || matchRows.length === 0) return { avg: 0, games: 0, values: [] };

  const matchIds = matchRows.map(m => m.id);

  const { data: statsRows } = await supabase
    .from('player_game_stats')
    .select(`${statType}, match_id`)
    .eq('player_id', playerId)
    .in('match_id', matchIds)
    .not(statType, 'is', null);

  const values = (statsRows ?? []).map(r => (r as unknown as Record<string, number>)[statType]).filter(v => v != null && isFinite(v));
  const avg = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  return { avg, games: values.length, values };
}

/**
 * Get player's stat averages at a specific venue.
 */
export async function getPlayerVenueSplit(
  playerId: string,
  venue: string,
  statType: StatType
): Promise<{ avg: number; games: number }> {
  if (!playerId || !venue) return { avg: 0, games: 0 };

  const { data } = await supabase
    .from('player_game_stats')
    .select(`${statType}`)
    .eq('player_id', playerId)
    .ilike('venue', `%${venue.trim()}%`)
    .not(statType, 'is', null);

  const values = (data ?? []).map(r => (r as unknown as Record<string, number>)[statType]).filter(v => isFinite(v));
  const avg = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  return { avg, games: values.length };
}

// ---------------------------------------------------------------------------
// Fixture sync
// ---------------------------------------------------------------------------

/**
 * Sync fixtures from CSV rows. Auto-normalizes team names.
 * Upserts by (season, round, home_team, away_team).
 * Skips past matches unless includePast=true.
 */
export async function syncFixtures(
  rows: Record<string, string>[],
  includePast = false
): Promise<FixtureSyncResult> {
  const today = new Date().toISOString().split('T')[0];
  const toInsert: Record<string, unknown>[] = [];
  const errors: string[] = [];
  let skipped = 0;

  for (const row of rows) {
    if (!row.season || !row.home_team || !row.away_team || !row.match_date) {
      errors.push(`Row missing required fields: ${JSON.stringify(row)}`);
      continue;
    }

    const isoDate = row.match_date.includes('T') ? row.match_date.split('T')[0] : row.match_date;
    if (!includePast && isoDate < today) { skipped++; continue; }

    const homeSlug = normalizeTeam(row.home_team);
    const awaySlug = normalizeTeam(row.away_team);

    toInsert.push({
      season: parseInt(row.season),
      round: row.round || null,
      home_team: teamSlugToName(homeSlug),
      away_team: teamSlugToName(awaySlug),
      venue: row.venue?.trim() || null,
      match_date: isoDate,
      home_score: null,
      away_score: null,
      api_match_id: row.api_match_id ? parseInt(row.api_match_id) : null,
    });
  }

  let success = 0;
  const BATCH = 500;
  for (let i = 0; i < toInsert.length; i += BATCH) {
    const batch = toInsert.slice(i, i + BATCH);
    const { error } = await supabase.from('matches').upsert(batch, {
      onConflict: 'season,round,home_team,away_team',
    });
    if (error) errors.push(`Batch ${Math.floor(i / BATCH) + 1}: ${error.message}`);
    else success += batch.length;
  }

  console.log(`[syncFixtures] inserted=${success} skipped(past)=${skipped} errors=${errors.length}`);
  return { success, errors, total: rows.length, skipped };
}

// ---------------------------------------------------------------------------
// Match Hub data helpers
// ---------------------------------------------------------------------------

/** All upcoming matches ordered by commence_time. */
export async function getUpcomingFixtures(limit = 50): Promise<Match[]> {
  const today = new Date().toISOString().split('T')[0];
  const { data, error } = await supabase
    .from('matches')
    .select('*')
    .gte('match_date', today)
    .order('commence_time_utc', { ascending: true, nullsFirst: false })
    .limit(limit);

  if (error) { console.error('[getUpcomingFixtures]', error.message); return []; }
  return (data as Match[]) ?? [];
}

/** Single match by ID. */
export async function getMatchById(matchId: string): Promise<Match | null> {
  const { data, error } = await supabase
    .from('matches')
    .select('*')
    .eq('id', matchId)
    .maybeSingle();

  if (error) { console.error('[getMatchById]', error.message); return null; }
  return data as Match | null;
}

/**
 * Active players for a team. Matches against current_players view.
 * Accepts display name, full name (e.g., "Collingwood Magpies"), or slug.
 */
export async function getActivePlayersForTeam(teamNameOrSlug: string): Promise<Player[]> {
  if (!teamNameOrSlug) return [];
  const slug = normalizeTeam(teamNameOrSlug);

  // Match team column which stores the slug
  const { data, error } = await supabase
    .from('current_players')
    .select('*')
    .eq('team', slug)
    .order('name');

  if (error) { console.error('[getActivePlayersForTeam]', error.message, 'slug=', slug); return []; }
  console.log(`[getActivePlayersForTeam] team="${teamNameOrSlug}" → slug="${slug}" → ${data?.length ?? 0} players`);
  return (data as Player[]) ?? [];
}

// ---------------------------------------------------------------------------
// Match-level odds (h2h, spreads, totals) from The Odds API
// Stored in match_odds table, synced via odds-sync edge function
// ---------------------------------------------------------------------------

export interface MatchOddsRow {
  id: string;
  match_id: string;
  bookmaker: string;
  market: 'h2h' | 'spreads' | 'totals';
  home_odds: number | null;
  away_odds: number | null;
  home_point: number | null;
  away_point: number | null;
  total_point: number | null;
  over_odds: number | null;
  under_odds: number | null;
  source: string;
  updated_at: string;
}

/**
 * Get MATCH-LEVEL odds (h2h, spreads, totals) for a match.
 * These are synced from The Odds API and stored in match_odds table.
 * This is SEPARATE from player prop odds.
 */
export async function getMatchOddsData(matchId: string): Promise<MatchOddsRow[]> {
  const { data, error } = await supabase
    .from('match_odds')
    .select('*')
    .eq('match_id', matchId)
    .order('updated_at', { ascending: false });

  if (error) {
    console.error('[getMatchOddsData]', error.message);
    return [];
  }

  return (data as MatchOddsRow[]) ?? [];
}

// ---------------------------------------------------------------------------
// Player prop odds (disposals, goals, tackles, etc.)
// Stored in bookmaker_odds table, ingested via CSV or API
// ---------------------------------------------------------------------------

/**
 * Get PLAYER PROP odds for a match from bookmaker_odds table.
 * Market options: 'disposals', 'goals', 'tackles', 'marks', 'hitouts'
 *
 * @deprecated Use getAltLadderOddsForMatch() from oddsNormalizer for better ladder support
 */
export async function getPlayerPropOddsForMatch(matchId: string, market?: string): Promise<BookmakerOdds[]> {
  let query = supabase
    .from('bookmaker_odds')
    .select('*')
    .eq('match_id', matchId)
    .not('line', 'is', null)
    .order('line', { ascending: true });

  if (market) query = query.ilike('market', `%${market}%`);

  const { data, error } = await query;
  if (error) { console.error('[getPlayerPropOddsForMatch]', error.message); return []; }

  // Exclude NaN / invalid odds
  return ((data ?? []) as BookmakerOdds[]).filter(o => {
    const overOk = o.over_odds == null || (isFinite(Number(o.over_odds)) && Number(o.over_odds) > 1);
    const underOk = o.under_odds == null || (isFinite(Number(o.under_odds)) && Number(o.under_odds) > 1);
    return overOk && underOk;
  });
}

/**
 * @deprecated Use getAltLadderOddsForMatch() from oddsNormalizer instead.
 */
export async function getMatchOdds(matchId: string, market?: string): Promise<BookmakerOdds[]> {
  return getPlayerPropOddsForMatch(matchId, market);
}

/** Player's current-season average for a stat type. */
export async function getPlayerSeasonAvg(
  playerId: string,
  statType: StatType,
  season = new Date().getFullYear()
): Promise<number | null> {
  const { data, error } = await supabase
    .from('player_game_stats')
    .select(`${statType}, match_date`)
    .eq('player_id', playerId)
    .not(statType, 'is', null)
    .gte('match_date', `${season}-01-01`)
    .lte('match_date', `${season}-12-31`);

  if (error || !data || data.length === 0) return null;
  const vals = (data as unknown as Array<Record<string, number>>)
    .map(r => r[statType])
    .filter(v => v != null && isFinite(v));
  return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

/** Player's last N game stats for a specific stat type. */
export async function getPlayerLastN(
  playerId: string,
  statType: StatType,
  n = 5
): Promise<EnrichedStat[]> {
  const { data, error } = await supabase
    .from('player_game_stats')
    .select('*')
    .eq('player_id', playerId)
    .order('match_date', { ascending: false })
    .limit(n);

  if (error) { console.error('[getPlayerLastN]', error.message); return []; }
  return (data as unknown as EnrichedStat[]) ?? [];
}

/** Player's average vs a specific opponent team. */
export async function getPlayerVsOpponentAvg(
  playerId: string,
  opponentTeamNameOrSlug: string,
  statType: StatType
): Promise<{ avg: number; games: number }> {
  const result = await getPlayerVsOpponent(playerId, opponentTeamNameOrSlug, statType);
  return { avg: result.avg, games: result.games };
}

/** Player's home/away stat split. */
export async function getPlayerVenueHomeAwaySplit(
  playerId: string,
  statType: StatType
): Promise<{ home: number | null; away: number | null; total: number | null }> {
  const { data: statsRows } = await supabase
    .from('player_game_stats')
    .select(`${statType}, match_id`)
    .eq('player_id', playerId)
    .not(statType, 'is', null);

  if (!statsRows || statsRows.length === 0) return { home: null, away: null, total: null };

  const matchIds = (statsRows as Array<{ match_id: string }>).map(s => s.match_id).filter(Boolean);
  const { data: matchesData } = await supabase
    .from('matches')
    .select('id, home_team')
    .in('id', matchIds);

  const { data: playerRow } = await supabase
    .from('players')
    .select('team')
    .eq('id', playerId)
    .maybeSingle();

  if (!playerRow?.team) return { home: null, away: null, total: null };

  const playerSlug = normalizeTeam(playerRow.team);
  const matchMap = new Map((matchesData ?? []).map(m => [m.id, m.home_team]));

  let homeSum = 0, homeCount = 0, awaySum = 0, awayCount = 0;
  for (const s of statsRows as unknown as Array<Record<string, number> & { match_id: string }>) {
    const val = s[statType];
    if (val == null || !isFinite(val)) continue;
    const homeTeam = matchMap.get(s.match_id);
    const isHome = homeTeam ? normalizeTeam(homeTeam) === playerSlug : false;
    if (isHome) { homeSum += val; homeCount++; }
    else { awaySum += val; awayCount++; }
  }

  const total = homeCount + awayCount;
  return {
    home: homeCount > 0 ? homeSum / homeCount : null,
    away: awayCount > 0 ? awaySum / awayCount : null,
    total: total > 0 ? (homeSum + awaySum) / total : null,
  };
}

// ---------------------------------------------------------------------------
// Bookmaker odds (real-time player prop odds from multiple bookmakers)
// Stored in bookmaker_odds table, ingested via bookmaker-odds-ingest edge function
// ---------------------------------------------------------------------------

import type { Bookmaker, BookmakerIngestResult } from './types';

/**
 * Get all bookmakers and their fetch status.
 */
export async function getBookmakers(): Promise<Bookmaker[]> {
  const { data, error } = await supabase
    .from('bookmakers')
    .select('*')
    .eq('is_active', true)
    .order('name');

  if (error) {
    console.error('[getBookmakers]', error.message);
    return [];
  }

  return (data as Bookmaker[]) ?? [];
}

/**
 * Get detailed odds breakdown by bookmaker for a player/market.
 */
export async function getBookmakerOddsBreakdown(
  playerId: string,
  matchId: string,
  market: string
): Promise<BookmakerOdds[]> {
  const { data, error } = await supabase
    .from('bookmaker_odds')
    .select('*')
    .eq('player_id', playerId)
    .eq('match_id', matchId)
    .ilike('market', `%${market}%`)
    .order('fetched_at', { ascending: false });

  if (error) {
    console.error('[getBookmakerOddsBreakdown]', error.message);
    return [];
  }

  return (data as BookmakerOdds[]) ?? [];
}

/**
 * Ingest bookmaker odds via edge function.
 */
export async function ingestBookmakerOdds(
  bookmakerId: string,
  oddsData: Array<{
    player_id?: string;
    match_id: string;
    bookmaker_player_name?: string;
    market: string;
    line: number;
    over_odds: number;
    under_odds: number;
  }>
): Promise<BookmakerIngestResult> {
  try {
    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/bookmaker-odds-ingest`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        bookmaker_id: bookmakerId,
        odds_data: oddsData,
      }),
    });

    const json = await response.json();
    return json as BookmakerIngestResult;
  } catch (err) {
    return {
      success: false,
      bookmaker_id: bookmakerId,
      odds_count: 0,
      errors: [err instanceof Error ? err.message : 'Network error'],
      skipped: 0,
      ingest_id: '',
      duration_ms: 0,
    };
  }
}
