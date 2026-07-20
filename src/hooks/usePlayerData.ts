import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import type { Player, PlayerGameStat, UpcomingGame, PlayerPropOdds, BookmakerOdds } from '../lib/types';
import { getUpcomingGames, getUpcomingPlayerOdds, getBookmakerOddsBreakdown } from '../lib/fixtures';

export function usePlayers() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase.from('current_players').select('*').order('name').then(({ data, error }) => {
      if (error) setError(error.message);
      else setPlayers(data ?? []);
      setLoading(false);
    });
  }, []);

  return { players, loading, error };
}

export function usePlayerStats(playerId: string | null) {
  const [stats, setStats] = useState<PlayerGameStat[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!playerId) { setStats([]); return; }
    setLoading(true);
    supabase
      .from('player_game_stats')
      .select('*')
      .eq('player_id', playerId)
      .order('match_date', { ascending: false })
      .then(({ data, error }) => {
        if (error) setError(error.message);
        else setStats(data ?? []);
        setLoading(false);
      });
  }, [playerId]);

  return { stats, loading, error };
}

export function useAllStats() {
  const [stats, setStats] = useState<PlayerGameStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from('player_game_stats')
      .select('*')
      .order('match_date', { ascending: false })
      .then(({ data, error }) => {
        if (error) setError(error.message);
        else setStats(data ?? []);
        setLoading(false);
      });
  }, []);

  return { stats, loading, error };
}

export function useUpcomingGames(teamSlug: string | null, limit = 5) {
  const [games, setGames] = useState<UpcomingGame[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!teamSlug) { setGames([]); return; }
    setLoading(true);
    getUpcomingGames(teamSlug, limit).then(g => {
      setGames(g);
      setLoading(false);
    });
  }, [teamSlug, limit]);

  return { games, loading };
}

export type UpcomingOdd = { odds: PlayerPropOdds; match_date: string; opponent: string; venue: string | null };

export function usePlayerOdds(playerId: string | null, market?: string) {
  const [odds, setOdds] = useState<UpcomingOdd[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!playerId) { setOdds([]); return; }

    let cancelled = false;

    async function fetchOdds() {
      if (!cancelled) setLoading(true);
      const o = await getUpcomingPlayerOdds(playerId!, market);
      if (!cancelled) { setOdds(o); setLoading(false); }
    }

    fetchOdds();

    // Listen for odds updates from bookmaker_odds table
    const channel = supabase
      .channel('odds_table_changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'bookmaker_odds' },
        () => { fetchOdds(); }
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [playerId, market]);

  return { odds, loading };
}

export function useBookmakerOdds(playerId: string | null, matchId: string | null, market: string) {
  const [odds, setOdds] = useState<BookmakerOdds[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!playerId || !matchId || !market) { setOdds([]); return; }

    let cancelled = false;
    setLoading(true);

    getBookmakerOddsBreakdown(playerId, matchId, market).then(o => {
      if (!cancelled) {
        setOdds(o);
        setLoading(false);
      }
    });

    return () => { cancelled = true; };
  }, [playerId, matchId, market]);

  return { odds, loading };
}
