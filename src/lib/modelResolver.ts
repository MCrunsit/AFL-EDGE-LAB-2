import { supabase } from './supabase';
import { getAltLadderOddsForMatch, getOULinesForMatch, getRawOddsForMatch, extractStatType, type NormalizedOddsRow } from './oddsNormalizer';
import { normalizeStatType, normalizeVenueKey } from './matchupEdge';
import {
  loadPositionEdgeCache, getPositionEdge, getPositionEdgeAdjustment, capAdjustment,
  computeFinalProbability, computeFinalEV, normalizeOpponentName, computeTotalMatchupAdjustment,
  capVenueAdjustment, capOpponentAdjustment,
  type PositionEdgeCache, type PositionEdgeResult, type VenueEdgeResult, type OpponentEdgeResult, type StatType,
} from './positionEdge';
import { normalizePlayerName, buildPlayerMatchCache, resolvePlayer, type PlayerMatchCache } from './playerMatching';
import {
  loadHistoricalStatsForPlayers, getVenueEdgeFromCache, getOpponentEdgeFromCache,
  getSeasonValuesForPlayerStat, inferCurrentSeason, computePlayerFreshness,
  type HistoricalStatsCache, type PlayerFreshness,
} from './historicalStatsService';
import { loadAllPlayers, normalizeFullName } from './canonicalPlayerService';
import {
  computeSampleComparison, computeSampleWarningTags, confidenceFactorBySampleSize,
  type SampleWindow, type SampleComparison,
} from './betGrading';
import type { Match } from './types';

async function getLatestCompletedStatsRound(): Promise<number | null> {
  try {
    const { supabase } = await import('./supabase');
    const today = new Date().toISOString().split('T')[0];
    const { data } = await supabase
      .from('matches')
      .select('round')
      .eq('season', 2026)
      .lt('match_date', today)
      .neq('round', '0')
      .order('round', { ascending: false })
      .limit(1);
    if (data && data.length > 0 && data[0].round) {
      return parseInt(data[0].round, 10);
    }
  } catch { /* ignore */ }
  return null;
}

export interface ContextStats {
  venue_name: string | null;
  venue_games: number;
  venue_hits: number;
  venue_hit_rate: number;
  venue_average: number;
  venue_max: number;
  opponent_team: string | null;
  opponent_games: number;
  opponent_hits: number;
  opponent_hit_rate: number;
  opponent_average: number;
  opponent_max: number;
  season_hit_rate: number;
}

export interface ModelProb {
  probability: number | null;
  conservativeProb: number | null;
  adjustedProb: number | null;
  sample_size: number;
  confidence: 'none' | 'low' | 'medium' | 'high';
  hit_count: number;
  hit_rate: number;
  max_stat: number;
  avg_stat: number;
  venue_adjustment: number;
  opponent_adjustment: number;
  tags: string[];
  context: ContextStats | null;
  quality_score: number;
  risk_level: 'Low' | 'Medium' | 'High';
  sampleWindow: SampleWindow;
  sampleComparison: SampleComparison | null;
  sampleWarningTags: string[];
}

export type ModelStatus =
  | 'MODEL_READY'
  | 'ODDS_ONLY'
  | 'PLAYER_UNRESOLVED'
  | 'NO_STATS'
  | 'INSUFFICIENT_MARKET_SAMPLE'
  | 'SAMPLE_AUDIT_FAILED'
  | 'WRONG_TEAM'
  | 'STALE_OR_LIMITED_SAMPLE';

export type NoStatsReason =
  | 'PLAYER_ID_NULL'
  | 'PLAYER_ID_HAS_ZERO_STATS'
  | 'INSUFFICIENT_MARKET_SAMPLE'
  | 'WRONG_TEAM'
  | 'PLAYER_TEAM_MISSING'
  | 'UNKNOWN';

