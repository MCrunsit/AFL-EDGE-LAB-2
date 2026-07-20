import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

/**
 * backfill-missing-player-stats Edge Function
 *
 * Targeted backfill using Kali /players?name=X and /player-stats?player_id=Y
 *
 * Flow per missing player:
 *   1. Search Kali /players?name=<full_name>
 *   2. Match by exact normalized full name (never surname, never partial)
 *   3. Confirm team from match context or Kali player data
 *   4. Create or reuse players row
 *   5. Fetch /player-stats?player_id=<kali_id>&year=<season> for 2024/2025/2026
 *   6. Upsert into player_game_stats
 *   7. Relink bookmaker_odds.player_id
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const KALI_BASE = "https://kaliaflstats.com/api/afl/v1";

const TEAM_CANONICAL: Record<string, string> = {
  "adelaide": "Adelaide", "adelaide crows": "Adelaide",
  "brisbane": "Brisbane", "brisbane lions": "Brisbane",
  "carlton": "Carlton", "carlton blues": "Carlton",
  "collingwood": "Collingwood", "collingwood magpies": "Collingwood",
  "essendon": "Essendon", "essendon bombers": "Essendon",
  "fremantle": "Fremantle", "fremantle dockers": "Fremantle",
  "geelong": "Geelong", "geelong cats": "Geelong",
  "gold-coast": "Gold Coast", "gold coast": "Gold Coast", "gold coast suns": "Gold Coast",
  "gws": "GWS", "gws giants": "GWS", "greater western sydney": "GWS", "greater western sydney giants": "GWS",
  "hawthorn": "Hawthorn", "hawthorn hawks": "Hawthorn",
  "melbourne": "Melbourne", "melbourne demons": "Melbourne",
  "north-melbourne": "North Melbourne", "north melbourne": "North Melbourne", "north melbourne kangaroos": "North Melbourne",
  "port-adelaide": "Port Adelaide", "port adelaide": "Port Adelaide", "port adelaide power": "Port Adelaide",
  "richmond": "Richmond", "richmond tigers": "Richmond",
  "st-kilda": "St Kilda", "st kilda": "St Kilda", "st kilda saints": "St Kilda",
  "sydney": "Sydney", "sydney swans": "Sydney",
  "west-coast": "West Coast", "west coast": "West Coast", "west coast eagles": "West Coast",
  "western-bulldogs": "Western Bulldogs", "western bulldogs": "Western Bulldogs",
};

const CANONICAL_TO_KALI: Record<string, string> = {
  "Adelaide": "adelaide", "Brisbane": "brisbane", "Carlton": "carlton",
  "Collingwood": "collingwood", "Essendon": "essendon", "Fremantle": "fremantle",
  "Geelong": "geelong", "Gold Coast": "gold-coast", "GWS": "gws",
  "Hawthorn": "hawthorn", "Melbourne": "melbourne", "North Melbourne": "north-melbourne",
  "Port Adelaide": "port-adelaide", "Richmond": "richmond", "St Kilda": "st-kilda",
  "Sydney": "sydney", "West Coast": "west-coast", "Western Bulldogs": "western-bulldogs",
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

function normalizeFullName(name: string): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface MissingPlayerInput {
  bookmaker_player_name: string;
  current_player_id: string | null;
  match_id: string;
  home_team: string | null;
  away_team: string | null;
  season: number;
  round: string | null;
  player_team: string | null;
  odds_rows: number;
}

interface StepLog {
  step: string;
  message: string;
}

interface PlayerDetail {
  playerName: string;
  team: string;
  action: "CREATED" | "UPDATED" | "RELINKED" | "NOT_FOUND" | "ERROR" | "NO_STATS_IN_KALI" | "TEAM_NOT_CONFIRMED";
  statsInserted: number;
  oddsRelinked: number;
  message: string;
  steps?: StepLog[];
}

interface BackfillResult {
  success: boolean;
  action: string;
  missingPlayersChecked: number;
  playersFoundInKali: number;
  playersCreated: number;
  existingPlayersUpdated: number;
  playerGameStatsRowsInserted: number;
  bookmakerOddsRowsRelinked: number;
  playersStillMissing: number;
  errors: string[];
  details: PlayerDetail[];
  requestsUsed: number;
  rateLimitRemaining: number | null;
  // Test mode fields
  envCheck?: {
    KALI_API_KEY: boolean;
    SUPABASE_URL: boolean;
    SUPABASE_SERVICE_ROLE_KEY: boolean;
    kaliBaseUrl: string;
  testEndpoint?: string;
    testHttpStatus?: number;
    testResponseSample?: string;
    rateLimitRemaining?: number | null;
    error?: string;
  };
}

function defaultResult(action: string = "backfill"): BackfillResult {
  return {
    success: false,
    action,
    missingPlayersChecked: 0,
    playersFoundInKali: 0,
    playersCreated: 0,
    existingPlayersUpdated: 0,
    playerGameStatsRowsInserted: 0,
    bookmakerOddsRowsRelinked: 0,
    playersStillMissing: 0,
    errors: [],
    details: [],
    requestsUsed: 0,
    rateLimitRemaining: null,
  };
}

async function kaliFetch(path: string, apiKey: string): Promise<{ data: any; rateLimitRemaining: number | null; status: number }> {
  const url = `${KALI_BASE}${path}`;
  const resp = await fetch(url, {
    headers: { "Authorization": `Bearer ${apiKey}`, "Accept": "application/json" },
  });

  const remaining = resp.headers.get("x-ratelimit-remaining");

  if (resp.status === 401) throw new Error(`Kali auth failed (401) — invalid API key. URL: ${url}`);
  if (resp.status === 429) throw new Error(`Kali rate limit exceeded (429). URL: ${url}`);

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Kali API error ${resp.status}: ${body.slice(0, 300)}. URL: ${url}`);
  }

  return { data: await resp.json(), rateLimitRemaining: remaining ? parseInt(remaining, 10) : null, status: resp.status };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  // ── Environment check ──
  const kaliApiKey = Deno.env.get("KALI_API_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  // ── Parse body ──
  let body: any = {};
  try {
    if (req.method === "POST") body = await req.json();
  } catch { /* GET or empty body */ }

  const action: string = body.action ?? "backfill";

  // ── ACTION: test_connection ──
  if (action === "test_connection") {
    const envCheck: BackfillResult["envCheck"] = {
      KALI_API_KEY: !!kaliApiKey,
      SUPABASE_URL: !!supabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: !!supabaseServiceKey,
      kaliBaseUrl: KALI_BASE,
    };

    if (!kaliApiKey) {
      envCheck.error = "Missing secret: KALI_API_KEY";
      return new Response(JSON.stringify({
        success: false,
        action,
        envCheck,
        errors: ["Missing secret: KALI_API_KEY"],
      } as BackfillResult), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    try {
      const { data, rateLimitRemaining, status } = await kaliFetch("/teams?limit=1", kaliApiKey);
      envCheck.testEndpoint = "/teams?limit=1";
      envCheck.testHttpStatus = status;
      envCheck.rateLimitRemaining = rateLimitRemaining;
      envCheck.testResponseSample = JSON.stringify(data?.data?.[0] ?? data).slice(0, 200);
      return new Response(JSON.stringify({
        success: true,
        action,
        envCheck,
        requestsUsed: 1,
        rateLimitRemaining,
      } as BackfillResult), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (e: any) {
      envCheck.error = e.message;
      return new Response(JSON.stringify({
        success: false,
        action,
        envCheck,
        errors: [e.message],
      } as BackfillResult), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  // ── ACTION: backfill or test_one ──
  const missingPlayers: MissingPlayerInput[] = body.missingPlayers ?? [];
  const seasons: number[] = body.seasons ?? [2024, 2025, 2026];
  const batchSize: number = Math.min(body.batchSize ?? 5, 10);

  const result = defaultResult(action);
  result.missingPlayersChecked = missingPlayers.length;

  // Check secrets
  if (!kaliApiKey) {
    result.errors.push("Missing secret: KALI_API_KEY — cannot call Kali API");
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!supabaseUrl || !supabaseServiceKey) {
    const missing = !supabaseUrl ? "SUPABASE_URL" : "SUPABASE_SERVICE_ROLE_KEY";
    result.errors.push(`Missing secret: ${missing}`);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (missingPlayers.length === 0) {
    result.success = true;
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    // Load all existing players for lookup
    const { data: allPlayers, error: playersError } = await supabase
      .from("players")
      .select("id, name, team");

    if (playersError) {
      result.errors.push(`Failed to load players: ${playersError.message}`);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const playersByNormName = new Map<string, any[]>();
    for (const p of allPlayers ?? []) {
      const norm = normalizeFullName(p.name);
      if (!playersByNormName.has(norm)) playersByNormName.set(norm, []);
      playersByNormName.get(norm)!.push(p);
    }

    // Process players (respect batch size)
    const playersToProcess = missingPlayers.slice(0, batchSize);

    // Pre-load all local matches ONCE for all seasons (for match_date enrichment)
    const localMatchesBySeasonRoundTeam = new Map<string, any[]>();
    for (const season of seasons) {
      const { data: seasonMatches } = await supabase
        .from("matches")
        .select("id, season, round, home_team, away_team, venue, match_date, api_match_id")
        .eq("season", season);
      for (const m of seasonMatches ?? []) {
        const key = `${season}|${m.round}`;
        if (!localMatchesBySeasonRoundTeam.has(key)) localMatchesBySeasonRoundTeam.set(key, []);
        localMatchesBySeasonRoundTeam.get(key)!.push(m);
      }
    }

    // Pre-check: skip players that already have 5+ stats rows
    const playerIdsToCheck = playersToProcess
      .map(mp => mp.current_player_id)
      .filter((id): id is string => !!id);
    const existingStatsCounts = new Map<string, number>();
    if (playerIdsToCheck.length > 0) {
      const { data: statsCounts } = await supabase
        .from("player_game_stats")
        .select("player_id")
        .in("player_id", playerIdsToCheck);
      for (const s of statsCounts ?? []) {
        existingStatsCounts.set(s.player_id, (existingStatsCounts.get(s.player_id) ?? 0) + 1);
      }
    }

    // ── Process players with concurrency (3 at a time for stability) ──
    const PLAYER_CONCURRENCY = 3;

    async function processPlayer(mp: typeof playersToProcess[0]): Promise<void> {
      const steps: StepLog[] = [];
      const normName = normalizeFullName(mp.bookmaker_player_name);

      steps.push({ step: "input", message: `player="${mp.bookmaker_player_name}", match=${mp.match_id?.slice(0, 8)}…, round=${mp.round}` });
      steps.push({ step: "match_teams", message: `home="${mp.home_team}", away="${mp.away_team}"` });
      steps.push({ step: "current_player_id", message: `id=${mp.current_player_id?.slice(0, 8) ?? "null"}…` });

      if (!normName) {
        result.playersStillMissing++;
        result.details.push({
          playerName: mp.bookmaker_player_name, team: "", action: "ERROR",
          statsInserted: 0, oddsRelinked: 0,
          message: "Empty player name", steps,
        });
        return;
      }

      // ── Skip if already has 15+ stats rows ──
      if (mp.current_player_id && (existingStatsCounts.get(mp.current_player_id) ?? 0) >= 15) {
        result.existingPlayersUpdated++;
        result.details.push({
          playerName: mp.bookmaker_player_name, team: "", action: "UPDATED",
          statsInserted: 0, oddsRelinked: 0,
          message: `Skipped — already has ${existingStatsCounts.get(mp.current_player_id)} stats rows`,
          steps: [{ step: "skip", message: "already has 15+ stats rows" }],
        });
        return;
      }

      // ── Step 1: Check if current player_id exists in players table ──
      const candidates = playersByNormName.get(normName) ?? [];
      const currentExists = mp.current_player_id ? candidates.find(c => c.id === mp.current_player_id) : null;
      steps.push({ step: "player_exists", message: `current_player_id in players? ${currentExists ? "yes" : "no"}` });

      // ── Step 2: Infer team ──
      let inferredTeam = "";
      if (mp.player_team) {
        inferredTeam = normalizeTeam(mp.player_team);
      }
      if (!inferredTeam) {
        if (candidates.length === 1) {
          inferredTeam = normalizeTeam(candidates[0].team ?? "");
        } else if (candidates.length > 1) {
          const homeNorm = normalizeTeam(mp.home_team ?? "");
          const awayNorm = normalizeTeam(mp.away_team ?? "");
          const homeMatch = candidates.find(c => normalizeTeam(c.team ?? "") === homeNorm);
          if (homeMatch) inferredTeam = homeNorm;
          else {
            const awayMatch = candidates.find(c => normalizeTeam(c.team ?? "") === awayNorm);
            if (awayMatch) inferredTeam = awayNorm;
          }
        }
      }
      steps.push({ step: "team_inference", message: `inferred="${inferredTeam || "unknown"}"` });

      const homeNorm = normalizeTeam(mp.home_team ?? "");
      const awayNorm = normalizeTeam(mp.away_team ?? "");

      // ── Step 3: Search Kali /players?name=<full_name> ──
      let kaliPlayerId: number | null = null;
      let kaliPlayerName = "";
      let kaliTeamId = "";

      try {
        // Use the full name for the search — Kali supports partial search
        // but we will verify with exact normalized match
        const { data: playersData, rateLimitRemaining } = await kaliFetch(
          `/players?name=${encodeURIComponent(mp.bookmaker_player_name)}&limit=50`,
          kaliApiKey,
        );
        result.requestsUsed++;
        result.rateLimitRemaining = rateLimitRemaining;

        const kaliPlayers = playersData?.data ?? [];
        steps.push({ step: "kali_search", message: `GET /players?name=${encodeURIComponent(mp.bookmaker_player_name)} → ${kaliPlayers.length} results` });

        // Match by EXACT full normalized name only
        for (const kp of kaliPlayers) {
          const kpNorm = normalizeFullName(kp.name ?? "");
          if (kpNorm !== normName) continue;

          // If we have an inferred team, check it matches
          if (inferredTeam) {
            const kpTeamNorm = normalizeTeam(kp.currentTeamId ?? kp.teamId ?? "");
            if (kpTeamNorm && kpTeamNorm !== inferredTeam) {
              // Team mismatch — skip this candidate
              continue;
            }
          }

          kaliPlayerId = kp.id;
          kaliPlayerName = kp.name;
          kaliTeamId = kp.currentTeamId ?? kp.teamId ?? "";
          break;
        }

        if (kaliPlayerId) {
          steps.push({ step: "kali_player_found", message: `id=${kaliPlayerId}, name="${kaliPlayerName}", team="${kaliTeamId}"` });
        } else {
          steps.push({ step: "kali_player_found", message: "no exact full-name match" });
        }
      } catch (e: any) {
        steps.push({ step: "kali_search_error", message: e.message });
        result.errors.push(`Kali /players search failed for ${mp.bookmaker_player_name}: ${e.message}`);
        result.playersStillMissing++;
        result.details.push({
          playerName: mp.bookmaker_player_name, team: inferredTeam || "",
          action: "ERROR", statsInserted: 0, oddsRelinked: 0,
          message: `Kali search error: ${e.message}`, steps,
        });
        return;
      }

      if (!kaliPlayerId) {
        result.playersStillMissing++;
        result.details.push({
          playerName: mp.bookmaker_player_name, team: inferredTeam || "",
          action: "NOT_FOUND", statsInserted: 0, oddsRelinked: 0,
          message: "KALI_PLAYER_NOT_FOUND — exact full name not found in Kali /players search",
          steps,
        });
        return;
      }

      // ── Step 4: Confirm team from Kali data ──
      let confirmedTeam = "";
      if (kaliTeamId) {
        confirmedTeam = normalizeTeam(kaliTeamId);
      }

      // If we couldn't confirm from Kali, try inferred team
      if (!confirmedTeam && inferredTeam) {
        confirmedTeam = inferredTeam;
      }

      // Check if confirmed team matches match home/away
      if (confirmedTeam) {
        const isHome = confirmedTeam === homeNorm;
        const isAway = confirmedTeam === awayNorm;
        if (!isHome && !isAway) {
          steps.push({ step: "team_check", message: `confirmed="${confirmedTeam}" but match teams are "${homeNorm}" / "${awayNorm}"` });
        } else {
          steps.push({ step: "team_check", message: `confirmed="${confirmedTeam}" matches ${isHome ? "home" : "away"} team` });
        }
      }

      if (!confirmedTeam) {
        steps.push({ step: "team_check", message: "TEAM_NOT_CONFIRMED — no team from Kali or inference" });
        result.playersStillMissing++;
        result.details.push({
          playerName: mp.bookmaker_player_name, team: "",
          action: "TEAM_NOT_CONFIRMED", statsInserted: 0, oddsRelinked: 0,
          message: "TEAM_NOT_CONFIRMED — cannot determine which team player belongs to",
          steps,
        });
        return;
      }

      // ── Step 5: Find or create local player row ──
      let correctPlayerId: string | null = null;
      let playerCreated = false;

      // First: try to find existing player by exact normalized full name + normalized team
      const teamMatched = candidates.find(c => normalizeTeam(c.team ?? "") === confirmedTeam);
      if (teamMatched) {
        correctPlayerId = teamMatched.id;
        steps.push({ step: "player_row", message: `reused existing player ${correctPlayerId.slice(0, 8)}… (team match: ${teamMatched.team})` });
      } else if (candidates.length === 1) {
        correctPlayerId = candidates[0].id;
        steps.push({ step: "player_row", message: `reused single candidate ${correctPlayerId.slice(0, 8)}…` });
      } else if (candidates.length > 1) {
        // Multiple candidates with same name — try matching by team using slug too
        const teamSlug = toKaliSlug(confirmedTeam);
        const slugMatch = candidates.find(c => c.team === teamSlug || c.team === confirmedTeam.toLowerCase().replace(/\s+/g, "-"));
        if (slugMatch) {
          correctPlayerId = slugMatch.id;
          steps.push({ step: "player_row", message: `reused existing player ${correctPlayerId.slice(0, 8)}… (slug match: ${slugMatch.team})` });
        }
      }

      // If still not found, try a direct DB query by exact name + team
      if (!correctPlayerId) {
        const teamSlug = toKaliSlug(confirmedTeam);
        const { data: dbPlayer } = await supabase
          .from("players")
          .select("id, name, team")
          .ilike("name", mp.bookmaker_player_name)
          .ilike("team", teamSlug)
          .limit(1);

        if (dbPlayer && dbPlayer.length > 0) {
          correctPlayerId = dbPlayer[0].id;
          steps.push({ step: "player_row", message: `reused existing player via DB query ${correctPlayerId.slice(0, 8)}…` });
        }
      }

      // If still not found, create with upsert + duplicate key fallback
      if (!correctPlayerId) {
        const teamSlug = toKaliSlug(confirmedTeam);
        steps.push({ step: "player_row", message: `attempting upsert: name="${kaliPlayerName || mp.bookmaker_player_name}", team="${teamSlug}"` });

        const { data: upsertedPlayer, error: upsertError } = await supabase
          .from("players")
          .upsert({
            name: kaliPlayerName || mp.bookmaker_player_name,
            team: teamSlug,
            is_active: true,
            games_last_two_seasons: 0,
          }, {
            onConflict: "name,team",
          })
          .select("id, name, team")
          .single();

        if (upsertError) {
          // Fallback: query existing player by name + team
          steps.push({ step: "player_row", message: `upsert failed (${upsertError.message}), querying existing…` });
          const { data: existingPlayer } = await supabase
            .from("players")
            .select("id, name, team")
            .ilike("name", kaliPlayerName || mp.bookmaker_player_name)
            .ilike("team", teamSlug)
            .limit(1);

          if (existingPlayer && existingPlayer.length > 0) {
            correctPlayerId = existingPlayer[0].id;
            steps.push({ step: "player_row", message: `found existing player after upsert fail: ${correctPlayerId.slice(0, 8)}…` });
          } else {
            steps.push({ step: "player_row", message: `player not found after upsert fail` });
            result.errors.push(`Failed to create or find player ${mp.bookmaker_player_name}: ${upsertError.message}`);
            result.playersStillMissing++;
            result.details.push({
              playerName: mp.bookmaker_player_name, team: confirmedTeam,
              action: "ERROR", statsInserted: 0, oddsRelinked: 0,
              message: `Failed to create or find player: ${upsertError.message}`, steps,
            });
            return;
          }
        } else if (upsertedPlayer) {
          correctPlayerId = upsertedPlayer.id;
          // Check if it was a create or update by seeing if it was already in our cache
          const wasExisting = candidates.some(c => c.id === correctPlayerId);
          if (!wasExisting) {
            playerCreated = true;
            result.playersCreated++;
            playersByNormName.set(normName, [...(playersByNormName.get(normName) ?? []), upsertedPlayer]);
            steps.push({ step: "player_row", message: `CREATED new player ${correctPlayerId.slice(0, 8)}…` });
          } else {
            steps.push({ step: "player_row", message: `reused existing player via upsert ${correctPlayerId.slice(0, 8)}…` });
          }
        }
      }

      // ── Step 6: Fetch stats from Kali for each season ──
      const allStatsRows: any[] = [];
      const skippedRows: string[] = [];
      let rawStatSample: any = null;
      let rowsWithDateBeforeEnrich = 0;

      // Local matches already pre-loaded outside the per-player loop — use the shared map
      steps.push({ step: "local_matches_loaded", message: `using pre-loaded matches for seasons ${seasons.join(",")}` });

      // ── Fetch all seasons in PARALLEL ──
      const seasonPromises = seasons.map(async (season) => {
        const seasonRows: any[] = [];
        const seasonSkipped: string[] = [];
        let seasonHadDate = 0;
        try {
          const { data: statsData, rateLimitRemaining } = await kaliFetch(
            `/player-stats?player_id=${kaliPlayerId}&year=${season}&limit=200`,
            kaliApiKey,
          );
          result.requestsUsed++;
          result.rateLimitRemaining = rateLimitRemaining;

          const playerStats = statsData?.data ?? [];
          steps.push({ step: `kali_stats_${season}`, message: `GET /player-stats?player_id=${kaliPlayerId}&year=${season} → ${playerStats.length} rows` });

          // Log raw sample in test_one mode
          if (action === "test_one" && !rawStatSample && playerStats.length > 0) {
            rawStatSample = playerStats[0];
            steps.push({ step: "raw_kali_stat_sample", message: JSON.stringify(rawStatSample).slice(0, 500) });
          }

          for (const ps of playerStats) {
            // Verify exact name match again (safety)
            const psNorm = normalizeFullName(ps.playerName ?? "");
            if (psNorm !== normName) continue;

            // Extract match_date from all possible fields
            const matchDate =
              ps.matchDate?.split("T")[0] ||
              ps.match_date?.split("T")[0] ||
              ps.date?.split("T")[0] ||
              ps.gameDate?.split("T")[0] ||
              ps.game_date?.split("T")[0] ||
              null;

            if (matchDate) seasonHadDate++;

            // Extract Kali match ID
            const kaliMatchId = ps.matchId ?? ps.match_id ?? ps.gameId ?? ps.game_id ?? null;

            // Extract round
            const statRound = String(ps.round ?? "");

            // Extract team
            const psTeamCanonical = normalizeTeam(ps.teamId ?? "");
            const psTeamSlug = toKaliSlug(psTeamCanonical);

            // ── Enrich from local matches ──
            let localMatchId: string | null = null;
            let enrichedDate: string | null = matchDate;
            let enrichedVenue: string | null = ps.venue ?? null;
            let opponent: string = "";

            // Try by api_match_id first
            if (kaliMatchId) {
              const { data: matchByApi } = await supabase
                .from("matches")
                .select("id, match_date, venue, home_team, away_team")
                .eq("api_match_id", String(kaliMatchId))
                .limit(1);
              if (matchByApi && matchByApi.length > 0) {
                const m = matchByApi[0];
                localMatchId = m.id;
                enrichedDate = m.match_date?.split("T")[0] ?? enrichedDate;
                enrichedVenue = m.venue ?? enrichedVenue;
                const homeNorm = normalizeTeam(m.home_team ?? "");
                const awayNorm = normalizeTeam(m.away_team ?? "");
                opponent = psTeamCanonical === homeNorm ? awayNorm : homeNorm;
              }
            }

            // If not found by api_match_id, try by season + round + team
            if (!localMatchId && statRound) {
              const key = `${season}|${statRound}`;
              const roundMatches = localMatchesBySeasonRoundTeam.get(key) ?? [];
              for (const m of roundMatches) {
                const homeNorm = normalizeTeam(m.home_team ?? "");
                const awayNorm = normalizeTeam(m.away_team ?? "");
                if (psTeamCanonical === homeNorm || psTeamCanonical === awayNorm ||
                    psTeamSlug === toKaliSlug(m.home_team ?? "") || psTeamSlug === toKaliSlug(m.away_team ?? "")) {
                  localMatchId = m.id;
                  enrichedDate = m.match_date?.split("T")[0] ?? enrichedDate;
                  enrichedVenue = m.venue ?? enrichedVenue;
                  opponent = psTeamCanonical === homeNorm ? awayNorm : homeNorm;
                  break;
                }
              }
            }

            // ── If still no date, try fetching Kali match by ID ──
            if (!enrichedDate && kaliMatchId) {
              try {
                const { data: kaliMatchData } = await kaliFetch(`/matches/${kaliMatchId}`, kaliApiKey);
                result.requestsUsed++;
                const km = kaliMatchData?.data ?? kaliMatchData;
                if (km?.date) {
                  enrichedDate = km.date.split("T")[0];
                  enrichedVenue = km.venue ?? enrichedVenue;
                  const kmHome = normalizeTeam(km.homeTeam ?? "");
                  const kmAway = normalizeTeam(km.awayTeam ?? "");
                  opponent = psTeamCanonical === kmHome ? kmAway : kmHome;
                }
              } catch {
                // Skip if Kali match fetch fails
              }
            }

            // ── Skip if no match_date ──
            if (!enrichedDate) {
              seasonSkipped.push(`S${season} R${statRound} — MISSING_MATCH_DATE`);
              continue;
            }

            seasonRows.push({
              player_id: correctPlayerId,
              player_name: ps.playerName,
              match_id: localMatchId,
              match_date: enrichedDate,
              season: season,
              round: statRound,
              team: psTeamCanonical,
              opponent: opponent || null,
              venue: enrichedVenue,
              disposals: ps.disposals ?? 0,
              marks: ps.marks ?? 0,
              tackles: ps.tackles ?? 0,
              goals: ps.goals ?? 0,
              hitouts: ps.hitouts ?? 0,
              source: "kali_targeted_backfill",
            });
          }
          return { season, rows: seasonRows, skipped: seasonSkipped, hadDate: seasonHadDate };
        } catch (e: any) {
          steps.push({ step: `kali_stats_${season}`, message: `ERROR: ${e.message}` });
          return { season, error: e.message, rows: [] as any[], skipped: [] as string[], hadDate: 0 };
        }
      });

      const seasonResults = await Promise.allSettled(seasonPromises);
      for (const sr of seasonResults) {
        if (sr.status === "fulfilled") {
          allStatsRows.push(...sr.value.rows);
          skippedRows.push(...sr.value.skipped);
          rowsWithDateBeforeEnrich += sr.value.hadDate;
        }
      }

      steps.push({ step: "stats_fetched", message: `${allStatsRows.length} valid rows collected, ${skippedRows.length} skipped (MISSING_MATCH_DATE), ${rowsWithDateBeforeEnrich} had date before enrichment` });
      if (skippedRows.length > 0 && action === "test_one") {
        steps.push({ step: "skipped_rows", message: skippedRows.slice(0, 10).join("; ") });
      }

      if (allStatsRows.length === 0) {
        result.playersStillMissing++;
        result.details.push({
          playerName: mp.bookmaker_player_name, team: confirmedTeam,
          action: "NO_STATS_IN_KALI", statsInserted: 0, oddsRelinked: 0,
          message: skippedRows.length > 0
            ? `NO_VALID_STATS_ROWS_AFTER_ENRICHMENT — ${skippedRows.length} rows skipped (no match_date)`
            : "Kali player found but 0 stats rows returned across all seasons",
          steps,
        });
        return;
      }

      result.playersFoundInKali++;

      // ── Step 7: Upsert valid stats into player_game_stats ──
      let statsInserted = 0;

      // Filter: only rows with player_id AND match_date AND team
      const validRows = allStatsRows.filter(r =>
        r.player_id && r.match_date && r.team
      );

      steps.push({ step: "valid_rows", message: `${validRows.length} valid rows after filtering` });

      if (validRows.length === 0) {
        result.playersStillMissing++;
        result.details.push({
          playerName: mp.bookmaker_player_name, team: confirmedTeam,
          action: "NO_STATS_IN_KALI", statsInserted: 0, oddsRelinked: 0,
          message: "NO_VALID_STATS_ROWS_AFTER_ENRICHMENT — no rows had match_date after enrichment",
          steps,
        });
        return;
      }

      // Split rows by whether they have a match_id (for conflict target)
      const rowsWithMatchId = validRows.filter(r => r.match_id);
      const rowsWithoutMatchId = validRows.filter(r => !r.match_id);

      if (rowsWithMatchId.length > 0) {
        const { error: upsertError } = await supabase
          .from("player_game_stats")
          .upsert(rowsWithMatchId, { onConflict: "player_id,match_id" });

        if (upsertError) {
          steps.push({ step: "upsert", message: `upsert (with match_id) FAILED: ${upsertError.message}` });
          result.errors.push(`Upsert error for ${mp.bookmaker_player_name}: ${upsertError.message}`);
        } else {
          statsInserted += rowsWithMatchId.length;
          steps.push({ step: "upsert", message: `upserted ${rowsWithMatchId.length} rows (with match_id)` });
        }
      }

      if (rowsWithoutMatchId.length > 0) {
        // For rows without match_id, insert with match_id = null — use a composite approach
        // Since (player_id, match_id) conflict won't work with null, just insert
        const { error: insertError } = await supabase
          .from("player_game_stats")
          .insert(rowsWithoutMatchId.map(r => ({ ...r, match_id: null })));

        if (insertError) {
          steps.push({ step: "insert", message: `insert (no match_id) FAILED: ${insertError.message}` });
          // Try upsert one by one — skip duplicates
          let singleInserted = 0;
          for (const r of rowsWithoutMatchId) {
            const { error: singleError } = await supabase
              .from("player_game_stats")
              .insert({ ...r, match_id: null });
            if (!singleError) singleInserted++;
          }
          if (singleInserted > 0) {
            statsInserted += singleInserted;
            steps.push({ step: "insert", message: `inserted ${singleInserted} rows individually (no match_id)` });
          }
        } else {
          statsInserted += rowsWithoutMatchId.length;
          steps.push({ step: "insert", message: `inserted ${rowsWithoutMatchId.length} rows (no match_id)` });
        }
      }

      result.playerGameStatsRowsInserted += statsInserted;
      steps.push({ step: "stats_inserted", message: `${statsInserted} rows inserted` });

      // ── Step 8: Relink bookmaker_odds (only if stats were inserted) ──
      let oddsRelinked = 0;
      if (correctPlayerId && statsInserted > 0) {
        const { data: oddsRows, error: oddsError } = await supabase
          .from("bookmaker_odds")
          .select("id")
          .eq("match_id", mp.match_id)
          .ilike("bookmaker_player_name", mp.bookmaker_player_name);

        if (oddsError) {
          steps.push({ step: "relink", message: `odds lookup FAILED: ${oddsError.message}` });
          result.errors.push(`Odds lookup error for ${mp.bookmaker_player_name}: ${oddsError.message}`);
        } else if (oddsRows && oddsRows.length > 0) {
          const ids = oddsRows.map(r => r.id);
          const { error: updateError } = await supabase
            .from("bookmaker_odds")
            .update({
              player_id: correctPlayerId,
              resolved_player_name: mp.bookmaker_player_name,
              resolution_status: "relinked",
              resolution_reason: "targeted_kali_backfill",
            })
            .in("id", ids);

          if (updateError) {
            steps.push({ step: "relink", message: `relink FAILED: ${updateError.message}` });
            result.errors.push(`Odds relink error for ${mp.bookmaker_player_name}: ${updateError.message}`);
          } else {
            oddsRelinked = ids.length;
            result.bookmakerOddsRowsRelinked += oddsRelinked;
            steps.push({ step: "relink", message: `relinked ${oddsRelinked} odds rows to ${correctPlayerId.slice(0, 8)}…` });
          }
        } else {
          steps.push({ step: "relink", message: "no odds rows found for this match/player" });
        }
      } else if (statsInserted === 0) {
        steps.push({ step: "relink", message: "skipped relink — no stats inserted" });
      }

      // ── Determine final status ──
      let playerAction: PlayerDetail["action"];
      if (statsInserted > 0 && oddsRelinked > 0) {
        playerAction = "RELINKED";
      } else if (statsInserted > 0) {
        playerAction = "UPDATED";
      } else if (oddsRelinked > 0) {
        // Relinked but no stats — NOT fixed, keep in missing queue
        playerAction = "RELINKED";
        result.playersStillMissing++;
      } else {
        playerAction = "UPDATED";
      }

      if (playerCreated && statsInserted > 0) {
        playerAction = "CREATED";
      }

      // Only count as fixed if statsInserted > 0
      if (statsInserted > 0 && !playerCreated) {
        result.existingPlayersUpdated++;
      }

      result.details.push({
        playerName: mp.bookmaker_player_name,
        team: confirmedTeam,
        action: playerAction,
        statsInserted,
        oddsRelinked,
        message: `Found in Kali (id=${kaliPlayerId}) — ${statsInserted} stats rows, ${oddsRelinked} odds relinked${skippedRows.length > 0 ? `, ${skippedRows.length} skipped (no date)` : ""}`,
        steps,
      });
    }

    // ── Run players with concurrency (5 at a time) ──
    for (let i = 0; i < playersToProcess.length; i += PLAYER_CONCURRENCY) {
      if (result.rateLimitRemaining !== null && result.rateLimitRemaining < 20) {
        result.errors.push(`Stopping early — rate limit low (${result.rateLimitRemaining} remaining)`);
        break;
      }
      const chunk = playersToProcess.slice(i, i + PLAYER_CONCURRENCY);
      await Promise.allSettled(chunk.map(mp => processPlayer(mp)));
    }

    result.success = true;
  } catch (e: any) {
    console.error("backfill-missing-player-stats failed", e);
    result.errors.push(e.message ?? String(e));
    result.errors.push(`Stack: ${e.stack ?? "no stack"}`);
    result.success = false;
  }

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
