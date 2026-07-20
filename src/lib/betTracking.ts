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
