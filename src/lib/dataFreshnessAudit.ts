import { supabase } from './supabase';
import { normalizeTeamName } from './positionEdge';
import { normalizeVenueKey } from './matchupEdge';

export type FreshnessStatus =
  | 'Fresh'
  | 'Missing last game'
  | 'No current season data'
  | 'No historical stats'
  | 'Team mismatch'
  | 'Duplicate player issue'
  | 'Match_id missing'
  | 'Needs review'
  | 'No last-round game found — possible bye/DNP';

export interface PlayerFreshnessRow {
  playerId: string | null;
  playerName: string;
  team: string | null;
  opponent: string | null;
  latestStatDate: string | null;
  latestStatSeason: number | null;
  latestStatRound: string | null;
  latestStatOpponent: string | null;
  latestStatVenue: string | null;
  latestDisposals: number | null;
  latestMarks: number | null;
  latestTackles: number | null;
  latestGoals: number | null;
  latestHitouts: number | null;
  totalGames: number;
  gamesThisSeason: number;
  expectedLatestRound: string | null;
  status: FreshnessStatus;
  statusReason: string;
  positionGroup: string | null;
  hasOdds: boolean;
}

export interface MatchFreshnessSummary {
  matchId: string;
  matchLabel: string;
  round: string | null;
  season: number;
  venue: string | null;
  playersWithOdds: number;
  playersMatchedToStats: number;
  playersWithLatestGame: number;
  playersMissingLatestGame: number;
  playersWithNoCurrentSeason: number;
  playersWithUnknownPosition: number;
  status: 'Ready' | 'Warning' | 'Broken';
  statusReasons: string[];
}

export interface RoundFreshnessResult {
  summaries: MatchFreshnessSummary[];
  playerRows: PlayerFreshnessRow[];
  expectedLatestRound: string | null;
  latestCompletedRound: string | null;
  latestCompletedMatchDate: string | null;
  totalPlayersWithOdds: number;
  totalPlayersMatched: number;
  totalPlayersWithLatestGame: number;
  totalPlayersMissingLatest: number;
  totalUnknownPosition: number;
  readiness: {
    playerMatchingPct: number;
    currentSeasonCoveragePct: number;
    latestGameCoveragePct: number;
    unknownPositionPct: number;
  };
  targetReadiness: {
    playerMatching: number;
    currentSeasonCoverage: number;
    latestGameCoverage: number;
    unknownPosition: number;
  };
  meetsTargets: boolean;
}

export interface PlayerSpotCheck {
  playerId: string | null;
  playerName: string;
  team: string | null;
  positionGroup: string | null;
  last5Games: StatGameRow[];
  last10Games: StatGameRow[];
  currentSeasonGames: StatGameRow[];
  latestGame: StatGameRow | null;
  latestGameIsFromLastCompletedRound: boolean;
  modelSample: {
    sampleSize: number;
    firstGameDate: string | null;
    latestGameDate: string | null;
    latestRound: string | null;
    latestOpponent: string | null;
    latestDisposals: number | null;
  };
  venueSampleGames: StatGameRow[];
  opponentSampleGames: StatGameRow[];
}

export interface StatGameRow {
  match_date: string;
  match_id: string | null;
  season: number | null;
  round: string | null;
  team: string | null;
  opponent: string | null;
  venue: string | null;
  disposals: number;
  marks: number;
  tackles: number;
  goals: number;
  hitouts: number;
}

function inferSeasonFromDate(dateStr: string): number {
  const d = new Date(dateStr);
  return d.getFullYear();
}

function getCurrentSeason(matchSeason?: number | null): number {
  if (matchSeason) return matchSeason;
  return new Date().getFullYear();
}

export async function getLatestCompletedRound(season: number): Promise<{ round: string | null; matchDate: string | null }> {
  const { data } = await supabase
    .from('matches')
    .select('round, match_date')
    .eq('season', season)
    .lt('match_date', new Date().toISOString().split('T')[0])
    .order('match_date', { ascending: false })
    .limit(1);
  if (data && data.length > 0) {
    return { round: data[0].round, matchDate: data[0].match_date };
  }
  return { round: null, matchDate: null };
}

