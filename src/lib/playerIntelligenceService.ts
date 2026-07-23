/**
 * Player Intelligence — combines Position Edge, Team Environment, Role Trends
 * (CBA/kick-in) and the player's own model output into one explainable,
 * display-only decision-support layer for the Multi Builder.
 *
 * Reuses existing verified services rather than recalculating anything:
 *  - positionEdge.ts (position_edges table — genuinely populated)
 *  - teamStatsService.ts (complete-match-only team disposal environment)
 *  - roleTrendService.ts (player_role_data table — genuine CBA/kick-in, currently unpopulated)
 *
 * Never invents a value. A component that lacks genuine, sufficient data
 * reports INSUFFICIENT_DATA / available: false and is excluded from the
 * intelligence score rather than scored as zero.
 */
import type { ModelledOddsRow } from './modelResolver';
import type { TeamEnvironmentMap, TeamDisposalStats, EnvironmentLabel } from './teamStatsService';
import { getLabelDisplay } from './teamStatsService';
import type { RoleTrendMap, RoleTrendEntry } from './roleTrendService';
import type { PositionEdgeCache, PositionEdgeResult, ConfidenceLevel } from './positionEdge';
import { getPositionEdge, normalizeOpponentName, loadPositionEdgeCache } from './positionEdge';
import { normalizeTeam } from './teamNormalizer';
import type { PlayerPossessionProfile, PositionGroupPossessionAverage } from './playerPossessionProfile';
import type { TeamFullStats } from './teamMatchAggregation';

export type PositionEdgeLabelType =
  | 'VERY_POSITIVE' | 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'VERY_NEGATIVE' | 'INSUFFICIENT_DATA';

export type TeamEnvironmentLabelType =
  | 'HIGH' | 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'LOW' | 'INSUFFICIENT_DATA';

export type RoleIntelLabelType =
  | 'ROLE_BOOST' | 'SLIGHT_BOOST' | 'STABLE' | 'SLIGHT_REDUCTION' | 'ROLE_REDUCTION' | 'UNCERTAIN';

export type TrendLabelType =
  | 'STRONG_RISE' | 'RISING' | 'STABLE' | 'FALLING' | 'STRONG_FALL' | 'INSUFFICIENT_DATA';

export type IntelligenceLabel = 'ELITE' | 'STRONG' | 'NEUTRAL' | 'WEAK' | 'AVOID' | 'UNRATED';

export interface PlayerIntelligence {
  playerId: string;
  playerName: string;
  team: string;
  matchId: string;

  positionEdge: {
    label: PositionEdgeLabelType;
    opponentRank: number | null;
    opponentRoleAverage: number | null;
    aflRoleAverage: number | null;
    sampleSize: number;
    coverage: number | null;
    confidence: number | null;
    reason: string;
  };

  teamEnvironment: {
    label: TeamEnvironmentLabelType;
    gamesUsed: number;
    coverage: number | null;
    expectedDirection: string;
    confidence: number | null;
    reason: string;
  };

  roleIntelligence: {
    label: RoleIntelLabelType;
    currentRole: string;
    sampleSize: number;
    confidence: number | null;
    reason: string;
  };

  cba: {
    available: boolean;
    /** Genuine centre-bounce attendance COUNT averages (e.g. 15.4 attendances/game). */
    seasonAverage: number | null;
    last10Average: number | null;
    last5Average: number | null;
    last3Average: number | null;
    latestValue: number | null;
    /** Share of the TEAM's centre bounces this player attended, as a 0-100 percentage. Display with %. */
    teamSharePercentage: number | null;
    latestRound: string | null;
    sampleSize: number;
    trend: TrendLabelType;
    reason: string;
  };

