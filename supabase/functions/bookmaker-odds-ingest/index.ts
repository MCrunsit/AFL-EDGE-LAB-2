import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

/**
 * bookmaker-odds-ingest Edge Function
 *
 * Ingests AFL player prop odds into bookmaker_odds_raw (Layer 1).
 *
 * LAYER 1 RULES (NON-NEGOTIABLE):
 *   1. raw_market stored EXACTLY as received — NO toLowerCase, NO canonicalization
 *   2. raw_line stored EXACTLY as received string
 *   3. line is the numeric value — NEVER derived from stats
 *   4. NO grouping, NO deduplication beyond the unique constraint
 *   5. raw_payload stores the full API response for audit
 *
 * DEBUG MODE: Every sync logs:
 *   - raw rows ingested
 *   - rejected rows (with reasons)
 *   - API response count
 *   - DB inserted count
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

type MarketType = 'ou_line' | 'alt_ladder';

interface IngestRow {
  player_name: string;
  player_id?: string;
  match_id: string;
  bookmaker?: string;
  raw_market: string;
  raw_line?: string;
  line: number;
  over_odds: number;
  under_odds: number;
  raw_payload?: Record<string, unknown>;
}

/**
 * Classify a row's market type.
 * Sportsbet alt-ladder: integer line + '+' in raw_market or raw_line.
 * All other rows are standard ou_line.
 */
function classifyMarket(
  bookmaker: string,
  rawMarket: string,
  rawLine: string,
  line: number
): { market_type: MarketType; base_line: number | null; display_label: string | null } {
  // RULE: integer line → alt_ladder (N+ market), half-point line → ou_line.
  // Applies to ALL bookmakers. Matches the DB migration logic exactly.
  if (line === Math.floor(line)) {
    const base = Math.floor(line);
    return { market_type: 'alt_ladder', base_line: base, display_label: `${base}+` };
  }

  return { market_type: 'ou_line', base_line: null, display_label: null };
}

interface DebugLog {
  player_name: string;
  raw_market: string;
  raw_line: string;
  line: string;
  rejected_reason: string | null;
  player_resolved: string | null;
}

interface IngestResult {
  success: boolean;
  bookmaker: string;
  api_response_count: number;
  valid_count: number;
  inserted_count: number;
  rejected_count: number;
  errors: string[];
  debug_logs: DebugLog[];
  validation_passed: boolean;
  validation_mismatches: number;
  duration_ms: number;
  ingest_id: string;
}

function normalizePlayerName(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
}

function extractSurname(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts.length > 0 ? parts[parts.length - 1].toLowerCase() : "";
}

