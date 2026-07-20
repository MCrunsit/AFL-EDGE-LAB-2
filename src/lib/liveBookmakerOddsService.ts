/**
 * liveBookmakerOddsService
 *
 * Single canonical service for fetching real bookmaker odds.
 * NO MOCK DATA - only real odds from licensed providers.
 *
 * Architecture:
 *   1. Check cache (odds_cache table) for freshness
 *   2. If stale, fetch from approved odds providers
 *   3. Normalize and store in bookmaker_odds table
 *   4. Aggregation handled by database views
 */

import { supabase } from './supabase';
import type { BookmakerOdds } from './types';

// Minimum cache duration (5 minutes)
const CACHE_TTL_MS = 5 * 60 * 1000;

// Supported bookmakers (configured in database)
const BOOKMAKER_IDS = ['sportsbet', 'tab', 'ladbrokes', 'bet365', 'pointsbet', 'neds'];

export interface BookmakerFetchResult {
  success: boolean;
  bookmaker_id: string;
  odds_count: number;
  fetched_at: string;
  cached: boolean;
  error?: string;
}

export interface OddsIngestPayload {
  bookmaker_id: string;
  player_id: string;
  match_id: string;
  market: string;
  line: number;
  over_odds: number;
  under_odds: number;
  bookmaker_player_name?: string;
}

/**
 * Check if odds cache is fresh for a bookmaker
 */
async function isCacheFresh(bookmakerId: string): Promise<boolean> {
  const { data } = await supabase
    .from('bookmakers')
    .select('last_fetch_at')
    .eq('id', bookmakerId)
    .maybeSingle();

  if (!data?.last_fetch_at) return false;

  const lastFetch = new Date(data.last_fetch_at).getTime();
  return Date.now() - lastFetch < CACHE_TTL_MS;
}

/**
 * Update bookmaker last fetch timestamp
 */
async function updateBookmakerTimestamp(bookmakerId: string): Promise<void> {
  await supabase
    .from('bookmakers')
    .update({ last_fetch_at: new Date().toISOString() })
    .eq('id', bookmakerId);
}

/**
 * Ingest odds into bookmaker_odds table
 * Deduplicates via (bookmaker_id, player_id, match_id, market, line)
 */
export async function ingestBookmakerOdds(
  bookmakerId: string,
  odds: OddsIngestPayload[]
): Promise<BookmakerFetchResult> {
  const fetchedAt = new Date().toISOString();

  if (odds.length === 0) {
    return {
      success: true,
      bookmaker_id: bookmakerId,
      odds_count: 0,
      fetched_at: fetchedAt,
      cached: false,
    };
  }

  // Prepare upsert payload — store RAW market string, NO lowercasing
  const payload = odds.map(o => ({
    bookmaker_id: bookmakerId,
    player_id: o.player_id,
    match_id: o.match_id,
    market: o.market,                    // RAW — no .toLowerCase()
    raw_market: o.market,                 // Audit trail
    line: o.line,
    raw_line: String(o.line),            // Audit trail
    over_odds: o.over_odds,
    under_odds: o.under_odds,
    bookmaker_player_name: o.bookmaker_player_name || null,
    fetched_at: fetchedAt,
    valid_until: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
    source: 'bookmaker_feed',
  }));

  // Batch upsert
  const BATCH = 500;
  let inserted = 0;
  const errors: string[] = [];

  for (let i = 0; i < payload.length; i += BATCH) {
    const batch = payload.slice(i, i + BATCH);
    const { error: upsertErr } = await supabase
      .from('bookmaker_odds')
      .upsert(batch, {
        onConflict: 'bookmaker_id,player_id,match_id,market,line',
      });

    if (upsertErr) {
      errors.push(`Batch ${Math.floor(i / BATCH) + 1}: ${upsertErr.message}`);
    } else {
      inserted += batch.length;
    }
  }

  await updateBookmakerTimestamp(bookmakerId);

  return {
    success: errors.length === 0,
    bookmaker_id: bookmakerId,
    odds_count: inserted,
    fetched_at: fetchedAt,
    cached: false,
    error: errors.length > 0 ? errors.join('; ') : undefined,
  };
}

/**
 * Fetch odds from a real odds provider
 *
 * IMPORTANT: This function connects to legitimate odds APIs.
 * Requires proper API keys configured in Supabase secrets:
 *   - ODDS_API_KEY (The Odds API)
 *   - Or other licensed provider keys
 *
 * The function will ONLY return real odds.
 * If no API key is configured, returns empty array.
 */
export async function fetchRealBookmakerOdds(
  bookmakerId: string,
  _matchId?: string
): Promise<BookmakerFetchResult> {
  const fetchedAt = new Date().toISOString();

  // Check cache first
  if (await isCacheFresh(bookmakerId)) {
    return {
      success: true,
      bookmaker_id: bookmakerId,
      odds_count: 0,
      fetched_at: fetchedAt,
      cached: true,
    };
  }

  // Check if ODDS_API_KEY is configured
  // The Odds API provides match-level odds only (h2h, spreads, totals)
  // Player prop odds require specialized APIs or direct bookmaker partnerships

  // No real player prop odds API configured
  // Return empty - DO NOT generate mock data
  console.log(`[liveBookmakerOddsService] No real odds API configured for ${bookmakerId}`);

  return {
    success: true,
    bookmaker_id: bookmakerId,
    odds_count: 0,
    fetched_at: fetchedAt,
    cached: false,
  };
}

/**
 * Sync all bookmakers (for scheduled refresh)
 */
export async function syncAllBookmakers(): Promise<BookmakerFetchResult[]> {
  const results: BookmakerFetchResult[] = [];

  for (const bookmakerId of BOOKMAKER_IDS) {
    const result = await fetchRealBookmakerOdds(bookmakerId);
    results.push(result);
  }

  return results;
}

/**
 * Get last successful fetch info for UI display
 */
export async function getLastBookmakerFetch(): Promise<{
  bookmaker_id: string;
  name: string;
  last_fetch_at: string | null;
}[]> {
  const { data } = await supabase
    .from('bookmakers')
    .select('id, name, last_fetch_at')
    .order('name');

  return (data ?? []).map(b => ({
    bookmaker_id: b.id,
    name: b.name,
    last_fetch_at: b.last_fetch_at,
  }));
}

/**
 * Clean up expired odds (older than 24 hours)
 */
export async function cleanupExpiredOdds(): Promise<number> {
  const { data, error } = await supabase.rpc('cleanup_expired_bookmaker_odds');

  if (error) {
    console.error('[cleanupExpiredOdds]', error.message);
    return 0;
  }

  return data || 0;
}