  kickIns: {
    available: boolean;
    /** Genuine kick-in COUNT averages (e.g. 3.8 kick-ins/game). */
    seasonAverage: number | null;
    last10Average: number | null;
    last5Average: number | null;
    last3Average: number | null;
    latestValue: number | null;
    /** Share of the TEAM's kick-ins this player took, as a 0-100 percentage. Display with %. */
    teamSharePercentage: number | null;
    latestRound: string | null;
    /** Percentage of this player's kick-ins played on from, 0-100. Display with %. */
    playOnPercentage: number | null;
    sampleSize: number;
    trend: TrendLabelType;
    reason: string;
  };

  /** Possession-style matchup intelligence (Phase 12) — separate from the
   * overall disposal teamEnvironment above. Insufficient CP/UP data reports
   * as INSUFFICIENT_DATA, never as negative. */
  possessionEnvironment: {
    uncontested: {
      label: TeamEnvironmentLabelType;
      playerRate: number | null; // this player's UP / (CP+UP), %
      positionRate: number | null; // position-group average UP rate, %
      teamForIndex: number | null; // team's UP-for vs league avg, ~100
      opponentAllowedIndex: number | null; // opponent's UP-allowed vs league avg, ~100
      playerSampleGames: number;
      reason: string;
    };
    contested: {
      label: TeamEnvironmentLabelType;
      playerRate: number | null;
      positionRate: number | null;
      teamForIndex: number | null;
      opponentAllowedIndex: number | null;
      playerSampleGames: number;
      reason: string;
    };
  };

  positives: string[];
  risks: string[];
  missingData: string[];

  intelligenceScore: number | null;
  intelligenceLabel: IntelligenceLabel;

  dataConfidence: number | null;
}

// ── Shared Position Edge cache — loaded once, independent of the "Use Position
// Edge" model toggle so intelligence is available regardless of that setting. ──
let sharedCachePromise: Promise<PositionEdgeCache> | null = null;
export function getSharedPositionEdgeCache(): Promise<PositionEdgeCache> {
  if (!sharedCachePromise) sharedCachePromise = loadPositionEdgeCache();
  return sharedCachePromise;
}

const POSITION_GROUP_LABELS: Record<string, string> = {
  'DEF-GEN': 'general defenders', 'DEF-KEY': 'key defenders', 'DEF-USER': 'rebounding defenders',
  'FWD-GEN': 'general forwards', 'FWD-KEY': 'key forwards', 'FWD-SML': 'small forwards',
  'MID-FWD': 'forward-midfielders', 'MID-INC': 'inside midfielders', 'MID-INU': 'inside/utility midfielders',
  'MID-OUT': 'outside midfielders', 'MID-TAG': 'tagging midfielders',
  'RUC-FWD': 'ruck-forwards', 'RUC-MOB': 'mobile ruckmen', 'RUC-TAP': 'ruckmen',
  'WING': 'wings', 'UNKNOWN': 'their position group',
};

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function confidenceLevelToNumber(level: ConfidenceLevel): number {
  switch (level) {
    case 'strong': return 0.9;
    case 'moderate': return 0.65;
    case 'weak': return 0.4;
    case 'low': return 0.2;
  }
}

const MIN_POSITION_EDGE_GAMES = 5;
const MIN_TEAM_ENV_GAMES = 3;
const MIN_ROLE_TREND_RECORDS = 3;

function computeOpponentRank(
  cache: PositionEdgeCache, positionGroup: string, statType: string, opponentTeam: string
): { rank: number | null; total: number } {
  const entries: { team: string; avg: number }[] = [];
  for (const key of Object.keys(cache)) {
    const e = cache[key];
    if (e.position_group !== positionGroup || e.stat_type !== statType) continue;
    if (e.games < MIN_POSITION_EDGE_GAMES) continue;
    entries.push({ team: e.opponent_team, avg: e.avg_stat_against_opponent });
  }
  if (entries.length === 0) return { rank: null, total: 0 };
  entries.sort((a, b) => a.avg - b.avg);
  const idx = entries.findIndex(e => e.team === opponentTeam);
  return { rank: idx === -1 ? null : idx + 1, total: entries.length };
}

