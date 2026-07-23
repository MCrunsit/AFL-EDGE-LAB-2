import { supabase } from './supabase';
import { fetchAllRows } from './supabasePagination';

export interface RepairNoStatsResult {
  oddsRowsChecked: number;
  noStatsRowsFound: number;
  relinked: number;
  stillNoStats: number;
  duplicateConflicts: number;
  errors: number;
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[''.\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTeam(team: string): string {
  const t = team.toLowerCase().trim();
  const aliases: Record<string, string> = {
    'adelaide crows': 'adelaide',
    'brisbane lions': 'brisbane',
    'carlton blues': 'carlton',
    'collingwood magpies': 'collingwood',
    'essendon bombers': 'essendon',
    'fremantle dockers': 'fremantle',
    'geelong cats': 'geelong',
    'gold coast suns': 'gold coast',
    'greater western sydney': 'gws',
    'gws giants': 'gws',
    'hawthorn hawks': 'hawthorn',
    'melbourne demons': 'melbourne',
    'north melbourne kangaroos': 'north melbourne',
    'port adelaide power': 'port adelaide',
    'richmond tigers': 'richmond',
    'st kilda saints': 'st kilda',
    'sydney swans': 'sydney',
    'west coast eagles': 'west coast',
    'western bulldogs': 'western bulldogs',
  };
  return aliases[t] ?? t;
}

export async function repairNoStatsOddsLinks(matchId: string): Promise<RepairNoStatsResult> {
  const result: RepairNoStatsResult = {
    oddsRowsChecked: 0,
    noStatsRowsFound: 0,
    relinked: 0,
    stillNoStats: 0,
    duplicateConflicts: 0,
    errors: 0,
  };

  try {
    // Step 1: Fetch all bookmaker_odds rows for this match with non-null player_id
    const PAGE_SIZE = 1000;
    let page = 0;
    let hasMore = true;
    const allOdds: Record<string, unknown>[] = [];

    while (hasMore) {
      const { data, error } = await supabase
        .from('bookmaker_odds')
        .select('id, player_id, bookmaker_player_name, match_id, market_type')
        .eq('match_id', matchId)
        .not('player_id', 'is', null)
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

      if (error) {
        result.errors++;
        return result;
      }

      if (data && data.length > 0) {
        allOdds.push(...(data as unknown as Record<string, unknown>[]));
        hasMore = data.length === PAGE_SIZE;
        page++;
      } else {
        hasMore = false;
      }
    }

    result.oddsRowsChecked = allOdds.length;

    // Step 2: For each odds row, check if player_id has stats
    const playerIds = [...new Set(allOdds.map(r => r.player_id as string))];

    // Fetch stats counts per player_id
    const { data: statsCounts, error: statsError } = await supabase
      .from('player_game_stats')
      .select('player_id')
      .in('player_id', playerIds);

    const statsCountMap = new Map<string, number>();
    if (!statsError && statsCounts) {
      for (const row of statsCounts as unknown as Record<string, unknown>[]) {
        const pid = row.player_id as string;
        statsCountMap.set(pid, (statsCountMap.get(pid) ?? 0) + 1);
      }
    }

    // Identify no-stats rows
    const noStatsRows = allOdds.filter(r => {
      const pid = r.player_id as string;
      return (statsCountMap.get(pid) ?? 0) === 0;
    });

    result.noStatsRowsFound = noStatsRows.length;

    if (noStatsRows.length === 0) return result;

    // Step 3: For each no-stats row, find a better player_id by normalized name + team
    // First, fetch all players matching the bookmaker_player_names
    const bookmakerNames = [...new Set(noStatsRows.map(r => r.bookmaker_player_name as string))];

    // Fetch match teams to determine which team each player should be on
    const { data: matchData } = await supabase
      .from('matches')
      .select('home_team, away_team')
      .eq('id', matchId)
      .single();

    const matchTeams = matchData
      ? [normalizeTeam((matchData as Record<string, unknown>).home_team as string),
         normalizeTeam((matchData as Record<string, unknown>).away_team as string)]
      : [];

    // Fetch all players with matching normalized names. Fully paginated —
    // an unpaginated select here was silently capped at Supabase's 1000-row
    // default out of ~2850 real players, causing false "no match" results
    // in this exact player-link repair tool for any player outside that
    // truncated subset.
    let allPlayers: { id: string; name: string; team: string }[];
    try {
      allPlayers = await fetchAllRows(supabase, 'players', 'id, name, team');
    } catch {
      result.errors++;
      return result;
    }

    // Build a map: normalized_name -> players[]
    const playersByName = new Map<string, Array<{ id: string; name: string; team: string }>>();
    for (const p of allPlayers as unknown as Record<string, unknown>[]) {
      const normName = normalizeName(p.name as string);
      if (!playersByName.has(normName)) playersByName.set(normName, []);
      playersByName.get(normName)!.push({
        id: p.id as string,
        name: p.name as string,
        team: p.team as string,
      });
    }

    // For each no-stats row, find the best candidate
    const updates: Array<{ oddsId: string; newPlayerId: string; playerName: string }> = [];

    for (const row of noStatsRows) {
      const bookmakerName = row.bookmaker_player_name as string;
      const normName = normalizeName(bookmakerName);
      const candidates = playersByName.get(normName) ?? [];

      if (candidates.length === 0) continue;

      // Filter candidates by team — ONLY allow players on the match's home or away team
      let teamFiltered: typeof candidates = [];
      if (matchTeams.length === 2) {
        teamFiltered = candidates.filter(c =>
          matchTeams.includes(normalizeTeam(c.team))
        );
      } else {
        teamFiltered = candidates;
      }

      if (teamFiltered.length === 0) continue;

      // Get stats counts for each candidate
      const candidateIds = teamFiltered.map(c => c.id);
      const { data: candidateStats } = await supabase
        .from('player_game_stats')
        .select('player_id')
        .in('player_id', candidateIds);

      const candidateStatsMap = new Map<string, number>();
      if (candidateStats) {
        for (const s of candidateStats as unknown as Record<string, unknown>[]) {
          const pid = s.player_id as string;
          candidateStatsMap.set(pid, (candidateStatsMap.get(pid) ?? 0) + 1);
        }
      }

      // Find candidate with most stats
      let bestCandidate: { id: string; name: string; stats: number } | null = null;
      let conflictCount = 0;

      for (const c of teamFiltered) {
        const stats = candidateStatsMap.get(c.id) ?? 0;
        if (stats > 0) {
          if (bestCandidate === null || stats > bestCandidate.stats) {
            bestCandidate = { id: c.id, name: c.name, stats };
          }
          conflictCount++;
        }
      }

      if (conflictCount > 1) {
        result.duplicateConflicts++;
      }

      if (bestCandidate) {
        updates.push({
          oddsId: row.id as string,
          newPlayerId: bestCandidate.id,
          playerName: bestCandidate.name,
        });
      }
    }

    // Step 4: Perform the updates
    for (const update of updates) {
      const { error: updateError } = await supabase
        .from('bookmaker_odds')
        .update({
          player_id: update.newPlayerId,
          resolved_player_name: update.playerName,
          resolution_status: 'relinked',
          resolution_reason: 'no_stats_repair_same_name_team',
        })
        .eq('id', update.oddsId);

      if (updateError) {
        result.errors++;
      } else {
        result.relinked++;
      }
    }

    // Step 5: Count still-no-stats
    result.stillNoStats = result.noStatsRowsFound - result.relinked;

    return result;
  } catch (err) {
    result.errors++;
    return result;
  }
}

export interface PlayerModelCoverageEntry {
  bookmakerPlayerName: string;
  oddsPlayerId: string | null;
  playerName: string | null;
  playerTeam: string | null;
  totalStatsRows: number;
  disposalsSample: number;
  marksSample: number;
  tacklesSample: number;
  goalsSample: number;
  hitoutsSample: number;
  marketsWithModel: number;
  marketsWithoutModel: number;
  reasonWithoutModel: string;
}

export async function fetchPlayerModelCoverage(
  matchId: string,
  oddsRows: Array<{ player_id: string | null; bookmaker_player_name: string; player_name: string }>
): Promise<PlayerModelCoverageEntry[]> {
  const entries: PlayerModelCoverageEntry[] = [];

  // Group odds by player
  const playerMap = new Map<string, {
    bookmakerName: string;
    playerId: string | null;
    oddsRows: Array<{ player_id: string | null; bookmaker_player_name: string; player_name: string }>;
  }>();

  for (const row of oddsRows) {
    const key = row.bookmaker_player_name;
    if (!playerMap.has(key)) {
      playerMap.set(key, {
        bookmakerName: key,
        playerId: row.player_id ?? null,
        oddsRows: [],
      });
    }
    playerMap.get(key)!.oddsRows.push(row);
  }

  // Fetch all players for name resolution. Fully paginated (see comment above).
  const allPlayers = await fetchAllRows<{ id: string; name: string; team: string }>(
    supabase, 'players', 'id, name, team',
  );

  const playersById = new Map<string, { name: string; team: string }>();
  if (allPlayers) {
    for (const p of allPlayers as unknown as Record<string, unknown>[]) {
      playersById.set(p.id as string, {
        name: p.name as string,
        team: p.team as string,
      });
    }
  }

  // For each unique player, fetch stats
  for (const [bookmakerName, info] of playerMap) {
    const playerId = info.playerId;
    let playerName: string | null = null;
    let playerTeam: string | null = null;
    let totalStatsRows = 0;
    let disposalsSample = 0;
    let marksSample = 0;
    let tacklesSample = 0;
    let goalsSample = 0;
    let hitoutsSample = 0;

    if (playerId) {
      const playerInfo = playersById.get(playerId);
      if (playerInfo) {
        playerName = playerInfo.name;
        playerTeam = playerInfo.team;
      }

      // Fetch stats for this player
      const { data: stats, error } = await supabase
        .from('player_game_stats')
        .select('disposals, marks, tackles, goals, hitouts')
        .eq('player_id', playerId)
        .not('match_date', 'is', null);

      if (!error && stats) {
        totalStatsRows = stats.length;
        for (const s of stats as unknown as Record<string, unknown>[]) {
          if (s.disposals != null) disposalsSample++;
          if (s.marks != null) marksSample++;
          if (s.tackles != null) tacklesSample++;
          if (s.goals != null) goalsSample++;
          if (s.hitouts != null) hitoutsSample++;
        }
      }
    }

    // Count markets with/without model
    const statTypes = ['disposals', 'marks', 'tackles', 'goals', 'hitouts'];
    let marketsWithModel = 0;
    let marketsWithoutModel = 0;
    let reasonWithoutModel = 'UNKNOWN';

    for (const stat of statTypes) {
      const hasMarket = info.oddsRows.some(r => {
        const marketLower = (r.bookmaker_player_name + ' ' + (r as any).market_type).toLowerCase();
        return marketLower.includes(stat) || (r as any).player_name?.toLowerCase().includes(stat);
      });

      // Check if this stat has enough sample (>= 5 rows)
      const sampleCount = stat === 'disposals' ? disposalsSample :
        stat === 'marks' ? marksSample :
        stat === 'tackles' ? tacklesSample :
        stat === 'goals' ? goalsSample :
        stat === 'hitouts' ? hitoutsSample : 0;

      if (sampleCount >= 5) {
        marketsWithModel++;
      } else if (totalStatsRows > 0) {
        marketsWithoutModel++;
        if (reasonWithoutModel === 'UNKNOWN') reasonWithoutModel = 'INSUFFICIENT_MARKET_SAMPLE';
      }
    }

    // Determine primary reason
    if (!playerId) {
      reasonWithoutModel = 'PLAYER_ID_NULL';
    } else if (totalStatsRows === 0) {
      reasonWithoutModel = 'PLAYER_ID_HAS_ZERO_STATS';
    } else if (marketsWithoutModel > 0 && marketsWithModel === 0) {
      reasonWithoutModel = 'INSUFFICIENT_MARKET_SAMPLE';
    } else if (marketsWithoutModel > 0) {
      reasonWithoutModel = 'INSUFFICIENT_MARKET_SAMPLE';
    }

    entries.push({
      bookmakerPlayerName: bookmakerName,
      oddsPlayerId: playerId,
      playerName,
      playerTeam,
      totalStatsRows,
      disposalsSample,
      marksSample,
      tacklesSample,
      goalsSample,
      hitoutsSample,
      marketsWithModel,
      marketsWithoutModel,
      reasonWithoutModel,
    });
  }

  return entries;
}

export interface SelectedMatchAuditResult {
  totalOddsRows: number;
  uniqueBookmakerPlayers: number;
  nullPlayerIdRows: number;
  wrongTeamRows: number;
  missingTeamRows: number;
  eligibleRows: number;
}

export async function auditSelectedMatchOddsContamination(matchId: string): Promise<SelectedMatchAuditResult> {
  const result: SelectedMatchAuditResult = {
    totalOddsRows: 0,
    uniqueBookmakerPlayers: 0,
    nullPlayerIdRows: 0,
    wrongTeamRows: 0,
    missingTeamRows: 0,
    eligibleRows: 0,
  };

  // Fetch match teams
  const { data: matchData } = await supabase
    .from('matches')
    .select('home_team, away_team')
    .eq('id', matchId)
    .single();

  if (!matchData) return result;
  const homeNorm = normalizeTeam((matchData as Record<string, unknown>).home_team as string);
  const awayNorm = normalizeTeam((matchData as Record<string, unknown>).away_team as string);

  // Fetch all bookmaker_odds for this match (paginated)
  const PAGE_SIZE = 1000;
  let page = 0;
  let hasMore = true;
  const allOdds: Record<string, unknown>[] = [];

  while (hasMore) {
    const { data, error } = await supabase
      .from('bookmaker_odds')
      .select('id, player_id, bookmaker_player_name')
      .eq('match_id', matchId)
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (error) break;
    if (data && data.length > 0) {
      allOdds.push(...(data as unknown as Record<string, unknown>[]));
      hasMore = data.length === PAGE_SIZE;
      page++;
    } else {
      hasMore = false;
    }
  }

  result.totalOddsRows = allOdds.length;
  const uniqueNames = new Set(allOdds.map(r => r.bookmaker_player_name as string));
  result.uniqueBookmakerPlayers = uniqueNames.size;

  const nullPlayerRows = allOdds.filter(r => !r.player_id);
  result.nullPlayerIdRows = nullPlayerRows.length;

  const playerIds = [...new Set(allOdds.filter(r => r.player_id).map(r => r.player_id as string))];

  if (playerIds.length > 0) {
    const { data: players } = await supabase
      .from('players')
      .select('id, team')
      .in('id', playerIds);

    const playerTeamMap = new Map<string, string>();
    if (players) {
      for (const p of players as unknown as Record<string, unknown>[]) {
        playerTeamMap.set(p.id as string, p.team as string);
      }
    }

    for (const row of allOdds) {
      const pid = row.player_id as string | null;
      if (!pid) continue;

      const team = playerTeamMap.get(pid);
      if (!team) {
        result.missingTeamRows++;
      } else {
        const teamNorm = normalizeTeam(team);
        if (teamNorm !== homeNorm && teamNorm !== awayNorm) {
          result.wrongTeamRows++;
        } else {
          result.eligibleRows++;
        }
      }
    }
  }

  return result;
}

export interface GlobalAuditEntry {
  matchName: string;
  matchId: string;
  totalOddsRows: number;
  validRows: number;
  wrongTeamRows: number;
  missingTeamRows: number;
  unresolvedRows: number;
}

export async function auditGlobalOddsContamination(): Promise<GlobalAuditEntry[]> {
  // Get all distinct match_ids from bookmaker_odds
  const { data: matchIdsData } = await supabase
    .from('bookmaker_odds')
    .select('match_id')
    .not('match_id', 'is', null);

  if (!matchIdsData) return [];

  const matchIds = [...new Set((matchIdsData as unknown as Record<string, unknown>[]).map(r => r.match_id as string))];

  // Fetch all matches
  const { data: matches } = await supabase
    .from('matches')
    .select('id, home_team, away_team')
    .in('id', matchIds);

  const matchMap = new Map<string, { home: string; away: string }>();
  if (matches) {
    for (const m of matches as unknown as Record<string, unknown>[]) {
      matchMap.set(m.id as string, {
        home: normalizeTeam(m.home_team as string),
        away: normalizeTeam(m.away_team as string),
      });
    }
  }

  const results: GlobalAuditEntry[] = [];

  for (const matchId of matchIds) {
    const matchInfo = matchMap.get(matchId);
    const matchName = matchInfo ? `${matchInfo.home} vs ${matchInfo.away}` : 'Unknown';

    // Count odds rows for this match
    const { count: totalRows } = await supabase
      .from('bookmaker_odds')
      .select('id', { count: 'exact', head: true })
      .eq('match_id', matchId);

    // Fetch player_ids for this match
    const { data: oddsRows } = await supabase
      .from('bookmaker_odds')
      .select('player_id')
      .eq('match_id', matchId);

    if (!oddsRows || oddsRows.length === 0) continue;

    const rows = oddsRows as unknown as Record<string, unknown>[];
    const unresolvedRows = rows.filter(r => !r.player_id).length;
    const playerIds = [...new Set(rows.filter(r => r.player_id).map(r => r.player_id as string))];

    let wrongTeam = 0;
    let missingTeam = 0;
    let valid = 0;

    if (playerIds.length > 0 && matchInfo) {
      const { data: players } = await supabase
        .from('players')
        .select('id, team')
        .in('id', playerIds);

      const playerTeamMap = new Map<string, string>();
      if (players) {
        for (const p of players as unknown as Record<string, unknown>[]) {
          playerTeamMap.set(p.id as string, p.team as string);
        }
      }

      for (const row of rows) {
        const pid = row.player_id as string | null;
        if (!pid) continue;
        const team = playerTeamMap.get(pid);
        if (!team) {
          missingTeam++;
        } else {
          const teamNorm = normalizeTeam(team);
          if (teamNorm !== matchInfo.home && teamNorm !== matchInfo.away) {
            wrongTeam++;
          } else {
            valid++;
          }
        }
      }
    }

    results.push({
      matchName,
      matchId,
      totalOddsRows: totalRows ?? 0,
      validRows: valid,
      wrongTeamRows: wrongTeam,
      missingTeamRows: missingTeam,
      unresolvedRows,
    });
  }

  return results.sort((a, b) => b.wrongTeamRows - a.wrongTeamRows);
}
