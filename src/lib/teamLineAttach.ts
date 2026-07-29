/**
 * Shared "attach a Team Line to a built multi" logic — used by Game Get-Up,
 * Game Multi, and Build Your Own Multi. Deliberately generic over plain
 * odds/probability numbers rather than any one multi type, since each
 * builder has its own multi shape (GameGetUpMulti, OptimizedMulti, the
 * local MultiCandidate in MultiBuilderPage.tsx).
 */
import {
  calculateTeamLineCoverProbability, filterComparableHistory,
  type TeamLineOption, type TeamLineCoverProbability, type TeamLineHistoryEntry,
} from './teamLine';
import { calculateTeamLineSafetyScore, computeTeamLineDataConfidence, type TeamLineSafetyScoreResult } from './teamLineSafetyScore';

export interface TeamLineLeg {
  option: TeamLineOption;
  coverProbability: TeamLineCoverProbability;
  safety: TeamLineSafetyScoreResult;
  dataConfidence: number;
}

/** Same flat-fallback contribution used for player-pair correlation
 * (correlationModel.ts's FLAT_PAIR_HAIRCUT) — there is no historical joint
 * "team covered its line AND player hit their prop" data anywhere in this
 * schema, so a Team Line's correlation with each player leg always uses
 * this conservative flat value, never a fabricated real correlation. */
export const TEAM_LINE_FLAT_PAIR_HAIRCUT = 0.05;
export const TEAM_LINE_MAX_TOTAL_HAIRCUT = 0.30;

/**
 * Score one Team Line option against its team's own history. Always
 * computed for every option regardless of settings, so a manual "Team
 * Markets" picker always has real numbers to offer — Team Line
 * Probability/Safety Score/Data Confidence are computed here and only
 * here, kept structurally separate from player-prop Safety Score.
 */
export function buildTeamLineLeg(option: TeamLineOption, history: TeamLineHistoryEntry[]): TeamLineLeg {
  const comparable = filterComparableHistory(history, option.point);
  const coverProbability = calculateTeamLineCoverProbability(history, option.point);
  const dataConfidence = computeTeamLineDataConfidence(comparable.length, option.updatedAt, option.bookmakerCount);
  const safety = calculateTeamLineSafetyScore(comparable, coverProbability.coverProbability, dataConfidence);
  return { option, coverProbability, safety, dataConfidence };
}

export interface TeamLineAttachBase {
  combinedOdds: number;
  rawProbability: number;
  conservativeProbability: number;
  /** Number of non-team-line legs already in the multi — determines how
   * many flat correlation contributions the Team Line adds. */
  playerLegCount: number;
}

export interface TeamLineAttachResult {
  combinedOdds: number;
  rawProbability: number;
  conservativeProbability: number;
  totalHaircut: number;
  warning: string;
}

/**
 * Fold a Team Line leg into an already-built multi's numbers. When the
 * Team Line's cover probability is unrated (too little history), the odds
 * still combine (a real, known price) but the probability estimate is left
 * as the rest-of-multi figure, with a warning — never fabricated.
 */
export function computeTeamLineAttachment(base: TeamLineAttachBase, leg: TeamLineLeg): TeamLineAttachResult {
  const combinedOdds = base.combinedOdds * leg.option.odds;
  const cp = leg.coverProbability.coverProbability;
  const rawProbability = cp !== null ? base.rawProbability * cp : base.rawProbability;

  // Existing haircut implied by the base multi's own probabilities, plus
  // one flat contribution per player leg now paired with the Team Line.
  const existingHaircut = base.rawProbability > 0 ? 1 - base.conservativeProbability / base.rawProbability : 0;
  const extraHaircut = base.playerLegCount * TEAM_LINE_FLAT_PAIR_HAIRCUT;
  const totalHaircut = Math.min(existingHaircut + extraHaircut, TEAM_LINE_MAX_TOTAL_HAIRCUT);
  const conservativeProbability = cp !== null ? rawProbability * (1 - totalHaircut) : base.conservativeProbability;

  const pointLabel = `${leg.option.teamName} ${leg.option.point > 0 ? '+' : ''}${leg.option.point}`;
  const warning = cp === null
    ? `${pointLabel} has insufficient cover-rate history — odds included, probability estimate reflects the rest of the multi only.`
    : `${pointLabel} combined via a conservative flat correlation estimate — no historical data exists linking team-line covers to individual player props.`;

  return { combinedOdds, rawProbability, conservativeProbability, totalHaircut, warning };
}
