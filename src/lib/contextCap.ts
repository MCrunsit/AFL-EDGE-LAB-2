/**
 * Clamp a value between min and max.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Combined context adjustment cap.
 * Total adjustment from venue, player-opponent, position, team environment, and role trend
 * must never exceed ±5 percentage points.
 */
export function computeTotalContextAdjustment(
  venueAdjustment: number,
  playerOpponentAdjustment: number,
  positionAdjustment: number,
  teamEnvironmentAdjustment: number,
  roleAdjustment: number,
): number {
  const raw =
    venueAdjustment +
    playerOpponentAdjustment +
    positionAdjustment +
    teamEnvironmentAdjustment +
    roleAdjustment;

  return clamp(raw, -0.05, 0.05);
}