export interface ModelledOddsRow extends NormalizedOddsRow {
  player_id: string | null;
  resolvedPlayerId: string | null;
  player_name: string;
  playerTeam: string;
  opponent: string | null;
  positionGroup: string;
  statType: string;
  modelProb: ModelProb;
  modelStatus: ModelStatus;
  noStatsReason: NoStatsReason | null;
  conservativeEV: number | null;
  adjustedEV: number | null;
  edge: number | null;
  impliedProb: number;
  isRealistic: boolean;
  isValid: boolean;
  positionEdge: PositionEdgeResult | null;
  positionEdgeAdjustment: number;
  venueEdge: VenueEdgeResult | null;
  venueEdgeAdjustment: number;
  opponentEdge: OpponentEdgeResult | null;
  opponentEdgeAdjustment: number;
  totalMatchupAdjustment: number;
  finalProbability: number | null;
  finalEV: number | null;
  isWrongTeam: boolean;
  totalStatsRows: number;
  directDbStatsCount: number;
  marketSampleCount: number;
  // Debug fields for sample inspection
  nonNullStatValues: number;
  firstFiveValues: number[];
  rawStatType: string | null;
  resolvedStatType: string;
  // Freshness
  freshness: PlayerFreshness | null;
}

export interface ModelCoverage {
  totalOddsRows: number;
  modelReady: number;
  oddsOnly: number;
  noStats: number;
  insufficientSample: number;
  wrongTeam: number;
  unresolvedPlayer: number;
  modelReadyPlayers: number;
  lastRefreshed: Date;
}

export interface ModelResolverResult {
  rows: ModelledOddsRow[];
  coverage: ModelCoverage;
  match: Match | null;
}

