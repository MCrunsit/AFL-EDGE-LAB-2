/**
 * Raw Bookmaker Odds Service
 *
 * This service fetches ONLY raw bookmaker_odds data - no derived lines, no EV, no merging.
 *
 * SOURCE OF TRUTH: bookmaker_odds table ONLY
 *
 * Rules:
 *   - NO merging of bookmaker markets
 *   - NO averaging lines
 *   - NO deduping
 *   - NO derived alt lines mixed in
 *   - NO EV calculations (removed temporarily)
 *
 * Each bookmaker market shown exactly as stored.
 */

import { supabase } from './supabase';
import type { StatType } from './types';

export interface RawBookmakerMarket {
  id: string;
  player_id: string | null;
  match_id: string;
  bookmaker_id: string;
  market: string;
  raw_market?: string;
  line: number;
  raw_line?: string;
  over_odds: number;
  under_odds: number | null;
  fetched_at: string;
  bookmaker_player_name?: string;
  display_label?: string;
}

export interface PlayerBookmakerMarkets {
  player_id: string;
  player_name: string;
  team: string;
  match_id: string;
  match_date: string | null;
  home_team: string;
  away_team: string;
  opponent: string;
  venue: string | null;
  markets: RawBookmakerMarket[];
  debug: {
    source_bookmakers_count: number;
    raw_markets_loaded: number;
    missing_markets: boolean;
    data_source_verified: boolean;
  };
}

/**
 * Get ALL raw bookmaker markets for a player/match/market
 * NO merging, NO deduping, show each bookmaker line separately
 * Uses ILIKE to match market strings that may contain the stat type
 * (e.g. "Player Disposals 27.5" matches statType "disposals")
 */
export async function getRawBookmakerMarkets(
  playerId: string,
  matchId: string,
  market: StatType
): Promise<RawBookmakerMarket[]> {
  const { data, error } = await supabase
    .from('bookmaker_odds')
    .select('id, player_id, match_id, bookmaker_id, market, raw_market, line, raw_line, over_odds, under_odds, fetched_at, bookmaker_player_name')
    .eq('player_id', playerId)
    .eq('match_id', matchId)
    .ilike('market', `%${market}%`)
    .not('line', 'is', null)
    .order('bookmaker_id');

  if (error) {
    console.error('[getRawBookmakerMarkets]', error.message);
    return [];
  }

  return (data || []).map(o => ({
    id: o.id,
    player_id: o.player_id,
    match_id: o.match_id,
    bookmaker_id: o.bookmaker_id,
    market: o.market,
    raw_market: o.raw_market || o.market,
    line: Number(o.line),
    raw_line: o.raw_line || String(o.line),
    over_odds: Number(o.over_odds),
    under_odds: Number(o.under_odds),
    fetched_at: o.fetched_at,
    bookmaker_player_name: o.bookmaker_player_name || undefined,
  }));
}

/**
 * Get ALL raw bookmaker markets for a player (all upcoming matches)
 */
export async function getPlayerAllBookmakerMarkets(
  playerId: string
): Promise<PlayerBookmakerMarkets[]> {
  // Get player info
  const { data: player } = await supabase
    .from('players')
    .select('id, name, team')
    .eq('id', playerId)
    .maybeSingle();

  if (!player) return [];

  // Get upcoming matches for player's team
  const { data: matches } = await supabase
    .from('matches')
    .select('id, home_team, away_team, venue, match_date, round, season')
    .or(`home_team.ilike.%${player.team}%,away_team.ilike.%${player.team}%`)
    .gte('match_date', new Date().toISOString().split('T')[0])
    .order('match_date')
    .limit(5);

  if (!matches || matches.length === 0) return [];

  const results: PlayerBookmakerMarkets[] = [];

  for (const match of matches) {
    const isHome = match.home_team?.toLowerCase().includes(player.team.toLowerCase());
    const opponent = isHome ? match.away_team : match.home_team;

    // Get ALL bookmaker odds for this player/match (ALL markets)
    const { data: odds } = await supabase
      .from('bookmaker_odds')
      .select('id, player_id, match_id, bookmaker_id, market, line, over_odds, under_odds, fetched_at, bookmaker_player_name')
      .eq('player_id', playerId)
      .eq('match_id', match.id)
      .not('line', 'is', null)
      .order('market')
      .order('bookmaker_id');

    const markets: RawBookmakerMarket[] = (odds || []).map(o => ({
      id: o.id,
      player_id: o.player_id,
      match_id: o.match_id,
      bookmaker_id: o.bookmaker_id,
      market: o.market,
      line: Number(o.line),
      over_odds: Number(o.over_odds),
      under_odds: Number(o.under_odds),
      fetched_at: o.fetched_at,
      bookmaker_player_name: o.bookmaker_player_name || undefined,
    }));

    // Group by bookmaker to count
    const bookmakers = new Set(markets.map(m => m.bookmaker_id));

    results.push({
      player_id: playerId,
      player_name: player.name,
      team: player.team,
      match_id: match.id,
      match_date: match.match_date,
      home_team: match.home_team || '',
      away_team: match.away_team || '',
      opponent: opponent || 'Unknown',
      venue: match.venue,
      markets,
      debug: {
        source_bookmakers_count: bookmakers.size,
        raw_markets_loaded: markets.length,
        missing_markets: markets.length === 0,
        data_source_verified: markets.length > 0,
      },
    });
  }

  return results;
}

/**
 * Get raw bookmaker markets for all players in a match
 * Groups by player_id if available, otherwise by bookmaker_player_name
 */
export async function getMatchBookmakerMarkets(
  matchId: string
): Promise<Map<string, RawBookmakerMarket[]>> {
  console.log(`[getMatchBookmakerMarkets] Loading bookmaker_odds for match ${matchId}`);

  const { data, error } = await supabase
    .from('bookmaker_odds')
    .select('id, player_id, match_id, bookmaker_id, market, raw_market, line, raw_line, over_odds, under_odds, fetched_at, bookmaker_player_name, market_type, display_label, source')
    .eq('match_id', matchId)
    .not('line', 'is', null)
    .order('bookmaker_player_name')
    .order('market')
    .order('line');

  if (error) {
    console.error('[getMatchBookmakerMarkets]', error.message);
    return new Map();
  }

  console.log(`[getMatchBookmakerMarkets] Rows loaded: ${data?.length ?? 0}`);
  if (data && data.length > 0) {
    console.log(`[getMatchBookmakerMarkets] Sample row:`, data[0]);
  }

  const byPlayer = new Map<string, RawBookmakerMarket[]>();

  for (const o of data || []) {
    // Use player_id if available, otherwise use bookmaker_player_name as key
    const playerKey = o.player_id || `name:${o.bookmaker_player_name}`;
    const markets = byPlayer.get(playerKey) || [];
    markets.push({
      id: o.id,
      player_id: o.player_id,
      match_id: o.match_id,
      bookmaker_id: o.bookmaker_id,
      market: o.market,
      raw_market: o.raw_market || o.market,
      line: Number(o.line),
      raw_line: o.raw_line || String(o.line),
      over_odds: Number(o.over_odds),
      under_odds: o.under_odds != null ? Number(o.under_odds) : null,
      fetched_at: o.fetched_at,
      bookmaker_player_name: o.bookmaker_player_name || undefined,
      display_label: o.display_label || undefined,
    });
    byPlayer.set(playerKey, markets);
  }

  console.log(`[getMatchBookmakerMarkets] Grouped into ${byPlayer.size} players`);
  return byPlayer;
}
