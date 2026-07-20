import { supabase } from './supabase';
import { normalizeTeamName, type StatType, type VenueEdgeCache, type OpponentEdgeCache, type VenueEdgeResult, type OpponentEdgeResult } from './positionEdge';

const STAT_COLUMNS: Record<StatType, string> = {
  disposals: 'disposals',
  marks: 'marks',
  tackles: 'tackles',
  goals: 'goals',
  hitouts: 'hitouts',
};

const BETTING_STATS: StatType[] = ['disposals', 'marks', 'tackles', 'goals', 'hitouts'];

// Venue variants mapping - normalize all to one key
const VENUE_VARIANTS: Record<string, string> = {
  // Optus Stadium / Perth
  'optus stadium': 'optus stadium',
  'optus': 'optus stadium',
  'perth stadium': 'optus stadium',
  'perth': 'optus stadium',

  // MCG
  'mcg': 'mcg',
  'melbourne cricket ground': 'mcg',
  'melbourne': 'mcg',

  // Marvel Stadium / Docklands
  'marvel stadium': 'marvel stadium',
  'marvel': 'marvel stadium',
  'docklands': 'marvel stadium',
  'etihad stadium': 'marvel stadium',
  'telstra dome': 'marvel stadium',

  // Adelaide Oval
  'adelaide oval': 'adelaide oval',
  'adelaide': 'adelaide oval',

  // SCG
  'scg': 'scg',
  'sydney cricket ground': 'scg',
  'sydney': 'scg',

  // Gabba
  'gabba': 'gabba',
  'the gabba': 'gabba',
  'brisbane': 'gabba',

  // GMHBA Stadium / Kardinia Park
  'gmhba stadium': 'gmhba stadium',
  'gmhba': 'gmhba stadium',
  'kardinia park': 'gmhba stadium',
  'geelong': 'gmhba stadium',

  // ENGIE Stadium / Giants Stadium / Spotless
  'engie stadium': 'engie stadium',
  'giants stadium': 'engie stadium',
  'spotless stadium': 'engie stadium',
  'showground': 'engie stadium',
  'sydney showground': 'engie stadium',

  // GCS / Carrara
  'carrara stadium': 'carrara',
  'carrara': 'carrara',
  'metricon stadium': 'carrara',
  'heritage bank stadium': 'carrara',
  'gold coast': 'carrara',

  // UTAS Stadium / York Park
  'utas stadium': 'utas stadium',
  'utas': 'utas stadium',
  'york park': 'utas stadium',
  'launceston': 'utas stadium',

  // Marden Sports Complex
  'marden sports complex': 'marden',
  'marden': 'marden',

  // Norwood Oval
  'norwood oval': 'norwood oval',
  'norwood': 'norwood oval',

  // Alberton Oval
  'alberton oval': 'alberton oval',
  'alberton': 'alberton oval',

  // Football Park / AAMI Stadium
  'football park': 'football park',
  'aami stadium': 'football park',

  // Subiaco Oval
  'subiaco oval': 'subiaco oval',
  'subiaco': 'subiaco oval',

  // WACA Ground
  'waca ground': 'waca',
  'waca': 'waca',

  // Stadium Australia / ANZ / Accor
  'stadium australia': 'stadium australia',
  'anz stadium': 'stadium australia',
  'accor stadium': 'stadium australia',
  'homebush': 'stadium australia',

  // Blacktown
  'blacktown': 'blacktown',
  'blacktown international sportspark': 'blacktown',

  // Cazaly's Stadium
  'cazalys stadium': 'cazalys',
  'cazalys': 'cazalys',
  'cazaly': 'cazalys',

  // TIO Stadium / Marrara
  'tio stadium': 'tio stadium',
  'tio': 'tio stadium',
  'marrara': 'tio stadium',
  'darwin': 'tio stadium',

  // Traeger Park
  'traeger park': 'traeger park',
  'alice springs': 'traeger park',

  // UNSW
  'unsw': 'unsw',
  'unsw canberra': 'unsw',

  // Manuka Oval
  'manuka oval': 'manuka oval',
  'manuka': 'manuka oval',
  'canberra': 'manuka oval',
};