export async function getUpcomingMatches(): Promise<{ id: string; season: number; round: string | null; home_team: string | null; away_team: string | null; venue: string | null; match_date: string | null }[]> {
  const today = new Date().toISOString().split('T')[0];
  const { data } = await supabase
    .from('matches')
    .select('id, season, round, home_team, away_team, venue, match_date')
    .gte('match_date', today)
    .order('commence_time_utc', { ascending: true, nullsFirst: false })
    .limit(20);
  return data ?? [];
}

export async function getOddsPlayersForMatch(matchId: string): Promise<{ bookmaker_player_name: string; player_id: string | null }[]> {
  const { data } = await supabase
    .from('bookmaker_odds')
    .select('bookmaker_player_name, player_id')
    .eq('match_id', matchId);
  const map = new Map<string, { bookmaker_player_name: string; player_id: string | null }>();
  for (const r of data ?? []) {
    const key = r.bookmaker_player_name;
    if (!map.has(key)) {
      map.set(key, { bookmaker_player_name: r.bookmaker_player_name, player_id: r.player_id });
    }
  }
  return Array.from(map.values());
}

export async function resolvePlayerByName(name: string): Promise<string | null> {
  const { data } = await supabase
    .from('players')
    .select('id, name')
    .ilike('name', name)
    .limit(1);
  return data && data.length > 0 ? data[0].id : null;
}

export async function getPlayerInfo(playerIds: string[]): Promise<Map<string, { name: string; team: string; position_group: string }>> {
  const map = new Map<string, { name: string; team: string; position_group: string }>();
  if (playerIds.length === 0) return map;
  const { data } = await supabase
    .from('players')
    .select('id, name, team, position_group')
    .in('id', playerIds);
  for (const p of data ?? []) {
    map.set(p.id, { name: p.name, team: p.team, position_group: p.position_group ?? 'UNKNOWN' });
  }
  return map;
}

export async function getPlayerStatsWithMatchInfo(playerId: string): Promise<StatGameRow[]> {
  const { data: stats } = await supabase
    .from('player_game_stats')
    .select('match_id, match_date, team, opponent, venue, disposals, marks, tackles, goals, hitouts')
    .eq('player_id', playerId)
    .order('match_date', { ascending: false });
  if (!stats || stats.length === 0) return [];
  const matchIds = [...new Set(stats.map(s => s.match_id).filter(Boolean))] as string[];
  const matchInfoMap = new Map<string, { venue: string | null; home_team: string | null; away_team: string | null; round: string | null; season: number | null }>();
  if (matchIds.length > 0) {
    const { data: matches } = await supabase
      .from('matches')
      .select('id, venue, home_team, away_team, round, season')
      .in('id', matchIds);
    for (const m of matches ?? []) {
      matchInfoMap.set(m.id, { venue: m.venue, home_team: m.home_team, away_team: m.away_team, round: m.round, season: m.season });
    }
  }
  const rows: StatGameRow[] = [];
  for (const s of stats) {
    const mi = s.match_id ? matchInfoMap.get(s.match_id) : null;
    const team = s.team;
    let opponent = s.opponent;
    let venue = s.venue || mi?.venue || null;
    if (!opponent && team && mi) {
      const teamNorm = normalizeTeamName(team);
      const homeNorm = normalizeTeamName(mi.home_team || '');
      const awayNorm = normalizeTeamName(mi.away_team || '');
      if (teamNorm === homeNorm) opponent = mi.away_team;
      else if (teamNorm === awayNorm) opponent = mi.home_team;
    }
    rows.push({
      match_date: s.match_date,
      match_id: s.match_id,
      season: mi?.season ?? null,
      round: mi?.round ?? null,
      team,
      opponent,
      venue,
      disposals: Number(s.disposals) || 0,
      marks: Number(s.marks) || 0,
      tackles: Number(s.tackles) || 0,
      goals: Number(s.goals) || 0,
      hitouts: Number(s.hitouts) || 0,
    });
  }
  return rows;
}

/**
 * Batch version of getPlayerStatsWithMatchInfo — fetches stats for many players in 2 queries
 * instead of 2N queries. Returns a map of playerId -> StatGameRow[]
 */