function labelFromPositionEdge(result: PositionEdgeResult): PositionEdgeLabelType {
  if (result.significance === 'very_significant') return result.edge_value > 0 ? 'VERY_POSITIVE' : 'VERY_NEGATIVE';
  if (result.significance === 'significant') return result.edge_value > 0 ? 'POSITIVE' : 'NEGATIVE';
  return 'NEUTRAL';
}

function computePositionEdgeIntel(
  cache: PositionEdgeCache | null,
  positionGroup: string,
  opponentTeamRaw: string | null,
  statType: string,
): PlayerIntelligence['positionEdge'] {
  const empty = (reason: string, sampleSize = 0, rank: number | null = null, total = 0, avg: number | null = null, league: number | null = null): PlayerIntelligence['positionEdge'] => ({
    label: 'INSUFFICIENT_DATA', opponentRank: rank, opponentRoleAverage: avg, aflRoleAverage: league,
    sampleSize, coverage: total > 0 ? total / 18 : null, confidence: null, reason,
  });

  if (!cache || !opponentTeamRaw) return empty('No opponent matchup data available for this line.');

  const opponentTeam = normalizeOpponentName(opponentTeamRaw);
  const roleLabel = POSITION_GROUP_LABELS[positionGroup] ?? 'this position group';
  const result = getPositionEdge(cache, positionGroup, opponentTeam, statType);
  const { rank, total } = computeOpponentRank(cache, positionGroup ?? 'UNKNOWN', statType, opponentTeam);

  if (!result || result.games < MIN_POSITION_EDGE_GAMES) {
    return empty(
      `Sample too small to trust ${opponentTeam}'s matchup against ${roleLabel} yet (${result?.games ?? 0} games).`,
      result?.games ?? 0, rank, total,
      result?.avg_stat_against_opponent ?? null, result?.league_avg_for_position ?? null,
    );
  }

  const label = labelFromPositionEdge(result);
  const confidence = confidenceLevelToNumber(result.confidence);
  const diffAbs = Math.abs(result.edge_value).toFixed(1);
  const direction = result.edge_value >= 0 ? 'above' : 'below';
  const rankText = rank ? `ranks ${ordinal(rank)} of ${total}` : 'has no ranked comparison yet';
  const reason = `${opponentTeam} ${rankText} against ${roleLabel}. They concede ${diffAbs} ${statType} ${direction} the AFL baseline for the role. Sample: ${result.games} complete matches.`;

  return {
    label, opponentRank: rank, opponentRoleAverage: result.avg_stat_against_opponent,
    aflRoleAverage: result.league_avg_for_position, sampleSize: result.games,
    coverage: total > 0 ? total / 18 : null, confidence, reason,
  };
}

function mapEnvironmentLabel(label: EnvironmentLabel): TeamEnvironmentLabelType {
  switch (label) {
    case 'VERY_POSITIVE': return 'HIGH';
    case 'POSITIVE': return 'POSITIVE';
    case 'NEUTRAL': return 'NEUTRAL';
    case 'NEGATIVE': return 'NEGATIVE';
    case 'VERY_NEGATIVE': return 'LOW';
    case 'INSUFFICIENT_DATA': return 'INSUFFICIENT_DATA';
  }
}

function computeTeamEnvironmentIntel(
  teamEnvMap: TeamEnvironmentMap | undefined,
  teamStats: TeamDisposalStats[] | undefined,
  teamRaw: string,
): PlayerIntelligence['teamEnvironment'] {
  const team = normalizeTeam(teamRaw) ?? teamRaw;
  const entry = teamEnvMap?.get(team);
  const stats = teamStats?.find(s => s.team === team);
  const gamesUsed = stats?.seasonGames ?? 0;

  if (!entry || entry.label === 'INSUFFICIENT_DATA' || gamesUsed < MIN_TEAM_ENV_GAMES) {
    return {
      label: 'INSUFFICIENT_DATA', gamesUsed, coverage: null, expectedDirection: 'Unknown',
      confidence: null, reason: 'Not enough complete matches yet to judge this team\'s disposal environment.',
    };
  }

  const label = mapEnvironmentLabel(entry.label);
  const confidence = Math.min(1, gamesUsed / 10);
  const direction = entry.environmentDiff >= 0 ? 'Above average' : 'Below average';
  const reason = `${getLabelDisplay(entry.label)} disposal environment for ${team}. Expected team disposals ${Math.abs(entry.environmentDiff)} ${entry.environmentDiff >= 0 ? 'above' : 'below'} league average, based on ${gamesUsed} complete matches.`;

  return { label, gamesUsed, coverage: Math.min(1, gamesUsed / 10), expectedDirection: direction, confidence, reason };
}

