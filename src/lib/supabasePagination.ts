/**
 * Shared pagination helper for Supabase reads.
 *
 * An unpaginated `.select()` is silently capped at Supabase's default
 * 1000-row limit — this has been the root cause of multiple confirmed bugs
 * in this app (Team Environment, CBA/kick-in samples, player-resolution
 * during Kali syncs) wherever a query touched player_game_stats (~7000
 * rows), player_role_data (~7200 rows), or players (~2850 rows) without
 * pagination. Use this anywhere a query result could plausibly exceed 1000
 * rows, instead of re-implementing the same range-loop per call site.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export async function fetchAllRows<T = any>(
  supabase: SupabaseClient,
  table: string,
  select: string,
  applyFilters?: (query: any) => any,
  pageSize = 1000,
): Promise<T[]> {
  const rows: T[] = [];
  let offset = 0;
  for (;;) {
    let query = supabase.from(table).select(select).order('id').range(offset, offset + pageSize - 1);
    if (applyFilters) query = applyFilters(query);
    const { data, error } = await query;
    if (error) throw new Error(`fetchAllRows(${table}) failed: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...(data as T[]));
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}