export async function getPlayerStatsBatched(playerIds: string[]): Promise<Map<string, StatGameRow[]>> {
  const result = new Map<string, StatGameRow[]>();
  if (playerIds.length === 0) return result;

  // Query 1: fetch all stats for all players at once
  const { data: allStats } = await supabase
    .from('player_game_stats')
    .select('player_id, match_id, match_date, team, opponent, venue, disposals, marks, tackles, goals, hitouts')
    .in('player_id', playerIds)
    .order('match_date', { ascending: false });

  if (!allStats || allStats.length === 0) return result;

  // Collect all match_ids for a single batch query
  const allMatchIds = new Set<string>();
  for (const s of allStats) {
    if (s.match_id) allMatchIds.add(s.match_id);
  }

  // Query 2: fetch match info for all matches at once
  const matchInfoMap = new Map<string, { venue: string | null; home_team: string | null; away_team: string | null; round: string | null; season: number | null }>();
  if (allMatchIds.size > 0) {
    const { data: matches } = await supabase
      .from('matches')
      .select('id, venue, home_team, away_team, round, season')
      .in('id', [...allMatchIds]);
    for (const m of matches ?? []) {
      matchInfoMap.set(m.id, { venue: m.venue, home_team: m.home_team, away_team: m.away_team, round: m.round, season: m.season });
    }
  }

  // Group stats by player
  for (const s of allStats) {
    const pid = s.player_id as string;
    if (!result.has(pid)) result.set(pid, []);
    const mi = s.match_id ? matchInfoMap.get(s.match_id) : null;
    const team = s.team;
    let opponent = s.opponent;
    let venue = s.venue || mi?.venue || null;
    if (!opponent && team && mi) {
      const teamNorm = normalizeTeamName(team);
      const homeNorm = normalizeTeamName(mi.home_team || '');
      const awayNorm = normalizeTeamName(mi.away_team || '');
      if (teamNorm === homeNorm) opponent = mi.away_team;
      else if (teamNorm === awayNorm) opponent = mi.home_team;
    }
    result.get(pid)!.push({
      match_date: s.match_date,
      match_id: s.match_id,
      season: mi?.season ?? null,
      round: mi?.round ?? null,
      team,
      opponent,
      venue,
      disposals: Number(s.disposals) || 0,
      marks: Number(s.marks) || 0,
      tackles: Number(s.tackles) || 0,
      goals: Number(s.goals) || 0,
      hitouts: Number(s.hitouts) || 0,
    });
  }

  return result;
}

/**
 * Batch version of auditRoundFreshness — audits multiple matches with batched queries
 * instead of per-player sequential queries
 */