async function resolvePlayerId(
  supabase: ReturnType<typeof createClient>,
  playerName: string,
): Promise<string | null> {
  const normalized = normalizePlayerName(playerName);
  const surname = extractSurname(playerName);

  // 1. Alias table
  const { data: aliasMatch } = await supabase
    .from("player_name_aliases")
    .select("player_id")
    .ilike("alias", normalized)
    .maybeSingle();
  if (aliasMatch?.player_id) return aliasMatch.player_id;

  // 2. Exact name match
  const { data: exactMatch } = await supabase
    .from("players")
    .select("id")
    .ilike("name", normalized)
    .maybeSingle();
  if (exactMatch?.id) return exactMatch.id;

  // 3. Partial surname match
  if (surname.length >= 3) {
    const { data: partialMatches } = await supabase
      .from("players")
      .select("id, name, team")
      .ilike("name", `%${surname}%`)
      .limit(5);

    if (partialMatches && partialMatches.length === 1) {
      await supabase.from("player_name_aliases").insert({
        player_id: partialMatches[0].id,
        alias: playerName.trim(),
      }).catch(() => {});
      return partialMatches[0].id;
    }
  }

  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const startedAt = Date.now();
  const ingestId = crypto.randomUUID();

  let body: {
    bookmaker?: string;
    bookmaker_id?: string;
    odds_data?: IngestRow[];
    dry_run?: boolean;
  } = {};

  try {
    if (req.method === "POST") body = await req.json();
  } catch { /* no body */ }

  const bookmaker = (body.bookmaker ?? body.bookmaker_id ?? "manual").toLowerCase();
  const oddsData = body.odds_data ?? [];
  const dryRun = body.dry_run === true;

  const result: IngestResult = {
    success: false,
    bookmaker,
    api_response_count: oddsData.length,
    valid_count: 0,
    inserted_count: 0,
    rejected_count: 0,
    errors: [],
    debug_logs: [],
    validation_passed: true,
    validation_mismatches: 0,
    duration_ms: 0,
    ingest_id: ingestId,
  };

  console.log(`[bookmaker-odds-ingest] START bookmaker=${bookmaker} api_rows=${oddsData.length} dry_run=${dryRun}`);

  try {
    if (oddsData.length === 0) {
      result.duration_ms = Date.now() - startedAt;
      return new Response(
        JSON.stringify({ ...result, errors: ["No odds_data provided"] }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const validRows: Array<{
      match_id: string;
      player_name: string;
      player_id: string | null;
      bookmaker: string;
      raw_market: string;
      raw_line: string;
      line: number;
      over_odds: number;
      under_odds: number;
      raw_payload: Record<string, unknown> | null;
      fetched_at: string;
      market_type: MarketType;
      base_line: number | null;
      display_label: string | null;
    }> = [];

    const fetchedAt = new Date().toISOString();

    for (const row of oddsData) {
      const debugLog: DebugLog = {
        player_name: row.player_name ?? "(missing)",
        raw_market: row.raw_market ?? "(missing)",
        raw_line: row.raw_line ?? (row.line != null ? String(row.line) : "(missing)"),
        line: row.line != null ? String(row.line) : "(missing)",
        rejected_reason: null,
        player_resolved: null,
      };

      // Validate player_name
      if (!row.player_name || typeof row.player_name !== "string" || !row.player_name.trim()) {
        debugLog.rejected_reason = "Missing player_name";
        result.errors.push(debugLog.rejected_reason);
        result.debug_logs.push(debugLog);
        result.rejected_count++;
        continue;
      }

      // Validate match_id
      if (!row.match_id || typeof row.match_id !== "string") {
        debugLog.rejected_reason = `Missing match_id for ${row.player_name}`;
        result.errors.push(debugLog.rejected_reason);
        result.debug_logs.push(debugLog);
        result.rejected_count++;
        continue;
      }

      // Validate raw_market — stored EXACTLY as-is, no transformation
      if (!row.raw_market || typeof row.raw_market !== "string" || !row.raw_market.trim()) {
        debugLog.rejected_reason = `Missing raw_market for ${row.player_name}`;
        result.errors.push(debugLog.rejected_reason);
        result.debug_logs.push(debugLog);
        result.rejected_count++;
        continue;
      }

      // Validate line — must be positive number, NEVER derived
      if (row.line == null || row.line <= 0 || !isFinite(row.line)) {
        debugLog.rejected_reason = `Invalid line for ${row.player_name}: ${row.line}`;
        result.errors.push(debugLog.rejected_reason);
        result.debug_logs.push(debugLog);
        result.rejected_count++;
        continue;
      }

      // Validate odds
      if (
        !row.over_odds || !row.under_odds ||
        row.over_odds <= 1.01 || row.under_odds <= 1.01 ||
        !isFinite(row.over_odds) || !isFinite(row.under_odds)
      ) {
        debugLog.rejected_reason = `Invalid odds for ${row.player_name}: over=${row.over_odds} under=${row.under_odds}`;
        result.errors.push(debugLog.rejected_reason);
        result.debug_logs.push(debugLog);
        result.rejected_count++;
        continue;
      }

      // Resolve player_id (optional — raw store accepts unresolved names)
      let playerId: string | null = row.player_id ?? null;
      if (!playerId) {
        playerId = await resolvePlayerId(supabase, row.player_name);
      }
      debugLog.player_resolved = playerId;

      const rawLine = row.raw_line ?? String(row.line);
      const marketClass = classifyMarket(bookmaker, row.raw_market.trim(), rawLine, row.line);

      validRows.push({
        match_id: row.match_id,
        player_name: row.player_name.trim(),   // raw — no normalization
        player_id: playerId,
        bookmaker,
        raw_market: row.raw_market.trim(),     // EXACT — no toLowerCase, no canonicalization
        raw_line: rawLine,                     // EXACT string from source
        line: row.line,                        // numeric — no derivation
        over_odds: row.over_odds,
        under_odds: row.under_odds,
        raw_payload: row.raw_payload ?? null,
        fetched_at: fetchedAt,
        ...marketClass,
      });

      result.debug_logs.push(debugLog);
    }

    result.valid_count = validRows.length;

    // Log debug summary
    console.log(`[bookmaker-odds-ingest] api_rows=${result.api_response_count} valid=${result.valid_count} rejected=${result.rejected_count}`);
    for (const log of result.debug_logs) {
      if (log.rejected_reason) {
        console.log(`  REJECTED player="${log.player_name}" market="${log.raw_market}" reason="${log.rejected_reason}"`);
      } else {
        console.log(`  OK player="${log.player_name}" market="${log.raw_market}" line=${log.line} resolved=${log.player_resolved ?? "unresolved"}`);
      }
    }

    if (dryRun) {
      result.duration_ms = Date.now() - startedAt;
      return new Response(
        JSON.stringify({ ...result, success: true, message: `Dry run: ${validRows.length} valid rows (would insert)` }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Batch upsert into Layer 1 (bookmaker_odds_raw)
    // Unique key: (bookmaker, player_name, match_id, raw_market, raw_line)
    const BATCH = 500;
    for (let i = 0; i < validRows.length; i += BATCH) {
      const batch = validRows.slice(i, i + BATCH);
      const { error: upsertErr } = await supabase
        .from("bookmaker_odds_raw")
        .upsert(batch, {
          onConflict: "bookmaker,player_name,match_id,raw_market,raw_line",
        });

      if (upsertErr) {
        result.errors.push(`Batch ${Math.floor(i / BATCH) + 1}: ${upsertErr.message}`);
        console.error(`[bookmaker-odds-ingest] Batch upsert error:`, upsertErr.message);
      } else {
        result.inserted_count += batch.length;
      }
    }

    console.log(`[bookmaker-odds-ingest] DB inserted=${result.inserted_count}`);

    // Post-insert validation guard
    // Assert: api.raw_market === db.raw_market AND api.line === db.line
    if (validRows.length > 0 && result.inserted_count > 0) {
      const playerNames = [...new Set(validRows.map(r => r.player_name))];
      const matchIds = [...new Set(validRows.map(r => r.match_id))];

      const { data: dbRows } = await supabase
        .from("bookmaker_odds_raw")
        .select("bookmaker, player_name, match_id, raw_market, raw_line, line")
        .eq("bookmaker", bookmaker)
        .in("player_name", playerNames)
        .in("match_id", matchIds);

      const dbLookup = new Map<string, true>();
      for (const db of dbRows ?? []) {
        dbLookup.set(`${db.bookmaker}|${db.player_name}|${db.match_id}|${db.raw_market}|${db.raw_line}`, true);
      }

      for (const api of validRows) {
        const key = `${bookmaker}|${api.player_name}|${api.match_id}|${api.raw_market}|${api.raw_line}`;
        if (!dbLookup.has(key)) {
          result.validation_mismatches++;
          result.validation_passed = false;
          console.error(`[VALIDATION] MISSING in DB: player="${api.player_name}" market="${api.raw_market}" line=${api.line}`);
        }
      }

      console.log(`[VALIDATION] ${result.validation_passed ? "PASSED" : "FAILED"} — checked=${validRows.length} mismatches=${result.validation_mismatches}`);
    }

    result.duration_ms = Date.now() - startedAt;
    result.success = result.inserted_count > 0 && result.validation_passed;

    // Update bookmaker last_fetch
    await supabase.from("bookmakers").update({ last_fetch_at: new Date().toISOString() }).eq("id", bookmaker).catch(() => {});

    console.log(`[bookmaker-odds-ingest] DONE inserted=${result.inserted_count} duration=${result.duration_ms}ms validation=${result.validation_passed ? "PASS" : "FAIL"}`);

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[bookmaker-odds-ingest] FATAL:", err);
    result.duration_ms = Date.now() - startedAt;
    return new Response(
      JSON.stringify({ ...result, success: false, errors: [err instanceof Error ? err.message : "Unknown error"] }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
