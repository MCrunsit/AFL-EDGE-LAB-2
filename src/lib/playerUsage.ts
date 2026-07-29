/**
 * Round-scoped "already used in a multi" flag, stored in localStorage keyed
 * by round. Purely informational — unlike playerExclusions.ts, this never
 * filters a player out of a search; it only surfaces a badge so the user
 * can see they've already leaned on a player elsewhere this round, with a
 * one-click toggle to reuse them anyway. Resets automatically each round
 * since the storage key is round-scoped.
 */

const STORAGE_PREFIX = 'pullem_player_usage_';

export interface PlayerUsageRecord {
  playerId: string;
  playerName: string;
  source: 'manual' | 'tracked';
}

function storageKey(round: string): string {
  return `${STORAGE_PREFIX}${round}`;
}

export function getUsedPlayers(round: string): PlayerUsageRecord[] {
  try {
    const raw = localStorage.getItem(storageKey(round));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function setUsedPlayers(round: string, players: PlayerUsageRecord[]): void {
  try {
    localStorage.setItem(storageKey(round), JSON.stringify(players));
  } catch {
    // localStorage may be full or unavailable
  }
}

export function markPlayerUsed(round: string, player: PlayerUsageRecord): void {
  const current = getUsedPlayers(round);
  if (current.some(p => p.playerId === player.playerId)) return;
  setUsedPlayers(round, [...current, player]);
}

export function unmarkPlayerUsed(round: string, playerId: string): void {
  const current = getUsedPlayers(round);
  setUsedPlayers(round, current.filter(p => p.playerId !== playerId));
}

export function clearUsedPlayers(round: string): void {
  try {
    localStorage.removeItem(storageKey(round));
  } catch {
    // ignore
  }
}

export function isPlayerUsed(round: string, playerId: string): boolean {
  return getUsedPlayers(round).some(p => p.playerId === playerId);
}

export function getUsedPlayerIds(round: string): Set<string> {
  return new Set(getUsedPlayers(round).map(p => p.playerId));
}