/**
 * Normalize venue to a canonical key
 */
export function normalizeVenueKey(venue: string | null | undefined): string {
  if (!venue) return '';
  const lower = venue
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return VENUE_VARIANTS[lower] ?? lower;
}

/**
 * Normalize stat type to canonical form
 */
export function normalizeStatType(statType: string | null | undefined): StatType | null {
  if (!statType) return null;
  const lower = statType.toLowerCase().trim();

  // Map various forms to canonical stat type
  if (lower.includes('disposal')) return 'disposals';
  if (lower.includes('mark')) return 'marks';
  if (lower.includes('tackle')) return 'tackles';
  if (lower.includes('goal')) return 'goals';
  if (lower.includes('hitout') || lower.includes('hit out') || lower.includes('hit-out')) return 'hitouts';

  // Direct match
  if (lower === 'disposals') return 'disposals';
  if (lower === 'marks') return 'marks';
  if (lower === 'tackles') return 'tackles';
  if (lower === 'goals') return 'goals';
  if (lower === 'hitouts') return 'hitouts';

  return null;
}

function getVenueLabel(sample: number, edge: number): VenueEdgeResult['label'] {
  if (sample < 3) return 'small_sample';
  if (sample >= 5 && edge >= 3.0) return 'strong_venue_boost';
  if (sample >= 5 && edge <= -3.0) return 'strong_venue_suppression';
  if (sample >= 3 && edge >= 1.5) return 'venue_boost';
  if (sample >= 3 && edge <= -1.5) return 'venue_suppression';
  return 'none';
}

function getOppLabel(sample: number, edge: number): OpponentEdgeResult['label'] {
  if (sample < 3) return 'small_sample';
  if (sample >= 5 && edge >= 3.0) return 'strong_opp_boost';
  if (sample >= 5 && edge <= -3.0) return 'strong_opp_suppression';
  if (sample >= 3 && edge >= 1.5) return 'opp_boost';
  if (sample >= 3 && edge <= -1.5) return 'opp_suppression';
  return 'none';
}

export interface VenueEdgeDiagnostics {
  selectedVenueRaw: string;
  selectedVenueNormalized: string;
  statsRowsChecked: number;
  rowsWithVenueFromStats: number;
  rowsWithVenueFromMatches: number;
  rowsMissingVenue: number;
  uniqueNormalizedVenuesFound: Set<string>;
  venueSamplesCreated: number;
  rowsWithVenueSample3Plus: number;
  rowsWithNonZeroVenueAdjustment: number;
}

export interface OpponentEdgeDiagnostics {
  currentHomeTeamNormalized: string;
  currentAwayTeamNormalized: string;
  statsRowsChecked: number;
  rowsWithOpponentFromStats: number;
  rowsWithOpponentFromMatchIdJoin: number;
  rowsWithOpponentFromFallback: number;
  rowsMissingOpponent: number;
  uniqueNormalizedOpponentsFound: Set<string>;
  opponentSamplesCreated: number;
  rowsWithOpponentSample3Plus: number;
  rowsWithNonZeroOpponentAdjustment: number;
}

