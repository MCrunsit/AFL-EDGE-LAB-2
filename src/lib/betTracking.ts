import { supabase } from './supabase';

export interface BetSignatureInput {
  match_id: string | null;
  player_id: string | null;
  player_name: string;
  market: string | null;
  line: string | null;
  odds_taken: number;
}

export interface MultiLegSignatureInput {
  player_name: string;
  market: string | null;
  display_label: string | null;
  odds: number;
}

export function createBetSignature(bet: BetSignatureInput): string {
  return `${bet.match_id || ''}|${bet.player_id || bet.player_name}|${bet.market || ''}|${bet.line || ''}|${bet.odds_taken}`;
}

export function createMultiSignature(legs: MultiLegSignatureInput[], combinedOdds: number): string {
  const legSigs = legs
    .map(l => `${l.player_name}|${l.market || ''}|${l.display_label || ''}|${l.odds}`)
    .sort()
    .join(';');
  return `${legSigs}|${combinedOdds.toFixed(2)}`;
}

export async function checkDuplicateSingle(bet: Partial<BetSignatureInput>): Promise<boolean> {
  const { data: existing } = await supabase
    .from('tracked_bets')
    .select('id')
    .eq('result', 'pending')
    .ilike('player_name', bet.player_name || '')
    .eq('market', bet.market || null)
    .eq('odds_taken', bet.odds_taken || 0)
    .maybeSingle();

  return !!existing;
}

export interface TrackableMultiLeg {
  player_name: string;
  player_id: string | null;
  market: string | null;
  line: string;
  display_label: string | null;
  odds: number;
  adjusted_probability: number | null;
  adjusted_ev: number | null;
  match_id: string;
  position_group?: string | null;
  position_edge_value?: number | null;
  position_edge_significance?: string | null;
  position_edge_adjustment?: number | null;
  final_probability?: number | null;
  final_ev?: number | null;
}

export interface TrackableMulti {
  source: 'manual' | 'round_multi' | 'game_getup';
  combined_odds: number;
  combined_model_prob: number | null;
  combined_ev: number | null;
  use_position_edge: boolean;
  legs: TrackableMultiLeg[];
}

/**
 * Insert a multi (from any builder — manual, Round Multi, Game Get-Up) into
 * tracked_multis/tracked_multi_legs. Shared so every builder's "Track this"
 * action feeds the same Bet Tracker table and stats.
 */
export async function trackMulti(candidate: TrackableMulti): Promise<{ success: boolean; duplicate: boolean; error?: string }> {
  const isDuplicate = await checkDuplicateMulti(
    candidate.legs.map(l => ({
      player_name: l.player_name,
      market: l.market,
      display_label: l.display_label,
      odds: l.odds,
    })),
    candidate.combined_odds,
  );

  if (isDuplicate) {
    return { success: false, duplicate: true };
  }

  const { data: multi, error } = await supabase
    .from('tracked_multis')
    .insert({
      source: candidate.source,
      combined_odds: candidate.combined_odds,
      estimated_adjusted_probability: candidate.combined_model_prob,
      estimated_adjusted_ev: candidate.combined_ev,
      match_ids: [...new Set(candidate.legs.map(l => l.match_id))],
      use_position_edge: candidate.use_position_edge,
      estimated_final_probability: candidate.use_position_edge ? candidate.combined_model_prob : null,
      estimated_final_ev: candidate.use_position_edge ? candidate.combined_ev : null,
    })
    .select()
    .single();

  if (error || !multi) {
    return { success: false, duplicate: false, error: error?.message };
  }

  const legsData = candidate.legs.map(leg => ({
    multi_id: multi.id,
    player_name: leg.player_name,
    player_id: leg.player_id,
    market: leg.market,
    line: leg.line,
    display_label: leg.display_label,
    odds: leg.odds,
    adjusted_probability: leg.adjusted_probability,
    adjusted_ev: leg.adjusted_ev,
    match_id: leg.match_id,
    position_group: leg.position_group ?? null,
    position_edge_value: leg.position_edge_value ?? null,
    position_edge_significance: leg.position_edge_significance ?? null,
    position_edge_adjustment: leg.position_edge_adjustment ?? null,
    final_probability: leg.final_probability ?? null,
    final_ev: leg.final_ev ?? null,
  }));

  const { error: legsError } = await supabase.from('tracked_multi_legs').insert(legsData);
  if (legsError) {
    return { success: false, duplicate: false, error: legsError.message };
  }

  return { success: true, duplicate: false };
}

export async function checkDuplicateMulti(legs: MultiLegSignatureInput[], combinedOdds: number): Promise<boolean> {
  if (legs.length === 0) return false;

  const { data: existingMultis } = await supabase
    .from('tracked_multis')
    .select('id, combined_odds')
    .eq('result', 'pending');

  if (!existingMultis || existingMultis.length === 0) return false;

  for (const em of existingMultis) {
    const { data: existingLegs } = await supabase
      .from('tracked_multi_legs')
      .select('player_name, market, display_label, odds')
      .eq('multi_id', em.id);

    if (existingLegs && existingLegs.length === legs.length) {
      const sig1 = createMultiSignature(legs, combinedOdds);
      const sig2 = createMultiSignature(
        existingLegs.map(l => ({
          player_name: l.player_name,
          market: l.market,
          display_label: l.display_label,
          odds: l.odds,
        })),
        em.combined_odds,
      );

      if (sig1 === sig2) return true;
    }
  }

  return false;
}