export function calculateModelProb(
  values: number[],
  threshold: number,
  context?: ContextStats | null,
  sampleWindow: SampleWindow = 'weighted',
  seasonValues?: number[]
): ModelProb {
  const games = values.length;

  const sampleComparison: SampleComparison | null = games >= 5
    ? computeSampleComparison(values, threshold, seasonValues)
    : null;
  const sampleWarningTags: string[] = sampleComparison
    ? computeSampleWarningTags(sampleComparison)
    : [];

  if (games < 5) {
    return {
      probability: null, conservativeProb: null, adjustedProb: null,
      sample_size: games, confidence: 'none', hit_count: 0, hit_rate: 0,
      max_stat: games > 0 ? Math.max(...values) : 0, avg_stat: games > 0 ? values.reduce((a, b) => a + b, 0) / games : 0,
      venue_adjustment: 0, opponent_adjustment: 0,
      tags: ['Low Sample'], context: null,
      quality_score: 0, risk_level: 'High',
      sampleWindow, sampleComparison, sampleWarningTags,
    };
  }

  let windowedValues: number[];
  let windowLabel: string;

  switch (sampleWindow) {
    case 'last5': windowedValues = values.slice(0, 5); windowLabel = 'Last 5'; break;
    case 'last10': windowedValues = values.slice(0, 10); windowLabel = 'Last 10'; break;
    case 'last15': windowedValues = values.slice(0, 15); windowLabel = 'Last 15'; break;
    case 'last20': windowedValues = values.slice(0, 20); windowLabel = 'Last 20'; break;
    case 'last30': windowedValues = values.slice(0, 30); windowLabel = 'Last 30'; break;
    case 'season': windowedValues = seasonValues && seasonValues.length > 0 ? seasonValues : values; windowLabel = 'Current Season'; break;
    case 'custom': windowedValues = values; windowLabel = 'Custom Date Range'; break;
    case 'weighted':
    default: windowedValues = values; windowLabel = 'Weighted Model'; break;
  }

  const windowGames = windowedValues.length;

  if (windowGames < 5 && sampleWindow !== 'weighted') {
    return {
      probability: null, conservativeProb: null, adjustedProb: null,
      sample_size: windowGames, confidence: 'none', hit_count: 0, hit_rate: 0,
      max_stat: windowGames > 0 ? Math.max(...windowedValues) : 0,
      avg_stat: windowGames > 0 ? windowedValues.reduce((a, b) => a + b, 0) / windowGames : 0,
      venue_adjustment: 0, opponent_adjustment: 0,
      tags: ['Small Sample'], context: null,
      quality_score: 0, risk_level: 'High',
      sampleWindow, sampleComparison, sampleWarningTags,
    };
  }

  const hitCount = windowedValues.filter(v => v >= threshold).length;
  const windowHR = windowGames > 0 ? hitCount / windowGames : 0;

  let rawProb: number;

  if (sampleWindow === 'weighted') {
    const seasonHR = hitCount / games;
    const last10HR = values.slice(0, 10).filter(v => v >= threshold).length / Math.min(10, games);
    const last5HR = values.slice(0, 5).filter(v => v >= threshold).length / Math.min(5, games);
    const last3HR = values.slice(0, 3).filter(v => v >= threshold).length / Math.min(3, games);
    rawProb = seasonHR * 0.40 + last10HR * 0.25 + last5HR * 0.25 + last3HR * 0.10;
  } else {
    rawProb = windowHR;
  }

  const { factor: confidenceFactor, confidence } = confidenceFactorBySampleSize(
    sampleWindow === 'weighted' ? games : windowGames
  );

  const conservativeProb = rawProb * confidenceFactor;
  const maxStat = Math.max(...windowedValues);
  const avgStat = windowedValues.reduce((a, b) => a + b, 0) / windowGames;

  let venueAdjustment = 0;
  let opponentAdjustment = 0;
  const tags: string[] = [];

  const baselineHR = sampleWindow === 'weighted' ? hitCount / games : windowHR;

  if (context) {
    if (context.venue_games >= 3) {
      const venueWeight = context.venue_games >= 8 ? 0.60 : context.venue_games >= 5 ? 0.40 : 0.25;
      const rawVenueAdj = (context.venue_hit_rate - baselineHR) * venueWeight;
      venueAdjustment = Math.max(-0.075, Math.min(0.075, rawVenueAdj));
      if (venueAdjustment >= 0.03) tags.push('Strong Venue');
      else if (venueAdjustment <= -0.03) tags.push('Weak Venue');
    } else {
      tags.push('No Venue Sample');
    }

    if (context.opponent_games >= 3) {
      const oppWeight = context.opponent_games >= 8 ? 0.60 : context.opponent_games >= 5 ? 0.40 : 0.25;
      const rawOppAdj = (context.opponent_hit_rate - baselineHR) * oppWeight;
      opponentAdjustment = Math.max(-0.075, Math.min(0.075, rawOppAdj));
      if (opponentAdjustment >= 0.03) tags.push('Strong Opponent');
      else if (opponentAdjustment <= -0.03) tags.push('Weak Opponent');
    } else {
      tags.push('No Opponent Sample');
    }
  }

  const totalAdj = Math.max(-0.10, Math.min(0.10, venueAdjustment + opponentAdjustment));
  const adjustedProb = Math.max(0.01, Math.min(0.95, conservativeProb + totalAdj));

  if (totalAdj > 0.02) tags.push('Context Boost');
  else if (totalAdj < -0.02) tags.push('Context Downgrade');

  if (threshold > maxStat) tags.push('Extreme Line');
  else if (hitCount === 0) tags.push('No Historical Hit');
  else if (hitCount <= 2) tags.push('Low Hit Count');
  else tags.unshift('Realistic');

  for (const tag of sampleWarningTags) {
    if (!tags.includes(tag)) tags.push(tag);
  }

  if (windowGames >= 15) tags.push('High Confidence');
  else if (windowGames < 10) tags.push('Small Sample');

  return {
    probability: rawProb,
    conservativeProb,
    adjustedProb,
    sample_size: windowGames,
    confidence: windowGames >= 10 ? confidence : 'low',
    hit_count: hitCount,
    hit_rate: windowHR,
    max_stat: maxStat,
    avg_stat: avgStat,
    venue_adjustment: venueAdjustment,
    opponent_adjustment: opponentAdjustment,
    tags,
    context,
    quality_score: 0,
    risk_level: 'Medium',
    sampleWindow,
    sampleComparison,
    sampleWarningTags,
  };
}

