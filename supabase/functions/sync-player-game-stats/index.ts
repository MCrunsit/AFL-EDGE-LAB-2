import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

/**
 * sync-player-game-stats Edge Function
 *
 * Fetches player game stats from the Kali AFL Stats API and upserts into
 * the player_game_stats table.
 *
 * Key fixes:
 * - Resolves player_id BEFORE writing to player_game_stats
 * - Uses UPSERT not INSERT to handle duplicates
 * - Writes unresolved players to raw_kali_player_game_stats staging table
 * - Never fails the whole batch due to one unresolved player
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const KALI_BASE = "https://kaliaflstats.com/api/afl/v1";

// Comprehensive team normalization: any variation → canonical name
const TEAM_CANONICAL: Record<string, string> = {
  // Kali slugs
  "adelaide": "Adelaide",
  "brisbane": "Brisbane",
  "carlton": "Carlton",
  "collingwood": "Collingwood",
  "essendon": "Essendon",
  "fremantle": "Fremantle",
  "geelong": "Geelong",
  "gold-coast": "Gold Coast",
  "gws": "GWS",
  "hawthorn": "Hawthorn",
  "melbourne": "Melbourne",
  "north-melbourne": "North Melbourne",
  "port-adelaide": "Port Adelaide",
  "richmond": "Richmond",
  "st-kilda": "St Kilda",
  "sydney": "Sydney",
  "west-coast": "West Coast",
  "western-bulldogs": "Western Bulldogs",
  // Full names from DB
  "adelaide crows": "Adelaide",
  "brisbane lions": "Brisbane",
  "carlton blues": "Carlton",
  "collingwood magpies": "Collingwood",
  "essendon bombers": "Essendon",
  "fremantle dockers": "Fremantle",
  "geelong cats": "Geelong",
  "gold coast suns": "Gold Coast",
  "greater western sydney giants": "GWS",
  "gws giants": "GWS",
  "hawthorn hawks": "Hawthorn",
  "melbourne demons": "Melbourne",
  "north melbourne kangaroos": "North Melbourne",
  "port adelaide power": "Port Adelaide",
  "richmond tigers": "Richmond",
  "st kilda saints": "St Kilda",
  "sydney swans": "Sydney",
  "west coast eagles": "West Coast",
  "western bulldogs": "Western Bulldogs",
};

// Canonical → Kali slug (for API calls)
const CANONICAL_TO_KALI: Record<string, string> = {
  "Adelaide": "adelaide",
  "Brisbane": "brisbane",
  "Carlton": "carlton",
  "Collingwood": "collingwood",
  "Essendon": "essendon",
  "Fremantle": "fremantle",
  "Geelong": "geelong",
  "Gold Coast": "gold-coast",
  "GWS": "gws",
  "Hawthorn": "hawthorn",
  "Melbourne": "melbourne",
  "North Melbourne": "north-melbourne",
  "Port Adelaide": "port-adelaide",
  "Richmond": "richmond",
  "St Kilda": "st-kilda",
  "Sydney": "sydney",
  "West Coast": "west-coast",
  "Western Bulldogs": "western-bulldogs",
};

function normalizeTeam(team: string): string {
  if (!team) return "";
  const key = team.toLowerCase().trim().replace(/\s+/g, "-");
  if (TEAM_CANONICAL[key]) return TEAM_CANONICAL[key];
  const key2 = team.toLowerCase().trim();
  if (TEAM_CANONICAL[key2]) return TEAM_CANONICAL[key2];
  return team.trim();
}

function toKaliSlug(team: string): string {
  const canonical = normalizeTeam(team);
  return CANONICAL_TO_KALI[canonical] ?? team.toLowerCase().replace(/\s+/g, "-");
}

function normalizePlayerName(name: string): string {
  return (name ?? "").toLowerCase().trim().replace(/\s+/g, " ");
}

interface KaliMatch {
  id: number;
  round: number;
  year: number;
  homeTeam: string;
  homeShortName: string;
  awayTeam: string;
  awayShortName: string;
  homeScore: number;
  awayScore: number;
  venue: string;
  date: string;
  crowd: number;
}

interface KaliPlayerStat {
  matchId: number;
  playerId: number;
  playerName: string;
  teamId: string;
  teamName: string;
  round: number;
  year: number;
  kicks: number;
  handballs: number;
  disposals: number;
  marks: number;
  goals: number;
  behinds: number;
  tackles: number;
  hitouts: number;
  goalAssists: number;
  inside50s: number;
  clearances: number;
  clangers: number;
  rebound50s: number;
  freesFor: number;
  freesAgainst: number;
  aflFantasyPts: number;
  supercoachPts: number;
}

interface FailedMatch {
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

interface SyncResult {
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

function defaultResult(action: string): SyncResult {
  return {
    success: false,
    action,
    kali_connected: false,
    kali_status: "unknown",
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

async function kaliFetch(path: string, apiKey: string): Promise<any> {
  const url = `${KALI_BASE}${path}`;
  const resp = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Accept": "application/json",
    },
  });

  if (resp.status === 401) throw new Error("Kali auth failed — invalid API key");
  if (resp.status === 429) throw new Error("Kali rate limit exceeded — daily quota reached");

  const remaining = resp.headers.get("x-ratelimit-remaining");

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Kali API error ${resp.status}: ${body.slice(0, 200)}`);
  }

  return {
    data: await resp.json(),
    rateLimitRemaining: remaining ? parseInt(remaining, 10) : null,
  };
}

/**
 * Resolve player_id by matching player name and team
 */