export async function auditMultipleMatchesFreshness(
  matchInfos: { id: string; season: number; home_team: string | null; away_team: string | null }[],
  expectedLatestRound: string | null
): Promise<Map<string, PlayerFreshnessRow[]>> {
  const result = new Map<string, PlayerFreshnessRow[]>();
  if (matchInfos.length === 0) return result;

  // Batch 1: Get all odds players for all matches at once
  const matchIds = matchInfos.map(m => m.id);
  const { data: allOdds } = await supabase
    .from('bookmaker_odds')
    .select('match_id, bookmaker_player_name, player_id')
    .in('match_id', matchIds);

  // Group odds by match_id, deduplicate by player name
  const oddsByMatch = new Map<string, Map<string, { bookmaker_player_name: string; player_id: string | null }>>();
  for (const r of allOdds ?? []) {
    if (!oddsByMatch.has(r.match_id)) oddsByMatch.set(r.match_id, new Map());
    const map = oddsByMatch.get(r.match_id)!;
    if (!map.has(r.bookmaker_player_name)) {
      map.set(r.bookmaker_player_name, { bookmaker_player_name: r.bookmaker_player_name, player_id: r.player_id });
    }
  }

  // Collect all player IDs across all matches
  const allPlayerIds = new Set<string>();
  const unresolvedNames = new Set<string>();
  for (const [, map] of oddsByMatch) {
    for (const [, op] of map) {
      if (op.player_id) allPlayerIds.add(op.player_id);
      else unresolvedNames.add(op.bookmaker_player_name);
    }
  }

  // Batch 2: Resolve unresolved player names (batch ilike query)
  const resolvedNames = new Map<string, string>();
  if (unresolvedNames.size > 0) {
    // Use a single query with OR conditions
    const nameFilters = [...unresolvedNames].slice(0, 50).map(n => `name.ilike.${n}`).join(',');
    const { data: resolvedPlayers } = await supabase
      .from('players')
      .select('id, name')
      .or(nameFilters);
    for (const p of resolvedPlayers ?? []) {
      for (const n of unresolvedNames) {
        if (p.name.toLowerCase() === n.toLowerCase()) {
          resolvedNames.set(n, p.id);
          allPlayerIds.add(p.id);
        }
      }
    }
  }

  // Batch 3: Get player info for all resolved IDs
  const playerInfoMap = new Map<string, { name: string; team: string; position_group: string }>();
  if (allPlayerIds.size > 0) {
    const infoMap = await getPlayerInfo([...allPlayerIds]);
    for (const [id, info] of infoMap) playerInfoMap.set(id, info);
  }

  // Batch 4: Get all stats for all players at once
  const statsMap = await getPlayerStatsBatched([...allPlayerIds]);

  // Now build freshness rows per match
  for (const m of matchInfos) {
    const matchOdds = oddsByMatch.get(m.id);
    if (!matchOdds) {
      result.set(m.id, []);
      continue;
    }

    const homeTeam = m.home_team;
    const awayTeam = m.away_team;
    const rows: PlayerFreshnessRow[] = [];

    for (const [, op] of matchOdds) {
      const playerId = op.player_id || resolvedNames.get(op.bookmaker_player_name) || null;
      const info = playerId ? playerInfoMap.get(playerId) : null;
      const playerName = op.bookmaker_player_name;
      const team = info?.team ?? null;
      let opponent: string | null = null;
      if (team) {
        const teamNorm = normalizeTeamName(team);
        if (teamNorm === normalizeTeamName(homeTeam)) opponent = awayTeam;
        else if (teamNorm === normalizeTeamName(awayTeam)) opponent = homeTeam;
      }
      const stats = playerId ? (statsMap.get(playerId) ?? []) : [];
      const totalGames = stats.length;
      const currentSeason = getCurrentSeason(m.season);
      const seasonGames = stats.filter(s => (s.season ?? inferSeasonFromDate(s.match_date)) === currentSeason);
      const gamesThisSeason = seasonGames.length;
      const latest = stats.length > 0 ? stats[0] : null;
      let status: FreshnessStatus = 'Needs review';
      let statusReason = '';
      if (totalGames === 0) {
        status = 'No historical stats';
        statusReason = 'No player_game_stats rows found for this player';
      } else if (gamesThisSeason === 0) {
        status = 'No current season data';
        statusReason = `No stats found for season ${currentSeason}`;
      } else if (expectedLatestRound && latest) {
        const latestRoundNum = parseInt(latest.round ?? '0', 10);
        const expectedRoundNum = parseInt(expectedLatestRound, 10);
        if (!isNaN(latestRoundNum) && !isNaN(expectedRoundNum) && latestRoundNum < expectedRoundNum) {
          const teamNorm = team ? normalizeTeamName(team) : '';
          const teamPlayedLastRound = teamNorm && (teamNorm === normalizeTeamName(homeTeam) || teamNorm === normalizeTeamName(awayTeam) || false);
          if (teamPlayedLastRound) {
            status = 'Missing last game';
            statusReason = `Latest stat is Round ${latest.round} but expected Round ${expectedLatestRound}. Team played Round ${expectedLatestRound} but stats not loaded.`;
          } else {
            status = 'No last-round game found — possible bye/DNP';
            statusReason = `Latest stat is Round ${latest.round}. Team may have had a bye or player did not play in Round ${expectedLatestRound}.`;
          }
        } else {
          status = 'Fresh';
          statusReason = `Latest game Round ${latest.round} matches expected latest completed round`;
        }
      } else if (latest) {
        status = 'Fresh';
        statusReason = `Latest game Round ${latest.round}`;
      }

      rows.push({
        playerName,
        playerId,
        team,
        opponent,
        positionGroup: info?.position_group ?? 'UNKNOWN',
        totalGames,
        gamesThisSeason,
        latestRound: latest?.round ?? null,
        latestMatchDate: latest?.match_date ?? null,
        latestVenue: latest?.venue ?? null,
        latestOpponent: latest?.opponent ?? null,
        latestDisposals: latest?.disposals ?? null,
        status,
        statusReason,
      });
    }
    result.set(m.id, rows);
  }

  return result;
}

