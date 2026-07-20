import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

/*
 * odds-sync Edge Function
 *
 * Fetches MATCH-LEVEL odds from The Odds API for AFL.
 *
 * ONLY fetches featured markets (h2h, spreads, totals) — these are:
 *   - Available for multiple games in a single API call
 *   - Cost-efficient (1 credit per market per region)
 *   - Do NOT require per-event API calls
 *
 * PLAYER PROPS are NOT fetched — computed internally from player_game_stats.
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const CACHE_TTL_HOURS = 6;
const MATCH_WINDOW_DAYS = 7;
const SPORT = "aussierules_afl";
const FEATURED_MARKETS = ["h2h", "spreads", "totals"];

// Skip reason tracking
interface SkipLog {
  api_home_team: string;
  api_away_team: string;
  event_date: string;
  market: string;
  reason: string;
  bookmaker?: string;
  details?: string;
}

function normaliseTeam(name: string): string {
  const MAP: Record<string, string> = {
    "brisbane lions": "brisbane",
    "brisbane": "brisbane",
    "gws giants": "gws",
    "greater western sydney": "gws",
    "gws": "gws",
    "gold coast suns": "gold-coast",
    "gold coast": "gold-coast",
    "north melbourne": "north-melbourne",
    "port adelaide": "port-adelaide",
    "st kilda": "st-kilda",
    "west coast": "west-coast",
    "west coast eagles": "west-coast",
    "western bulldogs": "western-bulldogs",
    "fremantle": "fremantle",
    "fremantle dockers": "fremantle",
    "collingwood": "collingwood",
    "collingwood magpies": "collingwood",
    "richmond": "richmond",
    "melbourne": "melbourne",
    "geelong": "geelong",
    "geelong cats": "geelong",
    "hawthorn": "hawthorn",
    "essendon": "essendon",
    "carlton": "carlton",
    "sydney": "sydney",
    "sydney swans": "sydney",
    "adelaide": "adelaide",
    "adelaide crows": "adelaide",
  };
  const key = name.trim().toLowerCase();
  return MAP[key] ?? key.replace(/\s+/g, "-");
}

/**
 * Fuzzy team match - handles minor variations
 */
function fuzzyTeamMatch(apiTeam: string, slug: string): boolean {
  const apiSlug = normaliseTeam(apiTeam);
  if (apiSlug === slug) return true;

  // Check if either contains the other (for partial matches)
  const apiLower = apiTeam.trim().toLowerCase();
  const slugLower = slug.toLowerCase();
  if (apiLower.includes(slugLower) || slugLower.includes(apiLower)) return true;

  // Handle "Lions" -> "brisbane", "Crows" -> "adelaide", etc.
  const aliases: Record<string, string[]> = {
    "brisbane": ["lions"],
    "adelaide": ["crows"],
    "collingwood": ["pies", "magpies"],
    "west-coast": ["eagles"],
    "western-bulldogs": ["bulldogs", "dogs"],
    "fremantle": ["dockers", "freo"],
    "gws": ["giants"],
    "sydney": ["swans"],
    "essendon": ["bombers", "dons"],
    "hawthorn": ["hawks"],
    "richmond": ["tigers"],
    "geelong": ["cats"],
    "melbourne": ["demons", "dees"],
    "north-melbourne": ["kangaroos", "roos", "north"],
    "st-kilda": ["saints"],
    "carlton": ["blues"],
    "port-adelaide": ["power", "port"],
    "gold-coast": ["suns"],
  };

  for (const [canonical, aliasList] of Object.entries(aliases)) {
    if (slug === canonical && aliasList.some(a => apiLower.includes(a))) return true;
    if (apiSlug === canonical && aliasList.some(a => slugLower.includes(a))) return true;
  }

  return false;
}

/**
 * ISO 8601 UTC without milliseconds for The Odds API
 */
