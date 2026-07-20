import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

/**
 * player-props-sync Edge Function
 *
 * 1. Syncs AFL fixtures from The Odds API (stores event IDs in api_match_id)
 * 2. Fetches player prop ladders AND genuine disposal O/U lines
 *
 * Markets:
 *   player_disposals        — genuine Over/Under disposal line (half-point, e.g. 28.5)
 *   player_disposals_over   — disposal over-only / ladder selections (integer, e.g. 21+, 22+)
 *   player_marks_over       — mark ladders
 *   player_tackles_over     — tackle ladders
 *   player_goals_scored_over — goal ladders
 *
 * O/U rows are stored as market_type='ou_line' with both real over_odds and under_odds.
 * Ladder rows are stored as market_type='alt_ladder' with over_odds only.
 * They never overwrite each other because raw_market and market_type differ.
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const SPORT = "aussierules_afl";
const CACHE_TTL_HOURS = 1;

const PLAYER_PROP_MARKETS = [
  "player_disposals",
  "player_disposals_over",
  "player_marks_over",
  "player_tackles_over",
  "player_goals_scored_over",
];

const MARKET_MAP: Record<string, string> = {
  "player_disposals": "disposals",
  "player_disposals_over": "disposals",
  "player_marks_over": "marks",
  "player_tackles_over": "tackles",
  "player_goals_scored_over": "goals",
};

interface ApiOutcome {
  name: string;
  description: string;
  price: number;
  point: number;
}

interface ApiMarket {
  key: string;
  last_update: string;
  outcomes: ApiOutcome[];
}

interface ApiBookmaker {
  key: string;
  title: string;
  markets: ApiMarket[];
}

interface ApiEvent {
  id: string;
  home_team: string;
  away_team: string;
  commence_time: string;
}

interface SyncResult {
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
  // O/U diagnostics
  ou_markets_returned: number;
  ladder_markets_returned: number;
  over_outcomes_received: number;
  under_outcomes_received: number;
  ou_rows_inserted: number;
  ladder_rows_inserted: number;
  outcomes_rejected: Array<{ player: string; reason: string }>;
}

const TEAM_NORMALIZE: Record<string, string> = {
  "adelaide crows": "adelaide", "adelaide": "adelaide",
  "brisbane lions": "brisbane", "brisbane": "brisbane",
  "carlton blues": "carlton", "carlton": "carlton",
  "collingwood magpies": "collingwood", "collingwood": "collingwood",
  "essendon bombers": "essendon", "essendon": "essendon",
  "fremantle dockers": "fremantle", "fremantle": "fremantle",
  "geelong cats": "geelong", "geelong": "geelong",
  "gold coast suns": "gold-coast", "gold coast": "gold-coast",
  "greater western sydney giants": "gws", "gws giants": "gws", "gws": "gws",
  "hawthorn hawks": "hawthorn", "hawthorn": "hawthorn",
  "melbourne demons": "melbourne", "melbourne": "melbourne",
  "north melbourne kangaroos": "north-melbourne", "north melbourne": "north-melbourne",
  "port adelaide power": "port-adelaide", "port adelaide": "port-adelaide",
  "richmond tigers": "richmond", "richmond": "richmond",
  "st kilda saints": "st-kilda", "st kilda": "st-kilda",
  "sydney swans": "sydney", "sydney": "sydney",
  "west coast eagles": "west-coast", "west coast": "west-coast",
  "western bulldogs": "western-bulldogs", "bulldogs": "western-bulldogs",
};

function normalizeTeam(name: string): string {
  const key = name?.toLowerCase().trim() ?? "";
  return TEAM_NORMALIZE[key] ?? key.replace(/\s+/g, "-");
}

function teamsMatch(apiTeam: string, dbTeam: string): boolean {
  const apiNorm = normalizeTeam(apiTeam);
  const dbNorm = normalizeTeam(dbTeam);
  if (apiNorm === dbNorm) return true;
  const apiLower = apiTeam?.toLowerCase() ?? "";
  const dbLower = dbTeam?.toLowerCase() ?? "";
  return apiLower.includes(dbLower) || dbLower.includes(apiLower);
}

function datesMatch(apiDate: string, dbDate: string, toleranceHours = 72): boolean {
  try {
    const apiTs = new Date(apiDate).getTime();
    const dbTs = new Date(dbDate).getTime();
    const diffHours = Math.abs(apiTs - dbTs) / (1000 * 60 * 60);
    return diffHours <= toleranceHours;
  } catch {
    return false;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const ODDS_API_KEY = Deno.env.get("ODDS_API_KEY");
  if (!ODDS_API_KEY) {
    return new Response(
      JSON.stringify({ error: "ODDS_API_KEY not configured", code: "MISSING_API_KEY" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  let force = false;
  try {
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      force = body?.force === true;
    }
  } catch { /* no body */ }

  const startedAt = Date.now();
  const fetchedAt = new Date().toISOString();
  const debugLog: string[] = [];

  const result: SyncResult = {
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
    debug_log: debugLog,
    requests_remaining: null,
    cached: false,
    duration_ms: 0,
    fetched_at: fetchedAt,
    ou_markets_returned: 0,
    ladder_markets_returned: 0,
    over_outcomes_received: 0,
    under_outcomes_received: 0,
    ou_rows_inserted: 0,
    ladder_rows_inserted: 0,
    outcomes_rejected: [],
  };

  try {
    debugLog.push("=== PLAYER PROPS SYNC (AFL LADDERS + O/U) ===");
    debugLog.push(`Time: ${fetchedAt}`);
    debugLog.push(`Markets: ${PLAYER_PROP_MARKETS.join(", ")}`);

    // Check cache
    if (!force) {
      const { data: cacheRow } = await supabase
        .from("odds_cache")
        .select("fetched_at")
        .eq("sport", `${SPORT}_props`)
        .maybeSingle();

      if (cacheRow?.fetched_at) {
        const ageH = (Date.now() - new Date(cacheRow.fetched_at).getTime()) / 3_600_000;
        if (ageH < CACHE_TTL_HOURS) {
          debugLog.push(`Cache hit — ${ageH.toFixed(1)}h old, skipping`);
          result.cached = true;
          result.duration_ms = Date.now() - startedAt;
          return new Response(JSON.stringify(result), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
    }

    // Step 1: Fetch AFL events from The Odds API
    const eventsUrl = new URL(`https://api.the-odds-api.com/v4/sports/${SPORT}/events/`);
    eventsUrl.searchParams.set("apiKey", ODDS_API_KEY);
    eventsUrl.searchParams.set("dateFormat", "iso");

    debugLog.push("Fetching AFL events...");
    const eventsResp = await fetch(eventsUrl.toString());

    if (eventsResp.headers.get("x-requests-remaining")) {
      result.requests_remaining = parseInt(eventsResp.headers.get("x-requests-remaining")!);
    }

    if (!eventsResp.ok) {
      throw new Error(`Events API error ${eventsResp.status}`);
    }

    const events: ApiEvent[] = await eventsResp.json();
    result.events_fetched = events.length;
    debugLog.push(`Fetched ${events.length} AFL events`);

    // Step 2: Sync fixtures - match events to DB and update api_match_id
    const today = new Date().toISOString().split("T")[0];

    // Load existing fixtures for next 30 days
    const { data: dbMatches } = await supabase
      .from("matches")
      .select("id, match_date, home_team, away_team, api_match_id, round")
      .gte("match_date", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]);

    // Detect next round number from latest completed stats round
    let nextRound = "TBD";
    const { data: latestStat } = await supabase
      .from("player_game_stats")
      .select("match_id, matches:match_id(round)")
      .order("match_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestStat) {
      const statRound = (latestStat as any)?.matches?.round;
      if (statRound) {
        const m = statRound.match(/(\d+)/);
        if (m) nextRound = String(parseInt(m[1], 10) + 1);
      }
    }
    debugLog.push(`Detected next round: ${nextRound} (latest stats round: ${(latestStat as any)?.matches?.round ?? 'none'})`);

    debugLog.push(`DB fixtures loaded: ${dbMatches?.length ?? 0}`);

    // Build lookup by api_match_id
    const matchByApiId = new Map<string, { id: string; match_date: string; home_team: string; away_team: string }>();
    for (const m of dbMatches ?? []) {
      if (m.api_match_id) {
        matchByApiId.set(m.api_match_id, m);
      }
    }

    // Match each event to a fixture
    const eventToMatch = new Map<string, string>();

    for (const event of events) {
      const apiDate = event.commence_time?.split("T")[0] ?? "";
      debugLog.push(`  Event: ${event.id} | ${event.home_team} v ${event.away_team} | ${event.commence_time}`);

      // PRIORITY 1: Match by api_match_id if already stored
      if (matchByApiId.has(event.id)) {
        const match = matchByApiId.get(event.id)!;
        eventToMatch.set(event.id, match.id);
        debugLog.push(`    -> Matched by api_match_id to ${match.id}`);
        continue;
      }

      // PRIORITY 2: Match by teams and date
      let matched = false;
      for (const m of dbMatches ?? []) {
        if (matched) break;
        if (!datesMatch(event.commence_time, m.match_date as string, 72)) continue;

        const homeMatch = teamsMatch(event.home_team, m.home_team ?? "");
        const awayMatch = teamsMatch(event.away_team, m.away_team ?? "");

        if (homeMatch && awayMatch) {
          eventToMatch.set(event.id, m.id);
          debugLog.push(`    -> Matched by teams/date to ${m.id}`);

          if (!m.api_match_id || !(m as { commence_time_utc?: string }).commence_time_utc) {
            const { error: updateErr } = await supabase
              .from("matches")
              .update({
                api_match_id: event.id,
                commence_time_utc: event.commence_time
              })
              .eq("id", m.id);

            if (!updateErr) {
              result.fixtures_updated++;
              debugLog.push(`    -> Updated api_match_id for ${m.id}`);
            }
          }
          matched = true;
        }
      }

      // PRIORITY 3: Create new fixture if no match
      if (!matched) {
        const { data: newMatch, error: createErr } = await supabase
          .from("matches")
          .insert({
            season: 2026,
            round: nextRound,
            home_team: event.home_team,
            away_team: event.away_team,
            match_date: event.commence_time.split("T")[0],
            venue: null,
            api_match_id: event.id,
            commence_time_utc: event.commence_time,
          })
          .select("id")
          .single();

        if (createErr) {
          debugLog.push(`    -> FAILED to create fixture: ${createErr.message}`);
        } else {
          result.fixtures_created++;
          eventToMatch.set(event.id, newMatch.id);
          debugLog.push(`    -> Created new fixture ${newMatch.id}`);
        }
      }
    }

    result.events_matched = eventToMatch.size;
    debugLog.push(`\n=== FIXTURE SYNC SUMMARY ===`);
    debugLog.push(`Events: ${result.events_fetched}, Matched: ${result.events_matched}, Updated: ${result.fixtures_updated}, Created: ${result.fixtures_created}`);

    // Step 3: Fetch player props for each matched event
    const ladderRows: Record<string, unknown>[] = [];
    const ouRows: Record<string, unknown>[] = [];
    const playersSeen = new Set<string>();

    for (const [eventId, matchId] of eventToMatch) {
      debugLog.push(`\nFetching props for event ${eventId}...`);

      const oddsUrl = new URL(`https://api.the-odds-api.com/v4/sports/${SPORT}/events/${eventId}/odds/`);
      oddsUrl.searchParams.set("apiKey", ODDS_API_KEY);
      oddsUrl.searchParams.set("bookmakers", "sportsbet");
      oddsUrl.searchParams.set("markets", PLAYER_PROP_MARKETS.join(","));
      oddsUrl.searchParams.set("regions", "au");
      oddsUrl.searchParams.set("oddsFormat", "decimal");
      oddsUrl.searchParams.set("dateFormat", "iso");

      const oddsResp = await fetch(oddsUrl.toString());

      if (oddsResp.headers.get("x-requests-remaining")) {
        result.requests_remaining = parseInt(oddsResp.headers.get("x-requests-remaining")!);
      }

      if (!oddsResp.ok) {
        debugLog.push(`  Error ${oddsResp.status} for event ${eventId}`);
        continue;
      }

      const oddsData: { bookmakers?: ApiBookmaker[] } = await oddsResp.json();

      for (const bm of oddsData.bookmakers ?? []) {
        const bookmakerKey = bm.key ?? "sportsbet";

        for (const market of bm.markets ?? []) {
          const appMarket = MARKET_MAP[market.key];
          if (!appMarket) {
            debugLog.push(`  Skipping unknown market: ${market.key}`);
            continue;
          }

          const isOUMarket = market.key === "player_disposals";
          const isLadderMarket = market.key.endsWith("_over");

          if (isOUMarket) {
            result.ou_markets_returned++;
          } else if (isLadderMarket) {
            result.ladder_markets_returned++;
          }

          debugLog.push(`  Market: ${market.key} (${market.outcomes?.length ?? 0} outcomes) — ${isOUMarket ? "O/U" : "ladder"}`);

          if (isOUMarket) {
            // Pair Over and Under outcomes by player + point
            // Each outcome has name: "Over" or "Under", description: player name, point: line, price: odds
            const overMap = new Map<string, ApiOutcome>();
            const underMap = new Map<string, ApiOutcome>();

            for (const outcome of market.outcomes ?? []) {
              const playerName = outcome.description;
              const point = outcome.point;
              const price = outcome.price;
              const name = (outcome.name ?? "").toLowerCase().trim();

              if (!playerName || price == null || point == null) {
                result.outcomes_rejected.push({
                  player: playerName ?? "unknown",
                  reason: `Missing fields (name=${outcome.name}, price=${price}, point=${point})`,
                });
                continue;
              }

              const key = `${playerName.toLowerCase().trim()}|${point}`;

              if (name === "over") {
                result.over_outcomes_received++;
                overMap.set(key, outcome);
                playersSeen.add(playerName);
              } else if (name === "under") {
                result.under_outcomes_received++;
                underMap.set(key, outcome);
                playersSeen.add(playerName);
              } else {
                result.outcomes_rejected.push({
                  player: playerName,
                  reason: `Unrecognised outcome name: "${outcome.name}"`,
                });
              }
            }

            // Pair over + under by key and create O/U rows
            const pairedKeys = new Set<string>([...overMap.keys(), ...underMap.keys()]);
            for (const key of pairedKeys) {
              const overOutcome = overMap.get(key);
              const underOutcome = underMap.get(key);

              const overOdds = overOutcome?.price;
              const underOdds = underOutcome?.price;
              const playerName = (overOutcome ?? underOutcome)!.description;
              const point = (overOutcome ?? underOutcome)!.point;

              if (overOdds == null || overOdds <= 1.0) {
                if (underOdds != null && underOdds > 1.0) {
                  result.outcomes_rejected.push({
                    player: playerName,
                    reason: `Over odds missing or invalid (over=${overOdds}) — under exists but cannot pair`,
                  });
                }
                continue;
              }

              // Store with the real half-point line (e.g. 28.5, not rounded)
              ouRows.push({
                match_id: matchId,
                bookmaker_id: bookmakerKey,
                bookmaker_player_name: playerName,
                player_id: null,
                market: appMarket,
                raw_market: market.key,
                line: point,
                raw_line: String(point),
                over_odds: overOdds,
                under_odds: underOdds ?? 0,
                market_type: "ou_line",
                base_line: null,
                display_label: null,
                source: "the_odds_api",
                fetched_at: fetchedAt,
              });
            }
          } else if (isLadderMarket) {
            // Ladder market — store each outcome as an alt_ladder row
            for (const outcome of market.outcomes ?? []) {
              const playerName = outcome.description;
              const price = outcome.price;
              const rawPoint = outcome.point;

              if (!playerName || price == null || rawPoint == null) {
                result.outcomes_rejected.push({
                  player: playerName ?? "unknown",
                  reason: `Missing fields in ladder outcome`,
                });
                continue;
              }

              // Ladder lines are integer thresholds (20.5 -> 21+ via ceil)
              const line = Math.ceil(rawPoint);
              playersSeen.add(playerName);

              ladderRows.push({
                match_id: matchId,
                bookmaker_id: bookmakerKey,
                bookmaker_player_name: playerName,
                player_id: null,
                market: appMarket,
                raw_market: market.key,
                line,
                raw_line: String(rawPoint),
                over_odds: price,
                under_odds: 0,
                market_type: "alt_ladder",
                base_line: line,
                display_label: `${line}+`,
                source: "the_odds_api",
                fetched_at: fetchedAt,
              });
            }
          }
        }
      }

      // Rate limiting
      await new Promise(r => setTimeout(r, 100));
    }

    result.players_found = playersSeen.size;
    debugLog.push(`\n=== PLAYER PROPS SUMMARY ===`);
    debugLog.push(`O/U rows built: ${ouRows.length}, Ladder rows built: ${ladderRows.length}`);
    debugLog.push(`O/U markets: ${result.ou_markets_returned}, Ladder markets: ${result.ladder_markets_returned}`);
    debugLog.push(`Over outcomes: ${result.over_outcomes_received}, Under outcomes: ${result.under_outcomes_received}`);
    debugLog.push(`Unique players: ${playersSeen.size}`);

    // Sample rows (mix of O/U and ladder)
    const allRows = [...ouRows, ...ladderRows];
    for (const row of allRows.slice(0, 15) as Record<string, unknown>[]) {
      result.sample_rows.push({
        player_name: row.bookmaker_player_name as string,
        market: row.raw_market as string,
        line: row.line as number,
        display_label: (row.display_label as string) ?? `O/U ${row.line}`,
        odds: row.over_odds as number,
        bookmaker: "Sportsbet",
      });
      debugLog.push(`  ${row.bookmaker_player_name} | ${row.raw_market} | line=${row.line} | over=${row.over_odds} | under=${row.under_odds} | type=${row.market_type}`);
    }

    // Batch upsert O/U rows first (they have raw_market='player_disposals')
    const BATCH_SIZE = 500;
    if (ouRows.length > 0) {
      for (let i = 0; i < ouRows.length; i += BATCH_SIZE) {
        const batch = ouRows.slice(i, i + BATCH_SIZE);
        const { error } = await supabase
          .from("bookmaker_odds")
          .upsert(batch, { onConflict: "bookmaker_id,bookmaker_player_name,match_id,market,line" });

        if (error) {
          result.errors.push(`O/U batch error: ${error.message}`);
          result.rows_skipped += batch.length;
        } else {
          result.rows_inserted += batch.length;
          result.ou_rows_inserted += batch.length;
        }
      }
    }

    // Batch upsert ladder rows (they have raw_market='player_disposals_over' etc)
    if (ladderRows.length > 0) {
      for (let i = 0; i < ladderRows.length; i += BATCH_SIZE) {
        const batch = ladderRows.slice(i, i + BATCH_SIZE);
        const { error } = await supabase
          .from("bookmaker_odds")
          .upsert(batch, { onConflict: "bookmaker_id,bookmaker_player_name,match_id,market,line" });

        if (error) {
          result.errors.push(`Ladder batch error: ${error.message}`);
          result.rows_skipped += batch.length;
        } else {
          result.rows_inserted += batch.length;
          result.ladder_rows_inserted += batch.length;
        }
      }
    }

    debugLog.push(`\nRows inserted: ${result.rows_inserted} (O/U: ${result.ou_rows_inserted}, Ladder: ${result.ladder_rows_inserted}), Skipped: ${result.rows_skipped}`);

    if (result.outcomes_rejected.length > 0) {
      debugLog.push(`Outcomes rejected: ${result.outcomes_rejected.length}`);
      for (const r of result.outcomes_rejected.slice(0, 10)) {
        debugLog.push(`  REJECTED: ${r.player} — ${r.reason}`);
      }
    }

    // Update cache
    await supabase.from("odds_cache").upsert(
      {
        sport: `${SPORT}_props`,
        fetched_at: fetchedAt,
        processed_at: new Date().toISOString(),
        inserted_count: result.rows_inserted,
        skipped_count: result.rows_skipped,
        requests_remaining: result.requests_remaining,
      },
      { onConflict: "sport" },
    );

    result.success = result.rows_inserted > 0;
    result.duration_ms = Date.now() - startedAt;
    debugLog.push(`\nDone. Duration: ${result.duration_ms}ms. API credits: ${result.requests_remaining}`);

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[player-props-sync] FATAL:", err);
    result.duration_ms = Date.now() - startedAt;
    result.errors.push(err instanceof Error ? err.message : String(err));
    debugLog.push(`FATAL ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return new Response(JSON.stringify({ ...result, success: false }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