function roleLabelFromTrend(label: RoleTrendEntry['trendLabel']): RoleIntelLabelType {
  switch (label) {
    case 'STRONG_POSITIVE': return 'ROLE_BOOST';
    case 'POSITIVE': return 'SLIGHT_BOOST';
    case 'STABLE': return 'STABLE';
    case 'NEGATIVE': return 'SLIGHT_REDUCTION';
    case 'STRONG_NEGATIVE': return 'ROLE_REDUCTION';
    case 'UNKNOWN': return 'UNCERTAIN';
  }
}

function computeRoleIntel(
  roleTrends: RoleTrendMap | undefined,
  playerId: string,
  positionGroup: string,
  row: ModelledOddsRow,
): PlayerIntelligence['roleIntelligence'] {
  const currentRole = POSITION_GROUP_LABELS[positionGroup] ?? positionGroup;
  const entry = roleTrends?.get(playerId);

  if (entry && entry.sampleSize >= MIN_ROLE_TREND_RECORDS && entry.trendLabel !== 'UNKNOWN') {
    const label = roleLabelFromTrend(entry.trendLabel);
    const confidence = entry.confidence === 'high' ? 0.85 : entry.confidence === 'medium' ? 0.6 : 0.35;
    const reason = label === 'ROLE_BOOST' || label === 'SLIGHT_BOOST'
      ? `Verified CBA/kick-in involvement has risen across the last 3 matches (${entry.sampleSize} genuine records).`
      : label === 'ROLE_REDUCTION' || label === 'SLIGHT_REDUCTION'
        ? `Verified CBA/kick-in involvement has fallen across the last 3 matches (${entry.sampleSize} genuine records).`
        : `Role has stayed stable across ${entry.sampleSize} genuine CBA/kick-in records.`;
    return { label, currentRole, sampleSize: entry.sampleSize, confidence, reason };
  }

  // Fall back to the player's own recent disposal trend as a weaker, single, capped signal —
  // never combined with the CBA/kick-in signal above (that branch already returned).
  const sc = row.modelProb.sampleComparison;
  if (sc?.last5 && sc?.last10 && row.modelProb.sample_size >= 8) {
    const last5Rate = sc.last5.hit_rate;
    const seasonRate = row.modelProb.hit_rate;
    const diff = last5Rate - seasonRate;
    if (Math.abs(diff) >= 0.15) {
      const label: RoleIntelLabelType = diff > 0 ? 'SLIGHT_BOOST' : 'SLIGHT_REDUCTION';
      return {
        label, currentRole, sampleSize: row.modelProb.sample_size, confidence: 0.3,
        reason: `Recent disposal involvement has ${diff > 0 ? 'improved' : 'dropped'} versus season average, but no verified CBA or kick-in role data is available to confirm this is a genuine role change.`,
      };
    }
  }

  return {
    label: 'UNCERTAIN', currentRole, sampleSize: entry?.sampleSize ?? 0, confidence: null,
    reason: 'No verified CBA, kick-in, or clear disposal-trend evidence is available for this player\'s role right now.',
  };
}

