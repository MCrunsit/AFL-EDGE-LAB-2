import { useState } from 'react';
import { X, Check, AlertTriangle, TrendingUp, Info, ShieldCheck, ChevronDown, ChevronRight } from 'lucide-react';
import type { PlayerIntelligence } from '../lib/playerIntelligenceService';
import type { PullEmLeg } from '../lib/pullEmMultiOptimizer';
import { supabase } from '../lib/supabase';

interface Props {
  intel: PlayerIntelligence | undefined;
  lines: PullEmLeg[];
  matchName: string;
  selectedKeys: string[];
  legKeyFn: (leg: PullEmLeg) => string;
  onToggleLeg: (leg: PullEmLeg) => void;
  conflictMsg: string | null;
  onClose: () => void;
}

function fmtPct(v: number | null): string {
  return v === null ? 'Unknown' : `${Math.round(v * 100)}%`;
}

function fmtNum(v: number | null, digits = 1): string {
  return v === null ? 'Unknown' : v.toFixed(digits);
}

function unavailable(text = 'Insufficient data') {
  return <span className="text-gray-600 italic">{text}</span>;
}

interface VerifyRow {
  round: string | null;
  match_date: string | null;
  source: string | null;
  value: string;
}

/** Phase 19 — lets the user directly inspect the last 5 stored rows behind
 * this player's form/advanced/CBA/kick-in figures, straight from the source
 * tables, rather than trusting the computed summary alone. */
