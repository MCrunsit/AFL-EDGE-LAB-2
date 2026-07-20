/**
 * Unified Match Player Props Service
 *
 * RAW BOOKMAKER DATA MIRROR — NO intelligence, NO modelling, NO optimisation.
 *
 * CRITICAL RULES (NON-NEGOTIABLE):
 *   - Odds come ONLY from bookmaker_odds, NEVER computed
 *   - Each bookmaker market row is UNIQUE and MUST NOT be grouped
 *   - NO merging, NO deduping, NO averaging, NO canonical "line"
 *   - NO line inference from player stats
 *   - NO EV, NO implied probability, NO vig adjustments
 *   - Every raw bookmaker row is returned as-is
 *   - Only filtering allowed = text match (includes/ILIKE)
 */

import { supabase } from './supabase';

const QUERY_TIMEOUT_MS = 10000;

export interface RawBookmakerRow {
  bookmaker_id: string;
  market: string;
  raw_market: string | null;
  line: number;
  raw_line: string | null;
  over_odds: number;
  under_odds: number | null;
  fetched_at: string;
}

export interface UnifiedPlayerProp {
  player_id: string;
  player_name: string;
  team: string;
  position: string | null;
  is_home: boolean;
  match_id: string;
  match_date: string | null;
  opponent: string;
  bookmaker_odds: RawBookmakerRow[];
}

export interface UnifiedMatchProps {
  match: {
    id: string;
    home_team: string;
    away_team: string;
    venue: string | null;
    match_date: string | null;
    round: string | null;
    season: number;
  };
  home_players: UnifiedPlayerProp[];
  away_players: UnifiedPlayerProp[];
  last_odds_update: string | null;
  debug: {
    match_loaded: boolean;
    home_players_count: number;
    away_players_count: number;
    odds_rows_count: number;
    data_sources: string[];
    errors: string[];
    load_time_ms: number;
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  const timeout = new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms));
  return Promise.race([promise, timeout]);
}

async function safeQuery<T>(
  queryFn: () => Promise<T>,
  fallback: T,
  errorCollector: (err: string) => void
): Promise<T> {
  try {
    return await withTimeout(queryFn(), QUERY_TIMEOUT_MS, fallback);
  } catch (err) {
    errorCollector(err instanceof Error ? err.message : 'Query failed');
    return fallback;
  }
}