function trendLabelFromChange(change: number, threshold: number, sampleSize: number): TrendLabelType {
  if (sampleSize < MIN_ROLE_TREND_RECORDS) return 'INSUFFICIENT_DATA';
  if (change >= threshold * 2) return 'STRONG_RISE';
  if (change >= threshold) return 'RISING';
  if (change <= -threshold * 2) return 'STRONG_FALL';
  if (change <= -threshold) return 'FALLING';
  return 'STABLE';
}

function computeCbaIntel(entry: RoleTrendEntry | undefined): PlayerIntelligence['cba'] {
  if (!entry || entry.sampleSize === 0) {
    return {
      available: false, seasonAverage: null, last10Average: null, last5Average: null, last3Average: null,
      latestValue: null, teamSharePercentage: null, latestRound: null, sampleSize: 0,
      trend: 'INSUFFICIENT_DATA', reason: 'No genuine centre-bounce attendance data has been imported for this player yet.',
    };
  }
  const trend = trendLabelFromChange(entry.cbaChange, 10, entry.sampleSize);
  return {
    available: true,
    // Counts (raw attendances), not the team-share percentage.
    seasonAverage: Math.round(entry.cbaCountSeasonAvg * 10) / 10,
    last10Average: Math.round(entry.cbaCountLast10 * 10) / 10,
    last5Average: Math.round(entry.cbaCountLast5 * 10) / 10,
    last3Average: Math.round(entry.cbaCountLast3 * 10) / 10,
    latestValue: entry.latestCbaCount,
    // cba_percentage is stored 0-1 in the DB — convert to 0-100 here, once, at the source.
    teamSharePercentage: entry.latestCba != null ? Math.round(entry.latestCba * 1000) / 10 : null,
    latestRound: entry.latestRound,
    sampleSize: entry.sampleSize,
    trend,
    reason: `Genuine CBA data from ${entry.sampleSize} matches (source: DFS Australia via player_role_data).`,
  };
}

function computeKickInIntel(entry: RoleTrendEntry | undefined): PlayerIntelligence['kickIns'] {
  if (!entry || entry.sampleSize === 0) {
    return {
      available: false, seasonAverage: null, last10Average: null, last5Average: null, last3Average: null,
      latestValue: null, teamSharePercentage: null, latestRound: null, playOnPercentage: null, sampleSize: 0,
      trend: 'INSUFFICIENT_DATA', reason: 'No genuine kick-in data has been imported for this player yet.',
    };
  }
  const trend = trendLabelFromChange(entry.kickInChange, 0.08, entry.sampleSize);
  return {
    available: true,
    // Counts (raw kick-ins), not the team-share percentage.
    seasonAverage: Math.round(entry.kickInCountSeasonAvg * 10) / 10,
    last10Average: Math.round(entry.kickInCountLast10 * 10) / 10,
    last5Average: Math.round(entry.kickInCountLast5 * 10) / 10,
    last3Average: Math.round(entry.kickInCountLast3 * 10) / 10,
    latestValue: entry.latestKickInCount,
    // kick_in_share is stored 0-1 in the DB — convert to 0-100 here, once, at the source.
    teamSharePercentage: entry.latestKickInShare != null ? Math.round(entry.latestKickInShare * 1000) / 10 : null,
    latestRound: entry.latestRound,
    playOnPercentage: entry.kickInPlayOnPctSeason != null ? Math.round(entry.kickInPlayOnPctSeason * 1000) / 10 : null,
    sampleSize: entry.sampleSize,
    trend,
    reason: `Genuine kick-in data from ${entry.sampleSize} matches (source: DFS Australia via player_role_data).`,
  };
}

function scoreFromPositionLabel(label: PositionEdgeLabelType): number {
  switch (label) {
    case 'VERY_POSITIVE': return 95;
    case 'POSITIVE': return 75;
    case 'NEUTRAL': return 50;
    case 'NEGATIVE': return 25;
    case 'VERY_NEGATIVE': return 5;
    case 'INSUFFICIENT_DATA': return 50;
  }
}

