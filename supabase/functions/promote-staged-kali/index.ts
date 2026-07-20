import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

interface PromoteResult {
  staged_rows: number;
  resolved_players: number;
  promoted_rows: number;
  empty_before: number;
  incomplete_before: number;
  complete_matches_before: number;
  empty_after: number;
  incomplete_after: number;
  complete_matches: number;
  errors: string[];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  const result: PromoteResult = {
    staged_rows: 0,
    resolved_players: 0,
    promoted_rows: 0,
    empty_before: 0,
    incomplete_before: 0,
    complete_matches_before: 0,
    empty_after: 0,
    incomplete_after: 0,
    complete_matches: 0,
    errors: [],
  };

  try {
    // Step 1: Count staged rows before
    const { count: stagedCount } = await supabase
      .from("raw_kali_player_game_stats")
      .select("*", { count: "exact", head: true });
    result.staged_rows = stagedCount ?? 0;

    // Step 2: Count match completeness before
    const { data: beforeStats } = await supabase.rpc("get_match_completeness_stats");
    if (beforeStats) {
      result.empty_before = beforeStats.empty_matches ?? 0;
      result.incomplete_before = beforeStats.incomplete_matches ?? 0;
      result.complete_matches_before = beforeStats.complete_matches ?? 0;
    }

    // Step 3: Resolve player_id for staged rows (using RPC function)
    const { error: resolveError } = await supabase.rpc("resolve_staged_player_ids");
    if (resolveError) {
      result.errors.push(`Resolve error: ${resolveError.message}`);
    }

    // Count resolved
    const { count: resolvedCount } = await supabase
      .from("raw_kali_player_game_stats")
      .select("*", { count: "exact", head: true })
      .not("player_id", "is", null);
    result.resolved_players = resolvedCount ?? 0;

    // Step 4: Promote to player_game_stats
    const { data: promoteData, error: promoteError } = await supabase.rpc("promote_staged_to_player_game_stats");
    if (promoteError) {
      result.errors.push(`Promote error: ${promoteError.message}`);
    }
    result.promoted_rows = promoteData ?? 0;

    // Step 5: Count match completeness after
    const { data: afterStats } = await supabase.rpc("get_match_completeness_stats");
    if (afterStats) {
      result.empty_after = afterStats.empty_matches ?? 0;
      result.incomplete_after = afterStats.incomplete_matches ?? 0;
      result.complete_matches = afterStats.complete_matches ?? 0;
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    result.errors.push(err.message);
    return new Response(JSON.stringify(result), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