export async function auditRoundFreshness(
  matchId: string,
  matchSeason: number,
  expectedLatestRound: string | null
): Promise<PlayerFreshnessRow[]> {
  const oddsPlayers = await getOddsPlayersForMatch(matchId);
  const playerInfoMap = new Map<string, { name: string; team: string; position_group: string }>();
  const allPlayerIds = new Set<string>();
  for (const op of oddsPlayers) {
    if (op.player_id) {
      allPlayerIds.add(op.player_id);
    }
  }
  if (allPlayerIds.size > 0) {
    const infoMap = await getPlayerInfo([...allPlayerIds]);
    for (const [id, info] of infoMap) playerInfoMap.set(id, info);
  }
  const resolvedByName = new Map<string, string>();
  for (const op of oddsPlayers) {
    if (!op.player_id) {
      const resolved = await resolvePlayerByName(op.bookmaker_player_name);
      if (resolved) {
        resolvedByName.set(op.bookmaker_player_name, resolved);
        allPlayerIds.add(resolved);
        if (!playerInfoMap.has(resolved)) {
          const info = await getPlayerInfo([resolved]);
          for (const [id, i] of info) playerInfoMap.set(id, i);
        }
      }
    }
  }
  const match = await supabase.from('matches').select('home_team, away_team').eq('id', matchId).maybeSingle();
  const homeTeam = match.data?.home_team ?? null;
  const awayTeam = match.data?.away_team ?? null;
  const rows: PlayerFreshnessRow[] = [];
  for (const op of oddsPlayers) {
    const playerId = op.player_id || resolvedByName.get(op.bookmaker_player_name) || null;
    const info = playerId ? playerInfoMap.get(playerId) : null;
    const playerName = op.bookmaker_player_name;
    const team = info?.team ?? null;
    let opponent: string | null = null;
    if (team) {
      const teamNorm = normalizeTeamName(team);
      if (teamNorm === normalizeTeamName(homeTeam)) opponent = awayTeam;
      else if (teamNorm === normalizeTeamName(awayTeam)) opponent = homeTeam;
    }
    let stats: StatGameRow[] = [];
    if (playerId) stats = await getPlayerStatsWithMatchInfo(playerId);
    const totalGames = stats.length;
    const currentSeason = getCurrentSeason(matchSeason);
    const seasonGames = stats.filter(s => (s.season ?? inferSeasonFromDate(s.match_date)) === currentSeason);
    const gamesThisSeason = seasonGames.length;
    const latest = stats.length > 0 ? stats[0] : null;
    let status: FreshnessStatus = 'Needs review';
    let statusReason = '';
    if (totalGames === 0) {
      status = 'No historical stats';
      statusReason = 'No player_game_stats rows found for this player';
    } else if (gamesThisSeason === 0) {
      status = 'No current season data';
      statusReason = `No stats found for season ${currentSeason}`;
    } else if (expectedLatestRound && latest) {
      const latestRoundNum = parseInt(latest.round ?? '0', 10);
      const expectedRoundNum = parseInt(expectedLatestRound, 10);
      if (!isNaN(latestRoundNum) && !isNaN(expectedRoundNum) && latestRoundNum < expectedRoundNum) {
        const teamNorm = team ? normalizeTeamName(team) : '';
        const latestOpp = latest.opponent ? normalizeTeamName(latest.opponent) : '';
        const teamPlayedLastRound = teamNorm && (teamNorm === normalizeTeamName(homeTeam) || teamNorm === normalizeTeamName(awayTeam) || false);
        if (teamPlayedLastRound) {
          status = 'Missing last game';
          statusReason = `Latest stat is Round ${latest.round} but expected Round ${expectedLatestRound}. Team played Round ${expectedLatestRound} but stats not loaded.`;
        } else {
          status = 'No last-round game found — possible bye/DNP';
          statusReason = `Latest stat is Round ${latest.round}. Team may have had a bye or player did not play in Round ${expectedLatestRound}.`;
        }
      } else {
        status = 'Fresh';
        statusReason = `Latest game Round ${latest.round} matches expected latest completed round`;
      }
    } else if (latest) {
      status = 'Fresh';
      statusReason = 'Latest game data available';
    } else {
      status = 'Needs review';
      statusReason = 'Unable to determine freshness';
    }
    if (team && (homeTeam || awayTeam)) {
      const teamNorm = normalizeTeamName(team);
      if (teamNorm !== normalizeTeamName(homeTeam) && teamNorm !== normalizeTeamName(awayTeam)) {
        status = 'Team mismatch';
        statusReason = `Player team "${team}" does not match match teams ${homeTeam} vs ${awayTeam}`;
      }
    }
    if (latest && !latest.match_id) {
      if (status === 'Fresh') {
        status = 'Match_id missing';
        statusReason = 'Latest stat row has no match_id — cannot verify round/venue';
      }
    }
    rows.push({
      playerId,
      playerName,
      team,
      opponent,
      latestStatDate: latest?.match_date ?? null,
      latestStatSeason: latest ? (latest.season ?? inferSeasonFromDate(latest.match_date)) : null,
      latestStatRound: latest?.round ?? null,
      latestStatOpponent: latest?.opponent ?? null,
      latestStatVenue: latest?.venue ?? null,
      latestDisposals: latest?.disposals ?? null,
      latestMarks: latest?.marks ?? null,
      latestTackles: latest?.tackles ?? null,
      latestGoals: latest?.goals ?? null,
      latestHitouts: latest?.hitouts ?? null,
      totalGames,
      gamesThisSeason,
      expectedLatestRound,
      status,
      statusReason,
      positionGroup: info?.position_group ?? null,
      hasOdds: true,
    });
  }
  return rows;
}

