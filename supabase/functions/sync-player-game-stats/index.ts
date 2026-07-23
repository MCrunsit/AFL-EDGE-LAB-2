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

    // ─── ACTION: inspect_kali_raw ───
    if (action === "inspect_kali_raw") {
      // Read-only. Zero database writes. Calls /player-stats-advanced and
      // /player-stats with the correct match_id param and confirms field names.
      try {
        // Select the most recent genuinely completed 2026 match (date <= today)
        const { data: recentMatches, error: matchErr } = await supabase
          .from("matches")
          .select("id, api_match_id, round, home_team, away_team, match_date, home_score, away_score")
          .eq("season", 2026)
          .lte("match_date", "2026-07-23")
          .not("home_score", "is", null)
          .not("away_score", "is", null)
          .order("match_date", { ascending: false })
          .limit(20);

        if (matchErr) {
          result.errors.push(`DB error fetching matches: ${matchErr.message}`);
          return new Response(JSON.stringify(result), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // Pick first match that has an api_match_id and valid teams
        const match = (recentMatches ?? []).find(
          (m: any) => m.api_match_id && m.home_team && m.away_team
        );

        if (!match) {
          result.errors.push("No completed 2026 match on or before 2026-07-23 found with api_match_id, home_team, away_team");
          return new Response(JSON.stringify(result), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const localMatchId: string = match.id;
        let kaliMatchId: string = match.api_match_id;
        let kaliMatchResolutionMethod = "stored_api_match_id";

        // If api_match_id looks suspicious (e.g. it's a UUID not a Kali integer),
        // attempt to resolve via the Kali /matches endpoint
        if (!/^\d+$/.test(kaliMatchId)) {
          result.debug_log.push(`api_match_id "${kaliMatchId}" is not a Kali integer — attempting resolution via /matches`);
          const kaliSeason = 2026;
          const homeSlug = toKaliSlug(match.home_team);
          const awaySlug = toKaliSlug(match.away_team);
          const matchListUrl = `/matches?season=${kaliSeason}&limit=200&offset=0`;
          try {
            const matchListResp = await fetch(`${KALI_BASE}${matchListUrl}`, {
              headers: { "Authorization": `Bearer ${apiKey}`, "Accept": "application/json" },
            });
            result.requests_used += 1;
            const rem = matchListResp.headers.get("x-ratelimit-remaining");
            if (rem) result.requests_remaining = parseInt(rem, 10);
            if (matchListResp.ok) {
              const matchListData = await matchListResp.json();
              const kaliMatches: KaliMatch[] = Array.isArray(matchListData)
                ? matchListData
                : (matchListData?.data ?? []);
              // Match by team slugs and approximate date
              const matchDate = match.match_date?.slice(0, 10) ?? "";
              const resolved = kaliMatches.find((km: KaliMatch) => {
                const kHome = (km.homeShortName ?? km.homeTeam ?? "").toLowerCase().replace(/\s+/g, "-");
                const kAway = (km.awayShortName ?? km.awayTeam ?? "").toLowerCase().replace(/\s+/g, "-");
                const kDate = (km.date ?? "").slice(0, 10);
                return (
                  (kHome === homeSlug || kAway === awaySlug) &&
                  Math.abs(new Date(kDate).getTime() - new Date(matchDate).getTime()) < 86400000 * 3
                );
              });
              if (resolved) {
                kaliMatchId = String(resolved.id);
                kaliMatchResolutionMethod = "resolved_via_kali_matches_endpoint";
                result.debug_log.push(`Resolved Kali match ID: ${kaliMatchId} (${resolved.homeTeam} vs ${resolved.awayTeam})`);
              } else {
                result.errors.push(`Could not resolve Kali integer match ID for ${match.home_team} vs ${match.away_team} on ${matchDate}`);
                return new Response(JSON.stringify(result), {
                  status: 200,
                  headers: { ...corsHeaders, "Content-Type": "application/json" },
                });
              }
            } else {
              const body = await matchListResp.text();
              result.errors.push(`Kali /matches returned ${matchListResp.status}: ${body.slice(0, 200)}`);
              return new Response(JSON.stringify(result), {
                status: 200,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            }
          } catch (fetchErr: any) {
            result.errors.push(`Fetch error resolving Kali match ID: ${fetchErr.message}`);
            return new Response(JSON.stringify(result), {
              status: 200,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        }

        const expectedTeams = [
          normalizeTeam(match.home_team).toLowerCase(),
          normalizeTeam(match.away_team).toLowerCase(),
        ];

        // ── Call /player-stats-advanced with correct match_id param ──
        const advancedEndpointPath = `/player-stats-advanced?match_id=${kaliMatchId}&limit=200&offset=0`;
        const advancedEndpointUrl = `${KALI_BASE}${advancedEndpointPath}`;
        let advancedHttpStatus = 0;
        let advancedRawData: any = null;
        let advancedErrorBody = "";

        try {
          const advResp = await fetch(advancedEndpointUrl, {
            headers: { "Authorization": `Bearer ${apiKey}`, "Accept": "application/json" },
          });
          advancedHttpStatus = advResp.status;
          result.requests_used += 1;
          const rem = advResp.headers.get("x-ratelimit-remaining");
          if (rem) result.requests_remaining = parseInt(rem, 10);
          if (advResp.ok) {
            advancedRawData = await advResp.json();
          } else {
            advancedErrorBody = (await advResp.text()).slice(0, 500);
          }
        } catch (fetchErr: any) {
          advancedErrorBody = `Fetch threw: ${fetchErr.message}`;
        }

        // ── Call /player-stats with correct match_id param ──
        const standardEndpointPath = `/player-stats?match_id=${kaliMatchId}&limit=200&offset=0`;
        const standardEndpointUrl = `${KALI_BASE}${standardEndpointPath}`;
        let standardHttpStatus = 0;
        let standardRawData: any = null;
        let standardErrorBody = "";

        try {
          const stdResp = await fetch(standardEndpointUrl, {
            headers: { "Authorization": `Bearer ${apiKey}`, "Accept": "application/json" },
          });
          standardHttpStatus = stdResp.status;
          result.requests_used += 1;
          const rem = stdResp.headers.get("x-ratelimit-remaining");
          if (rem) result.requests_remaining = parseInt(rem, 10);
          if (stdResp.ok) {
            standardRawData = await stdResp.json();
          } else {
            standardErrorBody = (await stdResp.text()).slice(0, 500);
          }
        } catch (fetchErr: any) {
          standardErrorBody = `Fetch threw: ${fetchErr.message}`;
        }

        // ── Parse advanced players ──
        const advancedPlayers: any[] = advancedRawData
          ? (Array.isArray(advancedRawData) ? advancedRawData : (advancedRawData?.data ?? []))
          : [];

        // ── Parse standard players ──
        const standardPlayers: any[] = standardRawData
          ? (Array.isArray(standardRawData) ? standardRawData : (standardRawData?.data ?? []))
          : [];

        // ── Validate team membership ──
        const advancedTeamsFound = [...new Set(advancedPlayers.map((p: any) =>
          normalizeTeam(p.teamId ?? p.teamName ?? "").toLowerCase()
        ))];
        const unexpectedTeams = advancedTeamsFound.filter(t => t && !expectedTeams.includes(t));

        // ── Field names ──
        const firstThreeAdvanced = advancedPlayers.slice(0, 3);
        const advancedFieldNames: string[] = firstThreeAdvanced[0] ? Object.keys(firstThreeAdvanced[0]) : [];
        const standardFieldNames: string[] = standardPlayers[0] ? Object.keys(standardPlayers[0]) : [];

        // ── Field presence check (no inference, no calculation) ──
        const advancedFieldsOfInterest = [
          "contestedPossessions",
          "uncontestedPossessions",
          "effectiveDisposals",
          "disposalEfficiencyPct",
          "metresGained",
          "intercepts",
          "timeOnGroundPct",
          // snake_case variants
          "contested_possessions",
          "uncontested_possessions",
          "effective_disposals",
          "disposal_efficiency_pct",
          "metres_gained",
          "time_on_ground_pct",
        ];
        const advancedFieldPresence: Record<string, boolean> = {};
        for (const f of advancedFieldsOfInterest) {
          advancedFieldPresence[f] = advancedFieldNames.includes(f);
        }

        const standardFieldsOfInterest = ["disposals", "kicks", "handballs"];
        const standardFieldPresence: Record<string, boolean> = {};
        for (const f of standardFieldsOfInterest) {
          standardFieldPresence[f] = standardFieldNames.includes(f);
        }

        // ── Join advanced + standard by playerId or normalised name+team ──
        const joinedSample = firstThreeAdvanced.map((adv: any) => {
          const advId = adv.playerId ?? adv.player_id;
          const advName = normalizePlayerName(adv.playerName ?? adv.player_name ?? "");
          const advTeam = normalizeTeam(adv.teamId ?? adv.teamName ?? "").toLowerCase();
          const std = standardPlayers.find((s: any) => {
            if (advId && (s.playerId ?? s.player_id)) return String(s.playerId ?? s.player_id) === String(advId);
            return normalizePlayerName(s.playerName ?? s.player_name ?? "") === advName &&
              normalizeTeam(s.teamId ?? s.teamName ?? "").toLowerCase() === advTeam;
          }) ?? null;
          return {
            playerName: adv.playerName ?? adv.player_name,
            teamId: adv.teamId ?? adv.teamName,
            advanced_record: adv,
            standard_disposals: std?.disposals ?? null,
            join_method: advId && std ? "playerId" : std ? "name+team" : "no_match",
          };
        });

        // ── Derived total if CP + UP exist ──
        const cpKey = advancedFieldNames.find(f => f === "contestedPossessions" || f === "contested_possessions");
        const upKey = advancedFieldNames.find(f => f === "uncontestedPossessions" || f === "uncontested_possessions");
        const derivedTotalNote = cpKey && upKey
          ? `Derived total_possessions = ${cpKey} + ${upKey} (app-calculated, not a Kali field)`
          : "Cannot derive total_possessions — CP and/or UP not confirmed in live response";

        result.success = true;
        result.kali_connected = true;
        result.kali_status = "connected";

        const inspectPayload = {
          selected_match: {
            local_match_id: localMatchId,
            kali_match_id: kaliMatchId,
            kali_match_id_resolution: kaliMatchResolutionMethod,
            label: `${match.home_team} vs ${match.away_team} — ${match.round} (${match.match_date})`,
            home_score: match.home_score,
            away_score: match.away_score,
            expected_teams: expectedTeams,
          },
          advanced_endpoint: {
            url_called: advancedEndpointUrl,
            http_status: advancedHttpStatus,
            error_body: advancedErrorBody || null,
            top_level_response_keys: advancedRawData ? Object.keys(advancedRawData) : [],
            total_player_records_returned: advancedPlayers.length,
            teams_found_in_response: advancedTeamsFound,
            unexpected_teams: unexpectedTeams,
            all_field_names: advancedFieldNames,
            field_presence: advancedFieldPresence,
            first_three_records: firstThreeAdvanced,
          },
          standard_endpoint: {
            url_called: standardEndpointUrl,
            http_status: standardHttpStatus,
            error_body: standardErrorBody || null,
            total_player_records_returned: standardPlayers.length,
            all_field_names: standardFieldNames,
            field_presence: standardFieldPresence,
          },
          row_count_match: advancedPlayers.length === standardPlayers.length,
          advanced_row_count: advancedPlayers.length,
          standard_row_count: standardPlayers.length,
          joined_sample: joinedSample,
          derived_total_possessions_note: derivedTotalNote,
        };

        return new Response(JSON.stringify({ ...result, inspect: inspectPayload }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (e: any) {
        result.errors.push(`inspect_kali_raw error: ${e.message}`);
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // ─── Load all players for matching ───
    const { data: ourPlayers } = await supabase
      .from("players")
      .select("id, name, team");

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

    const { data: existingStats } = await supabase
      .from("player_game_stats")
      .select("match_id, team")
      .in("match_id", [...completedMatchIds]);

    const statsByMatch = new Map<string, number>();
    if (existingStats) {
      for (const s of existingStats) {
        if (!s.match_id) continue;
        statsByMatch.set(s.match_id, (statsByMatch.get(s.match_id) ?? 0) + 1);
      }
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

          // Fetch advanced stats in parallel — never block on failure
          let advancedByName = new Map<string, any>();
          try {
            const { data: advData, rateLimitRemaining: advRem } = await kaliFetch(
              `/player-stats-advanced?match_id=${kaliMatchId}&limit=200&offset=0`,
              apiKey,
            );
            requestsUsed++;
            result.requests_remaining = advRem;
            const advRows: any[] = advData?.data ?? [];
            for (const adv of advRows) {
              const key = normalizePlayerName(adv.playerName ?? "") + "|" + normalizeTeam(adv.teamId ?? "").toLowerCase();
              advancedByName.set(key, adv);
            }
          } catch (_advErr) {
            // Advanced stats are best-effort; standard sync continues regardless
          }

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
              // ── Advanced stats (from /player-stats-advanced) ──
              ...(() => {
                const advKey = normalizePlayerName(ps.playerName ?? "") + "|" + teamCanonical.toLowerCase();
                const adv = advancedByName.get(advKey);
                if (!adv) return {};
                return {
                  contested_possessions: adv.contestedPossessions ?? null,
                  uncontested_possessions: adv.uncontestedPossessions ?? null,
                  effective_disposals: adv.effectiveDisposals ?? null,
                  disposal_efficiency_pct: adv.disposalEfficiencyPct ?? null,
                  metres_gained: adv.metresGained ?? null,
                  intercepts: adv.intercepts ?? null,
                  time_on_ground_pct: adv.timeOnGroundPct ?? null,
                };
              })(),
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
      const { data: existingAfter } = await supabase
        .from("player_game_stats")
        .select("match_id")
        .in("match_id", [...completedMatchIds]);

      const statsAfterByMatch = new Map<string, number>();
      if (existingAfter) {
        for (const s of existingAfter) {
          if (!s.match_id) continue;
          statsAfterByMatch.set(s.match_id, (statsAfterByMatch.get(s.match_id) ?? 0) + 1);
        }
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
