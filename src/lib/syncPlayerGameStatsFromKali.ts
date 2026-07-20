import { supabase } from './supabase';

export interface FailedMatch {
  season: number;
  round: string | null;
  match_date: string | null;
  home_team: string | null;
  away_team: string | null;
  venue: string | null;
  local_match_id: string;
  api_match_id: string | null;
  failure_reason: string;
}

export interface KaliSyncResult {
  success: boolean;
  action: string;
  kali_connected: boolean;
  kali_status: string;
  requests_used: number;
  requests_remaining: number | null;
  matches_fetched: number;
  player_rows_fetched: number;
  rows_inserted: number;
  rows_updated: number;
  rows_skipped: number;
  rows_unresolved: number;
  duplicates_removed: number;
  failed_rows: number;
  latest_stat_round_before: string | null;
  latest_stat_round_after: string | null;
  missing_matches_remaining: number;
  rows_to_backfill: number;
  matches_processed: string[];
  failed_matches: FailedMatch[];
  errors: string[];
  debug_log: string[];
}

export type KaliStatus = 'connected' | 'missing_key' | 'auth_failed' | 'rate_limited' | 'api_error' | 'not_tested';

export interface KaliConnectionTest {
  connected: boolean;
  status: KaliStatus;
  requests_remaining: number | null;
  message: string;
}

export type SyncPriority = 'round_17' | 'critical' | 'all';

/**
 * Test Kali API connection (lightweight — 1 API call to /teams?limit=1)
 */
export async function testKaliConnection(): Promise<KaliConnectionTest> {
  try {
    const { data, error } = await supabase.functions.invoke('sync-player-game-stats', {
      body: { action: 'test' },
    });

    if (error) {
      return { connected: false, status: 'api_error', requests_remaining: null, message: error.message };
    }

    const result = data as KaliSyncResult;
    return {
      connected: result.kali_connected,
      status: result.kali_status as KaliStatus,
      requests_remaining: result.requests_remaining,
      message: result.errors.length > 0 ? result.errors.join('; ') : 'Connection successful',
    };
  } catch (e) {
    return { connected: false, status: 'api_error', requests_remaining: null, message: e instanceof Error ? e.message : 'Unknown error' };
  }
}

/**
 * Dry run — find missing matches without fetching stats (0 heavy API calls)
 */
export async function dryRunKaliSync(season?: number): Promise<KaliSyncResult> {
  try {
    const { data, error } = await supabase.functions.invoke('sync-player-game-stats', {
      body: { action: 'dry_run', season: season ?? new Date().getFullYear() },
    });
    if (error) throw error;
    return data as KaliSyncResult;
  } catch (e) {
    return {
      ...defaultResult(),
      errors: [e instanceof Error ? e.message : 'Unknown error'],
    };
  }
}

/**
 * Sync player game stats from Kali API
 * Priority: 'round_17' (default), 'critical' (R13-R17 with R18 odds teams), 'all'
 */
export async function syncPlayerGameStatsFromKali(
  priority: SyncPriority = 'round_17',
  season?: number,
): Promise<KaliSyncResult> {
  try {
    const { data, error } = await supabase.functions.invoke('sync-player-game-stats', {
      body: {
        action: 'sync',
        priority,
        season: season ?? new Date().getFullYear(),
      },
    });
    if (error) throw error;
    return data as KaliSyncResult;
  } catch (e) {
    return {
      ...defaultResult(),
      errors: [e instanceof Error ? e.message : 'Unknown error'],
    };
  }
}

/**
 * Sync ALL missing completed matches from Kali API
 * No priority filter — backfills every missing match from R0 to latest completed
 */
export async function syncAllMissingFromKali(season?: number): Promise<KaliSyncResult> {
  try {
    const { data, error } = await supabase.functions.invoke('sync-player-game-stats', {
      body: {
        action: 'sync_all_missing',
        season: season ?? new Date().getFullYear(),
      },
    });
    if (error) throw error;
    return data as KaliSyncResult;
  } catch (e) {
    return {
      ...defaultResult(),
      errors: [e instanceof Error ? e.message : 'Unknown error'],
    };
  }
}

function defaultResult(): KaliSyncResult {
  return {
    success: false,
    action: 'sync',
    kali_connected: false,
    kali_status: 'unknown',
    requests_used: 0,
    requests_remaining: null,
    matches_fetched: 0,
    player_rows_fetched: 0,
    rows_inserted: 0,
    rows_updated: 0,
    rows_skipped: 0,
    rows_unresolved: 0,
    duplicates_removed: 0,
    failed_rows: 0,
    latest_stat_round_before: null,
    latest_stat_round_after: null,
    missing_matches_remaining: 0,
    rows_to_backfill: 0,
    matches_processed: [],
    failed_matches: [],
    errors: [],
    debug_log: [],
  };
}