export async function loadVenueEdgeCache(
  playerIds: string[],
  venue: string,
  returnDiagnostics: boolean = false
): Promise<VenueEdgeCache | { cache: VenueEdgeCache; diagnostics: VenueEdgeDiagnostics }> {
  const diagnostics: VenueEdgeDiagnostics = {
    selectedVenueRaw: venue,
    selectedVenueNormalized: normalizeVenueKey(venue),
    statsRowsChecked: 0,
    rowsWithVenueFromStats: 0,
    rowsWithVenueFromMatches: 0,
    rowsMissingVenue: 0,
    uniqueNormalizedVenuesFound: new Set(),
    venueSamplesCreated: 0,
    rowsWithVenueSample3Plus: 0,
    rowsWithNonZeroVenueAdjustment: 0,
  };

  if (playerIds.length === 0 || !venue) {
    return returnDiagnostics ? { cache: {}, diagnostics } : {};
  }

  console.log('[matchupEdge] loadVenueEdgeCache for', playerIds.length, 'players, venue:', venue, '→ normalized:', diagnostics.selectedVenueNormalized);

  // Step 1: Fetch all player_game_stats for these players
  const { data: stats, error: statsError } = await supabase
    .from('player_game_stats')
    .select('player_id, match_id, venue, disposals, marks, tackles, goals, hitouts')
    .in('player_id', playerIds);

  if (statsError || !stats) {
    console.log('[matchupEdge] No stats fetched or error:', statsError?.message);
    return returnDiagnostics ? { cache: {}, diagnostics } : {};
  }

  diagnostics.statsRowsChecked = stats.length;
  console.log('[matchupEdge] Stats rows fetched:', stats.length);

  // Step 2: Get all unique match_ids and fetch venues from matches table
  const matchIds = [...new Set(stats.map(s => s.match_id).filter(Boolean))] as string[];
  const matchVenueMap = new Map<string, string>();

  if (matchIds.length > 0) {
    const { data: matches } = await supabase
      .from('matches')
      .select('id, venue')
      .in('id', matchIds);

    for (const m of matches ?? []) {
      if (m.venue) {
        matchVenueMap.set(m.id, m.venue);
      }
    }
  }

  console.log('[matchupEdge] Match venues loaded:', matchVenueMap.size);

  // Step 3: Build venue-enriched stats
  const statsWithVenue: { player_id: string; venue: string; stat_type: StatType; value: number }[] = [];

  for (const s of stats) {
    // Get venue: prefer stats.venue, fallback to matches.venue
    let rowVenue = s.venue as string | null;

    if (rowVenue) {
      diagnostics.rowsWithVenueFromStats++;
    } else if (s.match_id && matchVenueMap.has(s.match_id)) {
      rowVenue = matchVenueMap.get(s.match_id)!;
      diagnostics.rowsWithVenueFromMatches++;
    } else {
      diagnostics.rowsMissingVenue++;
      continue; // Skip this row, no venue available
    }

    const normalizedVenue = normalizeVenueKey(rowVenue);
    diagnostics.uniqueNormalizedVenuesFound.add(normalizedVenue);

    // Record stats for each type
    for (const statType of BETTING_STATS) {
      const col = STAT_COLUMNS[statType];
      const val = Number(s[col as keyof typeof s]) || 0;
      if (val !== 0 || true) { // Include zeros for sample counting
        statsWithVenue.push({
          player_id: s.player_id as string,
          venue: normalizedVenue,
          stat_type: statType,
          value: val,
        });
      }
    }
  }

  console.log('[matchupEdge] Stats with venue:', statsWithVenue.length);
  console.log('[matchupEdge] Unique venues found:', [...diagnostics.uniqueNormalizedVenuesFound]);

  // Step 4: Calculate venue edges per player per stat type
  const cache: VenueEdgeCache = {};
  const targetVenueNorm = diagnostics.selectedVenueNormalized;

  for (const statType of BETTING_STATS) {
    // Per-player aggregates
    const overallMap = new Map<string, { total: number; count: number }>();
    const venueMap = new Map<string, { total: number; count: number }>();

    for (const s of statsWithVenue) {
      if (s.stat_type !== statType) continue;

      const pid = s.player_id;

      // Overall stats
      const ovr = overallMap.get(pid) ?? { total: 0, count: 0 };
      overallMap.set(pid, { total: ovr.total + s.value, count: ovr.count + 1 });

      // Venue-specific stats
      if (s.venue === targetVenueNorm) {
        const vn = venueMap.get(pid) ?? { total: 0, count: 0 };
        venueMap.set(pid, { total: vn.total + s.value, count: vn.count + 1 });
      }
    }

    // Create cache entries for players with venue samples
    for (const [pid, vn] of venueMap) {
      if (vn.count < 1) continue;
      const ovr = overallMap.get(pid);
      if (!ovr || ovr.count === 0) continue;

      const playerAvgAtVenue = vn.total / vn.count;
      const playerOverallAvg = ovr.total / ovr.count;
      const edge = playerAvgAtVenue - playerOverallAvg;

      // Key uses original venue string for compatibility
      const key = `${pid}|${statType}|${venue}`;
      cache[key] = {
        player_id: pid,
        stat_type: statType,
        venue,
        sample_size: vn.count,
        player_avg_at_venue: playerAvgAtVenue,
        player_overall_avg: playerOverallAvg,
        edge_value: edge,
        label: getVenueLabel(vn.count, edge),
      };

      diagnostics.venueSamplesCreated++;
      if (vn.count >= 3) diagnostics.rowsWithVenueSample3Plus++;
      if (edge >= 1.5 || edge <= -1.5) diagnostics.rowsWithNonZeroVenueAdjustment++;
    }
  }

  console.log('[matchupEdge] Venue edge cache built:', Object.keys(cache).length, 'entries');
  console.log('[matchupEdge] Diagnostics:', {
    statsRowsChecked: diagnostics.statsRowsChecked,
    rowsWithVenueFromStats: diagnostics.rowsWithVenueFromStats,
    rowsWithVenueFromMatches: diagnostics.rowsWithVenueFromMatches,
    rowsMissingVenue: diagnostics.rowsMissingVenue,
    venuesFound: [...diagnostics.uniqueNormalizedVenuesFound],
    samplesCreated: diagnostics.venueSamplesCreated,
  });

  return returnDiagnostics ? { cache, diagnostics } : cache;
}