function scoreFromEnvLabel(label: TeamEnvironmentLabelType): number {
  switch (label) {
    case 'HIGH': return 90;
    case 'POSITIVE': return 70;
    case 'NEUTRAL': return 50;
    case 'NEGATIVE': return 30;
    case 'LOW': return 10;
    case 'INSUFFICIENT_DATA': return 50;
  }
}

function scoreFromRoleLabel(label: RoleIntelLabelType): number {
  switch (label) {
    case 'ROLE_BOOST': return 90;
    case 'SLIGHT_BOOST': return 68;
    case 'STABLE': return 50;
    case 'SLIGHT_REDUCTION': return 32;
    case 'ROLE_REDUCTION': return 10;
    case 'UNCERTAIN': return 50;
  }
}

function labelFromScore(score: number): IntelligenceLabel {
  if (score >= 85) return 'ELITE';
  if (score >= 70) return 'STRONG';
  if (score >= 50) return 'NEUTRAL';
  if (score >= 30) return 'WEAK';
  return 'AVOID';
}

export interface PlayerIntelligenceInput {
  row: ModelledOddsRow;
  playerId: string;
  playerName: string;
  team: string;
  matchId: string;
  opponentTeam: string | null;
  positionGroup: string;
  statType?: string;
  positionEdgeCache: PositionEdgeCache | null;
  teamEnvMap: TeamEnvironmentMap | undefined;
  teamStats: TeamDisposalStats[] | undefined;
  roleTrends: RoleTrendMap | undefined;
  /** Optional — possession-style matchup intelligence (Phase 12). Absent
   * gracefully degrades to INSUFFICIENT_DATA rather than erroring. */
  possessionProfile?: PlayerPossessionProfile;
  positionPossessionAverages?: Map<string, PositionGroupPossessionAverage>;
  teamFullStats?: Map<string, TeamFullStats>;
}

function possessionSignal(
  playerRate: number | null | undefined,
  positionRate: number | null | undefined,
  teamForIndex: number | null | undefined,
  opponentAllowedIndex: number | null | undefined,
  playerSampleGames: number,
  styleName: 'uncontested' | 'contested',
  playerName: string,
  team: string,
  opponentTeam: string | null,
): PlayerIntelligence['possessionEnvironment']['uncontested'] {
  const MIN_SAMPLE = 3;
  if (playerRate == null || positionRate == null || playerSampleGames < MIN_SAMPLE) {
    return {
      label: 'INSUFFICIENT_DATA', playerRate: playerRate ?? null, positionRate: positionRate ?? null,
      teamForIndex: teamForIndex ?? null, opponentAllowedIndex: opponentAllowedIndex ?? null,
      playerSampleGames,
      reason: `Not enough genuine ${styleName} possession data yet (${playerSampleGames} game${playerSampleGames === 1 ? '' : 's'} recorded, need ${MIN_SAMPLE}+).`,
    };
  }
  const playerAbovePosition = playerRate - positionRate;
  const teamStrong = teamForIndex != null && teamForIndex >= 105;
  const oppAllowsMore = opponentAllowedIndex != null && opponentAllowedIndex >= 105;
  const teamWeak = teamForIndex != null && teamForIndex <= 95;
  const oppAllowsLess = opponentAllowedIndex != null && opponentAllowedIndex <= 95;

  let label: TeamEnvironmentLabelType = 'NEUTRAL';
  const positiveSignals = [playerAbovePosition > 3, teamStrong, oppAllowsMore].filter(Boolean).length;
  const negativeSignals = [playerAbovePosition < -3, teamWeak, oppAllowsLess].filter(Boolean).length;
  if (positiveSignals >= 2) label = 'HIGH';
  else if (positiveSignals >= 1 && negativeSignals === 0) label = 'POSITIVE';
  else if (negativeSignals >= 2) label = 'LOW';
  else if (negativeSignals >= 1 && positiveSignals === 0) label = 'NEGATIVE';

  const oppText = opponentTeam ? ` ${opponentAllowedIndex != null ? (opponentAllowedIndex >= 100 ? `${opponentTeam} allows ${opponentAllowedIndex - 100}% more ${styleName} possessions than the league average.` : `${opponentTeam} allows ${100 - opponentAllowedIndex}% fewer ${styleName} possessions than the league average.`) : ''}` : '';
  const reason = `${playerName} records ${playerRate}% of possessions ${styleName}, ${playerAbovePosition >= 0 ? 'above' : 'below'} the position average of ${positionRate}%.${oppText}`;

  return {
    label, playerRate, positionRate, teamForIndex: teamForIndex ?? null, opponentAllowedIndex: opponentAllowedIndex ?? null,
    playerSampleGames, reason,
  };
}