function resolvePlayer(
  playerName: string,
  teamName: string,
  playersByNormName: Map<string, any>,
  playersByLastAndTeam: Map<string, any>,
  playersByFirstLastAndTeam: Map<string, any>,
): string | null {
  const normName = normalizePlayerName(playerName);
  const normTeam = normalizeTeam(teamName);

  // Strategy 1: Exact match on normalized name
  const exact = playersByNormName.get(normName);
  if (exact) return exact.id;

  // Strategy 2: name + team match
  const nameTeamKey = `${normName}|${normTeam}`;
  const nameTeamMatch = playersByNormName.get(nameTeamKey);
  if (nameTeamMatch) return nameTeamMatch.id;

  // Strategy 3: Last name + team
  const parts = playerName.split(" ");
  if (parts.length >= 2) {
    const lastName = parts[parts.length - 1].toLowerCase();
    const lastTeamKey = `${lastName}|${normTeam}`;
    const lastTeamMatch = playersByLastAndTeam.get(lastTeamKey);
    if (lastTeamMatch) return lastTeamMatch.id;
  }

  // Strategy 4: First initial + last name + team
  if (parts.length >= 2) {
    const firstInitial = parts[0][0]?.toLowerCase();
    const lastName = parts[parts.length - 1].toLowerCase();
    if (firstInitial) {
      const firstLastKey = `${firstInitial}. ${lastName}|${normTeam}`;
      const firstLastMatch = playersByFirstLastAndTeam.get(firstLastKey);
      if (firstLastMatch) return firstLastMatch.id;
    }
  }

  return null;
}

/** Fully paginates a Supabase select past the 1000-row default cap. Used
 * anywhere a query result could exceed 1000 rows (players, player_game_stats)
 * — a single unpaginated select silently truncates and was the root cause of
 * multiple resolution/coverage bugs in this function. */
