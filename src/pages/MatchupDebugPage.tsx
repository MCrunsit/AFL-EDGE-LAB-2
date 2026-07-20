import { useState, useEffect, useMemo } from 'react';
import { Bug, Database, MapPin, Swords, Users, AlertCircle, CheckCircle, CheckCircle2, RefreshCw, Calendar } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { normalizePlayerName } from '../lib/playerMatching';
import { normalizeVenueKey, normalizeStatType } from '../lib/matchupEdge';
import { normalizeTeamName } from '../lib/positionEdge';
import { getAltLadderOddsForMatch } from '../lib/oddsNormalizer';
import type { Match } from '../lib/types';
import LoadingSpinner from '../components/LoadingSpinner';

interface PlayerDebugInfo {
  player_name: string;
  resolved_player_id: string | null;
  resolved_team: string | null;
  total_games: number;
  games_with_match_id: number;
  games_with_venue_from_matches: number;
  games_at_selected_venue: number;
  games_vs_selected_opponent: number;
  venue_edge_label: string;
  opponent_edge_label: string;
  venue_adjustment: number;
  opponent_adjustment: number;
  venue_sample: number;
  opponent_sample: number;
}

interface StageError {
  stage: string;
  message: string;
  code?: string;
  details?: unknown;
  hint?: string;
  tableQueried?: string;
}

interface MatchupDebugData {
  // Odds coverage
  bookmakerOddsRows: number;
  playersInBookmakerOdds: number;
  rowsWithPlayerId: number;
  rowsWithoutPlayerId: number;
  rowsMatchedToPlayersByName: number;
  rowsMatchedToPlayerGameStats: number;

  // Venue debug
  selectedVenueRaw: string;
  selectedVenueNormalized: string;
  totalPlayerGameStatsRows: number;
  rowsWithVenueInStats: number;
  rowsWithVenueFromMatches: number;
  rowsMissingVenue: number;
  uniqueHistoricalVenues: string[];
  rowsMatchingSelectedVenue: number;
  playersWithVenueSample1Plus: number;
  playersWithVenueSample3Plus: number;
  playersWithVenueSample5Plus: number;

  // Opponent debug
  selectedHomeTeam: string;
  selectedAwayTeam: string;
  selectedHomeTeamNormalized: string;
  selectedAwayTeamNormalized: string;
  rowsWithOpponentInStats: number;
  rowsWithOpponentFromMatchIdJoin: number;
  rowsMissingOpponent: number;
  uniqueHistoricalOpponents: string[];
  rowsMatchingCurrentOpponent: number;
  playersWithOpponentSample1Plus: number;
  playersWithOpponentSample3Plus: number;
  playersWithOpponentSample5Plus: number;

  // Player debug
  playerDebugInfo: PlayerDebugInfo[];

  // Stage tracking
  completedStages: string[];
  stageErrors: StageError[];
}

const TEST_PLAYERS_FREO_SYDNEY = [
  'Andrew Brayshaw',
  'Caleb Serong',
  'Errol Gulden',
  'Corey Wagner',
  'Jordan Clark',
  'Logan McDonald',
  'Chad Warner',
  'Brodie Grundy',
  'Isaac Heeney',
];