function VerifyPlayerData({ playerId }: { playerId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [formRows, setFormRows] = useState<VerifyRow[]>([]);
  const [advancedRows, setAdvancedRows] = useState<VerifyRow[]>([]);
  const [cbaRows, setCbaRows] = useState<VerifyRow[]>([]);
  const [kickInRows, setKickInRows] = useState<VerifyRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (loaded || loading) return;
    setLoading(true);
    setError(null);
    try {
      const [statsRes, roleRes] = await Promise.all([
        supabase
          .from('player_game_stats')
          .select('round, match_date, disposals, contested_possessions, uncontested_possessions, source')
          .eq('player_id', playerId)
          .order('match_date', { ascending: false })
          .limit(5),
        supabase
          .from('player_role_data')
          .select('round, cba_count, kick_in_count, source, updated_at')
          .eq('player_id', playerId)
          .limit(1000), // small per-player set; sorted client-side by round below
      ]);

      if (statsRes.error) throw statsRes.error;
      if (roleRes.error) throw roleRes.error;

      const stats = statsRes.data ?? [];
      setFormRows(stats.map(r => ({ round: r.round, match_date: r.match_date, source: r.source, value: `${r.disposals ?? '—'} disposals` })));
      setAdvancedRows(stats.map(r => ({
        round: r.round, match_date: r.match_date, source: r.source,
        value: r.contested_possessions != null && r.uncontested_possessions != null
          ? `${r.contested_possessions} CP / ${r.uncontested_possessions} UP` : 'No advanced data',
      })));

      const roleSorted = [...(roleRes.data ?? [])].sort((a, b) => {
        const ra = parseInt(a.round ?? '', 10), rb = parseInt(b.round ?? '', 10);
        if (!Number.isNaN(ra) && !Number.isNaN(rb)) return rb - ra;
        return (b.updated_at ?? '').localeCompare(a.updated_at ?? '');
      }).slice(0, 5);
      setCbaRows(roleSorted.map(r => ({ round: r.round, match_date: null, source: r.source, value: r.cba_count != null ? `${r.cba_count} attendances` : 'No data' })));
      setKickInRows(roleSorted.map(r => ({ round: r.round, match_date: null, source: r.source, value: r.kick_in_count != null ? `${r.kick_in_count} kick-ins` : 'No data' })));

      setLoaded(true);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  function Rows({ rows, label }: { rows: VerifyRow[]; label: string }) {
    return (
      <div>
        <p className="text-[10px] text-gray-500 uppercase mb-1">{label}</p>
        {rows.length === 0 ? (
          <p className="text-[10px] text-gray-600 italic">No rows found for this player.</p>
        ) : (
          <div className="space-y-1">
            {rows.map((r, i) => (
              <div key={i} className="flex items-center justify-between text-[10px] bg-gray-800/60 rounded px-2 py-1">
                <span className="text-gray-400">{r.round ? `Round ${r.round}` : 'Round —'}{r.match_date ? ` · ${r.match_date}` : ''}</span>
                <span className="text-white">{r.value}</span>
                <span className="text-gray-600">{r.source ?? 'unknown'}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
      <button
        onClick={() => { setOpen(!open); if (!open) load(); }}
        className="w-full flex items-center justify-between text-left"
      >
        <span className="flex items-center gap-1.5 text-xs font-semibold text-white">
          <ShieldCheck className="w-3.5 h-3.5 text-cyan-400" /> Verify Player Data
        </span>
        {open ? <ChevronDown className="w-3.5 h-3.5 text-gray-500" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-500" />}
      </button>
      {open && (
        <div className="mt-3 pt-3 border-t border-gray-800 space-y-3">
          {loading && <p className="text-[10px] text-gray-500">Loading source rows…</p>}
          {error && <p className="text-[10px] text-red-400">Error loading source data: {error}</p>}
          {loaded && (
            <>
              <Rows rows={formRows} label="Form data (player_game_stats)" />
              <Rows rows={advancedRows} label="Advanced data (contested/uncontested possessions)" />
              <Rows rows={cbaRows} label="CBA data (player_role_data)" />
              <Rows rows={kickInRows} label="Kick-in data (player_role_data)" />
              <p className="text-[9px] text-gray-600">Direct read from source tables — bypasses computed averages/caches.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function PlayerIntelligenceDrawer({
  intel, lines, matchName, selectedKeys, legKeyFn, onToggleLeg, conflictMsg, onClose,
}: Props) {
  if (!intel) return null;
  const sample = lines[0]?.row;
  const fr = sample?.freshness;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full max-w-md h-full bg-gray-950 border-l border-gray-800 overflow-y-auto">
        <div className="sticky top-0 bg-gray-950 border-b border-gray-800 p-4 flex items-center justify-between z-10">
          <div>
            <h2 className="text-white font-bold text-lg">{intel.playerName}</h2>
            <p className="text-xs text-gray-500">{intel.team} · {matchName}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-800 text-gray-400 hover:text-white transition">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Intelligence Score */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-3 text-center">
            <p className="text-[10px] text-gray-500 uppercase tracking-wide">Intelligence Score</p>
            {intel.intelligenceScore !== null ? (
              <p className="text-3xl font-bold text-white mt-1">{intel.intelligenceScore} <span className="text-base text-gray-400">{intel.intelligenceLabel}</span></p>
            ) : (
              <p className="text-lg font-bold text-gray-500 mt-1">Unrated</p>
            )}
            <p className="text-[10px] text-gray-500 mt-1">
              Data confidence: {intel.dataConfidence !== null ? `${Math.round(intel.dataConfidence * 100)}%` : 'Unknown'}
            </p>
            <p className="text-[9px] text-gray-600 mt-1">Decision support only — not a guaranteed outcome.</p>
          </div>

          {/* Positives / Risks / Missing */}
          {(intel.positives.length > 0 || intel.risks.length > 0) && (
            <div className="grid grid-cols-1 gap-2">
              {intel.positives.length > 0 && (
                <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-lg p-2.5">
                  <p className="text-[10px] font-semibold text-emerald-400 uppercase mb-1">Positives</p>
                  {intel.positives.map((p, i) => <p key={i} className="text-xs text-gray-300 mb-1 last:mb-0">{p}</p>)}
                </div>
              )}
              {intel.risks.length > 0 && (
                <div className="bg-red-500/5 border border-red-500/20 rounded-lg p-2.5">
                  <p className="text-[10px] font-semibold text-red-400 uppercase mb-1">Risks</p>
                  {intel.risks.map((r, i) => <p key={i} className="text-xs text-gray-300 mb-1 last:mb-0">{r}</p>)}
                </div>
              )}
            </div>
          )}
          {intel.missingData.length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-2.5">
              <p className="text-[10px] font-semibold text-gray-500 uppercase mb-1">Missing Data</p>
              {intel.missingData.map((m, i) => <p key={i} className="text-[11px] text-gray-500 mb-0.5 last:mb-0">{m}</p>)}
            </div>
          )}

          {/* Position Edge */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs font-semibold text-white">Position Edge</p>
              <span className="text-[10px] text-gray-500">{intel.positionEdge.label.replace(/_/g, ' ')}</span>
            </div>
            <p className="text-[11px] text-gray-400 mb-2">{intel.positionEdge.reason}</p>
            <div className="grid grid-cols-2 gap-1.5 text-[10px]">
              <div className="bg-gray-800 rounded px-1.5 py-1"><span className="text-gray-500">Opponent rank: </span><span className="text-white">{intel.positionEdge.opponentRank ?? unavailable('Unknown')}</span></div>
              <div className="bg-gray-800 rounded px-1.5 py-1"><span className="text-gray-500">Sample: </span><span className="text-white">{intel.positionEdge.sampleSize} games</span></div>
              <div className="bg-gray-800 rounded px-1.5 py-1"><span className="text-gray-500">Opponent avg: </span><span className="text-white">{fmtNum(intel.positionEdge.opponentRoleAverage)}</span></div>
              <div className="bg-gray-800 rounded px-1.5 py-1"><span className="text-gray-500">AFL avg: </span><span className="text-white">{fmtNum(intel.positionEdge.aflRoleAverage)}</span></div>
            </div>
          </div>

          {/* Team Environment */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs font-semibold text-white">Team Environment</p>
              <span className="text-[10px] text-gray-500">{intel.teamEnvironment.label.replace(/_/g, ' ')}</span>
            </div>
            <p className="text-[11px] text-gray-400">{intel.teamEnvironment.reason}</p>
          </div>

          {/* Possession-style matchup intelligence — uncontested / contested */}
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs font-semibold text-white">Uncontested Matchup</p>
                <span className="text-[10px] text-gray-500">{intel.possessionEnvironment.uncontested.label.replace(/_/g, ' ')}</span>
              </div>
              <p className="text-[11px] text-gray-400 mb-1">{intel.possessionEnvironment.uncontested.reason}</p>
              <div className="text-[10px] text-gray-500 space-y-0.5">
                <p>Player UP rate: {intel.possessionEnvironment.uncontested.playerRate != null ? `${intel.possessionEnvironment.uncontested.playerRate}%` : 'Unknown'}</p>
                <p>Position UP rate: {intel.possessionEnvironment.uncontested.positionRate != null ? `${intel.possessionEnvironment.uncontested.positionRate}%` : 'Unknown'}</p>
                <p>Team UP index: {intel.possessionEnvironment.uncontested.teamForIndex ?? 'Unknown'}</p>
                <p>Opp UP allowed index: {intel.possessionEnvironment.uncontested.opponentAllowedIndex ?? 'Unknown'}</p>
                <p>Sample: {intel.possessionEnvironment.uncontested.playerSampleGames} games</p>
              </div>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs font-semibold text-white">Contested Matchup</p>
                <span className="text-[10px] text-gray-500">{intel.possessionEnvironment.contested.label.replace(/_/g, ' ')}</span>
              </div>
              <p className="text-[11px] text-gray-400 mb-1">{intel.possessionEnvironment.contested.reason}</p>
              <div className="text-[10px] text-gray-500 space-y-0.5">
                <p>Player CP rate: {intel.possessionEnvironment.contested.playerRate != null ? `${intel.possessionEnvironment.contested.playerRate}%` : 'Unknown'}</p>
                <p>Position CP rate: {intel.possessionEnvironment.contested.positionRate != null ? `${intel.possessionEnvironment.contested.positionRate}%` : 'Unknown'}</p>
                <p>Team CP index: {intel.possessionEnvironment.contested.teamForIndex ?? 'Unknown'}</p>
                <p>Opp CP allowed index: {intel.possessionEnvironment.contested.opponentAllowedIndex ?? 'Unknown'}</p>
                <p>Sample: {intel.possessionEnvironment.contested.playerSampleGames} games</p>
              </div>
            </div>
          </div>

          {/* Role Intelligence */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs font-semibold text-white">Role Intelligence</p>
              <span className="text-[10px] text-gray-500">{intel.roleIntelligence.label.replace(/_/g, ' ')}</span>
            </div>
            <p className="text-[11px] text-gray-400 mb-1">Current role: {intel.roleIntelligence.currentRole}</p>
            <p className="text-[11px] text-gray-400">{intel.roleIntelligence.reason}</p>
          </div>

          {/* CBA / Kick-ins — counts and percentages are always kept distinct:
              seasonAverage/last*Average/latestValue are raw counts (already
              stored as counts, never re-scaled); teamSharePercentage and
              playOnPercentage are 0-100 percentages (converted once, at the
              service layer from the 0-1 DB values) and always rendered with %. */}
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
              <p className="text-xs font-semibold text-white mb-1">CBA Evidence</p>
              {intel.cba.available ? (
                <div className="text-[10px] text-gray-400 space-y-0.5">
                  <p>Latest: {intel.cba.latestValue ?? '—'} attendances</p>
                  <p>Team share: {intel.cba.teamSharePercentage !== null ? `${intel.cba.teamSharePercentage}%` : 'Unknown'}</p>
                  <p>Season average: {fmtNum(intel.cba.seasonAverage)}</p>
                  <p>Last 10 average: {fmtNum(intel.cba.last10Average)}</p>
                  <p>Last 5 average: {fmtNum(intel.cba.last5Average)}</p>
                  <p>Last 3 average: {fmtNum(intel.cba.last3Average)}</p>
                  <p>Latest data: {intel.cba.latestRound ? `Round ${intel.cba.latestRound}` : 'Unknown'}</p>
                  <p>Sample: {intel.cba.sampleSize} matches</p>
                  <p>Trend: {intel.cba.trend.replace(/_/g, ' ')}</p>
                </div>
              ) : unavailable()}
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
              <p className="text-xs font-semibold text-white mb-1">Kick-In Evidence</p>
              {intel.kickIns.available ? (
                <div className="text-[10px] text-gray-400 space-y-0.5">
                  <p>Latest: {intel.kickIns.latestValue ?? '—'}</p>
                  <p>Team share: {intel.kickIns.teamSharePercentage !== null ? `${intel.kickIns.teamSharePercentage}%` : 'Unknown'}</p>
                  <p>Played on: {intel.kickIns.playOnPercentage !== null ? `${intel.kickIns.playOnPercentage}%` : 'Insufficient data'}</p>
                  <p>Season average: {fmtNum(intel.kickIns.seasonAverage)}</p>
                  <p>Last 10 average: {fmtNum(intel.kickIns.last10Average)}</p>
                  <p>Last 5 average: {fmtNum(intel.kickIns.last5Average)}</p>
                  <p>Last 3 average: {fmtNum(intel.kickIns.last3Average)}</p>
                  <p>Latest data: {intel.kickIns.latestRound ? `Round ${intel.kickIns.latestRound}` : 'Unknown'}</p>
                  <p>Sample: {intel.kickIns.sampleSize} matches</p>
                  <p>Trend: {intel.kickIns.trend.replace(/_/g, ' ')}</p>
                </div>
              ) : unavailable()}
            </div>
          </div>

          {/* Sample line stats (from the first genuine line) */}
          {sample && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
              <p className="text-xs font-semibold text-white mb-2">Player Form</p>
              <div className="grid grid-cols-2 gap-1.5 text-[10px] mb-2">
                <div className="bg-gray-800 rounded px-1.5 py-1"><span className="text-gray-500">Season hit rate: </span><span className="text-white">{Math.round(sample.modelProb.hit_rate * 100)}%</span></div>
                <div className="bg-gray-800 rounded px-1.5 py-1"><span className="text-gray-500">Sample size: </span><span className="text-white">{sample.modelProb.sample_size} games</span></div>
                <div className="bg-gray-800 rounded px-1.5 py-1"><span className="text-gray-500">Adj. probability: </span><span className="text-white">{sample.modelProb.adjustedProb !== null ? fmtPct(sample.modelProb.adjustedProb) : 'Unknown'}</span></div>
                <div className="bg-gray-800 rounded px-1.5 py-1"><span className="text-gray-500">Implied probability: </span><span className="text-white">{fmtPct(sample.impliedProb)}</span></div>
                <div className="bg-gray-800 rounded px-1.5 py-1"><span className="text-gray-500">Latest round: </span><span className="text-white">{fr?.latestRound ? `Round ${fr.latestRound}` : 'Unknown'}</span></div>
                <div className={`rounded px-1.5 py-1 ${fr?.freshnessStatus === 'CURRENT' ? 'bg-emerald-500/10' : 'bg-amber-500/10'}`}>
                  <span className="text-gray-500">Freshness: </span>
                  <span className={fr?.freshnessStatus === 'CURRENT' ? 'text-emerald-400' : 'text-amber-400'}>{fr?.freshnessStatus ?? 'Unknown'}</span>
                </div>
              </div>
              {fr && fr.latestFiveDisposals.length > 0 && (
                <p className="text-[10px] text-gray-500">Last 5 values: {fr.latestFiveDisposals.join(', ')}</p>
              )}
            </div>
          )}

          <VerifyPlayerData playerId={intel.playerId} />

          {/* Genuine lines — add to slip */}
          <div className="bg-gray-900 border border-cyan-500/20 rounded-xl p-3">
            <div className="flex items-center gap-1.5 mb-2">
              <TrendingUp className="w-3.5 h-3.5 text-cyan-400" />
              <p className="text-xs font-semibold text-white">Every Genuine Line ({lines.length})</p>
            </div>
            {conflictMsg && (
              <div className="flex items-center gap-1.5 text-[10px] text-amber-400 bg-amber-500/10 rounded px-2 py-1.5 mb-2">
                <AlertTriangle className="w-3 h-3 shrink-0" /> {conflictMsg}
              </div>
            )}
            <div className="space-y-1 max-h-64 overflow-y-auto">
              {lines.map(leg => {
                const key = legKeyFn(leg);
                const isPicked = selectedKeys.includes(key);
                return (
                  <button
                    key={key}
                    onClick={() => onToggleLeg(leg)}
                    className={`w-full flex items-center justify-between px-2 py-1.5 rounded-lg border text-left transition ${
                      isPicked ? 'bg-cyan-500/10 border-cyan-500/40' : 'bg-gray-800/40 border-gray-800 hover:border-gray-700'
                    }`}
                  >
                    <span className="flex items-center gap-1.5 text-xs text-white">
                      {isPicked ? <Check className="w-3 h-3 text-cyan-400" /> : <span className="w-3" />}
                      {leg.displayLabel}
                    </span>
                    <span className="flex items-center gap-2 text-[10px] text-gray-500">
                      <span className="text-white font-bold">${leg.odds.toFixed(2)}</span>
                      <span>{(leg.modelProb * 100).toFixed(0)}% prob</span>
                    </span>
                  </button>
                );
              })}
              {lines.length === 0 && (
                <p className="text-[11px] text-gray-600 flex items-center gap-1.5"><Info className="w-3 h-3" /> No genuine lines currently loaded for this player.</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