async function fetchAllRows(
  supabase: ReturnType<typeof createClient>,
  table: string,
  select: string,
  applyFilters?: (q: any) => any,
  pageSize = 1000,
): Promise<any[]> {
  const rows: any[] = [];
  let offset = 0;
  for (;;) {
    let q = supabase.from(table).select(select).order("id").range(offset, offset + pageSize - 1);
    if (applyFilters) q = applyFilters(q);
    const { data: page, error } = await q;
    if (error) throw new Error(`fetchAllRows(${table}) failed: ${error.message}`);
    if (!page || page.length === 0) break;
    rows.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const apiKey = Deno.env.get("KALI_API_KEY");
  if (!apiKey) {
    const result = defaultResult("error");
    result.kali_status = "missing_key";
    result.errors.push("KALI_API_KEY not configured in edge function secrets");
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: any = {};
  try {
    if (req.method === "POST") {
      body = await req.json();
    }
  } catch {
    // GET request or empty body
  }

  const action = body.action ?? "dry_run";
  const priority = body.priority ?? "all";
  const season = body.season ?? new Date().getFullYear();

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const result = defaultResult(action);

  try {
    // ─── ACTION: test ───
    if (action === "test") {
      result.debug_log.push("Testing Kali connection with /teams endpoint...");
      try {
        const { data, rateLimitRemaining } = await kaliFetch("/teams?limit=1", apiKey);
        result.kali_connected = true;
        result.kali_status = "connected";
        result.requests_used = 1;
        result.requests_remaining = rateLimitRemaining;
        result.success = true;
        result.debug_log.push(`Connected — ${data?.data?.length ?? 0} teams returned`);
      } catch (e: any) {
        result.kali_connected = false;
        result.kali_status = e.message.includes("auth") ? "auth_failed"
          : e.message.includes("rate") ? "rate_limited"
          : "api_error";
        result.errors.push(e.message);
      }
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── ACTION: inspect_kali_raw (read-only, no DB writes) ───
    // Returns the verbatim Kali API response for one real completed match so
    // the actual field names can be confirmed instead of assumed from the
    // KaliPlayerStat interface (which may not list every field Kali returns).
    if (action === "inspect_kali_raw") {
      const inspectSeason = body.season ?? new Date().getFullYear();
      const inspectRound = body.round ?? null;
      try {
        const matchesPath = inspectRound != null
          ? `/matches?year=${inspectSeason}&round=${inspectRound}`
          : `/matches?year=${inspectSeason}`;
        const { data: matchesData, rateLimitRemaining: r1 } = await kaliFetch(matchesPath, apiKey);
        const kaliMatches: KaliMatch[] = matchesData?.data ?? [];
        const rawMatchesSample = matchesData;

        if (kaliMatches.length === 0) {
          return new Response(JSON.stringify({
            success: false,
            action,
            error: "No Kali matches returned for that season/round",
            matches_endpoint: matchesPath,
            raw_matches_response: rawMatchesSample,
          }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }

        const targetMatch = kaliMatches[0];
        const statsPath = `/player-stats?match_id=${targetMatch.id}&limit=5`;
        const { data: statsData, rateLimitRemaining: r2 } = await kaliFetch(statsPath, apiKey);
        const rawPlayerStats = statsData?.data ?? [];

        return new Response(JSON.stringify({
          success: true,
          action,
          matches_endpoint: matchesPath,
          stats_endpoint: statsPath,
          requests_remaining: r2 ?? r1,
          inspected_match: targetMatch,
          match_response_keys: kaliMatches.length > 0 ? Object.keys(kaliMatches[0]) : [],
          player_stat_sample_count: rawPlayerStats.length,
          player_stat_response_keys: rawPlayerStats.length > 0 ? Object.keys(rawPlayerStats[0]) : [],
          raw_player_stat_samples: rawPlayerStats.slice(0, 3),
        }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } catch (e: any) {
        return new Response(JSON.stringify({ success: false, action, error: e.message }), {
          status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // ─── ACTION: sync_advanced_stats (contested/uncontested possessions) ───
    // Attaches CP/UP to EXISTING player_game_stats rows only — never inserts a
    // new player-game row. Matches Kali's /player-stats-advanced records to
    // already-resolved standard rows by normalized player name + team within
    // the same match, per the confirmed join strategy (advanced records don't
    // carry a reliable shared player ID with /player-stats). Field names are
    // read defensively across the naming conventions Kali's other endpoints
    // use (camelCase primary, snake_case fallback) rather than assumed.
    if (action === "sync_advanced_stats") {
      const advSeason = body.season ?? new Date().getFullYear();
      const advRound = body.round ?? null; // optional: run one round at a time to stay inside function time limits
      const force = body.force === true; // re-check rows that already have CP/UP

      const advResult = {
        success: false,
        action,
        season: advSeason,
        round: advRound,
        matches_considered: 0,
        matches_matched_to_kali: 0,
        matches_advanced_fetched: 0,
        rows_updated: 0,
        rows_already_complete_skipped: 0,
        rows_unresolved: 0,
        requests_used: 0,
        requests_remaining: null as number | null,
        unresolved_samples: [] as any[],
        failed_matches: [] as any[],
        errors: [] as string[],
        debug_log: [] as string[],
      };

      // ─── Load target matches (completed, this season, optionally one round) ───
      const today = new Date().toISOString().split("T")[0];
      let matchQuery = supabase
        .from("matches")
        .select("id, round, season, home_team, away_team, venue, match_date, api_match_id")
        .eq("season", advSeason)
        .neq("round", "0")
        .lt("match_date", today);
      if (advRound != null) matchQuery = matchQuery.eq("round", String(advRound));
      const { data: targetMatches } = await matchQuery;

      if (!targetMatches || targetMatches.length === 0) {
        advResult.errors.push("No completed matches found for that season/round");
        return new Response(JSON.stringify(advResult), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      advResult.matches_considered = targetMatches.length;
      const targetMatchIds = targetMatches.map((m: any) => m.id);

      // ─── Fully paginate existing player_game_stats for these matches ───
      const existingRows: any[] = [];
      {
        const pageSize = 1000;
        let offset = 0;
        for (;;) {
          const { data: page, error } = await supabase
            .from("player_game_stats")
            .select("id, player_id, player_name, match_id, match_date, season, round, team, opponent, venue, disposals, marks, tackles, goals, hitouts, source, contested_possessions, uncontested_possessions, effective_disposals, disposal_efficiency_pct, intercepts, time_on_ground_pct, metres_gained")
            .in("match_id", targetMatchIds)
            .order("id")
            .range(offset, offset + pageSize - 1);
          if (error) { advResult.errors.push(`Failed to load existing stats: ${error.message}`); break; }
          if (!page || page.length === 0) break;
          existingRows.push(...page);
          if (page.length < pageSize) break;
          offset += pageSize;
        }
      }
      advResult.debug_log.push(`Loaded ${existingRows.length} existing player_game_stats rows across ${targetMatchIds.length} matches`);

      // ─── Players table, for rows where player_name is missing on the stored row ───
      const allPlayers = await fetchAllRows(supabase, "players", "id, name, team");
      const playerById = new Map<string, any>();
      for (const p of allPlayers ?? []) playerById.set(p.id, p);

      // Index existing rows by match_id + normalized(name) for advanced-record matching
      const existingIndex = new Map<string, any>(); // key: matchId|normName
      for (const row of existingRows) {
        const name = row.player_name || playerById.get(row.player_id)?.name || "";
        const key = `${row.match_id}|${normalizePlayerName(name)}`;
        existingIndex.set(key, row);
      }

      // ─── Match target matches to Kali matches (by round, same as standard sync) ───
      const roundsNeeded = new Set<number>();
      for (const m of targetMatches) {
        const r = parseInt(m.round ?? "0", 10);
        if (r > 0) roundsNeeded.add(r);
      }
      const kaliMatchesByRound = new Map<number, KaliMatch[]>();
      for (const roundNum of roundsNeeded) {
        try {
          const { data: kaliData, rateLimitRemaining } = await kaliFetch(`/matches?year=${advSeason}&round=${roundNum}`, apiKey);
          advResult.requests_used++;
          advResult.requests_remaining = rateLimitRemaining;
          kaliMatchesByRound.set(roundNum, kaliData?.data ?? []);
        } catch (e: any) {
          advResult.errors.push(`Failed to fetch Kali matches R${roundNum}: ${e.message}`);
        }
      }

      const updatesBatch: any[] = [];

      for (const dbMatch of targetMatches) {
        const roundNum = parseInt(dbMatch.round ?? "0", 10);
        const kaliMatches = kaliMatchesByRound.get(roundNum) ?? [];
        const homeKali = toKaliSlug(dbMatch.home_team ?? "");
        const awayKali = toKaliSlug(dbMatch.away_team ?? "");
        const kaliMatch = kaliMatches.find(km => {
          const kmHome = (km.homeTeam ?? "").toLowerCase().replace(/\s+/g, "-");
          const kmAway = (km.awayTeam ?? "").toLowerCase().replace(/\s+/g, "-");
          return (kmHome === homeKali && kmAway === awayKali) || (kmHome === awayKali && kmAway === homeKali);
        }) ?? kaliMatches.find(km => km.date?.split("T")[0] === dbMatch.match_date?.split("T")[0]);

        if (!kaliMatch) {
          advResult.failed_matches.push({ round: dbMatch.round, match: `${dbMatch.home_team} vs ${dbMatch.away_team}`, reason: "NO_KALI_MATCH_FOUND" });
          continue;
        }
        advResult.matches_matched_to_kali++;

        try {
          const { data: advData, rateLimitRemaining } = await kaliFetch(`/player-stats-advanced?match_id=${kaliMatch.id}&limit=200`, apiKey);
          advResult.requests_used++;
          advResult.requests_remaining = rateLimitRemaining;
          const advRows: any[] = advData?.data ?? [];
          if (advRows.length === 0) {
            advResult.failed_matches.push({ round: dbMatch.round, match: `${dbMatch.home_team} vs ${dbMatch.away_team}`, reason: "KALI_ADVANCED_EMPTY" });
            continue;
          }
          advResult.matches_advanced_fetched++;

          for (const ar of advRows) {
            const rawName = ar.playerName ?? ar.player_name ?? "";
            const normName = normalizePlayerName(rawName);
            const key = `${dbMatch.id}|${normName}`;
            const existing = existingIndex.get(key);

            // Read fields defensively — camelCase (Kali's usual convention) first, snake_case fallback.
            // NOTE: total_possessions is a Postgres GENERATED column (confirmed live) — never write to
            // it directly, Postgres derives it from contested_possessions + uncontested_possessions.
            const cp = ar.contestedPossessions ?? ar.contested_possessions ?? null;
            const up = ar.uncontestedPossessions ?? ar.uncontested_possessions ?? null;
            const effDisp = ar.effectiveDisposals ?? ar.effective_disposals ?? null;
            const dispEff = ar.disposalEfficiency ?? ar.disposal_efficiency ?? ar.disposalEfficiencyPct ?? ar.disposal_efficiency_pct ?? null;
            const intercepts = ar.intercepts ?? null;
            const tog = ar.timeOnGroundPercentage ?? ar.timeOnGroundPct ?? ar.time_on_ground_percentage ?? ar.time_on_ground_pct ?? null;
            const metresGained = ar.metresGained ?? ar.metres_gained ?? null;

            if (!existing) {
              advResult.rows_unresolved++;
              if (advResult.unresolved_samples.length < 30) {
                advResult.unresolved_samples.push({ raw_name: rawName, normalized_name: normName, match: `${dbMatch.home_team} vs ${dbMatch.away_team}`, round: dbMatch.round, reason: "NO_MATCHING_STANDARD_ROW" });
              }
              continue;
            }
            const existingComplete = existing.contested_possessions != null && existing.uncontested_possessions != null
              && existing.effective_disposals != null && existing.disposal_efficiency_pct != null
              && existing.intercepts != null && existing.time_on_ground_pct != null;
            if (!force && existingComplete) {
              advResult.rows_already_complete_skipped++;
              continue;
            }
            if (cp == null && up == null && effDisp == null && dispEff == null && intercepts == null && tog == null && metresGained == null) {
              // Kali genuinely has no advanced data for this player-game — leave null, don't fabricate 0
              continue;
            }

            const pick = (newVal: any, oldVal: any) => (newVal != null ? newVal : (oldVal ?? null));

            updatesBatch.push({
              id: existing.id,
              player_id: existing.player_id,
              player_name: existing.player_name,
              match_id: existing.match_id,
              match_date: existing.match_date,
              season: existing.season,
              round: existing.round,
              team: existing.team,
              opponent: existing.opponent,
              venue: existing.venue,
              disposals: existing.disposals,
              marks: existing.marks,
              tackles: existing.tackles,
              goals: existing.goals,
              hitouts: existing.hitouts,
              source: existing.source,
              contested_possessions: pick(cp, existing.contested_possessions),
              uncontested_possessions: pick(up, existing.uncontested_possessions),
              effective_disposals: pick(effDisp, existing.effective_disposals),
              disposal_efficiency_pct: pick(dispEff, existing.disposal_efficiency_pct),
              intercepts: pick(intercepts, existing.intercepts),
              time_on_ground_pct: pick(tog, existing.time_on_ground_pct),
              metres_gained: pick(metresGained, existing.metres_gained),
            });
          }
        } catch (e: any) {
          advResult.failed_matches.push({ round: dbMatch.round, match: `${dbMatch.home_team} vs ${dbMatch.away_team}`, reason: `FETCH_FAILED: ${e.message}` });
        }
      }

      // ─── Batch upsert updates (id is stable so this only ever touches existing rows) ───
      const batchSize = 200;
      for (let i = 0; i < updatesBatch.length; i += batchSize) {
        const batch = updatesBatch.slice(i, i + batchSize);
        const { error } = await supabase.from("player_game_stats").upsert(batch, { onConflict: "player_id,match_id" });
        if (error) {
          advResult.errors.push(`Batch update failed at offset ${i}: ${error.message}`);
        } else {
          advResult.rows_updated += batch.length;
        }
      }

      advResult.success = advResult.errors.length === 0;
      advResult.debug_log.push(
        `${advResult.rows_updated} rows updated, ${advResult.rows_already_complete_skipped} already complete, ${advResult.rows_unresolved} unresolved, ${advResult.failed_matches.length} matches failed`,
      );

      return new Response(JSON.stringify(advResult), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ─── ACTION: advanced_stats_coverage (read-only diagnostic) ───
    if (action === "advanced_stats_coverage") {
      const covSeason = body.season ?? new Date().getFullYear();
      const { data: covMatches } = await supabase.from("matches").select("id").eq("season", covSeason);
      const covMatchIds = new Set((covMatches ?? []).map((m: any) => m.id));

      const rows: any[] = [];
      {
        const pageSize = 1000;
        let offset = 0;
        for (;;) {
          const { data: page, error } = await supabase
            .from("player_game_stats")
            .select("match_id, team, contested_possessions, uncontested_possessions, match_date")
            .eq("season", covSeason)
            .order("id")
            .range(offset, offset + pageSize - 1);
          if (error || !page || page.length === 0) break;
          rows.push(...page);
          if (page.length < pageSize) break;
          offset += pageSize;
        }
      }

      const withCp = rows.filter(r => r.contested_possessions != null).length;
      const withUp = rows.filter(r => r.uncontested_possessions != null).length;
      const withBoth = rows.filter(r => r.contested_possessions != null && r.uncontested_possessions != null).length;
      const missingEither = rows.length - withBoth;
      const matches = new Set(rows.map(r => r.match_id).filter(Boolean));
      const teams = new Set(rows.map(r => r.team).filter(Boolean));
      const dates = rows.map(r => r.match_date).filter(Boolean).sort();

      return new Response(JSON.stringify({
        success: true,
        action,
        season: covSeason,
        total_player_game_rows: rows.length,
        rows_with_contested_possessions: withCp,
        rows_with_uncontested_possessions: withUp,
        rows_with_both: withBoth,
        rows_missing_either: missingEither,
        matches_represented: matches.size,
        teams_represented: teams.size,
        earliest_match_date: dates[0] ?? null,
        latest_match_date: dates[dates.length - 1] ?? null,
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ─── Load all players for matching ───
    const ourPlayers = await fetchAllRows(supabase, "players", "id, name, team");

    // Build multiple lookup maps
    const playersByNormName = new Map<string, any>();
    const playersByLastAndTeam = new Map<string, any>();
    const playersByFirstLastAndTeam = new Map<string, any>();

    for (const p of ourPlayers ?? []) {
      const normName = normalizePlayerName(p.name);
      const normTeam = normalizeTeam(p.team ?? "");

      // By normalized name
      playersByNormName.set(normName, p);

      // By name + team
      playersByNormName.set(`${normName}|${normTeam}`, p);

      // By last name + team
      const parts = p.name.split(" ");
      if (parts.length >= 2) {
        const lastName = parts[parts.length - 1].toLowerCase();
        playersByLastAndTeam.set(`${lastName}|${normTeam}`, p);

        // By first initial + last name + team
        const firstInitial = parts[0][0]?.toLowerCase();
        if (firstInitial) {
          playersByFirstLastAndTeam.set(`${firstInitial}. ${lastName}|${normTeam}`, p);
        }
      }
    }

    result.debug_log.push(`Loaded ${ourPlayers?.length ?? 0} players for matching`);

    // ─── Get latest stat round before sync ───
    const { data: beforeStats } = await supabase
      .from("player_game_stats")
      .select("match_id")
      .order("match_date", { ascending: false })
      .limit(1);
    let latestRoundBefore: string | null = null;
    if (beforeStats && beforeStats.length > 0 && beforeStats[0].match_id) {
      const { data: matchInfo } = await supabase
        .from("matches")
        .select("round")
        .eq("id", beforeStats[0].match_id)
        .maybeSingle();
      if (matchInfo?.round) latestRoundBefore = matchInfo.round;
    }
    result.latest_stat_round_before = latestRoundBefore;

    // ─── Get all completed matches from our DB ───
    const today = new Date().toISOString().split("T")[0];
    const { data: completedMatches } = await supabase
      .from("matches")
      .select("id, round, season, home_team, away_team, venue, match_date, api_match_id")
      .lt("match_date", today)
      .eq("season", season)
      .order("match_date", { ascending: false });

    if (!completedMatches || completedMatches.length === 0) {
      result.errors.push("No completed matches found in our DB");
      result.success = false;
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── Check completeness for each completed match ───
    const completedMatchIds = new Set(completedMatches.map((m: any) => m.id));

    const existingStats = await fetchAllRows(
      supabase, "player_game_stats", "match_id, team",
      (q) => q.in("match_id", [...completedMatchIds]),
    );

    const statsByMatch = new Map<string, number>();
    for (const s of existingStats) {
      if (!s.match_id) continue;
      statsByMatch.set(s.match_id, (statsByMatch.get(s.match_id) ?? 0) + 1);
    }

    const matchesToSync: any[] = [];
    for (const m of completedMatches) {
      const count = statsByMatch.get(m.id) ?? 0;
      // A match needs stats if it has fewer than 35 player rows
      if (count < 35) {
        matchesToSync.push(m);
      }
    }

    result.debug_log.push(`Found ${matchesToSync.length} matches needing stats`);

    // ─── ACTION: dry_run ───
    if (action === "dry_run") {
      result.success = true;
      result.kali_connected = true;
      result.kali_status = "not_tested";
      result.missing_matches_remaining = matchesToSync.length;
      result.rows_to_backfill = matchesToSync.length * 40;
      result.matches_processed = matchesToSync.map((m: any) =>
        `R${m.round} ${m.home_team} vs ${m.away_team}`
      );
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── ACTION: sync or sync_all_missing ───
    if (action === "sync" || action === "sync_all_missing") {
      if (matchesToSync.length === 0) {
        result.success = true;
        result.kali_connected = true;
        result.kali_status = "connected";
        result.missing_matches_remaining = 0;
        result.rows_to_backfill = 0;
        result.debug_log.push("All matches have stats — nothing to sync");
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ─── Fetch all Kali matches for the rounds we need ───
      const roundsNeeded = new Set<number>();
      for (const m of matchesToSync) {
        const r = parseInt(m.round ?? "0", 10);
        if (r > 0) roundsNeeded.add(r);
      }

      const allKaliMatches = new Map<number, KaliMatch[]>();
      let requestsUsed = 0;

      for (const roundNum of roundsNeeded) {
        try {
          const { data: kaliData, rateLimitRemaining } = await kaliFetch(
            `/matches?year=${season}&round=${roundNum}`,
            apiKey,
          );
          requestsUsed++;
          result.requests_remaining = rateLimitRemaining;

          if (kaliData?.data) {
            for (const km of kaliData.data) {
              if (!allKaliMatches.has(roundNum)) {
                allKaliMatches.set(roundNum, []);
              }
              allKaliMatches.get(roundNum)!.push(km);
            }
          }
          result.debug_log.push(`Fetched Kali R${roundNum}: ${kaliData?.data?.length ?? 0} matches`);
        } catch (e: any) {
          result.errors.push(`Failed to fetch Kali matches for R${roundNum}: ${e.message}`);
        }
      }

      result.matches_fetched = requestsUsed;

      if (result.matches_fetched === 0) {
        result.success = false;
        result.errors.push("KALI_BACKFILL_FAILED — NO MATCHES FETCHED");
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // ─── Match our DB matches to Kali matches ───
      const matchedMatches: Array<{ dbMatch: any; kaliMatchId: number }> = [];

      for (const dbMatch of matchesToSync) {
        const roundNum = parseInt(dbMatch.round ?? "0", 10);
        const kaliMatches = allKaliMatches.get(roundNum) ?? [];

        const homeKali = toKaliSlug(dbMatch.home_team ?? "");
        const awayKali = toKaliSlug(dbMatch.away_team ?? "");

        // Match by Kali slug
        let kaliMatch = kaliMatches.find(km => {
          const kmHome = (km.homeTeam ?? "").toLowerCase().replace(/\s+/g, "-");
          const kmAway = (km.awayTeam ?? "").toLowerCase().replace(/\s+/g, "-");
          return (kmHome === homeKali && kmAway === awayKali) ||
                 (kmHome === awayKali && kmAway === homeKali);
        });

        // Fallback: match by date
        if (!kaliMatch) {
          const dbDate = dbMatch.match_date?.split("T")[0];
          if (dbDate) {
            kaliMatch = kaliMatches.find(km => km.date?.split("T")[0] === dbDate);
          }
        }

        if (kaliMatch) {
          matchedMatches.push({ dbMatch, kaliMatchId: kaliMatch.id });
        } else {
          result.failed_matches.push({
            season: dbMatch.season ?? season,
            round: dbMatch.round,
            match_date: dbMatch.match_date?.split("T")[0] ?? null,
            home_team: dbMatch.home_team,
            away_team: dbMatch.away_team,
            venue: dbMatch.venue,
            local_match_id: dbMatch.id,
            api_match_id: dbMatch.api_match_id ?? null,
            failure_reason: "KALI_MATCH_NOT_FOUND",
          });
        }
      }

      result.debug_log.push(`Matched ${matchedMatches.length}/${matchesToSync.length} matches to Kali`);

      // ─── Fetch player stats for each matched Kali match ───
      const resolvedRows: any[] = [];
      const unresolvedRows: any[] = [];

      for (const { dbMatch, kaliMatchId } of matchedMatches) {
        try {
          const { data: statsData, rateLimitRemaining } = await kaliFetch(
            `/player-stats?match_id=${kaliMatchId}&limit=200`,
            apiKey,
          );
          requestsUsed++;
          result.requests_remaining = rateLimitRemaining;

          const playerStats: KaliPlayerStat[] = statsData?.data ?? [];

          if (playerStats.length === 0) {
            result.failed_matches.push({
              season: dbMatch.season ?? season,
              round: dbMatch.round,
              match_date: dbMatch.match_date?.split("T")[0] ?? null,
              home_team: dbMatch.home_team,
              away_team: dbMatch.away_team,
              venue: dbMatch.venue,
              local_match_id: dbMatch.id,
              api_match_id: dbMatch.api_match_id ?? null,
              failure_reason: "KALI_STATS_EMPTY",
            });
            continue;
          }

          result.player_rows_fetched += playerStats.length;

          const homeCanonical = normalizeTeam(dbMatch.home_team ?? "");
          const awayCanonical = normalizeTeam(dbMatch.away_team ?? "");

          for (const ps of playerStats) {
            const teamCanonical = normalizeTeam(ps.teamId ?? "");
            const isHome = teamCanonical === homeCanonical;
            const isAway = teamCanonical === awayCanonical;

            const team = isHome ? dbMatch.home_team : isAway ? dbMatch.away_team : teamCanonical;
            const opponent = isHome ? dbMatch.away_team : isAway ? dbMatch.home_team : null;

            const matchDate = dbMatch.match_date?.split("T")[0] ?? null;
            const roundNum = dbMatch.round ?? String(ps.round);

            // Resolve player_id
            const playerId = resolvePlayer(
              ps.playerName ?? "",
              team ?? "",
              playersByNormName,
              playersByLastAndTeam,
              playersByFirstLastAndTeam,
            );

            const row = {
              player_id: playerId,
              player_name: ps.playerName,
              match_id: dbMatch.id,
              match_date: matchDate,
              season: dbMatch.season ?? season,
              round: roundNum,
              team: team,
              opponent: opponent,
              venue: dbMatch.venue ?? null,
              disposals: ps.disposals ?? 0,
              marks: ps.marks ?? 0,
              tackles: ps.tackles ?? 0,
              goals: ps.goals ?? 0,
              hitouts: ps.hitouts ?? 0,
              source: "kali_footywire_std",
            };

            if (playerId) {
              resolvedRows.push(row);
            } else {
              unresolvedRows.push({
                ...row,
                raw_player_name: ps.playerName,
                normalized_player_name: normalizePlayerName(ps.playerName ?? ""),
                normalized_team: teamCanonical,
                failure_reason: "PLAYER_NOT_RESOLVED",
              });
            }
          }

          result.matches_processed.push(`R${dbMatch.round} ${dbMatch.home_team} vs ${dbMatch.away_team} (${playerStats.length} players)`);
        } catch (e: any) {
          result.failed_matches.push({
            season: dbMatch.season ?? season,
            round: dbMatch.round,
            match_date: dbMatch.match_date?.split("T")[0] ?? null,
            home_team: dbMatch.home_team,
            away_team: dbMatch.away_team,
            venue: dbMatch.venue,
            local_match_id: dbMatch.id,
            api_match_id: dbMatch.api_match_id ?? null,
            failure_reason: "ENDPOINT_FAILED",
          });
          result.errors.push(`Failed to fetch stats for Kali match ${kaliMatchId}: ${e.message}`);
        }
      }

      result.requests_used = requestsUsed;
      result.debug_log.push(`Resolved ${resolvedRows.length} players, ${unresolvedRows.length} unresolved`);

      // ─── Deduplicate resolved rows by player_id + match_id ───
      const resolvedByUniqueKey = new Map<string, any>();
      for (const row of resolvedRows) {
        if (!row.player_id || !row.match_id) continue;
        const key = `${row.player_id}|${row.match_id}`;
        if (!resolvedByUniqueKey.has(key)) {
          resolvedByUniqueKey.set(key, row);
        }
      }
      const dedupedResolvedRows = [...resolvedByUniqueKey.values()];
      result.duplicates_removed = resolvedRows.length - dedupedResolvedRows.length;

      // ─── Upsert resolved rows to player_game_stats ───
      if (dedupedResolvedRows.length > 0) {
        // Prepare rows for upsert - only include rows with both player_id and match_id
        const rowsForUpsert = dedupedResolvedRows.filter(r => r.player_id && r.match_id);

        result.debug_log.push(`Attempting to upsert ${rowsForUpsert.length} resolved rows`);

        if (rowsForUpsert.length > 0) {
          // Use upsert with onConflict
          const { error: upsertError } = await supabase
            .from("player_game_stats")
            .upsert(rowsForUpsert, {
              onConflict: "player_id,match_id",
            });

          if (upsertError) {
            result.errors.push(`Upsert failed: ${upsertError.message}`);
            result.failed_rows = rowsForUpsert.length;
            result.debug_log.push(`Upsert error details: ${JSON.stringify(upsertError)}`);
          } else {
            result.rows_inserted = rowsForUpsert.length;
            result.debug_log.push(`Upserted ${rowsForUpsert.length} resolved rows`);
          }
        }
      }

      // ─── Insert unresolved rows to raw_kali_player_game_stats ───
      if (unresolvedRows.length > 0) {
        const rowsForRaw = unresolvedRows.map(r => ({
          season: r.season,
          round: r.round,
          match_id: r.match_id,
          match_date: r.match_date,
          raw_player_name: r.raw_player_name,
          normalized_player_name: r.normalized_player_name,
          team: r.team,
          normalized_team: r.normalized_team,
          opponent: r.opponent,
          venue: r.venue,
          disposals: r.disposals,
          marks: r.marks,
          tackles: r.tackles,
          goals: r.goals,
          hitouts: r.hitouts,
          source: r.source,
          failure_reason: r.failure_reason,
        }));

        const { error: rawError } = await supabase
          .from("raw_kali_player_game_stats")
          .upsert(rowsForRaw, {
            onConflict: "match_id,normalized_player_name,team",
          });

        if (rawError) {
          result.errors.push(`Raw staging insert failed: ${rawError.message}`);
        } else {
          result.rows_unresolved = unresolvedRows.length;
          result.debug_log.push(`Stored ${unresolvedRows.length} unresolved rows to staging`);
        }
      }

      // ─── Re-check missing matches after sync ───
      const existingAfter = await fetchAllRows(
        supabase, "player_game_stats", "match_id",
        (q) => q.in("match_id", [...completedMatchIds]),
      );

      const statsAfterByMatch = new Map<string, number>();
      for (const s of existingAfter) {
        if (!s.match_id) continue;
        statsAfterByMatch.set(s.match_id, (statsAfterByMatch.get(s.match_id) ?? 0) + 1);
      }

      let stillMissing = 0;
      for (const m of completedMatches) {
        const count = statsAfterByMatch.get(m.id) ?? 0;
        if (count < 35) stillMissing++;
      }

      result.missing_matches_remaining = stillMissing;
      result.rows_to_backfill = stillMissing * 40;

      // ─── Get latest stat round after sync ───
      const { data: afterStats } = await supabase
        .from("player_game_stats")
        .select("match_id")
        .order("match_date", { ascending: false })
        .limit(1);
      if (afterStats && afterStats.length > 0 && afterStats[0].match_id) {
        const { data: matchInfo } = await supabase
          .from("matches")
          .select("round")
          .eq("id", afterStats[0].match_id)
          .maybeSingle();
        if (matchInfo?.round) result.latest_stat_round_after = matchInfo.round;
      }

      // ─── Determine success ───
      const didWork = result.rows_inserted > 0;
      const allComplete = result.missing_matches_remaining === 0;

      if (allComplete) {
        result.success = true;
        result.kali_connected = true;
        result.kali_status = "connected";
        result.debug_log.push("BACKFILL COMPLETE — All matches have stats");
      } else if (didWork) {
        result.success = true;
        result.kali_connected = true;
        result.kali_status = "connected";
        result.debug_log.push(`Progress: ${result.rows_inserted} rows upserted, ${result.missing_matches_remaining} matches still need stats`);
      } else {
        result.success = false;
        result.errors.push("KALI_BACKFILL_FAILED — No rows imported");
      }
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    result.errors.push(e.message ?? String(e));
    result.success = false;
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
