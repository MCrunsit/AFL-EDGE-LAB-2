/**
 * Per-match player exclusions, stored in localStorage keyed by match ID.
 * Each match has its own independent exclusion list.
 */

const STORAGE_PREFIX = 'pullem_excluded_players_';

export interface ExcludedPlayer {
  playerId: string;
  playerName: string;
  team: string;
}

function storageKey(matchId: string): string {
  return `${STORAGE_PREFIX}${matchId}`;
}

export function getExcludedPlayers(matchId: string): ExcludedPlayer[] {
  try {
    const raw = localStorage.getItem(storageKey(matchId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function setExcludedPlayers(matchId: string, players: ExcludedPlayer[]): void {
  try {
    localStorage.setItem(storageKey(matchId), JSON.stringify(players));
  } catch {
    // localStorage may be full or unavailable
  }
}

export function excludePlayer(matchId: string, player: ExcludedPlayer): void {
  const current = getExcludedPlayers(matchId);
  if (current.some(p => p.playerId === player.playerId)) return;
  setExcludedPlayers(matchId, [...current, player]);
}

export function unexcludePlayer(matchId: string, playerId: string): void {
  const current = getExcludedPlayers(matchId);
  setExcludedPlayers(matchId, current.filter(p => p.playerId !== playerId));
}

export function clearExcludedPlayers(matchId: string): void {
  try {
    localStorage.removeItem(storageKey(matchId));
  } catch {
    // ignore
  }
}

export function isPlayerExcluded(matchId: string, playerId: string): boolean {
  return getExcludedPlayers(matchId).some(p => p.playerId === player.playerId);
}

export function getExcludedPlayerIds(matchId: string): Set<string> {
  return new Set(getExcludedPlayers(matchId).map(p => p.playerId));
}
