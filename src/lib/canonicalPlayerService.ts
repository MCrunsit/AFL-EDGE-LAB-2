import { supabase } from './supabase';
import { normalizeTeam } from './teamNormalizer';

export interface CanonicalPlayer {
  id: string;
  name: string;
  team: string | null;
}

export interface PlayerIdentity {
  canonicalId: string;
  canonicalName: string;
  canonicalTeam: string | null;
  allIds: string[];
  legacyIds: string[];
  status: 'CANONICAL_AND_CURRENT' | 'LEGACY_ID_WITH_STATS' | 'BOOKMAKER_ID_BROKEN' | 'DUPLICATE_PLAYER_IDS' | 'NO_HISTORICAL_STATS' | 'IDENTITY_AMBIGUOUS' | 'UNRESOLVED';
}

const PLAYER_CACHE: { byId: Map<string, CanonicalPlayer>; byNormName: Map<string, CanonicalPlayer[]>; ts: number } = {
  byId: new Map(), byNormName: new Map(), ts: 0,
};
const CACHE_TTL = 60_000;

export function normalizeFullName(name: string): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function loadAllPlayers(): Promise<{ byId: Map<string, CanonicalPlayer>; byNormName: Map<string, CanonicalPlayer[]> }> {
  if (Date.now() - PLAYER_CACHE.ts < CACHE_TTL && PLAYER_CACHE.byId.size > 0) {
    return { byId: PLAYER_CACHE.byId, byNormName: PLAYER_CACHE.byNormName };
  }

  const byId = new Map<string, CanonicalPlayer>();
  const byNormName = new Map<string, CanonicalPlayer[]>();
  const PAGE = 1000;
  let page = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from('players')
      .select('id, name, team')
      .range(page * PAGE, (page + 1) * PAGE - 1);

    if (error || !data) break;
    for (const p of data as any[]) {
      const cp: CanonicalPlayer = { id: p.id, name: p.name, team: p.team };
      byId.set(p.id, cp);
      const norm = normalizeFullName(p.name);
      if (!byNormName.has(norm)) byNormName.set(norm, []);
      byNormName.get(norm)!.push(cp);
    }
    hasMore = data.length === PAGE;
    page++;
  }

  PLAYER_CACHE.byId = byId;
  PLAYER_CACHE.byNormName = byNormName;
  PLAYER_CACHE.ts = Date.now();

  return { byId, byNormName };
}

/**
 * Resolve a player to their canonical identity.
 * Resolution order:
 * 1. valid existing player_id
 * 2. exact normalized full name + canonical current team
 * 3. exact normalized full name + historical team
 * 4. explicit alias table
 * 5. unresolved
 */