export async function getUnifiedMatchPlayerProps(matchId: string): Promise<UnifiedMatchProps | null> {
  const startTime = Date.now();
  const errors: string[] = [];
  const dataSources: string[] = [];

  const debug = {
    match_loaded: false,
    home_players_count: 0,
    away_players_count: 0,
    odds_rows_count: 0,
    data_sources: dataSources,
    errors: errors,
    load_time_ms: 0,
  };

  try {
    const { data: match, error: matchError } = await supabase
      .from('matches')
      .select('id, season, round, home_team, away_team, venue, match_date')
      .eq('id', matchId)
      .maybeSingle();

    if (matchError) {
      errors.push(`Match query: ${matchError.message}`);
    }

    if (!match) {
      debug.load_time_ms = Date.now() - startTime;
      return null;
    }

    debug.match_loaded = true;

    const [homePlayers, awayPlayers] = await Promise.all([
      safeQuery(
        () => getActivePlayersForTeam(match.home_team),
        [],
        e => errors.push(`Home players: ${e}`)
      ),
      safeQuery(
        () => getActivePlayersForTeam(match.away_team),
        [],
        e => errors.push(`Away players: ${e}`)
      ),
    ]);

    debug.home_players_count = homePlayers.length;
    debug.away_players_count = awayPlayers.length;

    // Get ALL odds rows for this match — NO grouping, NO deduping, NO filtering
    const { data: allOdds, error: oddsError } = await supabase
      .from('bookmaker_odds')
      .select('player_id, bookmaker_player_name, market, raw_market, line, raw_line, over_odds, under_odds, bookmaker_id, fetched_at')
      .eq('match_id', matchId);

    if (oddsError) {
      errors.push(`Odds query: ${oddsError.message}`);
    }

    const oddsRows = allOdds || [];
    debug.odds_rows_count = oddsRows.length;

    console.log(`[getUnifiedMatchPlayerProps] Loaded ${oddsRows.length} odds rows for match ${matchId}`);

    if (oddsRows.length > 0) {
      dataSources.push('bookmaker_odds');
    }

    // Build lookup: player_id OR bookmaker_player_name => ALL raw bookmaker rows
    const oddsByPlayerId = new Map<string, RawBookmakerRow[]>();
    const oddsByPlayerName = new Map<string, RawBookmakerRow[]>();

    for (const o of oddsRows) {
      const row: RawBookmakerRow = {
        bookmaker_id: o.bookmaker_id,
        market: o.market,
        raw_market: o.raw_market ?? o.market,
        line: Number(o.line),
        raw_line: o.raw_line ?? String(o.line),
        over_odds: Number(o.over_odds),
        under_odds: o.under_odds != null ? Number(o.under_odds) : null,
        fetched_at: o.fetched_at,
      };

      // Store by player_id if available
      if (o.player_id) {
        const rows = oddsByPlayerId.get(o.player_id) || [];
        rows.push(row);
        oddsByPlayerId.set(o.player_id, rows);
      }

      // Also store by bookmaker_player_name for matching
      if (o.bookmaker_player_name) {
        const nameKey = o.bookmaker_player_name.toLowerCase().trim();
        const rows = oddsByPlayerName.get(nameKey) || [];
        rows.push(row);
        oddsByPlayerName.set(nameKey, rows);
      }
    }

    const buildPlayerProp = (
      player: { id: string; name: string; team: string; position: string | null },
      isHome: boolean
    ): UnifiedPlayerProp => {
      // Try to match by player_id first, then by name
      let bookmakerOdds = oddsByPlayerId.get(player.id) || [];

      // If no match by ID, try matching by name
      if (bookmakerOdds.length === 0) {
        const nameKey = player.name.toLowerCase().trim();
        bookmakerOdds = oddsByPlayerName.get(nameKey) || [];

        // Also try last name only
        if (bookmakerOdds.length === 0) {
          const nameParts = player.name.toLowerCase().split(' ');
          if (nameParts.length >= 2) {
            const lastName = nameParts.slice(1).join(' ').trim();
            bookmakerOdds = oddsByPlayerName.get(lastName) || [];
          }
        }
      }

      return {
        player_id: player.id,
        player_name: player.name,
        team: player.team,
        position: player.position,
        is_home: isHome,
        match_id: matchId,
        match_date: match.match_date,
        opponent: isHome ? (match.away_team ?? '—') : (match.home_team ?? '—'),
        bookmaker_odds: bookmakerOdds,
      };
    };

    const homePlayerProps = homePlayers.map(p => buildPlayerProp(p, true));
    const awayPlayerProps = awayPlayers.map(p => buildPlayerProp(p, false));

    // Find unmatched odds (rows with bookmaker_player_name that didn't match any player)
    const matchedPlayerNameKeys = new Set([
      ...homePlayers.map(p => p.name.toLowerCase().trim()),
      ...awayPlayers.map(p => p.name.toLowerCase().trim()),
      ...homePlayers.flatMap(p => {
        const parts = p.name.split(' ');
        return parts.length >= 2 ? [parts.slice(1).join(' ').toLowerCase().trim()] : [];
      }),
      ...awayPlayers.flatMap(p => {
        const parts = p.name.split(' ');
        return parts.length >= 2 ? [parts.slice(1).join(' ').toLowerCase().trim()] : [];
      }),
    ]);

    const unmatchedOdds: Array<{ playerName: string; odds: RawBookmakerRow[] }> = [];
    for (const [nameKey, odds] of oddsByPlayerName.entries()) {
      if (!matchedPlayerNameKeys.has(nameKey)) {
        unmatchedOdds.push({ playerName: nameKey, odds });
      }
    }

    // Add unmatched odds as virtual players
    for (const { playerName, odds } of unmatchedOdds) {
      const displayName = playerName.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      homePlayerProps.push({
        player_id: `unmatched-${playerName}`,
        player_name: displayName,
        team: 'Unknown',
        position: null,
        is_home: false,
        match_id: matchId,
        match_date: match.match_date,
        opponent: '—',
        bookmaker_odds: odds,
      });
    }

    const lastUpdate = oddsRows.length > 0
      ? oddsRows.reduce((max, o) =>
          o.fetched_at && (!max || o.fetched_at > max) ? o.fetched_at : max, null as string | null)
        : null;

    debug.load_time_ms = Date.now() - startTime;

    return {
      match: {
        id: match.id,
        home_team: match.home_team,
        away_team: match.away_team,
        venue: match.venue,
        match_date: match.match_date,
        round: match.round,
        season: match.season,
      },
      home_players: homePlayerProps,
      away_players: awayPlayerProps,
      last_odds_update: lastUpdate,
      debug,
    };
  } catch (err) {
    errors.push(`Unexpected: ${err instanceof Error ? err.message : 'Unknown error'}`);
    debug.load_time_ms = Date.now() - startTime;
    console.error('[getUnifiedMatchPlayerProps]', err);
    return null;
  }
}

async function getActivePlayersForTeam(team: string | null): Promise<Array<{
  id: string;
  name: string;
  team: string;
  position: string | null;
}>> {
  if (!team) return [];

  const teamSlug = team.toLowerCase().replace(/\s+/g, '-');

  const { data } = await supabase
    .from('players')
    .select('id, name, team, position')
    .eq('is_active', true)
    .or(`team.ilike.%${team}%,team.ilike.%${teamSlug}%`)
    .limit(50);

  return (data as Array<{ id: string; name: string; team: string; position: string | null }>) ?? [];
}

export async function getUnifiedPlayerProps(
  playerId: string,
  matchId?: string
): Promise<UnifiedPlayerProp | null> {
  const { data: player } = await supabase
    .from('players')
    .select('id, name, team, position')
    .eq('id', playerId)
    .maybeSingle();

  if (!player) return null;

  let targetMatchId = matchId;
  if (!targetMatchId) {
    const { data: upcomingMatch } = await supabase
      .from('matches')
      .select('id')
      .or(`home_team.ilike.%${player.team}%,away_team.ilike.%${player.team}%`)
      .gte('match_date', new Date().toISOString().split('T')[0])
      .order('match_date')
      .limit(1)
      .maybeSingle();

    if (!upcomingMatch) return null;
    targetMatchId = upcomingMatch.id;
  }

  const matchProps = await getUnifiedMatchPlayerProps(targetMatchId);
  if (!matchProps) return null;

  return [...matchProps.home_players, ...matchProps.away_players]
    .find(p => p.player_id === playerId) || null;
}