function computePossessionEnvironmentIntel(
  playerName: string, team: string, opponentTeam: string | null,
  profile: PlayerPossessionProfile | undefined,
  positionAverages: Map<string, PositionGroupPossessionAverage> | undefined,
  teamFullStats: Map<string, TeamFullStats> | undefined,
): PlayerIntelligence['possessionEnvironment'] {
  const posAvg = profile ? positionAverages?.get(profile.positionGroup) : undefined;
  // teamFullStats is keyed by canonical team name (e.g. "Collingwood"); the
  // player row's team field can be a raw slug ("collingwood") — normalize
  // before lookup, the same gap that caused Team Environment's earlier bug.
  const teamStatsEntry = teamFullStats?.get(normalizeTeam(team) ?? team);
  const oppStatsEntry = opponentTeam ? teamFullStats?.get(normalizeTeam(opponentTeam) ?? opponentTeam) : undefined;
  const sample = profile?.season.games ?? 0;

  return {
    uncontested: possessionSignal(
      profile?.season.upRate, posAvg?.upRate, teamStatsEntry?.uncontestedForIndex, oppStatsEntry?.uncontestedAllowedIndex,
      sample, 'uncontested', playerName, team, opponentTeam,
    ),
    contested: possessionSignal(
      profile?.season.cpRate, posAvg?.cpRate, teamStatsEntry?.contestedForIndex, oppStatsEntry?.contestedAllowedIndex,
      sample, 'contested', playerName, team, opponentTeam,
    ),
  };
}

