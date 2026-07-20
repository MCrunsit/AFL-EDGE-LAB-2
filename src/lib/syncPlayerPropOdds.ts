import { supabase } from './supabase';

export interface PlayerPropsSyncResult {
  success: boolean;
  events_fetched: number;
  fixtures_updated: number;
  fixtures_created: number;
  events_matched: number;
  players_found: number;
  rows_inserted: number;
  rows_skipped: number;
  sample_rows: Array<{
    player_name: string;
    market: string;
    line: number;
    display_label: string;
    odds: number;
    bookmaker: string;
  }>;
  errors: string[];
  debug_log: string[];
  requests_remaining: number | null;
  fetched_at: string;
  cached: boolean;
  duration_ms: number;
  error?: string;
  code?: string;
}

/**
 * Trigger the player-props-sync edge function.
 * Reports what player prop markets are available from The Odds API.
 */
export async function syncPlayerPropsFromApi(force = false): Promise<PlayerPropsSyncResult> {
  const fallback: PlayerPropsSyncResult = {
    success: false,
    events_fetched: 0,
    fixtures_updated: 0,
    fixtures_created: 0,
    events_matched: 0,
    players_found: 0,
    rows_inserted: 0,
    rows_skipped: 0,
    sample_rows: [],
    errors: [],
    debug_log: [],
    requests_remaining: null,
    fetched_at: new Date().toISOString(),
    cached: false,
    duration_ms: 0,
  };

  try {
    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/player-props-sync`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ force }),
    });

    const json = await response.json();

    if (!response.ok) {
      return { ...fallback, error: json.error ?? `HTTP ${response.status}`, code: json.code, errors: [json.error ?? `HTTP ${response.status}`] };
    }

    return json;
  } catch (err) {
    return { ...fallback, error: err instanceof Error ? err.message : 'Network error', errors: [err instanceof Error ? err.message : 'Network error'] };
  }
}

export interface OddsSyncResult {
  inserted: number;
  skipped: number;
  errors: string[];
  requests_remaining: number | null;
  synced_at: string;
  cached: boolean;       // true = served from cache, no API call made
  error?: string;
  code?: string;
}

/**
 * Trigger a match odds sync via the odds-sync edge function.
 *
 * Syncs MATCH-LEVEL odds (h2h, spreads, totals) from The Odds API.
 * PLAYER PROP ODDS are NOT synced from any API — they are computed
 * internally from player_game_stats and enriched_player_stats tables.
 *
 * The edge function enforces a 6-hour cache TTL server-side:
 *   - Normal call: skips the API if last fetch < 6h old (returns cached=true)
 *   - force=true:  bypasses the cache and always calls the API
 *
 * Call sites:
 *   - "Sync Match Odds" button on the Import page → force=false (respects cache)
 */
export async function syncOddsFromApi(force = false): Promise<OddsSyncResult> {
  const synced_at = new Date().toISOString();

  try {
    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/odds-sync`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ force }),
    });

    const json = await response.json();

    if (!response.ok) {
      return {
        inserted: 0,
        skipped: 0,
        errors: [json.error ?? `HTTP ${response.status}`],
        requests_remaining: null,
        synced_at,
        cached: false,
        error: json.error,
        code: json.code,
      };
    }

    return { ...json, synced_at: json.fetched_at ?? synced_at };
  } catch (err) {
    return {
      inserted: 0,
      skipped: 0,
      errors: [err instanceof Error ? err.message : String(err)],
      requests_remaining: null,
      synced_at,
      cached: false,
      error: err instanceof Error ? err.message : 'Network error',
    };
  }
}

/**
 * Read the last successful odds sync time directly from odds_cache.
 * Returns null if never synced.
 */
export async function getLastOddsSyncTime(): Promise<{ fetchedAt: string | null; requestsRemaining: number | null }> {
  const { data } = await supabase
    .from('odds_cache')
    .select('fetched_at, requests_remaining')
    .eq('sport', 'aussierules_afl')
    .maybeSingle();
  return {
    fetchedAt: data?.fetched_at ?? null,
    requestsRemaining: data?.requests_remaining ?? null,
  };
}

/**
 * Human-readable age string: "Just now", "5 minutes ago", "3 hours ago".
 */
export function formatSyncAge(isoTimestamp: string | null): string {
  if (!isoTimestamp) return 'Never';
  const diff = Date.now() - new Date(isoTimestamp).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
