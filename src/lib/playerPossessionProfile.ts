/**
 * Player possession profiles — season/last-5/last-3 contested and
 * uncontested possession averages and rates, per player, plus the
 * position-group average for comparison. Built directly from
 * player_game_stats rather than the disposals-only historicalStatsCache,
 * since CP/UP live on different columns with their own null-vs-genuine-zero
 * semantics (a player can genuinely record 0 contested possessions in a
 * game — that's not the same as Kali having no advanced data for them).
 */
import { supabase } from './supabase';

export interface PlayerPossessionPeriod {
  games: number;
  cpAvg: number | null;
  upAvg: number | null;
  totalPossAvg: number | null;
  cpRate: number | null; // CP / (CP + UP)
  upRate: number | null; // UP / (CP + UP)
}

export interface PlayerPossessionProfile {
  playerId: string;
  positionGroup: string;
  season: PlayerPossessionPeriod;
  last5: PlayerPossessionPeriod;
  last3: PlayerPossessionPeriod;
}

async function fetchAllRows<T>(
  table: string,
  select: string,
  applyFilters?: (q: any) => any,
  pageSize = 1000,
): Promise<T[]> {
  const rows: T[] = [];
  let offset = 0;
  for (;;) {
    let q = supabase.from(table).select(select).order('id').range(offset, offset + pageSize - 1);
    if (applyFilters) q = applyFilters(q);
    const { data, error } = await q;
    if (error) throw new Error(`fetchAllRows(${table}) failed: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...(data as T[]));
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

function periodFrom(games: { cp: number | null; up: number | null }[]): PlayerPossessionPeriod {
  const valid = games.filter(g => g.cp != null && g.up != null) as { cp: number; up: number }[];
  if (valid.length === 0) return { games: games.length, cpAvg: null, upAvg: null, totalPossAvg: null, cpRate: null, upRate: null };
  const cpAvg = valid.reduce((a, g) => a + g.cp, 0) / valid.length;
  const upAvg = valid.reduce((a, g) => a + g.up, 0) / valid.length;
  const totalAvg = cpAvg + upAvg;
  return {
    games: games.length,
    cpAvg: Math.round(cpAvg * 10) / 10,
    upAvg: Math.round(upAvg * 10) / 10,
    totalPossAvg: Math.round(totalAvg * 10) / 10,
    cpRate: totalAvg > 0 ? Math.round((cpAvg / totalAvg) * 1000) / 10 : null,
    upRate: totalAvg > 0 ? Math.round((upAvg / totalAvg) * 1000) / 10 : null,
  };
}

export interface PositionGroupPossessionAverage {
  positionGroup: string;
  cpRate: number | null;
  upRate: number | null;
  sampleSize: number;
}

/** Builds a possession profile for every player with any 2026 player_game_stats
 * row, plus the league-wide average CP/UP rate per position group (for
 * "this player's UP rate vs their position's average" comparisons). */
export async function buildPlayerPossessionProfiles(season: number): Promise<{
  profiles: Map<string, PlayerPossessionProfile>;
  positionAverages: Map<string, PositionGroupPossessionAverage>;
}> {
  const rows = await fetchAllRows<any>(
    'player_game_stats',
    'player_id, match_date, contested_possessions, uncontested_possessions',
    (q) => q.eq('season', season).not('player_id', 'is', null),
  );

  const players = await fetchAllRows<any>('players', 'id, position_group');
  const positionByPlayer = new Map<string, string>();
  for (const p of players) positionByPlayer.set(p.id, p.position_group ?? 'UNKNOWN');

  const byPlayer = new Map<string, { cp: number | null; up: number | null; date: string }[]>();
  for (const r of rows) {
    if (!byPlayer.has(r.player_id)) byPlayer.set(r.player_id, []);
    byPlayer.get(r.player_id)!.push({ cp: r.contested_possessions, up: r.uncontested_possessions, date: r.match_date });
  }

  const profiles = new Map<string, PlayerPossessionProfile>();
  const positionRateSamples = new Map<string, { cpRate: number; upRate: number }[]>();

  for (const [playerId, games] of byPlayer) {
    games.sort((a, b) => b.date.localeCompare(a.date));
    const positionGroup = positionByPlayer.get(playerId) ?? 'UNKNOWN';
    const season_ = periodFrom(games);
    const last5 = periodFrom(games.slice(0, 5));
    const last3 = periodFrom(games.slice(0, 3));
    profiles.set(playerId, { playerId, positionGroup, season: season_, last5, last3 });

    if (season_.cpRate != null && season_.upRate != null) {
      if (!positionRateSamples.has(positionGroup)) positionRateSamples.set(positionGroup, []);
      positionRateSamples.get(positionGroup)!.push({ cpRate: season_.cpRate, upRate: season_.upRate });
    }
  }

  const positionAverages = new Map<string, PositionGroupPossessionAverage>();
  for (const [pg, samples] of positionRateSamples) {
    positionAverages.set(pg, {
      positionGroup: pg,
      cpRate: Math.round((samples.reduce((a, s) => a + s.cpRate, 0) / samples.length) * 10) / 10,
      upRate: Math.round((samples.reduce((a, s) => a + s.upRate, 0) / samples.length) * 10) / 10,
      sampleSize: samples.length,
    });
  }

  return { profiles, positionAverages };
}