export async function auditFullRoundFreshness(): Promise<RoundFreshnessResult> {
  const upcoming = await getUpcomingMatches();
  if (upcoming.length === 0) {
    return {
      summaries: [],
      playerRows: [],
      expectedLatestRound: null,
      latestCompletedRound: null,
      latestCompletedMatchDate: null,
      totalPlayersWithOdds: 0,
      totalPlayersMatched: 0,
      totalPlayersWithLatestGame: 0,
      totalPlayersMissingLatest: 0,
      totalUnknownPosition: 0,
      readiness: { playerMatchingPct: 0, currentSeasonCoveragePct: 0, latestGameCoveragePct: 0, unknownPositionPct: 0 },
      targetReadiness: { playerMatching: 90, currentSeasonCoverage: 85, latestGameCoverage: 80, unknownPosition: 10 },
      meetsTargets: false,
    };
  }
  const firstMatch = upcoming[0];
  const season = firstMatch.season;
  const { round: latestCompletedRound, matchDate: latestCompletedMatchDate } = await getLatestCompletedRound(season);
  const expectedLatestRound = latestCompletedRound;
  const summaries: MatchFreshnessSummary[] = [];
  const allPlayerRows: PlayerFreshnessRow[] = [];
  let totalPlayersWithOdds = 0;
  let totalPlayersMatched = 0;
  let totalPlayersWithLatestGame = 0;
  let totalPlayersMissingLatest = 0;
  let totalPlayersWithNoCurrentSeason = 0;
  let totalUnknownPosition = 0;
  for (const m of upcoming) {
    const rows = await auditRoundFreshness(m.id, m.season, expectedLatestRound);
    allPlayerRows.push(...rows);
    const playersWithOdds = rows.length;
    const playersMatched = rows.filter(r => r.playerId !== null).length;
    const playersWithLatestGame = rows.filter(r => r.status === 'Fresh').length;
    const playersMissingLatest = rows.filter(r => r.status === 'Missing last game').length;
    const playersWithNoCurrentSeason = rows.filter(r => r.status === 'No current season data').length;
    const playersWithUnknownPosition = rows.filter(r => r.positionGroup === 'UNKNOWN' || !r.positionGroup).length;
    totalPlayersWithOdds += playersWithOdds;
    totalPlayersMatched += playersMatched;
    totalPlayersWithLatestGame += playersWithLatestGame;
    totalPlayersMissingLatest += playersMissingLatest;
    totalPlayersWithNoCurrentSeason += playersWithNoCurrentSeason;
    totalUnknownPosition += playersWithUnknownPosition;
    const statusReasons: string[] = [];
    if (playersMatched / Math.max(1, playersWithOdds) < 0.9) statusReasons.push(`Player matching ${((playersMatched / Math.max(1, playersWithOdds)) * 100).toFixed(0)}% < 90%`);
    if (playersWithNoCurrentSeason / Math.max(1, playersWithOdds) > 0.15) statusReasons.push(`${playersWithNoCurrentSeason} players with no current season data`);
    if (playersMissingLatest / Math.max(1, playersWithOdds) > 0.20) statusReasons.push(`${playersMissingLatest} players missing latest game`);
    if (playersWithUnknownPosition / Math.max(1, playersWithOdds) > 0.10) statusReasons.push(`${playersWithUnknownPosition} players with UNKNOWN position`);
    let status: 'Ready' | 'Warning' | 'Broken' = 'Ready';
    if (playersMatched === 0 || playersWithOdds === 0) status = 'Broken';
    else if (statusReasons.length >= 2 || playersMissingLatest > playersWithOdds * 0.3) status = 'Warning';
    else if (statusReasons.length >= 1) status = 'Warning';
    summaries.push({
      matchId: m.id,
      matchLabel: `${m.home_team} vs ${m.away_team}`,
      round: m.round,
      season: m.season,
      venue: m.venue,
      playersWithOdds,
      playersMatchedToStats: playersMatched,
      playersWithLatestGame,
      playersMissingLatestGame: playersMissingLatest,
      playersWithNoCurrentSeason: playersWithNoCurrentSeason,
      playersWithUnknownPosition: playersWithUnknownPosition,
      status,
      statusReasons,
    });
  }
  const playerMatchingPct = totalPlayersWithOdds > 0 ? (totalPlayersMatched / totalPlayersWithOdds) * 100 : 0;
  const currentSeasonCoveragePct = totalPlayersWithOdds > 0 ? ((totalPlayersWithOdds - totalPlayersWithNoCurrentSeason) / totalPlayersWithOdds) * 100 : 0;
  const latestGameCoveragePct = totalPlayersMatched > 0 ? (totalPlayersWithLatestGame / totalPlayersMatched) * 100 : 0;
  const unknownPositionPct = totalPlayersWithOdds > 0 ? (totalUnknownPosition / totalPlayersWithOdds) * 100 : 0;
  const targetReadiness = { playerMatching: 90, currentSeasonCoverage: 85, latestGameCoverage: 80, unknownPosition: 10 };
  const meetsTargets =
    playerMatchingPct >= targetReadiness.playerMatching &&
    currentSeasonCoveragePct >= targetReadiness.currentSeasonCoverage &&
    latestGameCoveragePct >= targetReadiness.latestGameCoverage &&
    unknownPositionPct <= targetReadiness.unknownPosition;
  return {
    summaries,
    playerRows: allPlayerRows,
    expectedLatestRound,
    latestCompletedRound,
    latestCompletedMatchDate,
    totalPlayersWithOdds,
    totalPlayersMatched,
    totalPlayersWithLatestGame,
    totalPlayersMissingLatest,
    totalUnknownPosition,
    readiness: { playerMatchingPct, currentSeasonCoveragePct, latestGameCoveragePct, unknownPositionPct },
    targetReadiness,
    meetsTargets,
  };
}