export async function loadOpponentEdgeCache(
  playerIds: string[],
  opponent: string,
  returnDiagnostics: boolean = false
): Promise<OpponentEdgeCache | { cache: OpponentEdgeCache; diagnostics: OpponentEdgeDiagnostics }> {
  const opponentNorm = normalizeTeamName(opponent);

  const diagnostics: OpponentEdgeDiagnostics = {
    currentHomeTeamNormalized: '',
    currentAwayTeamNormalized: opponentNorm,
    statsRowsChecked: 0,
    rowsWithOpponentFromStats: 0,
    rowsWithOpponentFromMatchIdJoin: 0,
    rowsWithOpponentFromFallback: 0,
    rowsMissingOpponent: 0,
    uniqueNormalizedOpponentsFound: new Set(),
    opponentSamplesCreated: 0,
    rowsWithOpponentSample3Plus: 0,
    rowsWithNonZeroOpponentAdjustment: 0,
  };

  if (playerIds.length === 0 || !opponent) {
    return returnDiagnostics ? { cache: {}, diagnostics } : {};
  }

  console.log('[matchupEdge] loadOpponentEdgeCache for', playerIds.length, 'players, opponent:', opponent, '→ normalized:', opponentNorm);

  // Step 1: Fetch all player_game_stats for these players
  const { data: stats, error: statsError } = await supabase
    .from('player_game_stats')
    .select('player_id, match_id, team, opponent, disposals, marks, tackles, goals, hitouts')
    .in('player_id', playerIds);

  if (statsError || !stats) {
    console.log('[matchupEdge] No stats fetched or error:', statsError?.message);
    return returnDiagnostics ? { cache: {}, diagnostics } : {};
  }

  diagnostics.statsRowsChecked = stats.length;
  console.log('[matchupEdge] Stats rows fetched:', stats.length);

  // Step 2: Get all unique match_ids and fetch team info from matches table
  const matchIds = [...new Set(stats.map(s => s.match_id).filter(Boolean))] as string[];
  const matchTeamMap = new Map<string, { home: string; away: string }>();

  if (matchIds.length > 0) {
    const { data: matches } = await supabase
      .from('matches')
      .select('id, home_team, away_team')
      .in('id', matchIds);

    for (const m of matches ?? []) {
      matchTeamMap.set(m.id, {
        home: normalizeTeamName(m.home_team),
        away: normalizeTeamName(m.away_team),
      });
    }
  }

  console.log('[matchupEdge] Match teams loaded:', matchTeamMap.size);

  // Step 3: Build opponent-enriched stats
  const statsWithOpponent: { player_id: string; opponent: string; stat_type: StatType; value: number }[] = [];

  for (const s of stats) {
    // Determine opponent: prefer stats.opponent, then match_id join
    let rowOpponent: string | null = null;

    // A. Use opponent column if it exists
    if (s.opponent && String(s.opponent).trim()) {
      rowOpponent = normalizeTeamName(s.opponent);
      diagnostics.rowsWithOpponentFromStats++;
    }
    // B. Use match_id join to determine opponent
    else if (s.match_id && matchTeamMap.has(s.match_id)) {
      const teams = matchTeamMap.get(s.match_id)!;
      const playerTeamNorm = normalizeTeamName(s.team);

      if (playerTeamNorm === teams.home) {
        rowOpponent = teams.away;
      } else if (playerTeamNorm === teams.away) {
        rowOpponent = teams.home;
      }
      diagnostics.rowsWithOpponentFromMatchIdJoin++;
    }
    // C. No opponent found
    else {
      diagnostics.rowsMissingOpponent++;
      continue;
    }

    if (!rowOpponent) {
      diagnostics.rowsMissingOpponent++;
      continue;
    }

    diagnostics.uniqueNormalizedOpponentsFound.add(rowOpponent);

    // Record stats for each type
    for (const statType of BETTING_STATS) {
      const col = STAT_COLUMNS[statType];
      const val = Number(s[col as keyof typeof s]) || 0;
      statsWithOpponent.push({
        player_id: s.player_id as string,
        opponent: rowOpponent,
        stat_type: statType,
        value: val,
      });
    }
  }

  console.log('[matchupEdge] Stats with opponent:', statsWithOpponent.length);
  console.log('[matchupEdge] Unique opponents found:', [...diagnostics.uniqueNormalizedOpponentsFound]);

  // Step 4: Calculate opponent edges per player per stat type
  const cache: OpponentEdgeCache = {};

  for (const statType of BETTING_STATS) {
    // Per-player aggregates
    const overallMap = new Map<string, { total: number; count: number }>();
    const opponentMap = new Map<string, { total: number; count: number }>();

    for (const s of statsWithOpponent) {
      if (s.stat_type !== statType) continue;

      const pid = s.player_id;

      // Overall stats
      const ovr = overallMap.get(pid) ?? { total: 0, count: 0 };
      overallMap.set(pid, { total: ovr.total + s.value, count: ovr.count + 1 });

      // Opponent-specific stats
      if (s.opponent === opponentNorm) {
        const op = opponentMap.get(pid) ?? { total: 0, count: 0 };
        opponentMap.set(pid, { total: op.total + s.value, count: op.count + 1 });
      }
    }

    // Create cache entries for players with opponent samples
    for (const [pid, op] of opponentMap) {
      if (op.count < 1) continue;
      const ovr = overallMap.get(pid);
      if (!ovr || ovr.count === 0) continue;

      const playerAvgVsOpponent = op.total / op.count;
      const playerOverallAvg = ovr.total / ovr.count;
      const edge = playerAvgVsOpponent - playerOverallAvg;

      const key = `${pid}|${statType}|${opponentNorm}`;
      cache[key] = {
        player_id: pid,
        stat_type: statType,
        opponent: opponentNorm,
        sample_size: op.count,
        player_avg_vs_opponent: playerAvgVsOpponent,
        player_overall_avg: playerOverallAvg,
        edge_value: edge,
        label: getOppLabel(op.count, edge),
      };

      diagnostics.opponentSamplesCreated++;
      if (op.count >= 3) diagnostics.rowsWithOpponentSample3Plus++;
      if (edge >= 1.5 || edge <= -1.5) diagnostics.rowsWithNonZeroOpponentAdjustment++;
    }
  }

  console.log('[matchupEdge] Opponent edge cache built:', Object.keys(cache).length, 'entries');
  console.log('[matchupEdge] Diagnostics:', {
    statsRowsChecked: diagnostics.statsRowsChecked,
    rowsWithOpponentFromStats: diagnostics.rowsWithOpponentFromStats,
    rowsWithOpponentFromMatchIdJoin: diagnostics.rowsWithOpponentFromMatchIdJoin,
    rowsMissingOpponent: diagnostics.rowsMissingOpponent,
    opponentsFound: [...diagnostics.uniqueNormalizedOpponentsFound],
    samplesCreated: diagnostics.opponentSamplesCreated,
  });

  return returnDiagnostics ? { cache, diagnostics } : cache;
}
