import { supabase } from './supabase';
import type { PlayerGameStat } from './types';
import { fetchAllRows } from './supabasePagination';

export interface MissingStatsEntry {
  playerName: string;
  team: string;
  matchName: string;
  matchId: string;
  playerId: string | null;
  reason: MissingStatsReason;
  oddsRowCount: number;
  suggestedAction: string;
}

export type MissingStatsReason =
  | 'NO_PLAYER_ROW'
  | 'PLAYER_ID_HAS_ZERO_STATS'
  | 'DUPLICATE_PLAYER_WITH_STATS_FOUND_AND_RELINKED'
  | 'RAW_KALI_ROWS_PROMOTED'
  | 'NO_RAW_KALI_STATS_FOUND'
  | 'TEAM_NAME_MISMATCH'
  | 'PLAYER_NAME_MISMATCH';

export interface GlobalRepairResult {
  bookmakerRowsChecked: number;
  playersChecked: number;
  noStatsPlayersFound: number;
  duplicatePlayerLinksRepaired: number;
  rawKaliRowsPromoted: number;
  rowsStillMissingStats: number;
  errors: number;
  missingStatsQueue: MissingStatsEntry[];
  errorMessages: string[];
}

function normalizeName(name: string): string {
  return (name || '')
    .toLowerCase()
    .trim()
    .replace(/[''.\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTeam(team: string): string {
  const t = (team || '').toLowerCase().trim();
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

/**
 * Global no-stats repair — checks every bookmaker_odds row for all given match IDs.
 *
 * For each odds row:
 *   1. Get bookmaker_player_name, team, match_id, current player_id
 *   2. Count player_game_stats for current player_id
 *   3. If 0 stats → search players table for same normalized name + team
 *   4. If a candidate has stats → relink bookmaker_odds.player_id
 *   5. If no candidate has stats → search raw_kali_player_game_stats
 *   6. If raw_kali rows exist → promote them into player_game_stats
 *   7. If nothing found → add to Missing Stats Queue
 */
export async function repairGlobalNoStatsPlayerLinks(matchIds: string[]): Promise<GlobalRepairResult> {
  const result: GlobalRepairResult = {
    bookmakerRowsChecked: 0,
    playersChecked: 0,
    noStatsPlayersFound: 0,
    duplicatePlayerLinksRepaired: 0,
    rawKaliRowsPromoted: 0,
    rowsStillMissingStats: 0,
    errors: 0,
    missingStatsQueue: [],
    errorMessages: [],
  };

  if (matchIds.length === 0) return result;

  try {
    // ── Step 1: Fetch all bookmaker_odds rows for all selected matches (paginated) ──
    const PAGE_SIZE = 1000;
    const allOdds: Array<{
      id: string;
      player_id: string | null;
      bookmaker_player_name: string;
      match_id: string;
    }> = [];

    for (const matchId of matchIds) {
      let page = 0;
      let hasMore = true;
      while (hasMore) {
        const { data, error } = await supabase
          .from('bookmaker_odds')
          .select('id, player_id, bookmaker_player_name, match_id')
          .eq('match_id', matchId)
          .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

        if (error) {
          result.errors++;
          result.errorMessages.push(`Fetch error for match ${matchId}: ${error.message}`);
          break;
        }

        if (data && data.length > 0) {
          allOdds.push(...(data as typeof allOdds));
          hasMore = data.length === PAGE_SIZE;
          page++;
        } else {
          hasMore = false;
        }
      }
    }

    result.bookmakerRowsChecked = allOdds.length;

    // ── Step 2: Fetch match teams for all matches ──
    const uniqueMatchIds = [...new Set(allOdds.map(r => r.match_id))];
    const { data: matchesData } = await supabase
      .from('matches')
      .select('id, home_team, away_team')
      .in('id', uniqueMatchIds);

    const matchTeamsMap = new Map<string, { home: string; away: string; homeNorm: string; awayNorm: string }>();
    if (matchesData) {
      for (const m of matchesData as Array<{ id: string; home_team: string | null; away_team: string | null }>) {
        const home = m.home_team ?? '';
        const away = m.away_team ?? '';
        matchTeamsMap.set(m.id, {
          home, away,
          homeNorm: normalizeTeam(home),
          awayNorm: normalizeTeam(away),
        });
      }
    }

    // ── Step 3: Group odds rows by player_id to check stats ──
    const allPlayerIds = [...new Set(allOdds.filter(r => r.player_id).map(r => r.player_id!))];
    result.playersChecked = allPlayerIds.length;

    // Fetch stats counts per player_id, batched by player_id (in() can exceed
    // URL limits) AND paginated per batch (200 players' full game history can
    // itself exceed Supabase's 1000-row default, silently undercounting
    // players who genuinely have stats and falsely flagging them for repair).
    const statsCountMap = new Map<string, number>();
    const STATS_BATCH = 200;
    for (let i = 0; i < allPlayerIds.length; i += STATS_BATCH) {
      const batch = allPlayerIds.slice(i, i + STATS_BATCH);
      let statsRows: { player_id: string }[];
      try {
        statsRows = await fetchAllRows(supabase, 'player_game_stats', 'player_id', (q) => q.in('player_id', batch));
      } catch (e: any) {
        result.errors++;
        result.errorMessages.push(`Stats fetch error: ${e.message}`);
        continue;
      }
      for (const s of statsRows) {
        statsCountMap.set(s.player_id, (statsCountMap.get(s.player_id) ?? 0) + 1);
      }
    }

    // ── Step 4: Identify no-stats rows (player_id has 0 stats) ──
    const noStatsRows = allOdds.filter(r => {
      if (!r.player_id) return false;
      return (statsCountMap.get(r.player_id) ?? 0) === 0;
    });

    // Also group by bookmaker_player_name + match to find unique no-stats players
    const noStatsByPlayerKey = new Map<string, typeof noStatsRows>();
    for (const row of noStatsRows) {
      const key = `${normalizeName(row.bookmaker_player_name)}|${row.match_id}`;
      if (!noStatsByPlayerKey.has(key)) noStatsByPlayerKey.set(key, []);
      noStatsByPlayerKey.get(key)!.push(row);
    }

    result.noStatsPlayersFound = noStatsByPlayerKey.size;

    if (noStatsByPlayerKey.size === 0) return result;

    // ── Step 5: Fetch all players for name matching (fully paginated) ──
    let allPlayers: { id: string; name: string; team: string }[];
    try {
      allPlayers = await fetchAllRows(supabase, 'players', 'id, name, team');
    } catch (e: any) {
      result.errors++;
      result.errorMessages.push(`Players fetch error: ${e.message}`);
      return result;
    }

    // Build normalized name → players[] map
    const playersByNormName = new Map<string, Array<{ id: string; name: string; team: string; teamNorm: string }>>();
    for (const p of allPlayers as Array<{ id: string; name: string; team: string | null }>) {
      const normName = normalizeName(p.name);
      if (!playersByNormName.has(normName)) playersByNormName.set(normName, []);
      playersByNormName.get(normName)!.push({
        id: p.id,
        name: p.name,
        team: p.team ?? '',
        teamNorm: normalizeTeam(p.team ?? ''),
      });
    }

    // ── Step 6: For each no-stats player, try to find a better player_id ──
    const relinkUpdates: Array<{ oddsIds: string[]; newPlayerId: string; playerName: string }> = [];
    const playersToPromoteKali: Array<{ playerId: string; normName: string; teamNorm: string; matchId: string; bookmakerName: string }> = [];
    const stillMissing: MissingStatsEntry[] = [];

    for (const [playerKey, rows] of noStatsByPlayerKey) {
      const firstRow = rows[0];
      const bookmakerName = firstRow.bookmaker_player_name;
      const matchId = firstRow.match_id;
      const normName = normalizeName(bookmakerName);
      const matchTeams = matchTeamsMap.get(matchId);

      // Determine which team this player should be on
      const matchTeamNorms = matchTeams ? [matchTeams.homeNorm, matchTeams.awayNorm] : [];

      // Find candidates by normalized name
      const candidates = playersByNormName.get(normName) ?? [];

      // Filter by team (match teams)
      let teamFiltered = candidates;
      if (matchTeamNorms.length === 2) {
        teamFiltered = candidates.filter(c => matchTeamNorms.includes(c.teamNorm));
      }

      if (candidates.length === 0) {
        // No player row at all
        stillMissing.push({
          playerName: bookmakerName,
          team: matchTeams?.home ?? matchTeams?.away ?? '',
          matchName: matchTeams ? `${matchTeams.home} vs ${matchTeams.away}` : matchId,
          matchId,
          playerId: firstRow.player_id,
          reason: 'NO_PLAYER_ROW',
          oddsRowCount: rows.length,
          suggestedAction: 'Add player to players table or sync from Kali',
        });
        continue;
      }

      if (teamFiltered.length === 0) {
        // Name exists but team doesn't match
        stillMissing.push({
          playerName: bookmakerName,
          team: matchTeams?.home ?? matchTeams?.away ?? '',
          matchName: matchTeams ? `${matchTeams.home} vs ${matchTeams.away}` : matchId,
          matchId,
          playerId: firstRow.player_id,
          reason: 'TEAM_NAME_MISMATCH',
          oddsRowCount: rows.length,
          suggestedAction: `Found ${candidates.length} player(s) with same name but different team. Check team mapping.`,
        });
        continue;
      }

      // Check stats for each team-filtered candidate
      const candidateIds = teamFiltered.map(c => c.id);
      const candidateStatsMap = new Map<string, number>();
      const { data: candidateStats } = await supabase
        .from('player_game_stats')
        .select('player_id')
        .in('player_id', candidateIds);

      if (candidateStats) {
        for (const s of candidateStats as Array<{ player_id: string }>) {
          candidateStatsMap.set(s.player_id, (candidateStatsMap.get(s.player_id) ?? 0) + 1);
        }
      }

      // Find candidate with most stats
      let bestCandidate: { id: string; name: string; stats: number } | null = null;
      for (const c of teamFiltered) {
        const stats = candidateStatsMap.get(c.id) ?? 0;
        if (stats > 0) {
          if (bestCandidate === null || stats > bestCandidate.stats) {
            bestCandidate = { id: c.id, name: c.name, stats };
          }
        }
      }

      if (bestCandidate) {
        // Relink all odds rows for this player to the better player_id
        const oddsIds = rows.map(r => r.id);
        relinkUpdates.push({
          oddsIds,
          newPlayerId: bestCandidate.id,
          playerName: bestCandidate.name,
        });

        // Also add to missing queue as "repaired"
        stillMissing.push({
          playerName: bookmakerName,
          team: teamFiltered[0]?.team ?? '',
          matchName: matchTeams ? `${matchTeams.home} vs ${matchTeams.away}` : matchId,
          matchId,
          playerId: bestCandidate.id,
          reason: 'DUPLICATE_PLAYER_WITH_STATS_FOUND_AND_RELINKED',
          oddsRowCount: rows.length,
          suggestedAction: `Relinked to ${bestCandidate.name} (${bestCandidate.stats} stats). Reload odds to see updated model.`,
        });
        continue;
      }

      // ── Step 7: No candidate has stats — check raw_kali ──
      // Search raw_kali for same normalized name and team
      const kaliTeamNorms = teamFiltered.map(c => c.teamNorm);
      const { data: rawKaliRows } = await supabase
        .from('raw_kali_player_game_stats')
        .select('id, player_id, normalized_player_name, normalized_team, match_id, season, round, match_date, team, opponent, venue, disposals, marks, tackles, goals, hitouts')
        .eq('normalized_player_name', normName);

      let kaliPromoted = false;
      if (rawKaliRows && rawKaliRows.length > 0) {
        // Filter by team
        const teamMatchedKali = (rawKaliRows as Array<Record<string, unknown>>).filter(r => {
          const kaliTeamNorm = normalizeTeam(String(r.team ?? ''));
          return kaliTeamNorms.includes(kaliTeamNorm);
        });

        if (teamMatchedKali.length > 0) {
          // We need to promote these raw_kali rows to player_game_stats
          // Use the first candidate's player_id (they all have 0 stats)
          const targetPlayerId = teamFiltered[0].id;

          // First, resolve the raw_kali player_id if not set
          const unresolvedKali = teamMatchedKali.filter(r => !r.player_id);
          if (unresolvedKali.length > 0) {
            // Update raw_kali to set player_id
            for (const r of unresolvedKali) {
              await supabase
                .from('raw_kali_player_game_stats')
                .update({ player_id: targetPlayerId })
                .eq('id', String(r.id));
            }
          }

          // Promote to player_game_stats
          for (const r of teamMatchedKali) {
            const insertData = {
              player_id: r.player_id || targetPlayerId,
              match_id: r.match_id,
              match_date: r.match_date,
              season: r.season,
              round: r.round,
              team: String(r.team ?? ''),
              opponent: String(r.opponent ?? ''),
              venue: String(r.venue ?? ''),
              disposals: r.disposals ?? null,
              marks: r.marks ?? null,
              tackles: r.tackles ?? null,
              goals: r.goals ?? null,
              hitouts: r.hitouts ?? null,
              source: 'promoted_global_repair',
            };

            const { error: insertErr } = await supabase
              .from('player_game_stats')
              // insertData is assembled from loosely-typed raw_kali staging rows;
              // cast preserves the existing promotion behaviour.
              .upsert(insertData as unknown as PlayerGameStat, { onConflict: 'player_id,match_id' });

            if (insertErr) {
              result.errors++;
              result.errorMessages.push(`Promote error for ${bookmakerName}: ${insertErr.message}`);
            } else {
              result.rawKaliRowsPromoted++;
              kaliPromoted = true;
            }
          }

          if (kaliPromoted) {
            // Also relink the bookmaker_odds to this player_id
            const oddsIds = rows.map(r => r.id);
            relinkUpdates.push({
              oddsIds,
              newPlayerId: targetPlayerId,
              playerName: teamFiltered[0].name,
            });

            stillMissing.push({
              playerName: bookmakerName,
              team: teamFiltered[0]?.team ?? '',
              matchName: matchTeams ? `${matchTeams.home} vs ${matchTeams.away}` : matchId,
              matchId,
              playerId: targetPlayerId,
              reason: 'RAW_KALI_ROWS_PROMOTED',
              oddsRowCount: rows.length,
              suggestedAction: `Promoted ${teamMatchedKali.length} raw_kali rows. Relinked to ${teamFiltered[0].name}. Reload odds to see updated model.`,
            });
            continue;
          }
        }
      }

      // ── Step 8: No raw_kali rows either — genuinely missing ──
      stillMissing.push({
        playerName: bookmakerName,
        team: teamFiltered[0]?.team ?? '',
        matchName: matchTeams ? `${matchTeams.home} vs ${matchTeams.away}` : matchId,
        matchId,
        playerId: firstRow.player_id,
        reason: 'NO_RAW_KALI_STATS_FOUND',
        oddsRowCount: rows.length,
        suggestedAction: 'No stats in players, player_game_stats, or raw_kali. Sync from Kali API or add manually.',
      });
    }

    // ── Step 9: Execute relink updates ──
    for (const update of relinkUpdates) {
      const { error: updateError } = await supabase
        .from('bookmaker_odds')
        .update({
          player_id: update.newPlayerId,
          resolved_player_name: update.playerName,
          resolution_status: 'relinked',
          resolution_reason: 'global_no_stats_repair',
        })
        .in('id', update.oddsIds);

      if (updateError) {
        result.errors++;
        result.errorMessages.push(`Relink error for ${update.playerName}: ${updateError.message}`);
      } else {
        result.duplicatePlayerLinksRepaired += update.oddsIds.length;
      }
    }

    // ── Step 10: Final counts ──
    const repairedKeys = new Set(
      stillMissing
        .filter(e => e.reason === 'DUPLICATE_PLAYER_WITH_STATS_FOUND_AND_RELINKED' || e.reason === 'RAW_KALI_ROWS_PROMOTED')
        .map(e => `${normalizeName(e.playerName)}|${e.matchId}`)
    );

    result.rowsStillMissingStats = noStatsRows.filter(r => {
      const key = `${normalizeName(r.bookmaker_player_name)}|${r.match_id}`;
      return !repairedKeys.has(key);
    }).length;

    result.missingStatsQueue = stillMissing;

    return result;
  } catch (err) {
    result.errors++;
    result.errorMessages.push(err instanceof Error ? err.message : 'Unknown error in global repair');
    return result;
  }
}