export default function MatchupDebugPage() {
  const [matches, setMatches] = useState<Match[]>([]);
  const [selectedMatchId, setSelectedMatchId] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [debugData, setDebugData] = useState<MatchupDebugData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const today = new Date().toISOString().split('T')[0];
    supabase
      .from('matches')
      .select('*')
      .gte('match_date', today)
      .order('commence_time_utc', { ascending: true, nullsFirst: false })
      .limit(20)
      .then(({ data }) => {
        setMatches(data ?? []);
        if (data && data.length > 0) setSelectedMatchId(data[0].id);
      });
  }, []);

  const selectedMatch = useMemo(() => {
    return matches.find(m => m.id === selectedMatchId);
  }, [matches, selectedMatchId]);

  async function runDebug() {
    if (!selectedMatchId || !selectedMatch) return;

    setLoading(true);
    setError(null);

    const completedStages: string[] = [];
    const stageErrors: StageError[] = [];

    // Helper to extract Supabase error details
    const extractError = (err: unknown, stage: string, table?: string): StageError => {
      const e = err as Record<string, unknown>;
      return {
        stage,
        message: (e?.message as string) || (err instanceof Error ? err.message : 'Unknown error'),
        code: e?.code as string | undefined,
        details: e?.details,
        hint: e?.hint as string | undefined,
        tableQueried: table,
      };
    };

    // Shared context for error reporting
    const matchId = selectedMatchId;
    const homeTeam = selectedMatch.home_team ?? '';
    const awayTeam = selectedMatch.away_team ?? '';
    const venue = selectedMatch.venue ?? '';

    // Accumulator data (partial results preserved across stage failures)
    let bookmakerOddsRows = 0;
    let playersInBookmakerOdds = 0;
    let rowsWithPlayerId = 0;
    let rowsWithoutPlayerId = 0;
    let rowsMatchedToPlayersByName = 0;
    let rowsMatchedToPlayerGameStats = 0;
    const selectedVenueRaw = venue;
    const selectedVenueNormalized = normalizeVenueKey(selectedVenueRaw);
    const selectedHomeTeam = homeTeam;
    const selectedAwayTeam = awayTeam;
    const selectedHomeTeamNormalized = normalizeTeamName(selectedHomeTeam);
    const selectedAwayTeamNormalized = normalizeTeamName(selectedAwayTeam);
    let totalPlayerGameStatsRows = 0;
    let rowsWithVenueInStats = 0;
    let rowsWithVenueFromMatches = 0;
    let rowsMissingVenue = 0;
    let uniqueHistoricalVenues: string[] = [];
    let rowsMatchingSelectedVenue = 0;
    let playersWithVenueSample1Plus = 0;
    let playersWithVenueSample3Plus = 0;
    let playersWithVenueSample5Plus = 0;
    let rowsWithOpponentInStats = 0;
    let rowsWithOpponentFromMatchIdJoin = 0;
    let rowsMissingOpponent = 0;
    let uniqueHistoricalOpponents: string[] = [];
    let rowsMatchingCurrentOpponent = 0;
    let playersWithOpponentSample1Plus = 0;
    let playersWithOpponentSample3Plus = 0;
    let playersWithOpponentSample5Plus = 0;
    let playerDebugInfo: PlayerDebugInfo[] = [];

    try {
      console.log('[MatchupDebug] Starting debug for match:', matchId, { homeTeam, awayTeam, venue });

      // --- Stage 1: Match Check ---
      try {
        const { data: matchCheck, error: matchError } = await supabase
          .from('matches')
          .select('id, home_team, away_team, venue, commence_time_utc')
          .eq('id', matchId)
          .maybeSingle();

        if (matchError) throw matchError;
        if (!matchCheck) throw new Error(`Match ${matchId} not found in matches table`);

        completedStages.push('1. Match Check');
        console.log('[MatchupDebug] Stage 1 (Match Check) passed:', matchCheck);
      } catch (err) {
        stageErrors.push(extractError(err, '1. Match Check', 'matches'));
        // If match check fails, we can't proceed meaningfully
        setDebugData({
          bookmakerOddsRows, playersInBookmakerOdds, rowsWithPlayerId, rowsWithoutPlayerId,
          rowsMatchedToPlayersByName, rowsMatchedToPlayerGameStats,
          selectedVenueRaw, selectedVenueNormalized, totalPlayerGameStatsRows,
          rowsWithVenueInStats, rowsWithVenueFromMatches, rowsMissingVenue,
          uniqueHistoricalVenues, rowsMatchingSelectedVenue,
          playersWithVenueSample1Plus, playersWithVenueSample3Plus, playersWithVenueSample5Plus,
          selectedHomeTeam, selectedAwayTeam, selectedHomeTeamNormalized, selectedAwayTeamNormalized,
          rowsWithOpponentInStats, rowsWithOpponentFromMatchIdJoin, rowsMissingOpponent,
          uniqueHistoricalOpponents, rowsMatchingCurrentOpponent,
          playersWithOpponentSample1Plus, playersWithOpponentSample3Plus, playersWithOpponentSample5Plus,
          playerDebugInfo, completedStages, stageErrors,
        });
        setError(`Stage 1 (Match Check) failed: ${extractError(err, '1. Match Check').message}`);
        setLoading(false);
        return;
      }

      // --- Stage 2: Odds Check ---
      let uniquePlayersInOdds = new Set<string>();
      let unmatchedPlayerNames: string[] = [];
      try {
        // Use the same query as Odds Screen (getAltLadderOddsForMatch)
        const oddsRows = await getAltLadderOddsForMatch(matchId);

        bookmakerOddsRows = oddsRows.length;
        for (const o of oddsRows) {
          uniquePlayersInOdds.add(o.player_name || 'Unknown');
        }
        playersInBookmakerOdds = uniquePlayersInOdds.size;
        rowsWithPlayerId = oddsRows.filter(o => o.player_id).length;
        rowsWithoutPlayerId = bookmakerOddsRows - rowsWithPlayerId;

        completedStages.push('2. Odds Check');
        console.log('[MatchupDebug] Stage 2 (Odds Check) passed:', { bookmakerOddsRows, playersInBookmakerOdds });
      } catch (err) {
        stageErrors.push(extractError(err, '2. Odds Check', 'bookmaker_odds'));
      }

      // --- Stage 3: Player Matching Check ---
      let playerByName = new Map<string, { id: string; team: string | null }>();
      try {
        const { data: allPlayers, error: playersError } = await supabase
          .from('players')
          .select('id, name, team');

        if (playersError) throw playersError;

        for (const p of allPlayers ?? []) {
          const normName = normalizePlayerName(p.name);
          if (normName) {
            playerByName.set(normName, { id: p.id, team: p.team });
          }
        }

        // Use already-fetched odds rows from Stage 2 instead of re-querying
        for (const playerName of uniquePlayersInOdds) {
          const normName = normalizePlayerName(playerName);
          if (normName && playerByName.has(normName)) {
            rowsMatchedToPlayersByName++;
          }
        }

        completedStages.push('3. Player Matching Check');
        console.log('[MatchupDebug] Stage 3 (Player Matching) passed:', { playerByNameSize: playerByName.size, rowsMatchedToPlayersByName });
      } catch (err) {
        stageErrors.push(extractError(err, '3. Player Matching Check', 'players'));
      }

      // --- Stage 4: Historical Stats Check ---
      let testPlayerIds: string[] = [];
      let testPlayerInfo = new Map<string, { id: string; team: string | null }>();
      let playerGameStats: Record<string, unknown>[] | null = null;

      try {
        const testPlayers = selectedHomeTeam.includes('Fremantle') || selectedAwayTeam.includes('Sydney')
          ? TEST_PLAYERS_FREO_SYDNEY
          : [...uniquePlayersInOdds].slice(0, 10);

        for (const playerName of testPlayers) {
          const normName = normalizePlayerName(playerName);
          const found = playerByName.get(normName);
          if (found) {
            testPlayerIds.push(found.id);
            testPlayerInfo.set(playerName, found);
          }
        }

        if (testPlayerIds.length > 0) {
          const { data, error: statsError } = await supabase
            .from('player_game_stats')
            .select('player_id, match_id, team, venue, opponent, match_date, disposals, marks, tackles, goals, hitouts')
            .in('player_id', testPlayerIds);

          if (statsError) throw statsError;
          playerGameStats = data;
        }

        totalPlayerGameStatsRows = playerGameStats?.length ?? 0;
        completedStages.push('4. Historical Stats Check');
        console.log('[MatchupDebug] Stage 4 (Historical Stats) passed:', { totalPlayerGameStatsRows, testPlayerIds: testPlayerIds.length });
      } catch (err) {
        stageErrors.push(extractError(err, '4. Historical Stats Check', 'player_game_stats'));
      }

      // --- Stage 5: Matches Join Check ---
      let matchVenueMap = new Map<string, string>();
      let matchTeamMap = new Map<string, { home: string; away: string }>();

      try {
        const statsMatchIds = [...new Set((playerGameStats ?? []).map(s => (s as Record<string, unknown>).match_id as string).filter(Boolean))] as string[];

        if (statsMatchIds.length > 0) {
          const { data: statsMatches, error: matchesError } = await supabase
            .from('matches')
            .select('id, venue, home_team, away_team')
            .in('id', statsMatchIds);

          if (matchesError) throw matchesError;

          for (const m of statsMatches ?? []) {
            if (m.venue) matchVenueMap.set(m.id, m.venue);
            matchTeamMap.set(m.id, { home: normalizeTeamName(m.home_team), away: normalizeTeamName(m.away_team) });
          }
        }

        completedStages.push('5. Matches Join Check');
        console.log('[MatchupDebug] Stage 5 (Matches Join) passed:', { matchVenueMapSize: matchVenueMap.size, matchTeamMapSize: matchTeamMap.size });
      } catch (err) {
        stageErrors.push(extractError(err, '5. Matches Join Check', 'matches'));
      }

      // --- Stage 6: Venue Check ---
      try {
        const uniqueVenuesSet = new Set<string>();

        for (const s of (playerGameStats ?? []) as Record<string, unknown>[]) {
          let rowVenue: string | null = null;

          if (s.venue) {
            rowVenue = s.venue as string;
            rowsWithVenueInStats++;
          } else if (s.match_id && matchVenueMap.has(s.match_id as string)) {
            rowVenue = matchVenueMap.get(s.match_id as string)!;
            rowsWithVenueFromMatches++;
          } else {
            rowsMissingVenue++;
            continue;
          }

          const normVenue = normalizeVenueKey(rowVenue);
          if (normVenue) uniqueVenuesSet.add(normVenue);

          if (normVenue === selectedVenueNormalized) {
            rowsMatchingSelectedVenue++;
          }
        }

        uniqueVenuesSet.delete('');
        uniqueHistoricalVenues = [...uniqueVenuesSet].sort();

        completedStages.push('6. Venue Check');
        console.log('[MatchupDebug] Stage 6 (Venue Check) passed:', { rowsWithVenueInStats, rowsWithVenueFromMatches, rowsMissingVenue, uniqueHistoricalVenues: uniqueHistoricalVenues.length });
      } catch (err) {
        stageErrors.push(extractError(err, '6. Venue Check', 'player_game_stats'));
      }

      // --- Stage 7: Opponent Check ---
      try {
        const uniqueOpponentsSet = new Set<string>();

        for (const s of (playerGameStats ?? []) as Record<string, unknown>[]) {
          let opponent: string | null = null;

          if (s.opponent) {
            opponent = normalizeTeamName(s.opponent as string);
            rowsWithOpponentInStats++;
          } else if (s.match_id && matchTeamMap.has(s.match_id as string)) {
            const teams = matchTeamMap.get(s.match_id as string)!;
            const playerTeamNorm = normalizeTeamName(s.team as string);
            if (playerTeamNorm === teams.home) {
              opponent = teams.away;
            } else if (playerTeamNorm === teams.away) {
              opponent = teams.home;
            }
            if (opponent) rowsWithOpponentFromMatchIdJoin++;
          }

          if (!opponent) {
            rowsMissingOpponent++;
            continue;
          }

          uniqueOpponentsSet.add(opponent);

          if (opponent === selectedAwayTeamNormalized || opponent === selectedHomeTeamNormalized) {
            rowsMatchingCurrentOpponent++;
          }
        }

        uniqueHistoricalOpponents = [...uniqueOpponentsSet].sort();

        completedStages.push('7. Opponent Check');
        console.log('[MatchupDebug] Stage 7 (Opponent Check) passed:', { rowsWithOpponentInStats, rowsWithOpponentFromMatchIdJoin, rowsMissingOpponent, uniqueHistoricalOpponents: uniqueHistoricalOpponents.length });
      } catch (err) {
        stageErrors.push(extractError(err, '7. Opponent Check', 'player_game_stats'));
      }

      // --- Per-player debug info (best effort, doesn't fail the page) ---
      try {
        const testPlayers = selectedHomeTeam.includes('Fremantle') || selectedAwayTeam.includes('Sydney')
          ? TEST_PLAYERS_FREO_SYDNEY
          : [...uniquePlayersInOdds].slice(0, 10);

        for (const playerName of testPlayers) {
          const info = testPlayerInfo.get(playerName);
          if (!info) {
            playerDebugInfo.push({
              player_name: playerName,
              resolved_player_id: null,
              resolved_team: null,
              total_games: 0,
              games_with_match_id: 0,
              games_with_venue_from_matches: 0,
              games_at_selected_venue: 0,
              games_vs_selected_opponent: 0,
              venue_edge_label: 'No Data',
              opponent_edge_label: 'No Data',
              venue_adjustment: 0,
              opponent_adjustment: 0,
              venue_sample: 0,
              opponent_sample: 0,
            });
            continue;
          }

          const playerStats = (playerGameStats ?? []).filter(s => (s as Record<string, unknown>).player_id === info.id) as Record<string, unknown>[];
          const totalGames = playerStats.length;
          const gamesWithMatchId = playerStats.filter(s => s.match_id).length;

          const gamesAtVenue: number[] = [];
          const allGamesDisposals: number[] = [];

          for (const s of playerStats) {
            const disp = Number(s.disposals) || 0;
            allGamesDisposals.push(disp);

            let gameVenue: string | null = (s.venue as string) || null;
            if (!gameVenue && s.match_id && matchVenueMap.has(s.match_id as string)) {
              gameVenue = matchVenueMap.get(s.match_id as string)!;
            }

            if (gameVenue) {
              const normVenue = normalizeVenueKey(gameVenue);
              if (normVenue === selectedVenueNormalized) {
                gamesAtVenue.push(disp);
              }
            }
          }

          const venueSample = gamesAtVenue.length;
          const overallAvg = allGamesDisposals.length > 0
            ? allGamesDisposals.reduce((a, b) => a + b, 0) / allGamesDisposals.length
            : 0;
          const venueAvg = venueSample > 0
            ? gamesAtVenue.reduce((a, b) => a + b, 0) / venueSample
            : 0;
          const venueEdge = venueAvg - overallAvg;

          let venueEdgeLabel = 'No Data';
          let venueAdjustment = 0;
          if (venueSample < 3) {
            venueEdgeLabel = `Small Sample (${venueSample}g)`;
          } else if (venueSample >= 5 && venueEdge >= 3.0) {
            venueEdgeLabel = `Strong Boost (+${venueEdge.toFixed(1)} over ${venueSample}g)`;
            venueAdjustment = 0.02;
          } else if (venueSample >= 5 && venueEdge <= -3.0) {
            venueEdgeLabel = `Strong Suppression (${venueEdge.toFixed(1)} over ${venueSample}g)`;
            venueAdjustment = -0.02;
          } else if (venueEdge >= 1.5) {
            venueEdgeLabel = `Boost (+${venueEdge.toFixed(1)} over ${venueSample}g)`;
            venueAdjustment = 0.01;
          } else if (venueEdge <= -1.5) {
            venueEdgeLabel = `Suppression (${venueEdge.toFixed(1)} over ${venueSample}g)`;
            venueAdjustment = -0.01;
          } else {
            venueEdgeLabel = `Neutral (${venueEdge.toFixed(1)} over ${venueSample}g)`;
          }

          const gamesVsOpponent: number[] = [];
          let gamesWithVenueFromMatchesCount = 0;

          for (const s of playerStats) {
            if (s.match_id && matchVenueMap.has(s.match_id as string)) {
              gamesWithVenueFromMatchesCount++;
            }

            let opponent: string | null = null;
            if (s.opponent) {
              opponent = normalizeTeamName(s.opponent as string);
            } else if (s.match_id && matchTeamMap.has(s.match_id as string)) {
              const teams = matchTeamMap.get(s.match_id as string)!;
              const playerTeamNorm = normalizeTeamName(s.team as string);
              if (playerTeamNorm === teams.home) {
                opponent = teams.away;
              } else if (playerTeamNorm === teams.away) {
                opponent = teams.home;
              }
            }

            const playerTeamNorm = normalizeTeamName(info.team);
            let targetOpponent = selectedAwayTeamNormalized;
            if (playerTeamNorm === selectedAwayTeamNormalized) {
              targetOpponent = selectedHomeTeamNormalized;
            }

            if (opponent && opponent === targetOpponent) {
              gamesVsOpponent.push(Number(s.disposals) || 0);
            }
          }

          const opponentSample = gamesVsOpponent.length;
          const opponentAvg = opponentSample > 0
            ? gamesVsOpponent.reduce((a, b) => a + b, 0) / opponentSample
            : 0;
          const opponentEdge = opponentAvg - overallAvg;

          let opponentEdgeLabel = 'No Data';
          let opponentAdjustment = 0;
          if (opponentSample < 3) {
            opponentEdgeLabel = `Small Sample (${opponentSample}g)`;
          } else if (opponentSample >= 5 && opponentEdge >= 3.0) {
            opponentEdgeLabel = `Strong Boost (+${opponentEdge.toFixed(1)} over ${opponentSample}g)`;
            opponentAdjustment = 0.02;
          } else if (opponentSample >= 5 && opponentEdge <= -3.0) {
            opponentEdgeLabel = `Strong Suppression (${opponentEdge.toFixed(1)} over ${opponentSample}g)`;
            opponentAdjustment = -0.02;
          } else if (opponentEdge >= 1.5) {
            opponentEdgeLabel = `Boost (+${opponentEdge.toFixed(1)} over ${opponentSample}g)`;
            opponentAdjustment = 0.01;
          } else if (opponentEdge <= -1.5) {
            opponentEdgeLabel = `Suppression (${opponentEdge.toFixed(1)} over ${opponentSample}g)`;
            opponentAdjustment = -0.01;
          } else {
            opponentEdgeLabel = `Neutral (${opponentEdge.toFixed(1)} over ${opponentSample}g)`;
          }

          playerDebugInfo.push({
            player_name: playerName,
            resolved_player_id: info.id,
            resolved_team: info.team ?? null,
            total_games: totalGames,
            games_with_match_id: gamesWithMatchId,
            games_with_venue_from_matches: gamesWithVenueFromMatchesCount,
            games_at_selected_venue: venueSample,
            games_vs_selected_opponent: opponentSample,
            venue_edge_label: venueEdgeLabel,
            opponent_edge_label: opponentEdgeLabel,
            venue_adjustment: venueAdjustment,
            opponent_adjustment: opponentAdjustment,
            venue_sample: venueSample,
            opponent_sample: opponentSample,
          });
        }

        playersWithVenueSample1Plus = playerDebugInfo.filter(p => p.venue_sample >= 1).length;
        playersWithVenueSample3Plus = playerDebugInfo.filter(p => p.venue_sample >= 3).length;
        playersWithVenueSample5Plus = playerDebugInfo.filter(p => p.venue_sample >= 5).length;
        playersWithOpponentSample1Plus = playerDebugInfo.filter(p => p.opponent_sample >= 1).length;
        playersWithOpponentSample3Plus = playerDebugInfo.filter(p => p.opponent_sample >= 3).length;
        playersWithOpponentSample5Plus = playerDebugInfo.filter(p => p.opponent_sample >= 5).length;
        rowsMatchedToPlayerGameStats = playerDebugInfo.filter(p => p.total_games > 0).length;
      } catch (err) {
        console.error('[MatchupDebug] Per-player debug info failed:', err);
      }

      const data: MatchupDebugData = {
        bookmakerOddsRows,
        playersInBookmakerOdds,
        rowsWithPlayerId,
        rowsWithoutPlayerId,
        rowsMatchedToPlayersByName,
        rowsMatchedToPlayerGameStats,
        selectedVenueRaw,
        selectedVenueNormalized,
        totalPlayerGameStatsRows,
        rowsWithVenueInStats,
        rowsWithVenueFromMatches,
        rowsMissingVenue,
        uniqueHistoricalVenues,
        rowsMatchingSelectedVenue,
        playersWithVenueSample1Plus,
        playersWithVenueSample3Plus,
        playersWithVenueSample5Plus,
        selectedHomeTeam,
        selectedAwayTeam,
        selectedHomeTeamNormalized,
        selectedAwayTeamNormalized,
        rowsWithOpponentInStats,
        rowsWithOpponentFromMatchIdJoin,
        rowsMissingOpponent,
        uniqueHistoricalOpponents,
        rowsMatchingCurrentOpponent,
        playersWithOpponentSample1Plus,
        playersWithOpponentSample3Plus,
        playersWithOpponentSample5Plus,
        playerDebugInfo,
        completedStages,
        stageErrors,
      };

      console.log('[MatchupDebug] Debug complete:', { completedStages, stageErrors: stageErrors.length, data });
      setDebugData(data);

      if (stageErrors.length > 0) {
        setError(`${stageErrors.length} stage(s) failed — see details below`);
      }
    } catch (err: unknown) {
      console.error('[MatchupDebug] Unexpected error:', err);
      const e = err as Record<string, unknown>;
      setError(`Unexpected error: ${(e?.message as string) || (err instanceof Error ? err.message : 'Unknown error')}`);
      setDebugData(prev => prev ? { ...prev, completedStages, stageErrors } : null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (selectedMatchId) runDebug();
  }, [selectedMatchId]);

  const selectedMatchDisplay = selectedMatch
    ? `${selectedMatch.home_team} vs ${selectedMatch.away_team}`
    : 'Select a match';

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-center gap-3">
        <Bug className="w-5 h-5 text-amber-400" />
        <h2 className="text-white font-bold text-lg">Matchup Debug</h2>
        <span className="text-xs text-gray-600">Supabase-only diagnostics — NO The Odds API calls</span>
      </div>

      {/* Match Selector */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">Match</label>
        <div className="flex items-center gap-4">
          <select
            value={selectedMatchId}
            onChange={e => setSelectedMatchId(e.target.value)}
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-amber-500"
          >
            {matches.map(m => (
              <option key={m.id} value={m.id}>
                {m.home_team} vs {m.away_team} — R{m.round} @ {m.venue || 'TBD'}
              </option>
            ))}
          </select>
          <button
            onClick={runDebug}
            disabled={loading}
            className="px-4 py-2 bg-amber-500/20 border border-amber-500/30 text-amber-400 rounded-lg text-sm font-medium hover:bg-amber-500/30 flex items-center gap-2"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Run Debug
          </button>
        </div>
      </div>

      {loading && <LoadingSpinner message="Querying Supabase..." />}

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-red-400" />
            <p className="text-red-400 text-sm">{error}</p>
          </div>
          {debugData?.stageErrors && debugData.stageErrors.length > 0 && (
            <div className="space-y-2 mt-2">
              <p className="text-xs text-red-300 font-semibold uppercase">Failed Stages:</p>
              {debugData.stageErrors.map((se, i) => (
                <div key={i} className="bg-red-500/5 border border-red-500/20 rounded-lg p-3 text-xs space-y-1">
                  <p className="text-red-400 font-bold">{se.stage}</p>
                  <p className="text-gray-300"><span className="text-gray-500">Error:</span> {se.message}</p>
                  {se.code && <p className="text-gray-300"><span className="text-gray-500">Code:</span> <code className="text-amber-400">{se.code}</code></p>}
                  {se.hint && <p className="text-gray-300"><span className="text-gray-500">Hint:</span> {se.hint}</p>}
                  {se.details && <p className="text-gray-300"><span className="text-gray-500">Details:</span> {String(se.details)}</p>}
                  {se.tableQueried && <p className="text-gray-300"><span className="text-gray-500">Table:</span> <code className="text-blue-400">{se.tableQueried}</code></p>}
                </div>
              ))}
            </div>
          )}
          {debugData && (
            <div className="text-xs text-gray-500 border-t border-red-500/20 pt-2 mt-2">
              <p>Match ID: {selectedMatchId} | Home: {debugData.selectedHomeTeam || 'N/A'} | Away: {debugData.selectedAwayTeam || 'N/A'} | Venue: {debugData.selectedVenueRaw || 'N/A'}</p>
              {debugData.completedStages.length > 0 && (
                <p className="mt-1">Completed stages: {debugData.completedStages.join(', ')}</p>
              )}
            </div>
          )}
        </div>
      )}

      {debugData && !loading && (
        <>
          {/* Stage Status */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <h3 className="text-white font-semibold text-sm">Stage Status</h3>
            </div>
            <div className="flex flex-wrap gap-2">
              {['1. Match Check', '2. Odds Check', '3. Player Matching Check', '4. Historical Stats Check', '5. Matches Join Check', '6. Venue Check', '7. Opponent Check'].map(stage => {
                const completed = debugData.completedStages.includes(stage);
                const failed = debugData.stageErrors.some(e => e.stage === stage);
                return (
                  <span key={stage} className={`text-xs px-2 py-1 rounded-full border ${completed && !failed ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400' : failed ? 'bg-red-500/15 border-red-500/30 text-red-400' : 'bg-gray-800 border-gray-700 text-gray-500'}`}>
                    {completed && !failed ? '✓' : failed ? '✗' : '○'} {stage}
                  </span>
                );
              })}
            </div>
          </div>

          {/* Match Info */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <Calendar className="w-4 h-4 text-gray-500" />
              <h3 className="text-white font-semibold text-sm">{selectedMatchDisplay}</h3>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <div>
                <p className="text-gray-500">Venue (raw)</p>
                <p className="text-white font-bold">{debugData.selectedVenueRaw || 'None'}</p>
              </div>
              <div>
                <p className="text-gray-500">Venue (normalized)</p>
                <p className="text-blue-400 font-bold">{debugData.selectedVenueNormalized || 'None'}</p>
              </div>
              <div>
                <p className="text-gray-500">Home Team</p>
                <p className="text-white font-bold">{debugData.selectedHomeTeam}</p>
              </div>
              <div>
                <p className="text-gray-500">Away Team</p>
                <p className="text-white font-bold">{debugData.selectedAwayTeam}</p>
              </div>
            </div>
          </div>

          {/* Odds Coverage */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <Database className="w-4 h-4 text-emerald-400" />
              <h3 className="text-emerald-400 font-semibold text-sm">Odds Coverage</h3>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Bookmaker Rows</p>
                <p className="text-white font-bold text-lg">{debugData.bookmakerOddsRows}</p>
              </div>
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Unique Players</p>
                <p className="text-white font-bold text-lg">{debugData.playersInBookmakerOdds}</p>
              </div>
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Rows w/ player_id</p>
                <p className="text-emerald-400 font-bold text-lg">{debugData.rowsWithPlayerId}</p>
              </div>
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Rows w/o player_id</p>
                <p className="text-amber-400 font-bold text-lg">{debugData.rowsWithoutPlayerId}</p>
              </div>
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Matched by Name</p>
                <p className="text-blue-400 font-bold text-lg">{debugData.rowsMatchedToPlayersByName}</p>
              </div>
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Matched to Stats</p>
                <p className="text-emerald-400 font-bold text-lg">{debugData.rowsMatchedToPlayerGameStats}</p>
              </div>
            </div>
          </div>

          {/* Venue Debug */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <MapPin className="w-4 h-4 text-blue-400" />
              <h3 className="text-blue-400 font-semibold text-sm">Venue Edge Debug</h3>
              {debugData.playersWithVenueSample3Plus === 0 && (
                <span className="text-amber-400 text-xs">(No venue samples ≥3 found)</span>
              )}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs mb-3">
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Stats Rows Checked</p>
                <p className="text-white font-bold">{debugData.totalPlayerGameStatsRows}</p>
              </div>
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Venue from stats.venue</p>
                <p className="text-emerald-400 font-bold">{debugData.rowsWithVenueInStats}</p>
              </div>
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Venue from matches join</p>
                <p className="text-blue-400 font-bold">{debugData.rowsWithVenueFromMatches}</p>
              </div>
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Missing Venue</p>
                <p className="text-amber-400 font-bold">{debugData.rowsMissingVenue}</p>
              </div>
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Rows @ Selected Venue</p>
                <p className={`font-bold ${debugData.rowsMatchingSelectedVenue > 0 ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {debugData.rowsMatchingSelectedVenue}
                </p>
              </div>
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Players w/ 1+ samples</p>
                <p className="text-white font-bold">{debugData.playersWithVenueSample1Plus}</p>
              </div>
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Players w/ 3+ samples</p>
                <p className={`font-bold ${debugData.playersWithVenueSample3Plus > 0 ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {debugData.playersWithVenueSample3Plus}
                </p>
              </div>
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Players w/ 5+ samples</p>
                <p className="text-white font-bold">{debugData.playersWithVenueSample5Plus}</p>
              </div>
            </div>

            {/* Unique Historical Venues */}
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500 mb-1">Unique Historical Venues ({debugData.uniqueHistoricalVenues.length})</p>
              <div className="flex flex-wrap gap-1">
                {debugData.uniqueHistoricalVenues.slice(0, 20).map(v => (
                  <span
                    key={v}
                    className={`px-2 py-0.5 rounded text-[10px] ${v === debugData.selectedVenueNormalized ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' : 'bg-gray-700 text-gray-400'}`}
                  >
                    {v}
                  </span>
                ))}
                {debugData.uniqueHistoricalVenues.length > 20 && (
                  <span className="text-gray-600 text-[10px]">+{debugData.uniqueHistoricalVenues.length - 20} more</span>
                )}
              </div>
            </div>
          </div>

          {/* Opponent Debug */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <Swords className="w-4 h-4 text-amber-400" />
              <h3 className="text-amber-400 font-semibold text-sm">Opponent Edge Debug</h3>
              {debugData.playersWithOpponentSample3Plus === 0 && (
                <span className="text-amber-400 text-xs">(No opponent samples ≥3 found)</span>
              )}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs mb-3">
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Rows w/ opponent col</p>
                <p className="text-emerald-400 font-bold">{debugData.rowsWithOpponentInStats}</p>
              </div>
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Opp from match_id join</p>
                <p className="text-blue-400 font-bold">{debugData.rowsWithOpponentFromMatchIdJoin}</p>
              </div>
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Missing Opponent</p>
                <p className="text-amber-400 font-bold">{debugData.rowsMissingOpponent}</p>
              </div>
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Rows vs Cur Opponent</p>
                <p className={`font-bold ${debugData.rowsMatchingCurrentOpponent > 0 ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {debugData.rowsMatchingCurrentOpponent}
                </p>
              </div>
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Players w/ 1+ samples</p>
                <p className="text-white font-bold">{debugData.playersWithOpponentSample1Plus}</p>
              </div>
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Players w/ 3+ samples</p>
                <p className={`font-bold ${debugData.playersWithOpponentSample3Plus > 0 ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {debugData.playersWithOpponentSample3Plus}
                </p>
              </div>
              <div className="bg-gray-800/50 rounded p-2">
                <p className="text-gray-500">Players w/ 5+ samples</p>
                <p className="text-white font-bold">{debugData.playersWithOpponentSample5Plus}</p>
              </div>
            </div>

            {/* Unique Historical Opponents */}
            <div className="bg-gray-800/50 rounded p-2">
              <p className="text-gray-500 mb-1">Unique Historical Opponents ({debugData.uniqueHistoricalOpponents.length})</p>
              <div className="flex flex-wrap gap-1">
                {debugData.uniqueHistoricalOpponents.slice(0, 20).map(o => (
                  <span
                    key={o}
                    className={`px-2 py-0.5 rounded text-[10px] ${o === debugData.selectedAwayTeamNormalized || o === debugData.selectedHomeTeamNormalized ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' : 'bg-gray-700 text-gray-400'}`}
                  >
                    {o}
                  </span>
                ))}
                {debugData.uniqueHistoricalOpponents.length > 20 && (
                  <span className="text-gray-600 text-[10px]">+{debugData.uniqueHistoricalOpponents.length - 20} more</span>
                )}
              </div>
            </div>
          </div>

          {/* Player Debug Table */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <div className="flex items-center gap-2 p-4 border-b border-gray-800">
              <Users className="w-4 h-4 text-emerald-400" />
              <h3 className="text-emerald-400 font-semibold text-sm">Player Debug ({debugData.playerDebugInfo.length} players)</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-800 sticky top-0">
                  <tr className="text-gray-500 uppercase tracking-wider">
                    <th className="text-left px-3 py-2 font-medium">Player</th>
                    <th className="text-left px-2 py-2 font-medium">Team</th>
                    <th className="text-center px-2 py-2 font-medium">Total Games</th>
                    <th className="text-center px-2 py-2 font-medium">Venue Sample</th>
                    <th className="text-center px-2 py-2 font-medium">Venue Label</th>
                    <th className="text-center px-2 py-2 font-medium">Venue Adj</th>
                    <th className="text-center px-2 py-2 font-medium">Opp Sample</th>
                    <th className="text-center px-2 py-2 font-medium">Opp Label</th>
                    <th className="text-center px-2 py-2 font-medium">Opp Adj</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/50">
                  {debugData.playerDebugInfo.map((p, i) => (
                    <tr key={i} className="hover:bg-gray-800/30">
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <span className="text-white font-medium">{p.player_name}</span>
                          {p.resolved_player_id ? (
                            <CheckCircle className="w-3 h-3 text-emerald-400" />
                          ) : (
                            <AlertCircle className="w-3 h-3 text-amber-400" />
                          )}
                        </div>
                      </td>
                      <td className="px-2 py-2 text-gray-400">{p.resolved_team || '?'}</td>
                      <td className="px-2 py-2 text-center text-white font-bold">{p.total_games}</td>
                      <td className="px-2 py-2 text-center">
                        <span className={`font-bold ${p.venue_sample >= 3 ? 'text-emerald-400' : p.venue_sample >= 1 ? 'text-amber-400' : 'text-red-400'}`}>
                          {p.venue_sample}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-center text-gray-400 text-[10px]">{p.venue_edge_label}</td>
                      <td className="px-2 py-2 text-center">
                        <span className={`font-bold ${p.venue_adjustment > 0 ? 'text-blue-400' : p.venue_adjustment < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                          {p.venue_adjustment >= 0 ? '+' : ''}{(p.venue_adjustment * 100).toFixed(1)}%
                        </span>
                      </td>
                      <td className="px-2 py-2 text-center">
                        <span className={`font-bold ${p.opponent_sample >= 3 ? 'text-emerald-400' : p.opponent_sample >= 1 ? 'text-amber-400' : 'text-red-400'}`}>
                          {p.opponent_sample}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-center text-gray-400 text-[10px]">{p.opponent_edge_label}</td>
                      <td className="px-2 py-2 text-center">
                        <span className={`font-bold ${p.opponent_adjustment > 0 ? 'text-amber-400' : p.opponent_adjustment < 0 ? 'text-red-400' : 'text-gray-500'}`}>
                          {p.opponent_adjustment >= 0 ? '+' : ''}{(p.opponent_adjustment * 100).toFixed(1)}%
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Summary Warnings */}
          {(debugData.playersWithVenueSample3Plus === 0 || debugData.playersWithOpponentSample3Plus === 0) && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 space-y-2">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-5 h-5 text-amber-400" />
                <h3 className="text-amber-400 font-semibold text-sm">Sample Coverage Issues</h3>
              </div>
              <ul className="text-amber-300 text-xs space-y-1">
                {debugData.playersWithVenueSample3Plus === 0 && (
                  <li className="flex items-start gap-2">
                    <MapPin className="w-3 h-3 mt-0.5 shrink-0" />
                    <span>
                      <strong>Venue samples:</strong> No players have 3+ games at "{debugData.selectedVenueNormalized}".
                      {debugData.rowsMatchingSelectedVenue === 0 && ` The venue was not found in historical data.`}
                      {debugData.uniqueHistoricalVenues.length > 0 && ` Available venues: ${debugData.uniqueHistoricalVenues.slice(0, 5).join(', ')}`}
                    </span>
                  </li>
                )}
                {debugData.playersWithOpponentSample3Plus === 0 && (
                  <li className="flex items-start gap-2">
                    <Swords className="w-3 h-3 mt-0.5 shrink-0" />
                    <span>
                      <strong>Opponent samples:</strong> No players have 3+ games vs {debugData.selectedAwayTeamNormalized}.
                      {debugData.rowsMatchingCurrentOpponent === 0 && ` The opponent was not matched in historical data.`}
                      {debugData.rowsMissingOpponent > 0 && ` ${debugData.rowsMissingOpponent} rows missing opponent info.`}
                    </span>
                  </li>
                )}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
