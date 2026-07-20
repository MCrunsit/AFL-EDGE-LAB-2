import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

/**
 * player-props-ingest Edge Function
 *
 * Accepts real bookmaker player prop odds and stores them in bookmaker_odds.
 * Designed for manual/future API ingestion of AFL player prop ladders.
 *
 * Payload format:
 * {
 *   player_name: "Isaac Heeney",
 *   team: "Sydney",
 *   match_date: "2026-07-12",
 *   market: "disposals",
 *   line: 25,
 *   side: "Over",
 *   odds: 1.35,
 *   bookmaker: "Sportsbet",
 *   timestamp: "2026-07-07T10:00:00Z"
 * }
 *
 * Accepts both single odds and batch arrays.
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface PropOddsPayload {
  player_name: string;
  team: string;
  match_date: string;
  market: string;
  line: number;
  side: "Over" | "Under";
  odds: number;
  bookmaker: string;
  timestamp?: string;
}

interface IngestResult {
  success: boolean;
  ingested: number;
  skipped: number;
  errors: string[];
  details: Array<{
    player_name: string;
    market: string;
    line: number;
    status: "inserted" | "skipped" | "error";
    reason?: string;
  }>;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed. Use POST.", code: "METHOD_NOT_ALLOWED" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const result: IngestResult = {
    success: false,
    ingested: 0,
    skipped: 0,
    errors: [],
    details: [],
  };

  try {
    const body = await req.json();
    const payloads: PropOddsPayload[] = Array.isArray(body) ? body : [body];

    if (payloads.length === 0) {
      return new Response(
        JSON.stringify({ error: "No payloads provided", code: "EMPTY_PAYLOAD" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Load current players for matching
    const { data: players } = await supabase
      .from("current_players")
      .select("id, name, team");

    const playerMap = new Map<string, { id: string; team: string }>();
    for (const p of (players ?? []) as { id: string; name: string; team: string }[]) {
      playerMap.set(p.name.toLowerCase().trim(), { id: p.id, team: p.team });
      // Also try without common name variations
      const parts = p.name.toLowerCase().split(" ");
      if (parts.length >= 2) {
        playerMap.set(parts.slice(1).join(" "), { id: p.id, team: p.team }); // Last name only
      }
    }

    // Load upcoming matches
    const today = new Date().toISOString().split("T")[0];
    const { data: matches } = await supabase
      .from("matches")
      .select("id, match_date, home_team, away_team")
      .gte("match_date", today);

    const matchesByDate = new Map<string, Array<{ id: string; home_team: string; away_team: string }>>();
    for (const m of (matches ?? []) as { id: string; match_date: string; home_team: string; away_team: string }[]) {
      const dateKey = m.match_date?.split("T")[0];
      if (!dateKey) continue;
      if (!matchesByDate.has(dateKey)) matchesByDate.set(dateKey, []);
      matchesByDate.get(dateKey)!.push(m);
    }

    const toInsert: Record<string, unknown>[] = [];

    for (const payload of payloads) {
      // Validate required fields
      if (!payload.player_name || !payload.team || !payload.match_date ||
          !payload.market || payload.line == null || !payload.side || !payload.odds || !payload.bookmaker) {
        result.errors.push(`Missing required fields in payload: ${JSON.stringify(payload).slice(0, 200)}`);
        continue;
      }

      // Validate odds
      const odds = Number(payload.odds);
      if (isNaN(odds) || odds <= 1 || !isFinite(odds)) {
        result.errors.push(`Invalid odds for ${payload.player_name}: ${payload.odds}`);
        result.details.push({
          player_name: payload.player_name,
          market: payload.market,
          line: payload.line,
          status: "error",
          reason: `Invalid odds: ${payload.odds}`,
        });
        continue;
      }

      // Validate line
      const line = Number(payload.line);
      if (isNaN(line) || line <= 0) {
        result.errors.push(`Invalid line for ${payload.player_name}: ${payload.line}`);
        result.details.push({
          player_name: payload.player_name,
          market: payload.market,
          line: payload.line,
          status: "error",
          reason: `Invalid line: ${payload.line}`,
        });
        continue;
      }

      // Find player
      const playerKey = payload.player_name.toLowerCase().trim();
      const player = playerMap.get(playerKey);
      if (!player) {
        result.skipped++;
        result.details.push({
          player_name: payload.player_name,
          market: payload.market,
          line: payload.line,
          status: "skipped",
          reason: "Player not found in current_players",
        });
        continue;
      }

      // Find match
      const dateKey = payload.match_date?.split("T")[0];
      const dayMatches = matchesByDate.get(dateKey) ?? [];

      // Normalize team name for matching
      const teamNorm = payload.team.toLowerCase().replace(/\s+/g, "-");
      const match = dayMatches.find(m =>
        m.home_team.toLowerCase().replace(/\s+/g, "-") === teamNorm ||
        m.away_team.toLowerCase().replace(/\s+/g, "-") === teamNorm
      );

      if (!match) {
        result.skipped++;
        result.details.push({
          player_name: payload.player_name,
          market: payload.market,
          line: payload.line,
          status: "skipped",
          reason: `No match found for ${payload.team} on ${payload.match_date}`,
        });
        continue;
      }

      // Determine market_type and display_label
      const isIntegerLine = line === Math.floor(line);
      const marketType = isIntegerLine ? "alt_ladder" : "ou_line";
      const displayLabel = isIntegerLine ? `${Math.floor(line)}+` : null;
      const baseLine = isIntegerLine ? Math.floor(line) : null;

      // Map Over/Under to over_odds/under_odds
      const overOdds = payload.side === "Over" ? odds : 0;
      const underOdds = payload.side === "Under" ? odds : 0;

      toInsert.push({
        match_id: match.id,
        bookmaker_id: payload.bookmaker.toLowerCase().trim(),
        bookmaker_player_name: payload.player_name.trim(),
        player_id: player.id,
        market: payload.market.toLowerCase().trim(),
        raw_market: payload.market,
        line,
        raw_line: String(line),
        over_odds: overOdds,
        under_odds: underOdds,
        market_type: marketType,
        base_line: baseLine,
        display_label: displayLabel,
        source: "ingest_api",
        fetched_at: payload.timestamp || new Date().toISOString(),
      });

      result.details.push({
        player_name: payload.player_name,
        market: payload.market,
        line: payload.line,
        status: "inserted",
      });
    }

    // Batch upsert
    if (toInsert.length > 0) {
      const BATCH_SIZE = 500;
      for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
        const batch = toInsert.slice(i, i + BATCH_SIZE);
        const { error } = await supabase
          .from("bookmaker_odds")
          .upsert(batch, {
            onConflict: "bookmaker_id,bookmaker_player_name,match_id,market,line"
          });

        if (error) {
          result.errors.push(`Batch insert error: ${error.message}`);
        } else {
          result.ingested += batch.length;
        }
      }
    }

    result.success = result.ingested > 0 || result.skipped === 0;

    console.log(`[player-props-ingest] Ingested ${result.ingested} rows, skipped ${result.skipped}, errors ${result.errors.length}`);

    return new Response(JSON.stringify(result), {
      status: result.success ? 200 : 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("[player-props-ingest] FATAL:", err);
    result.errors.push(err instanceof Error ? err.message : String(err));
    return new Response(JSON.stringify(result), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