function toOddsApiIsoString(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function getOddsApiTimeRange(): { commenceTimeFrom: string; commenceTimeTo: string } {
  const now = new Date();
  const endDate = new Date(now.getTime() + MATCH_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return {
    commenceTimeFrom: toOddsApiIsoString(now),
    commenceTimeTo: toOddsApiIsoString(endDate),
  };
}

interface OddsApiEvent {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers?: OddsApiBookmaker[];
}

interface OddsApiBookmaker {
  key: string;
  title: string;
  last_update: string;
  markets: OddsApiMarket[];
}

interface OddsApiMarket {
  key: string;
  last_update: string;
  outcomes: OddsApiOutcome[];
}

interface OddsApiOutcome {
  name: string;
  description?: string;
  price: number;
  point?: number;
}

interface SyncResult {
  inserted: number;
  skipped: number;
  errors: string[];
  skipLogs: SkipLog[];
  requests_remaining: number | null;
  cached: boolean;
  fetched_at: string;
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
      JSON.stringify({
        error: "ODDS_API_KEY secret is not configured.",
        code: "MISSING_ODDS_API_KEY",
        cached: false,
        inserted: 0,
        skipped: 0,
        errors: [],
        skipLogs: [],
        requests_remaining: null,
        fetched_at: new Date().toISOString(),
      }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  let force = false;
  try {
    if (req.method === "POST" && req.headers.get("content-type")?.includes("application/json")) {
      const body = await req.json();
      force = body?.force === true;
    }
  } catch { /* no body */ }

  const result: SyncResult = {
    inserted: 0,
    skipped: 0,
    errors: [],
    skipLogs: [],
    requests_remaining: null,
    cached: false,
    fetched_at: new Date().toISOString(),
  };

  try {
    // ── 1. Cache check ───────────────────────────────────────────────────────
    const { data: cacheRow } = await supabase
      .from("odds_cache")
      .select("fetched_at, inserted_count, skipped_count, requests_remaining")
      .eq("sport", SPORT)
      .maybeSingle();

    if (!force && cacheRow?.fetched_at) {
      const ageHours = (Date.now() - new Date(cacheRow.fetched_at).getTime()) / 3_600_000;
      if (ageHours < CACHE_TTL_HOURS) {
        console.log(`[odds-sync] Cache hit — last fetch ${ageHours.toFixed(1)}h ago, skipping`);
        return new Response(
          JSON.stringify({
            ...result,
            cached: true,
            fetched_at: cacheRow.fetched_at,
            inserted: cacheRow.inserted_count,
            skipped: cacheRow.skipped_count,
            requests_remaining: cacheRow.requests_remaining,
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // ── 2. API call ──────────────────────────────────────────────────────────
    const { commenceTimeFrom, commenceTimeTo } = getOddsApiTimeRange();
    const now = new Date();

    const eventsUrl = new URL(`https://api.the-odds-api.com/v4/sports/${SPORT}/odds/`);
    eventsUrl.searchParams.set("apiKey", ODDS_API_KEY);
    eventsUrl.searchParams.set("regions", "au");
    eventsUrl.searchParams.set("markets", FEATURED_MARKETS.join(","));
    eventsUrl.searchParams.set("oddsFormat", "decimal");
    eventsUrl.searchParams.set("dateFormat", "iso");
    eventsUrl.searchParams.set("commenceTimeFrom", commenceTimeFrom);
    eventsUrl.searchParams.set("commenceTimeTo", commenceTimeTo);

    console.log(`[odds-sync] API request:`);
    console.log(`  commenceTimeFrom: ${commenceTimeFrom}`);
    console.log(`  commenceTimeTo: ${commenceTimeTo}`);

    const eventsResp = await fetch(eventsUrl.toString());

    const remainingHeader = eventsResp.headers.get("x-requests-remaining");
    if (remainingHeader) result.requests_remaining = parseInt(remainingHeader);
    result.fetched_at = now.toISOString();

    if (!eventsResp.ok) {
      const errText = await eventsResp.text();
      const msg = `API error ${eventsResp.status}: ${errText.slice(0, 500)}`;
      console.error("[odds-sync]", msg);
      return new Response(
        JSON.stringify({ ...result, error: msg, code: "ODDS_API_ERROR" }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const events: OddsApiEvent[] = await eventsResp.json();
    console.log(`[odds-sync] Fetched ${events.length} AFL events`);

    await supabase.from("odds_cache").upsert(
      {
        sport: SPORT,
        raw_response: events as unknown as Record<string, unknown>[],
        fetched_at: result.fetched_at,
        requests_remaining: result.requests_remaining,
        inserted_count: 0,
        skipped_count: 0,
      },
      { onConflict: "sport" },
    );

    if (events.length === 0) {
      return new Response(
        JSON.stringify({ ...result, cached: false }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── 3. Load upcoming matches ──────────────────────────────────────────────
    const todayISO = now.toISOString().split("T")[0];
    const windowEndISO = commenceTimeTo.split("T")[0];

    const { data: upcomingMatches, error: matchesErr } = await supabase
      .from("matches")
      .select("id, match_date, home_team, away_team")
      .gte("match_date", todayISO)
      .lte("match_date", windowEndISO);

    if (matchesErr) throw new Error(`Failed to load matches: ${matchesErr.message}`);

    // Build match lookup with fuzzy matching support
    const matchByDateHomeAway = new Map<string, string>();
    const matchesByDate = new Map<string, Array<{ id: string; home_team: string; away_team: string; home_slug: string; away_slug: string }>>();

    for (const m of (upcomingMatches ?? [])) {
      const dateKey = (m.match_date as string).split("T")[0];
      const h = normaliseTeam(m.home_team ?? "");
      const a = normaliseTeam(m.away_team ?? "");

      // Exact match keys
      matchByDateHomeAway.set(`${dateKey}|${h}|${a}`, m.id);
      matchByDateHomeAway.set(`${dateKey}|${a}|${h}`, m.id);

      // Group by date for fuzzy matching
      if (!matchesByDate.has(dateKey)) matchesByDate.set(dateKey, []);
      matchesByDate.get(dateKey)!.push({
        id: m.id,
        home_team: m.home_team ?? "",
        away_team: m.away_team ?? "",
        home_slug: h,
        away_slug: a,
      });
    }

    console.log(`[odds-sync] ${upcomingMatches?.length ?? 0} DB matches in window`);

    // ── 4. Process events with detailed logging ──────────────────────────────
    const toUpsert: Record<string, unknown>[] = [];
    const syncedAt = result.fetched_at;

    for (const event of events) {
      const eventDate = event.commence_time ? event.commence_time.split("T")[0] : "";
      if (!eventDate || eventDate > windowEndISO) {
        result.skipLogs.push({
          api_home_team: event.home_team,
          api_away_team: event.away_team,
          event_date: eventDate,
          market: "all",
          reason: "OUT_OF_WINDOW",
        });
        result.skipped++;
        continue;
      }

      // Try exact match first
      const hSlug = normaliseTeam(event.home_team);
      const aSlug = normaliseTeam(event.away_team);
      let matchId = matchByDateHomeAway.get(`${eventDate}|${hSlug}|${aSlug}`);

      // Try fuzzy match if no exact match
      if (!matchId) {
        const dayMatches = matchesByDate.get(eventDate) ?? [];
        for (const m of dayMatches) {
          const homeMatch = fuzzyTeamMatch(event.home_team, m.home_slug);
          const awayMatch = fuzzyTeamMatch(event.away_team, m.away_slug);
          // Also try reversed (API might have teams swapped)
          const homeMatchRev = fuzzyTeamMatch(event.home_team, m.away_slug);
          const awayMatchRev = fuzzyTeamMatch(event.away_team, m.home_slug);

          if ((homeMatch && awayMatch) || (homeMatchRev && awayMatchRev)) {
            matchId = m.id;
            console.log(`[odds-sync] Fuzzy match: ${event.home_team} vs ${event.away_team} → ${m.home_team} vs ${m.away_team}`);
            break;
          }
        }
      }

      if (!matchId) {
        result.skipLogs.push({
          api_home_team: event.home_team,
          api_away_team: event.away_team,
          event_date: eventDate,
          market: "all",
          reason: "MATCH_NOT_FOUND",
          details: `normalized: ${hSlug} vs ${aSlug}, available: ${(upcomingMatches ?? []).filter(m => (m.match_date as string)?.split('T')[0] === eventDate).map(m => `${m.home_team} v ${m.away_team}`).join('; ') || 'none'}`,
        });
        result.skipped++;
        continue;
      }

      // Process each bookmaker/market
      for (const bookmaker of event.bookmakers ?? []) {
        for (const market of bookmaker.markets ?? []) {
          if (!FEATURED_MARKETS.includes(market.key)) continue;

          const outcomes = market.outcomes ?? [];

          if (market.key === "h2h") {
            const homeOutcome = outcomes.find(o => fuzzyTeamMatch(o.name, hSlug));
            const awayOutcome = outcomes.find(o => fuzzyTeamMatch(o.name, aSlug));

            if (!homeOutcome || !awayOutcome) {
              result.skipLogs.push({
                api_home_team: event.home_team,
                api_away_team: event.away_team,
                event_date: eventDate,
                market: "h2h",
                bookmaker: bookmaker.title,
                reason: "TEAM_NOT_FOUND_IN_OUTCOMES",
                details: `outcomes: ${outcomes.map(o => o.name).join(', ')}`,
              });
              result.skipped++;
              continue;
            }

            if (homeOutcome.price <= 1.01 || awayOutcome.price <= 1.01) {
              result.skipLogs.push({
                api_home_team: event.home_team,
                api_away_team: event.away_team,
                event_date: eventDate,
                market: "h2h",
                bookmaker: bookmaker.title,
                reason: "INVALID_ODDS",
                details: `home=${homeOutcome.price}, away=${awayOutcome.price}`,
              });
              result.skipped++;
              continue;
            }

            toUpsert.push({
              match_id: matchId,
              bookmaker: bookmaker.title,
              market: "h2h",
              home_odds: homeOutcome.price,
              away_odds: awayOutcome.price,
              source: "api",
              updated_at: syncedAt,
            });
          }
          else if (market.key === "spreads") {
            const homeOutcome = outcomes.find(o => fuzzyTeamMatch(o.name, hSlug));
            const awayOutcome = outcomes.find(o => fuzzyTeamMatch(o.name, aSlug));

            if (!homeOutcome || !awayOutcome) {
              result.skipLogs.push({
                api_home_team: event.home_team,
                api_away_team: event.away_team,
                event_date: eventDate,
                market: "spreads",
                bookmaker: bookmaker.title,
                reason: "TEAM_NOT_FOUND_IN_OUTCOMES",
                details: `outcomes: ${outcomes.map(o => o.name).join(', ')}`,
              });
              result.skipped++;
              continue;
            }

            if (homeOutcome.price <= 1.01 || awayOutcome.price <= 1.01) {
              result.skipLogs.push({
                api_home_team: event.home_team,
                api_away_team: event.away_team,
                event_date: eventDate,
                market: "spreads",
                bookmaker: bookmaker.title,
                reason: "INVALID_ODDS",
                details: `home=${homeOutcome.price}, away=${awayOutcome.price}`,
              });
              result.skipped++;
              continue;
            }

            if (homeOutcome.point == null || awayOutcome.point == null) {
              result.skipLogs.push({
                api_home_team: event.home_team,
                api_away_team: event.away_team,
                event_date: eventDate,
                market: "spreads",
                bookmaker: bookmaker.title,
                reason: "MISSING_SPREAD_POINTS",
                details: `home_point=${homeOutcome.point}, away_point=${awayOutcome.point}`,
              });
              result.skipped++;
              continue;
            }

            toUpsert.push({
              match_id: matchId,
              bookmaker: bookmaker.title,
              market: "spreads",
              home_odds: homeOutcome.price,
              away_odds: awayOutcome.price,
              home_point: homeOutcome.point,
              away_point: awayOutcome.point,
              source: "api",
              updated_at: syncedAt,
            });
          }
          else if (market.key === "totals") {
            const overOutcome = outcomes.find(o => o.name.toLowerCase() === "over");
            const underOutcome = outcomes.find(o => o.name.toLowerCase() === "under");

            if (!overOutcome || !underOutcome) {
              result.skipLogs.push({
                api_home_team: event.home_team,
                api_away_team: event.away_team,
                event_date: eventDate,
                market: "totals",
                bookmaker: bookmaker.title,
                reason: "TOTALS_NOT_FOUND",
                details: `outcomes: ${outcomes.map(o => o.name).join(', ')}`,
              });
              result.skipped++;
              continue;
            }

            if (overOutcome.price <= 1.01 || underOutcome.price <= 1.01) {
              result.skipLogs.push({
                api_home_team: event.home_team,
                api_away_team: event.away_team,
                event_date: eventDate,
                market: "totals",
                bookmaker: bookmaker.title,
                reason: "INVALID_ODDS",
                details: `over=${overOutcome.price}, under=${underOutcome.price}`,
              });
              result.skipped++;
              continue;
            }

            if (overOutcome.point == null) {
              result.skipLogs.push({
                api_home_team: event.home_team,
                api_away_team: event.away_team,
                event_date: eventDate,
                market: "totals",
                bookmaker: bookmaker.title,
                reason: "MISSING_TOTAL_POINT",
                details: `point=${overOutcome.point}`,
              });
              result.skipped++;
              continue;
            }

            toUpsert.push({
              match_id: matchId,
              bookmaker: bookmaker.title,
              market: "totals",
              total_point: overOutcome.point,
              over_odds: overOutcome.price,
              under_odds: underOutcome.price,
              source: "api",
              updated_at: syncedAt,
            });
          }
        }
      }
    }

    // ── 5. Batch upsert ──────────────────────────────────────────────────────
    const BATCH = 500;
    for (let i = 0; i < toUpsert.length; i += BATCH) {
      const batch = toUpsert.slice(i, i + BATCH);
      const { error: upsertErr } = await supabase
        .from("match_odds")
        .upsert(batch, { onConflict: "match_id,bookmaker,market" });
      if (upsertErr) {
        result.errors.push(`Upsert batch error: ${upsertErr.message}`);
      } else {
        result.inserted += batch.length;
      }
    }

    // ── 6. Update cache ─────────────────────────────────────────────────────
    await supabase.from("odds_cache").upsert(
      {
        sport: SPORT,
        fetched_at: result.fetched_at,
        processed_at: new Date().toISOString(),
        inserted_count: result.inserted,
        skipped_count: result.skipped,
        requests_remaining: result.requests_remaining,
      },
      { onConflict: "sport" },
    );

    // Log skip summary
    if (result.skipLogs.length > 0) {
      console.log(`[odds-sync] Skip summary (${result.skipLogs.length} entries):`);
      const byReason = new Map<string, number>();
      for (const log of result.skipLogs) {
        byReason.set(log.reason, (byReason.get(log.reason) ?? 0) + 1);
      }
      for (const [reason, count] of byReason) {
        console.log(`  ${reason}: ${count}`);
      }
    }

    console.log(`[odds-sync] Complete — inserted=${result.inserted} skipped=${result.skipped} api_remaining=${result.requests_remaining}`);

    return new Response(JSON.stringify({ ...result, cached: false }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[odds-sync] Fatal:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err), code: "SYNC_FAILED", ...result }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
