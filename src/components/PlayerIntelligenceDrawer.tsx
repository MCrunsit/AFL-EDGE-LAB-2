import { X, Check, AlertTriangle, TrendingUp, Info } from 'lucide-react';
import { useState, useEffect } from 'react';
import type { PlayerIntelligence } from '../lib/playerIntelligenceService';
import { loadPossessionProfile } from '../lib/playerIntelligenceService';
import type { PullEmLeg } from '../lib/pullEmMultiOptimizer';

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

export default function PlayerIntelligenceDrawer({
  intel, lines, matchName, selectedKeys, legKeyFn, onToggleLeg, conflictMsg, onClose,
}: Props) {
  const [possProfile, setPossProfile] = useState<PlayerIntelligence['possessionProfile'] | null>(null);

  useEffect(() => {
    if (!intel?.playerId) return;
    setPossProfile(null);
    loadPossessionProfile(intel.playerId).then(setPossProfile);
  }, [intel?.playerId]);

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

          {/* Role Intelligence */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs font-semibold text-white">Role Intelligence</p>
              <span className="text-[10px] text-gray-500">{intel.roleIntelligence.label.replace(/_/g, ' ')}</span>
            </div>
            <p className="text-[11px] text-gray-400 mb-1">Current role: {intel.roleIntelligence.currentRole}</p>
            <p className="text-[11px] text-gray-400">{intel.roleIntelligence.reason}</p>
          </div>

          {/* CBA / Kick-ins */}
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
              <p className="text-xs font-semibold text-white mb-1">CBA Evidence</p>
              {intel.cba.available ? (
                <div className="text-[10px] text-gray-400 space-y-0.5">
                  <p>Season: {fmtNum(intel.cba.seasonAverage)}</p>
                  <p>Last 10: {fmtNum(intel.cba.last10Average)}</p>
                  <p>Last 5: {fmtNum(intel.cba.last5Average)}</p>
                  <p>Last 3: {fmtNum(intel.cba.last3Average)}</p>
                  <p>Latest: {fmtNum(intel.cba.latestValue)}</p>
                  <p>Latest round: {intel.cba.latestRound ? `Round ${intel.cba.latestRound}` : 'Unknown'}</p>
                  <p>Sample: {intel.cba.sampleSize} matches</p>
                  <p>Trend: {intel.cba.trend.replace(/_/g, ' ')}</p>
                </div>
              ) : unavailable()}
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
              <p className="text-xs font-semibold text-white mb-1">Kick-In Evidence</p>
              {intel.kickIns.available ? (
                <div className="text-[10px] text-gray-400 space-y-0.5">
                  <p>Season: {fmtNum(intel.kickIns.seasonAverage, 2)}</p>
                  <p>Last 10: {fmtNum(intel.kickIns.last10Average, 2)}</p>
                  <p>Last 5: {fmtNum(intel.kickIns.last5Average, 2)}</p>
                  <p>Last 3: {fmtNum(intel.kickIns.last3Average, 2)}</p>
                  <p>Latest: {fmtNum(intel.kickIns.latestValue, 2)}</p>
                  <p>Latest round: {intel.kickIns.latestRound ? `Round ${intel.kickIns.latestRound}` : 'Unknown'}</p>
                  <p>Play-on %: {intel.kickIns.playOnPercentage !== null ? `${Math.round(intel.kickIns.playOnPercentage * 100)}%` : 'Insufficient data'}</p>
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

          {/* Possession Profile */}
          {possProfile && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold text-white">Possession Profile</p>
                {possProfile.available && (
                  <span className="text-[10px] text-gray-500">{possProfile.reason}</span>
                )}
              </div>
              {!possProfile.available ? (
                <p className="text-[11px] text-gray-500">{possProfile.reason}</p>
              ) : (
                <div className="grid grid-cols-2 gap-1.5 text-[10px]">
                  <div className="bg-gray-800 rounded px-1.5 py-1.5">
                    <span className="text-gray-500 block">Avg Contested</span>
                    <span className="text-cyan-400 font-semibold">{possProfile.avgCP ?? '—'}</span>
                  </div>
                  <div className="bg-gray-800 rounded px-1.5 py-1.5">
                    <span className="text-gray-500 block">Avg Uncontested</span>
                    <span className="text-amber-400 font-semibold">{possProfile.avgUP ?? '—'}</span>
                  </div>
                  <div className="bg-gray-800 rounded px-1.5 py-1.5">
                    <span className="text-gray-500 block">Total Poss (CP+UP)</span>
                    <span className="text-white font-semibold">{possProfile.avgTotalPossessions ?? '—'}</span>
                  </div>
                  <div className="bg-gray-800 rounded px-1.5 py-1.5">
                    <span className="text-gray-500 block">Avg Disposals</span>
                    <span className="text-white">{possProfile.avgDisposals ?? '—'}</span>
                  </div>
                  <div className="bg-gray-800 rounded px-1.5 py-1.5">
                    <span className="text-gray-500 block">Metres Gained</span>
                    <span className="text-white">{possProfile.avgMetresGained ?? '—'}</span>
                  </div>
                  <div className="bg-gray-800 rounded px-1.5 py-1.5">
                    <span className="text-gray-500 block">Intercepts</span>
                    <span className="text-white">{possProfile.avgIntercepts ?? '—'}</span>
                  </div>
                  <div className="bg-gray-800 rounded px-1.5 py-1.5">
                    <span className="text-gray-500 block">TOG%</span>
                    <span className="text-white">{possProfile.avgTOGPct != null ? `${possProfile.avgTOGPct}%` : '—'}</span>
                  </div>
                  <div className="bg-gray-800 rounded px-1.5 py-1.5">
                    <span className="text-gray-500 block">Disposal Eff%</span>
                    <span className="text-white">{possProfile.avgDisposalEffPct != null ? `${possProfile.avgDisposalEffPct}%` : '—'}</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