export async function resolveCanonicalPlayer(
  playerId: string | null,
  playerName: string,
  teamHint?: string | null,
): Promise<PlayerIdentity> {
  const { byId, byNormName } = await loadAllPlayers();
  const normName = normalizeFullName(playerName);

  // 1. Check if player_id is valid
  if (playerId) {
    const existing = byId.get(playerId);
    if (existing) {
      // Check for duplicates with same name
      const duplicates = byNormName.get(normName) ?? [];
      const legacyIds = duplicates.filter(d => d.id !== playerId).map(d => d.id);
      const hasStats = await checkStatsExist(playerId);
      if (hasStats) {
        return {
          canonicalId: playerId,
          canonicalName: existing.name,
          canonicalTeam: existing.team,
          allIds: [playerId, ...legacyIds],
          legacyIds,
          status: 'CANONICAL_AND_CURRENT',
        };
      }
      // Player exists but has no stats — check if a duplicate has stats
      for (const dup of duplicates) {
        if (dup.id === playerId) continue;
        if (teamHint) {
          const dupTeamNorm = normalizeTeam(dup.team ?? '');
          const hintNorm = normalizeTeam(teamHint);
          if (dupTeamNorm !== hintNorm) continue;
        }
        const dupHasStats = await checkStatsExist(dup.id);
        if (dupHasStats) {
          return {
            canonicalId: dup.id,
            canonicalName: dup.name,
            canonicalTeam: dup.team,
            allIds: [playerId, dup.id],
            legacyIds: [dup.id],
            status: 'LEGACY_ID_WITH_STATS',
          };
        }
      }
      return {
        canonicalId: playerId,
        canonicalName: existing.name,
        canonicalTeam: existing.team,
        allIds: [playerId, ...legacyIds],
        legacyIds,
        status: 'NO_HISTORICAL_STATS',
      };
    }
    // player_id doesn't exist in players table — broken
  }

  // 2. Exact name + team match
  const candidates = byNormName.get(normName) ?? [];
  if (candidates.length > 0 && teamHint) {
    const hintNorm = normalizeTeam(teamHint);
    const teamMatch = candidates.find(c => normalizeTeam(c.team ?? '') === hintNorm);
    if (teamMatch) {
      const hasStats = await checkStatsExist(teamMatch.id);
      const allIds = candidates.map(c => c.id);
      return {
        canonicalId: teamMatch.id,
        canonicalName: teamMatch.name,
        canonicalTeam: teamMatch.team,
        allIds,
        legacyIds: allIds.filter(id => id !== teamMatch.id),
        status: hasStats ? 'CANONICAL_AND_CURRENT' : 'NO_HISTORICAL_STATS',
      };
    }
  }

  // 3. Exact name match (any team)
  if (candidates.length === 1) {
    const c = candidates[0];
    const hasStats = await checkStatsExist(c.id);
    return {
      canonicalId: c.id,
      canonicalName: c.name,
      canonicalTeam: c.team,
      allIds: [c.id],
      legacyIds: [],
      status: hasStats ? 'CANONICAL_AND_CURRENT' : 'NO_HISTORICAL_STATS',
    };
  }

  if (candidates.length > 1) {
    // Multiple candidates — try to find one with stats
    for (const c of candidates) {
      if (teamHint) {
        const cTeamNorm = normalizeTeam(c.team ?? '');
        const hintNorm = normalizeTeam(teamHint);
        if (cTeamNorm !== hintNorm) continue;
      }
      const hasStats = await checkStatsExist(c.id);
      if (hasStats) {
        return {
          canonicalId: c.id,
          canonicalName: c.name,
          canonicalTeam: c.team,
          allIds: candidates.map(x => x.id),
          legacyIds: candidates.filter(x => x.id !== c.id).map(x => x.id),
          status: 'CANONICAL_AND_CURRENT',
        };
      }
    }
    return {
      canonicalId: candidates[0].id,
      canonicalName: candidates[0].name,
      canonicalTeam: candidates[0].team,
      allIds: candidates.map(c => c.id),
      legacyIds: candidates.slice(1).map(c => c.id),
      status: 'DUPLICATE_PLAYER_IDS',
    };
  }

  return {
    canonicalId: '',
    canonicalName: playerName,
    canonicalTeam: teamHint ?? null,
    allIds: playerId ? [playerId] : [],
    legacyIds: [],
    status: 'UNRESOLVED',
  };
}

/**
 * Check if any stats exist for a player_id.
 */
export async function checkStatsExist(playerId: string): Promise<boolean> {
  const { count } = await supabase
    .from('player_game_stats')
    .select('*', { count: 'exact', head: true })
    .eq('player_id', playerId);
  return (count ?? 0) > 0;
}

/**
 * Fetch stats counts for a list of player_ids (paginated).
 */
export async function fetchStatsCountsForIds(playerIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (playerIds.length === 0) return map;
  const BATCH = 200;
  for (let i = 0; i < playerIds.length; i += BATCH) {
    const batch = playerIds.slice(i, i + BATCH);
    const { data } = await supabase
      .from('player_game_stats')
      .select('player_id')
      .in('player_id', batch);
    if (data) {
      for (const s of data as any[]) {
        map.set(s.player_id, (map.get(s.player_id) ?? 0) + 1);
      }
    }
  }
  return map;
}

/**
 * Get all player_ids associated with a normalized name (canonical + legacy).
 */
export async function getAllIdsForName(normName: string): Promise<string[]> {
  const { byNormName } = await loadAllPlayers();
  return (byNormName.get(normName) ?? []).map(p => p.id);
}

export function clearPlayerCache() {
  PLAYER_CACHE.byId = new Map();
  PLAYER_CACHE.byNormName = new Map();
  PLAYER_CACHE.ts = 0;
}