export async function getPlayerSpotCheck(
  playerName: string,
  playerId: string | null,
  matchId: string,
  matchSeason: number,
  expectedLatestRound: string | null,
  venue?: string | null,
  playerTeam?: string | null,
  homeTeam?: string | null,
  awayTeam?: string | null
): Promise<PlayerSpotCheck> {
  let resolvedId = playerId;
  if (!resolvedId) {
    resolvedId = await resolvePlayerByName(playerName);
  }
  if (!resolvedId) {
    return {
      playerId: null,
      playerName,
      team: null,
      positionGroup: null,
      last5Games: [],
      last10Games: [],
      currentSeasonGames: [],
      latestGame: null,
      latestGameIsFromLastCompletedRound: false,
      modelSample: { sampleSize: 0, firstGameDate: null, latestGameDate: null, latestRound: null, latestOpponent: null, latestDisposals: null },
      venueSampleGames: [],
      opponentSampleGames: [],
    };
  }
  const stats = await getPlayerStatsWithMatchInfo(resolvedId);
  const info = await getPlayerInfo([resolvedId]);
  const playerInfo = info.get(resolvedId);
  const team = playerInfo?.team ?? playerTeam ?? null;
  const positionGroup = playerInfo?.position_group ?? null;
  const last5 = stats.slice(0, 5);
  const last10 = stats.slice(0, 10);
  const currentSeason = getCurrentSeason(matchSeason);
  const seasonGames = stats.filter(s => (s.season ?? inferSeasonFromDate(s.match_date)) === currentSeason);
  const latest = stats.length > 0 ? stats[0] : null;
  let latestIsFromLastRound = false;
  if (latest && expectedLatestRound) {
    const latestRoundNum = parseInt(latest.round ?? '0', 10);
    const expectedNum = parseInt(expectedLatestRound, 10);
    if (!isNaN(latestRoundNum) && !isNaN(expectedNum) && latestRoundNum >= expectedNum) {
      latestIsFromLastRound = true;
    }
  }
  const modelSample = {
    sampleSize: Math.min(25, stats.length),
    firstGameDate: stats.length > 0 ? stats[stats.length - 1].match_date : null,
    latestGameDate: latest?.match_date ?? null,
    latestRound: latest?.round ?? null,
    latestOpponent: latest?.opponent ?? null,
    latestDisposals: latest?.disposals ?? null,
  };
  let venueSampleGames: StatGameRow[] = [];
  if (venue) {
    const venueNorm = normalizeVenueKey(venue);
    venueSampleGames = stats.filter(s => normalizeVenueKey(s.venue) === venueNorm);
  }
  let opponentSampleGames: StatGameRow[] = [];
  if (team && (homeTeam || awayTeam)) {
    const teamNorm = normalizeTeamName(team);
    let targetOpponent: string | null = null;
    if (teamNorm === normalizeTeamName(homeTeam)) targetOpponent = awayTeam;
    else if (teamNorm === normalizeTeamName(awayTeam)) targetOpponent = homeTeam;
    if (targetOpponent) {
      const oppNorm = normalizeTeamName(targetOpponent);
      opponentSampleGames = stats.filter(s => normalizeTeamName(s.opponent) === oppNorm);
    }
  }
  return {
    playerId: resolvedId,
    playerName,
    team,
    positionGroup,
    last5Games: last5,
    last10Games: last10,
    currentSeasonGames: seasonGames,
    latestGame: latest,
    latestGameIsFromLastCompletedRound: latestIsFromLastRound,
    modelSample,
    venueSampleGames,
    opponentSampleGames,
  };
}