export function calculateQualityScore(prob: ModelProb, ev: number | null, odds: number): number {
  if (!prob.adjustedProb) return 0;
  const evScore = Math.min(30, Math.max(0, (ev || 0) * 300));
  const probScore = prob.adjustedProb * 25;
  const confScore = prob.sample_size >= 20 ? 20 : prob.sample_size >= 15 ? 16 : prob.sample_size >= 10 ? 12 : prob.sample_size >= 5 ? 8 : 4;
  const hitScore = prob.hit_count >= 15 ? 15 : prob.hit_count >= 10 ? 12 : prob.hit_count >= 5 ? 9 : prob.hit_count >= 2 ? 5 : 2;
  const contextScore = prob.tags.includes('Strong Venue') || prob.tags.includes('Strong Opponent') ? 10 :
    prob.tags.includes('Context Boost') ? 8 :
      prob.tags.includes('Weak Venue') || prob.tags.includes('Weak Opponent') ? 3 :
        prob.tags.includes('No Venue Sample') || prob.tags.includes('No Opponent Sample') ? 5 : 7;
  let total = evScore + probScore + confScore + hitScore + contextScore;
  if (prob.tags.includes('Extreme Line')) total -= 15;
  if (prob.tags.includes('No Historical Hit')) total -= 20;
  if (prob.tags.includes('Weak Venue')) total -= 5;
  if (prob.tags.includes('Weak Opponent')) total -= 5;
  if (odds > 4.0) total -= 5;
  if (prob.hit_count <= 2) total -= 8;
  return Math.max(0, Math.min(100, total));
}

export function calculateRiskLevel(prob: ModelProb, odds: number): 'Low' | 'Medium' | 'High' {
  if (!prob.adjustedProb) return 'High';
  if (prob.adjustedProb >= 0.70 && odds <= 1.60 && prob.sample_size >= 20 && prob.hit_count >= 15) return 'Low';
  if (prob.adjustedProb >= 0.45 && odds <= 3.00 && prob.sample_size >= 10 && prob.hit_count >= 5) return 'Medium';
  return 'High';
}

export interface ModelResolverOptions {
  sampleWindow?: SampleWindow;
  usePositionEdge?: boolean;
  useVenueEdge?: boolean;
  useOpponentEdge?: boolean;
  minHits?: number;
  minSample?: number;
  maxOdds?: number;
  minAdjustedProb?: number;
  minAdjustedEV?: number;
  includeOULines?: boolean;
}