export function computePlayerIntelligence(input: PlayerIntelligenceInput): PlayerIntelligence {
  const {
    row, playerId, playerName, team, matchId, opponentTeam, positionGroup,
    statType = 'disposals', positionEdgeCache, teamEnvMap, teamStats, roleTrends,
    possessionProfile, positionPossessionAverages, teamFullStats,
  } = input;

  const positionEdge = computePositionEdgeIntel(positionEdgeCache, positionGroup, opponentTeam, statType);
  const teamEnvironment = computeTeamEnvironmentIntel(teamEnvMap, teamStats, team);
  const possessionEnvironment = computePossessionEnvironmentIntel(
    playerName, team, opponentTeam, possessionProfile, positionPossessionAverages, teamFullStats,
  );
  const roleEntry = roleTrends?.get(playerId);
  const roleIntelligence = computeRoleIntel(roleTrends, playerId, positionGroup, row);
  const cba = computeCbaIntel(roleEntry);
  const kickIns = computeKickInIntel(roleEntry);

  const positives: string[] = [];
  const risks: string[] = [];
  const missingData: string[] = [];

  if (positionEdge.label === 'POSITIVE' || positionEdge.label === 'VERY_POSITIVE') positives.push(positionEdge.reason);
  else if (positionEdge.label === 'NEGATIVE' || positionEdge.label === 'VERY_NEGATIVE') risks.push(positionEdge.reason);
  else if (positionEdge.label === 'INSUFFICIENT_DATA') missingData.push('Position Edge: ' + positionEdge.reason);

  if (teamEnvironment.label === 'POSITIVE' || teamEnvironment.label === 'HIGH') positives.push(teamEnvironment.reason);
  else if (teamEnvironment.label === 'NEGATIVE' || teamEnvironment.label === 'LOW') risks.push(teamEnvironment.reason);
  else if (teamEnvironment.label === 'INSUFFICIENT_DATA') missingData.push('Team Environment: ' + teamEnvironment.reason);

  // Possession-style signals — display-only matchup intelligence, never blended
  // into intelligenceScore (no explicit model-adjustment setting exists for it).
  if (possessionEnvironment.uncontested.label === 'POSITIVE' || possessionEnvironment.uncontested.label === 'HIGH') positives.push('Positive uncontested matchup: ' + possessionEnvironment.uncontested.reason);
  else if (possessionEnvironment.uncontested.label === 'NEGATIVE' || possessionEnvironment.uncontested.label === 'LOW') risks.push('Negative uncontested matchup: ' + possessionEnvironment.uncontested.reason);
  if (possessionEnvironment.contested.label === 'POSITIVE' || possessionEnvironment.contested.label === 'HIGH') positives.push('Positive contested matchup: ' + possessionEnvironment.contested.reason);
  else if (possessionEnvironment.contested.label === 'NEGATIVE' || possessionEnvironment.contested.label === 'LOW') risks.push('Negative contested matchup: ' + possessionEnvironment.contested.reason);

  if (roleIntelligence.label === 'ROLE_BOOST' || roleIntelligence.label === 'SLIGHT_BOOST') positives.push(roleIntelligence.reason);
  else if (roleIntelligence.label === 'ROLE_REDUCTION' || roleIntelligence.label === 'SLIGHT_REDUCTION') risks.push(roleIntelligence.reason);
  else if (roleIntelligence.label === 'UNCERTAIN') missingData.push('Role Intelligence: ' + roleIntelligence.reason);

  if (!cba.available) missingData.push('CBA data not yet imported for this player.');
  if (!kickIns.available) missingData.push('Kick-in data not yet imported for this player.');

  if (row.freshness && row.freshness.freshnessStatus !== 'CURRENT') {
    risks.push(`Stats freshness is ${row.freshness.freshnessStatus.toLowerCase()} — verify before relying on this line.`);
  }
  if (row.modelProb.sample_size < 10) {
    missingData.push(`Only ${row.modelProb.sample_size} games of historical sample for this line.`);
  }

  // Weighted score over available components only — unavailable components are
  // excluded, not scored as zero, and reduce dataConfidence instead.
  const components: { value: number; weight: number }[] = [];
  if (positionEdge.label !== 'INSUFFICIENT_DATA') components.push({ value: scoreFromPositionLabel(positionEdge.label), weight: 0.30 });
  if (teamEnvironment.label !== 'INSUFFICIENT_DATA') components.push({ value: scoreFromEnvLabel(teamEnvironment.label), weight: 0.25 });
  if (roleIntelligence.label !== 'UNCERTAIN') components.push({ value: scoreFromRoleLabel(roleIntelligence.label), weight: 0.20 });
  if (row.modelProb.adjustedProb != null) components.push({ value: row.modelProb.adjustedProb * 100, weight: 0.25 });

  const totalWeight = components.reduce((s, c) => s + c.weight, 0);
  const hasEnoughEvidence = totalWeight >= 0.25 && row.modelProb.sample_size >= 5;

  let intelligenceScore: number | null = null;
  let intelligenceLabel: IntelligenceLabel = 'UNRATED';
  let dataConfidence: number | null = null;

  if (hasEnoughEvidence) {
    intelligenceScore = Math.round(components.reduce((s, c) => s + c.value * c.weight, 0) / totalWeight);
    intelligenceLabel = labelFromScore(intelligenceScore);
    dataConfidence = Math.round(totalWeight * 100) / 100;
  }

  return {
    playerId, playerName, team, matchId,
    positionEdge, teamEnvironment, possessionEnvironment, roleIntelligence, cba, kickIns,
    positives: positives.slice(0, 3),
    risks: risks.slice(0, 3),
    missingData,
    intelligenceScore, intelligenceLabel, dataConfidence,
  };
}