export async function getPositionOverrides(): Promise<{ player_name: string; team: string | null; position_group: string; confidence: string }[]> {
  const { data } = await supabase
    .from('player_position_overrides')
    .select('player_name, team, position_group, confidence')
    .order('player_name');
  return data ?? [];
}

export async function upsertPositionOverride(playerName: string, team: string | null, positionGroup: string, confidence: string): Promise<void> {
  const { data: existing } = await supabase
    .from('player_position_overrides')
    .select('id')
    .ilike('player_name', playerName)
    .limit(1);
  if (existing && existing.length > 0) {
    await supabase
      .from('player_position_overrides')
      .update({ position_group: positionGroup, confidence, team, source: 'manual', updated_at: new Date().toISOString() })
      .eq('id', existing[0].id);
  } else {
    await supabase
      .from('player_position_overrides')
      .insert({
        player_name: playerName,
        team,
        position_group: positionGroup,
        confidence,
        source: 'manual',
      });
  }
}

export async function getUnknownPositionPlayersForMatch(matchId: string): Promise<{ playerName: string; playerId: string | null; team: string | null }[]> {
  const oddsPlayers = await getOddsPlayersForMatch(matchId);
  const result: { playerName: string; playerId: string | null; team: string | null }[] = [];
  for (const op of oddsPlayers) {
    let pid = op.player_id;
    if (!pid) pid = await resolvePlayerByName(op.bookmaker_player_name);
    if (!pid) {
      result.push({ playerName: op.bookmaker_player_name, playerId: null, team: null });
      continue;
    }
    const info = await getPlayerInfo([pid]);
    const p = info.get(pid);
    if (!p || p.position_group === 'UNKNOWN' || !p.position_group) {
      result.push({ playerName: op.bookmaker_player_name, playerId: pid, team: p?.team ?? null });
    }
  }
  return result;
}