export async function getModelledBookmakerOddsForMatch(
  matchId: string,
  options: ModelResolverOptions = {}
): Promise<ModelResolverResult> {
  const {
    sampleWindow = 'weighted',
    usePositionEdge = false,
    useVenueEdge = false,
    useOpponentEdge = false,
    includeOULines = false,
  } = options;

  // Fetch match
  const { data: matchData } = await supabase
    .from('matches')
    .select('*')
    .eq('id', matchId)
    .maybeSingle();
  const match = matchData as Match | null;

  // Fetch odds from bookmaker_odds only
  let rows = await getAltLadderOddsForMatch(matchId);
  if (includeOULines) {
    const ouOnlyRows = await getOULinesForMatch(matchId);
    const existing = new Set(rows.map(r => r.id));
    const newOuRows = ouOnlyRows.filter(r => !existing.has(r.id));
    rows = [...rows, ...newOuRows];
  }
  if (rows.length === 0) {
    return {
      rows: [],
      coverage: {
        totalOddsRows: 0, modelReady: 0, oddsOnly: 0, noStats: 0,
        insufficientSample: 0, wrongTeam: 0, unresolvedPlayer: 0,
        modelReadyPlayers: 0, lastRefreshed: new Date(),
      },
      match,
    };
  }

  // Build player match cache
  const playerMatchCache = await buildPlayerMatchCache();

  // Resolve player IDs
  const nameToIdMap = new Map<string, string>();
  const allPlayerIds = new Set<string>();

  for (const row of rows) {
    if (row.player_id) allPlayerIds.add(row.player_id);
    const normalizedName = normalizePlayerName(row.player_name);
    const matchResult = resolvePlayer(row.player_name, row.player_id, playerMatchCache);
    if (matchResult.player_id) {
      allPlayerIds.add(matchResult.player_id);
      nameToIdMap.set(normalizedName, matchResult.player_id);
    }
  }
  for (const [normName, matchResult] of playerMatchCache.byNormalizedName) {
    if (matchResult.player_id) nameToIdMap.set(normName, matchResult.player_id);
  }

  // Fetch player positions and teams
  const playerIdList = [...allPlayerIds];
  const positionMap = new Map<string, string>();
  const teamMap = new Map<string, string>();

  if (playerIdList.length > 0) {
    const { data: playersData } = await supabase
      .from('players')
      .select('id, position_group, team')
      .in('id', playerIdList);
    for (const p of playersData ?? []) {
      positionMap.set(p.id, p.position_group ?? 'UNKNOWN');
      if (p.team) teamMap.set(p.id, p.team);
    }
    // Fallback: resolve team from player_game_stats
    const playersWithoutTeam = playerIdList.filter(id => !teamMap.has(id));
    if (playersWithoutTeam.length > 0) {
      const { data: statsTeams } = await supabase
        .from('player_game_stats')
        .select('player_id, team')
        .in('player_id', playersWithoutTeam)
        .order('match_date', { ascending: false })
        .limit(playersWithoutTeam.length * 5);
      for (const s of statsTeams ?? []) {
        if (s.team && !teamMap.has(s.player_id)) teamMap.set(s.player_id, s.team);
      }
    }
  }

  // Load shared historical stats cache
  const { cache: historicalStatsCache } = await loadHistoricalStatsForPlayers(playerIdList, true);

  // Build a direct DB stats count map for every resolved player ID — this is the source of truth.
  // The historical cache might miss a player if the bookmaker_odds.player_id differs from the
  // resolved ID used to build allPlayerIds, so we do a direct count per resolved player here.
  const directDbStatsCountMap = new Map<string, number>();
  if (playerIdList.length > 0) {
    const PAGE = 1000;
    let page = 0;
    let hasMore = true;
    while (hasMore) {
      const { data: countRows } = await supabase
        .from('player_game_stats')
        .select('player_id')
        .in('player_id', playerIdList)
        .range(page * PAGE, (page + 1) * PAGE - 1);
      if (countRows && countRows.length > 0) {
        for (const r of countRows) {
          directDbStatsCountMap.set(r.player_id, (directDbStatsCountMap.get(r.player_id) ?? 0) + 1);
        }
        hasMore = countRows.length === PAGE;
        page++;
      } else {
        hasMore = false;
      }
    }
  }

  // Load position edge cache
  const positionEdgeCache = usePositionEdge ? await loadPositionEdgeCache() : {};

  // Preload canonical player maps and latest completed round for freshness computation
  const { byId: allPlayersById, byNormName: allPlayersByNormName } = await loadAllPlayers();
  const latestCompletedStatsRound = await getLatestCompletedStatsRound();

  // Build modelled rows
  const matchHome = match?.home_team ?? null;
  const matchAway = match?.away_team ?? null;
  const venue = match?.venue ?? '';

  const modelledRows: ModelledOddsRow[] = rows.map(row => {
    const rawStatType = extractStatType(row.raw_market);
    const statType = normalizeStatType(rawStatType) || rawStatType || 'other';

    let resolvedPlayerId = row.player_id;
    if (!resolvedPlayerId) {
      const normalizedName = normalizePlayerName(row.player_name);
      // Use allCandidatesByName for proper disambiguation
      const candidates = playerMatchCache.allCandidatesByName.get(normalizedName);
      if (candidates && candidates.length === 1) {
        // Single exact-name candidate — accept it
        resolvedPlayerId = candidates[0].player_id;
      } else if (candidates && candidates.length > 1) {
        // Multiple candidates — disambiguate by match team
        const homeNorm = normalizeOpponentName(matchHome);
        const awayNorm = normalizeOpponentName(matchAway);
        for (const c of candidates) {
          const cTeamNorm = normalizeOpponentName(c.team ?? '');
          if (cTeamNorm !== 'UNKNOWN' && (cTeamNorm === homeNorm || cTeamNorm === awayNorm)) {
            resolvedPlayerId = c.player_id;
            break;
          }
        }
        // If team from players table didn't match, try teamMap (from stats)
        if (!resolvedPlayerId) {
          for (const c of candidates) {
            if (c.player_id && teamMap.has(c.player_id)) {
              const tNorm = normalizeOpponentName(teamMap.get(c.player_id) ?? '');
              if (tNorm !== 'UNKNOWN' && (tNorm === homeNorm || tNorm === awayNorm)) {
                resolvedPlayerId = c.player_id;
                break;
              }
            }
          }
        }
      }
      // Final fallback: byNormalizedName (may have team-suffixed keys)
      if (!resolvedPlayerId) {
        resolvedPlayerId = nameToIdMap.get(normalizedName) ?? null;
      }
    }

    const playerKey = resolvedPlayerId ? `${resolvedPlayerId}|${statType}` : null;
    const positionGroup = resolvedPlayerId
      ? (positionMap.get(resolvedPlayerId) ?? 'UNKNOWN')
      : 'UNKNOWN';

    let playerTeam = '';
    if (resolvedPlayerId && teamMap.has(resolvedPlayerId)) {
      playerTeam = teamMap.get(resolvedPlayerId) ?? '';
    }

    const playerTeamNorm = normalizeOpponentName(playerTeam);
    const homeNorm = normalizeOpponentName(matchHome);
    const awayNorm = normalizeOpponentName(matchAway);

    const isWrongTeam = playerTeam !== '' &&
      playerTeamNorm !== 'UNKNOWN' &&
      playerTeamNorm !== homeNorm &&
      playerTeamNorm !== awayNorm;

    // Use direct DB count as the authoritative stats count — never use cache length as truth
    const directDbStatsCount = resolvedPlayerId
      ? (directDbStatsCountMap.get(resolvedPlayerId) ?? 0)
      : 0;
    // Cache-based count for model probability (still uses the cache rows)
    const totalStatsRows = resolvedPlayerId
      ? Math.max(
          historicalStatsCache?.rawByPlayerId.get(resolvedPlayerId)?.length ?? 0,
          directDbStatsCount
        )
      : 0;

    let modelProb: ModelProb = {
      probability: null, conservativeProb: null, adjustedProb: null,
      sample_size: 0, confidence: 'none', hit_count: 0, hit_rate: 0,
      max_stat: 0, avg_stat: 0, venue_adjustment: 0, opponent_adjustment: 0,
      tags: [], context: null, quality_score: 0, risk_level: 'High',
      sampleWindow, sampleComparison: null, sampleWarningTags: [],
    };

    // Extract non-null values from cache (byPlayerStat only has non-null values post-fix)
    const cachedValues = (playerKey ? historicalStatsCache?.byPlayerStat.get(playerKey) : undefined) ?? [];
    if (cachedValues.length > 0) {
      const currentSeason = inferCurrentSeason(match?.season);
      const seasonVals = getSeasonValuesForPlayerStat(historicalStatsCache!, resolvedPlayerId!, statType, currentSeason);
      modelProb = calculateModelProb(cachedValues, row.line, null, sampleWindow, seasonVals);
    }
    const nonNullStatValues = cachedValues.length;
    const firstFiveValues = cachedValues.slice(0, 5);

    // Determine model status — directDbStatsCount is the truth for NO_STATS
    let modelStatus: ModelStatus = 'MODEL_READY';
    let noStatsReason: NoStatsReason | null = null;

    if (!resolvedPlayerId) {
      modelStatus = 'PLAYER_UNRESOLVED';
      noStatsReason = 'PLAYER_ID_NULL';
    } else if (isWrongTeam) {
      modelStatus = 'WRONG_TEAM';
      noStatsReason = 'WRONG_TEAM';
    } else if (directDbStatsCount === 0) {
      modelStatus = 'NO_STATS';
      noStatsReason = 'PLAYER_ID_HAS_ZERO_STATS';
    } else if (nonNullStatValues === 0) {
      // Has DB rows but none have a non-null value for this stat type
      modelStatus = 'INSUFFICIENT_MARKET_SAMPLE';
      noStatsReason = 'INSUFFICIENT_MARKET_SAMPLE';
    } else if (nonNullStatValues < 5) {
      // Has some values but too few for a reliable model
      modelStatus = 'INSUFFICIENT_MARKET_SAMPLE';
      noStatsReason = 'INSUFFICIENT_MARKET_SAMPLE';
    }

    // Determine opponent
    let opponent: string | null = null;
    if (playerTeamNorm && playerTeamNorm === homeNorm) {
      opponent = matchAway;
    } else if (playerTeamNorm && playerTeamNorm === awayNorm) {
      opponent = matchHome;
    } else {
      opponent = matchAway ?? matchHome;
    }

    const peStatType = extractStatType(row.raw_market);
    const positionEdge = (usePositionEdge && opponent)
      ? getPositionEdge(positionEdgeCache, positionGroup, opponent, peStatType)
      : null;
    const impliedProb = 1 / row.over_odds;

    const conservativeEV = modelProb.conservativeProb ? (modelProb.conservativeProb * row.over_odds) - 1 : null;
    const adjustedEV = modelProb.adjustedProb ? (modelProb.adjustedProb * row.over_odds) - 1 : null;
    const edge = modelProb.adjustedProb ? modelProb.adjustedProb - impliedProb : null;

    modelProb.quality_score = calculateQualityScore(modelProb, adjustedEV, row.over_odds);

    const isRealistic =
      modelProb.hit_count >= 2 &&
      modelProb.sample_size >= 10 &&
      row.line <= modelProb.max_stat &&
      row.over_odds <= 15 &&
      (modelProb.conservativeProb ?? 0) >= 0.08;

    const isValid = modelProb.conservativeProb !== null && modelProb.sample_size >= 5;

    const passesRealisticFilters = isRealistic && isValid;
    const rawPosAdj = (usePositionEdge && passesRealisticFilters)
      ? getPositionEdgeAdjustment(positionEdge, positionGroup)
      : 0;
    const positionEdgeAdjustment = capAdjustment(rawPosAdj);

    const venueEdge = (useVenueEdge && passesRealisticFilters && resolvedPlayerId && historicalStatsCache && peStatType)
      ? getVenueEdgeFromCache(historicalStatsCache, resolvedPlayerId, peStatType as StatType, venue).result
      : null;
    const rawVenueAdj = venueEdge ? venueEdge.edge_value : 0;
    const venueEdgeAdjustment = capVenueAdjustment(rawVenueAdj);

    const opponentEdge = (useOpponentEdge && passesRealisticFilters && resolvedPlayerId && historicalStatsCache && peStatType)
      ? getOpponentEdgeFromCache(historicalStatsCache, resolvedPlayerId, peStatType as StatType, playerTeam, matchHome, matchAway).result
      : null;
    const rawOppAdj = opponentEdge ? opponentEdge.edge_value : 0;
    const opponentEdgeAdjustment = capOpponentAdjustment(rawOppAdj);

    const anyMatchupToggleOn = usePositionEdge || useVenueEdge || useOpponentEdge;
    const totalMatchupAdjustment = anyMatchupToggleOn && passesRealisticFilters
      ? computeTotalMatchupAdjustment(positionEdgeAdjustment, venueEdgeAdjustment, opponentEdgeAdjustment)
      : 0;

    const finalProbability = anyMatchupToggleOn
      ? computeFinalProbability(modelProb.adjustedProb, totalMatchupAdjustment)
      : modelProb.adjustedProb;
    const finalEV = anyMatchupToggleOn
      ? computeFinalEV(finalProbability, row.over_odds)
      : adjustedEV;

    modelProb.risk_level = calculateRiskLevel(modelProb, row.over_odds);

    // Compute freshness
    let freshness: PlayerFreshness | null = null;
    if (resolvedPlayerId && historicalStatsCache) {
      const player = allPlayersById.get(resolvedPlayerId);
      const allIds: string[] = [resolvedPlayerId];
      if (player) {
        const norm = normalizeFullName(player.name);
        const duplicates = allPlayersByNormName.get(norm) ?? [];
        for (const d of duplicates) {
          if (d.id !== resolvedPlayerId) allIds.push(d.id);
        }
      }
      freshness = computePlayerFreshness(
        historicalStatsCache,
        resolvedPlayerId,
        allIds,
        latestCompletedStatsRound,
      );
    }

    return {
      ...row,
      player_id: resolvedPlayerId,
      resolvedPlayerId,
      player_name: row.player_name,
      playerTeam,
      opponent,
      positionGroup,
      statType,
      modelProb,
      modelStatus,
      noStatsReason,
      conservativeEV,
      adjustedEV,
      edge,
      impliedProb,
      isRealistic,
      isValid,
      positionEdge,
      positionEdgeAdjustment,
      venueEdge,
      venueEdgeAdjustment,
      opponentEdge,
      opponentEdgeAdjustment,
      totalMatchupAdjustment,
      finalProbability,
      finalEV,
      isWrongTeam,
      totalStatsRows,
      directDbStatsCount,
      marketSampleCount: modelProb.sample_size,
      nonNullStatValues,
      firstFiveValues,
      rawStatType: extractStatType(row.raw_market),
      resolvedStatType: statType,
      freshness,
    };
  });

  // Compute coverage
  const modelReadyPlayers = new Set<string>();
  for (const r of modelledRows) {
    if (r.modelStatus === 'MODEL_READY' && r.resolvedPlayerId) {
      modelReadyPlayers.add(r.resolvedPlayerId);
    }
  }

  const coverage: ModelCoverage = {
    totalOddsRows: modelledRows.length,
    modelReady: modelledRows.filter(r => r.modelStatus === 'MODEL_READY').length,
    oddsOnly: modelledRows.filter(r => r.modelStatus === 'ODDS_ONLY').length,
    noStats: modelledRows.filter(r => r.modelStatus === 'NO_STATS').length,
    insufficientSample: modelledRows.filter(r => r.modelStatus === 'INSUFFICIENT_MARKET_SAMPLE').length,
    wrongTeam: modelledRows.filter(r => r.modelStatus === 'WRONG_TEAM').length,
    unresolvedPlayer: modelledRows.filter(r => r.modelStatus === 'PLAYER_UNRESOLVED').length,
    modelReadyPlayers: modelReadyPlayers.size,
    lastRefreshed: new Date(),
  };

  return { rows: modelledRows, coverage, match };
}
