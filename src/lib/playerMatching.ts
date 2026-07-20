/**
 * Player Matching Utilities
 *
 * Utilities for matching bookmaker_odds player_name to players table
 * and resolving player team when player_id is not available.
 */

import { supabase } from './supabase';
import { findPlayerByAlias, expandSearchWithAliases } from './playerAliases';

/**
 * Normalize a player name for matching:
 * - lowercase
 * - trim
 * - remove punctuation (apostrophes, hyphens, periods become spaces, then collapsed)
 * - handle curly apostrophes
 * - remove accents
 * - collapse spaces
 */
export function normalizePlayerName(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .toLowerCase()
    .trim()
    // Normalize curly quotes and apostrophes to straight
    .replace(/['']/g, "'")
    // Replace apostrophes, hyphens, periods with spaces (for names like D'Ambrosio, Zerk-Thatcher)
    .replace(/['.\-]/g, ' ')
    // Remove remaining punctuation
    .replace(/[^a-z0-9\s]/g, '')
    // Collapse multiple spaces
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize a team name for matching
 */
export function normalizeTeamKeyForMatch(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '-')
    .trim();
}

/**
 * Canonical team name mapping
 * Maps variations to a consistent canonical form
 */
const TEAM_CANONICAL_MAP: Record<string, string> = {
  // Kali slugs (normalized to spaces)
  'adelaide': 'Adelaide',
  'brisbane': 'Brisbane',
  'carlton': 'Carlton',
  'collingwood': 'Collingwood',
  'essendon': 'Essendon',
  'fremantle': 'Fremantle',
  'geelong': 'Geelong',
  'gold coast': 'Gold Coast',
  'gws': 'GWS',
  'hawthorn': 'Hawthorn',
  'melbourne': 'Melbourne',
  'north melbourne': 'North Melbourne',
  'port adelaide': 'Port Adelaide',
  'richmond': 'Richmond',
  'st kilda': 'St Kilda',
  'sydney': 'Sydney',
  'west coast': 'West Coast',
  'western bulldogs': 'Western Bulldogs',
  // Full names from DB
  'adelaide crows': 'Adelaide',
  'brisbane lions': 'Brisbane',
  'carlton blues': 'Carlton',
  'collingwood magpies': 'Collingwood',
  'essendon bombers': 'Essendon',
  'fremantle dockers': 'Fremantle',
  'geelong cats': 'Geelong',
  'gold coast suns': 'Gold Coast',
  'greater western sydney giants': 'GWS',
  'gws giants': 'GWS',
  'hawthorn hawks': 'Hawthorn',
  'melbourne demons': 'Melbourne',
  'north melbourne kangaroos': 'North Melbourne',
  'port adelaide power': 'Port Adelaide',
  'richmond tigers': 'Richmond',
  'st kilda saints': 'St Kilda',
  'sydney swans': 'Sydney',
  'west coast eagles': 'West Coast',
};

/**
 * Normalize a team name to its canonical form
 */
export function normalizeTeamToCanonical(team: string | null | undefined): string {
  if (!team) return '';
  const key = team.toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  return TEAM_CANONICAL_MAP[key] ?? team.trim();
}

/**
 * Normalize a venue name for matching
 */
export function normalizeVenueName(venue: string | null | undefined): string {
  if (!venue) return '';
  return venue
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface PlayerMatch {
  player_id: string | null;
  player_name: string;
  normalized_name: string;
  team: string | null;
  position_group: string | null;
  match_method: 'id' | 'exact_name' | 'normalized_name' | 'none';
}

export interface PlayerMatchCache {
  byId: Map<string, PlayerMatch>;
  // Map: normalized name -> ALL players with that name (for disambiguation)
  byNormalizedName: Map<string, PlayerMatch>;
  // Map: normalized name -> array of all candidates (for team disambiguation)
  allCandidatesByName: Map<string, PlayerMatch[]>;
}

interface RawPlayer {
  id: string;
  name: string;
  team: string | null;
  position_group: string | null;
}

/**
 * Fetch ALL players from the database with pagination.
 * Supabase's default limit is 1,000 rows — without pagination, players
 * beyond that boundary are invisible and become PLAYER_UNRESOLVED.
 */
export async function fetchAllPlayers(): Promise<RawPlayer[]> {
  const PAGE_SIZE = 1000;
  const allPlayers: RawPlayer[] = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from('players')
      .select('id, name, team, position_group')
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      console.error('[PlayerMatchCache] Error fetching players page', from, error.message);
      break;
    }

    const page = (data ?? []) as RawPlayer[];
    allPlayers.push(...page);

    if (page.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  console.log('[PlayerMatchCache] players loaded', allPlayers.length);
  return allPlayers;
}

/**
 * Build a player match cache from players table.
 * Loads ALL players with pagination — no 1,000-row truncation.
 */
export async function buildPlayerMatchCache(): Promise<PlayerMatchCache> {
  const players = await fetchAllPlayers();

  const byId = new Map<string, PlayerMatch>();
  const byNormalizedName = new Map<string, PlayerMatch>();
  const allCandidatesByName = new Map<string, PlayerMatch[]>();

  for (const p of players) {
    const normalizedName = normalizePlayerName(p.name);
    const match: PlayerMatch = {
      player_id: p.id,
      player_name: p.name,
      normalized_name: normalizedName,
      team: p.team ?? null,
      position_group: p.position_group ?? null,
      match_method: 'id',
    };

    if (p.id) byId.set(p.id, match);

    // Store all candidates by normalized name
    if (normalizedName) {
      if (!allCandidatesByName.has(normalizedName)) {
        allCandidatesByName.set(normalizedName, []);
      }
      allCandidatesByName.get(normalizedName)!.push(match);

      // Primary key: first match wins for backward compat (but allCandidates has all)
      if (!byNormalizedName.has(normalizedName)) {
        byNormalizedName.set(normalizedName, match);
      }
    }

    // Key with team: name + team (for disambiguation)
    if (normalizedName && p.team) {
      const teamNorm = normalizeTeamKeyForMatch(p.team);
      const nameTeamKey = `${normalizedName}|${teamNorm}`;
      if (!byNormalizedName.has(nameTeamKey)) {
        byNormalizedName.set(nameTeamKey, match);
      }
    }
  }

  return { byId, byNormalizedName, allCandidatesByName };
}

/**
 * Resolve a bookmaker player name to a player match.
 * Resolver order:
 * 1. Existing valid bookmaker_odds.player_id
 * 2. Exact normalized full name (single candidate)
 * 3. Exact normalized full name + team disambiguation (multiple candidates)
 * 4. Alias lookup
 * 5. PLAYER_UNRESOLVED
 */
export function resolvePlayer(
  bookmakerPlayerName: string,
  bookmakerPlayerId: string | null,
  cache: PlayerMatchCache
): PlayerMatch {
  // 1. Try by ID if available
  if (bookmakerPlayerId && cache.byId.has(bookmakerPlayerId)) {
    const match = cache.byId.get(bookmakerPlayerId)!;
    return { ...match, match_method: 'id' };
  }

  // 2. Try exact normalized name match
  const normalizedBookmakerName = normalizePlayerName(bookmakerPlayerName);
  if (normalizedBookmakerName) {
    const candidates = cache.allCandidatesByName.get(normalizedBookmakerName);
    if (candidates && candidates.length === 1) {
      return { ...candidates[0], match_method: 'exact_name' };
    }
    // If multiple candidates, we can't resolve without team info here
    // The modelResolver will handle team disambiguation separately
    if (candidates && candidates.length > 1) {
      // Return the first candidate — modelResolver will confirm via team
      // This is a temporary resolution; the relink function does it properly
      return { ...candidates[0], match_method: 'normalized_name' };
    }
    // Fall through to byNormalizedName (includes last-name keys etc.)
    if (cache.byNormalizedName.has(normalizedBookmakerName)) {
      const match = cache.byNormalizedName.get(normalizedBookmakerName)!;
      return { ...match, match_method: 'normalized_name' };
    }
  }

  // 3. Try alias match — bookmaker may use nickname
  const canonicalFromAlias = findPlayerByAlias(bookmakerPlayerName);
  if (canonicalFromAlias) {
    const normalizedCanonical = normalizePlayerName(canonicalFromAlias);
    if (normalizedCanonical) {
      const candidates = cache.allCandidatesByName.get(normalizedCanonical);
      if (candidates && candidates.length === 1) {
        return { ...candidates[0], match_method: 'exact_name' };
      }
      if (cache.byNormalizedName.has(normalizedCanonical)) {
        const match = cache.byNormalizedName.get(normalizedCanonical)!;
        return { ...match, match_method: 'normalized_name' };
      }
    }
  }

  // 4. No match - return unknown
  return {
    player_id: null,
    player_name: bookmakerPlayerName,
    normalized_name: normalizedBookmakerName,
    team: null,
    position_group: null,
    match_method: 'none',
  };
}

/**
 * Determine player team from multiple sources
 * Priority:
 * 1. bookmaker_odds.team (if available - but this column may not exist)
 * 2. players.team by player_id
 * 3. players.team by normalized name
 * 4. Infer from match teams if player appears in stats for one side
 */
export async function resolvePlayerTeam(
  playerId: string | null,
  playerName: string,
  matchId: string,
  matchHomeTeam: string | null,
  matchAwayTeam: string | null,
  cache: PlayerMatchCache
): Promise<{ team: string | null; method: string }> {
  // 1. Check by player_id
  if (playerId && cache.byId.has(playerId)) {
    const match = cache.byId.get(playerId)!;
    if (match.team) {
      return { team: match.team, method: 'players.id' };
    }
  }

  // 2. Check by normalized name
  const normalizedName = normalizePlayerName(playerName);
  if (normalizedName && cache.byNormalizedName.has(normalizedName)) {
    const match = cache.byNormalizedName.get(normalizedName)!;
    if (match.team) {
      return { team: match.team, method: 'players.name' };
    }
  }

  // 3. Try to infer from player_game_stats for this match
  // This is expensive, so only do it if we have match info
  if (matchId && (matchHomeTeam || matchAwayTeam)) {
    // Look for stats for this player in this match
    const { data: stats } = await supabase
      .from('player_game_stats')
      .select('player_id, team')
      .eq('match_id', matchId)
      .limit(100);

    if (stats && stats.length > 0) {
      // Try to match by player_id first
      if (playerId) {
        const statRow = stats.find(s => s.player_id === playerId);
        if (statRow?.team) {
          return { team: statRow.team, method: 'stats.match_id' };
        }
      }

      // Try to match by normalized name
      if (normalizedName) {
        // Need to get player names for the stats
        const statPlayerIds = [...new Set(stats.map(s => s.player_id).filter(Boolean))] as string[];
        if (statPlayerIds.length > 0) {
          const { data: statPlayers } = await supabase
            .from('players')
            .select('id, name')
            .in('id', statPlayerIds);

          if (statPlayers) {
            for (const sp of statPlayers) {
              if (normalizePlayerName(sp.name) === normalizedName) {
                const statRow = stats.find(s => s.player_id === sp.id);
                if (statRow?.team) {
                  return { team: statRow.team, method: 'stats.match_name' };
                }
              }
            }
          }
        }
      }
    }
  }

  return { team: null, method: 'none' };
}

/**
 * Search for players by name, with alias expansion.
 * Returns all PlayerMatch entries that match the search term.
 */
export function searchPlayersWithAliases(
  searchTerm: string,
  cache: PlayerMatchCache
): PlayerMatch[] {
  const results: PlayerMatch[] = [];
  const seen = new Set<string>();

  const expandedTerms = expandSearchWithAliases(searchTerm);
  for (const term of expandedTerms) {
    const normalized = normalizePlayerName(term);
    if (normalized && cache.byNormalizedName.has(normalized)) {
      const match = cache.byNormalizedName.get(normalized)!;
      if (match.player_id && !seen.has(match.player_id)) {
        seen.add(match.player_id);
        results.push(match);
      }
    }
  }

  return results;
}

// ============================================================================
// Round Odds Relinker — permanently links bookmaker_odds.player_id
// ============================================================================

export interface RelinkResult {
  totalOddsRows: number;
  uniqueBookmakerPlayers: number;
  uniqueResolvedPlayers: number;
  uniqueUnresolvedPlayers: number;
  oddsRowsRelinked: number;
  oddsRowsStillUnresolved: number;
  unresolvedPlayers: Array<{
    bookmakerName: string;
    match: string;
    exactNameCandidateCount: number;
    candidatePlayerIds: string[];
    candidateTeams: string[];
    latestStatsTeams: string[];
    reasonNotLinked: string;
  }>;
  resolvedPlayers: Array<{
    bookmakerName: string;
    match: string;
    resolvedPlayerId: string;
    resolvedTeam: string;
    oddsRowsRelinked: number;
  }>;
}

/**
 * Determine a player's current team using priority:
 * 1. Latest 2026 player_game_stats.team
 * 2. Latest player_game_stats.team (any season)
 * 3. players.team (fallback)
 */
async function resolveCurrentTeam(
  playerId: string,
  playersTeam: string | null
): Promise<string | null> {
  // Try latest 2026 stats first
  const { data: latest2026 } = await supabase
    .from('player_game_stats')
    .select('team')
    .eq('player_id', playerId)
    .gte('match_date', '2026-01-01')
    .order('match_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latest2026?.team) return latest2026.team;

  // Try latest historical stats (any season)
  const { data: latestAny } = await supabase
    .from('player_game_stats')
    .select('team')
    .eq('player_id', playerId)
    .order('match_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latestAny?.team) return latestAny.team;

  // Fallback to players.team
  return playersTeam ?? null;
}

/**
 * Relink Round 19 bookmaker_odds rows to canonical players.
 *
 * For each unique bookmaker player name:
 * 1. Normalize the full name
 * 2. Find all exact normalized-name candidates from the complete players table
 * 3. Determine the player's current team (latest stats → players.team)
 * 4. Compare that team against the Round 19 match home/away teams
 * 5. Select the exact-name candidate whose current team belongs to that match
 * 6. Update all corresponding bookmaker_odds.player_id rows
 *
 * No surname matching. No partial-name matching.
 */
export async function relinkRoundOddsToCanonicalPlayers(
  matchIds: string[]
): Promise<RelinkResult> {
  const result: RelinkResult = {
    totalOddsRows: 0,
    uniqueBookmakerPlayers: 0,
    uniqueResolvedPlayers: 0,
    uniqueUnresolvedPlayers: 0,
    oddsRowsRelinked: 0,
    oddsRowsStillUnresolved: 0,
    unresolvedPlayers: [],
    resolvedPlayers: [],
  };

  if (matchIds.length === 0) return result;

  // 1. Fetch all bookmaker_odds rows for the selected matches (paginated)
  const allOddsRows: any[] = [];
  const PAGE_SIZE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('bookmaker_odds')
      .select('id, bookmaker_player_name, player_id, match_id')
      .in('match_id', matchIds)
      .range(from, from + PAGE_SIZE - 1);
    if (error) break;
    if (!data || data.length === 0) break;
    allOddsRows.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  result.totalOddsRows = allOddsRows.length;

  // 2. Fetch matches for team lookup
  const { data: matchesData } = await supabase
    .from('matches')
    .select('id, home_team, away_team')
    .in('id', matchIds);
  const matchMap = new Map<string, { home_team: string | null; away_team: string | null }>();
  for (const m of matchesData ?? []) {
    matchMap.set(m.id, { home_team: m.home_team, away_team: m.away_team });
  }

  // 3. Load ALL players with pagination
  const allPlayers = await fetchAllPlayers();

  // Build normalized name → candidates map
  const playersByName = new Map<string, RawPlayer[]>();
  for (const p of allPlayers) {
    const norm = normalizePlayerName(p.name);
    if (!norm) continue;
    if (!playersByName.has(norm)) playersByName.set(norm, []);
    playersByName.get(norm)!.push(p);
  }

  // 4. Group odds rows by (normalized bookmaker name, match_id)
  const oddsGroups = new Map<string, { bookmakerName: string; matchId: string; rowIds: string[] }>();
  for (const row of allOddsRows) {
    const normName = normalizePlayerName(row.bookmaker_player_name);
    const key = `${normName}|${row.match_id}`;
    if (!oddsGroups.has(key)) {
      oddsGroups.set(key, { bookmakerName: row.bookmaker_player_name, matchId: row.match_id, rowIds: [] });
    }
    oddsGroups.get(key)!.rowIds.push(row.id);
  }

  result.uniqueBookmakerPlayers = oddsGroups.size;

  // 5. Process each group
  const updateBatch: { rowIds: string[]; playerId: string }[] = [];

  for (const [key, group] of oddsGroups) {
    const normName = normalizePlayerName(group.bookmakerName);
    const matchTeams = matchMap.get(group.matchId);
    if (!matchTeams) continue;

    const candidates = playersByName.get(normName) ?? [];
    const matchHomeCanonical = normalizeTeamToCanonical(matchTeams.home_team);
    const matchAwayCanonical = normalizeTeamToCanonical(matchTeams.away_team);

    let resolvedPlayer: RawPlayer | null = null;
    let resolvedTeam: string | null = null;
    let reason = '';

    if (candidates.length === 0) {
      reason = 'No exact name match in players table';
    } else if (candidates.length === 1) {
      // Single candidate — resolve team to confirm
      const candidate = candidates[0];
      const currentTeam = await resolveCurrentTeam(candidate.id, candidate.team);
      const teamCanonical = normalizeTeamToCanonical(currentTeam);
      if (teamCanonical === matchHomeCanonical || teamCanonical === matchAwayCanonical) {
        resolvedPlayer = candidate;
        resolvedTeam = currentTeam;
      } else if (!currentTeam) {
        // No team info at all — accept the single candidate
        resolvedPlayer = candidate;
        resolvedTeam = candidate.team ?? null;
      } else {
        reason = `Single candidate team "${currentTeam}" does not match ${matchTeams.home_team} vs ${matchTeams.away_team}`;
      }
    } else {
      // Multiple candidates — must disambiguate by team
      let matchFound = false;
      for (const candidate of candidates) {
        const currentTeam = await resolveCurrentTeam(candidate.id, candidate.team);
        const teamCanonical = normalizeTeamToCanonical(currentTeam);
        if (teamCanonical === matchHomeCanonical || teamCanonical === matchAwayCanonical) {
          resolvedPlayer = candidate;
          resolvedTeam = currentTeam;
          matchFound = true;
          break;
        }
      }
      if (!matchFound) {
        // Gather diagnostics for all candidates
        const candidateTeams: string[] = [];
        const latestStatsTeams: string[] = [];
        for (const c of candidates) {
          const t = await resolveCurrentTeam(c.id, c.team);
          candidateTeams.push(t ?? c.team ?? 'null');
          latestStatsTeams.push(t ?? 'null');
        }
        result.unresolvedPlayers.push({
          bookmakerName: group.bookmakerName,
          match: `${matchTeams.home_team} vs ${matchTeams.away_team}`,
          exactNameCandidateCount: candidates.length,
          candidatePlayerIds: candidates.map(c => c.id),
          candidateTeams,
          latestStatsTeams,
          reasonNotLinked: `Multiple candidates (${candidates.length}) but none matched match teams`,
        });
      }
    }

    if (resolvedPlayer) {
      updateBatch.push({ rowIds: group.rowIds, playerId: resolvedPlayer.id });
      result.resolvedPlayers.push({
        bookmakerName: group.bookmakerName,
        match: `${matchTeams.home_team} vs ${matchTeams.away_team}`,
        resolvedPlayerId: resolvedPlayer.id,
        resolvedTeam: resolvedTeam ?? resolvedPlayer.team ?? 'unknown',
        oddsRowsRelinked: group.rowIds.length,
      });
    } else if (reason) {
      result.unresolvedPlayers.push({
        bookmakerName: group.bookmakerName,
        match: `${matchTeams.home_team} vs ${matchTeams.away_team}`,
        exactNameCandidateCount: candidates.length,
        candidatePlayerIds: candidates.map(c => c.id),
        candidateTeams: candidates.map(c => c.team ?? 'null'),
        latestStatsTeams: [],
        reasonNotLinked: reason,
      });
    }
  }

  // 6. Batch update bookmaker_odds.player_id
  for (const { rowIds, playerId } of updateBatch) {
    // Update in safe batches of 200
    for (let i = 0; i < rowIds.length; i += 200) {
      const batch = rowIds.slice(i, i + 200);
      const { error } = await supabase
        .from('bookmaker_odds')
        .update({ player_id: playerId })
        .in('id', batch);
      if (error) {
        console.error('[Relink] Error updating batch:', error.message);
      }
    }
    result.oddsRowsRelinked += rowIds.length;
  }

  result.uniqueResolvedPlayers = result.resolvedPlayers.length;
  result.uniqueUnresolvedPlayers = result.unresolvedPlayers.length;
  result.oddsRowsStillUnresolved = result.totalOddsRows - result.oddsRowsRelinked;

  console.log('[Relink] Result:', {
    totalOddsRows: result.totalOddsRows,
    uniqueBookmakerPlayers: result.uniqueBookmakerPlayers,
    uniqueResolvedPlayers: result.uniqueResolvedPlayers,
    uniqueUnresolvedPlayers: result.uniqueUnresolvedPlayers,
    oddsRowsRelinked: result.oddsRowsRelinked,
    oddsRowsStillUnresolved: result.oddsRowsStillUnresolved,
  });

  return result;
}
