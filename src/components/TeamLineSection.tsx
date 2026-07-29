import { useState } from 'react';
import { X, Plus } from 'lucide-react';
import type { TeamLineLeg, GameGetUpTeamLineSettings } from '../lib/gameGetUp';

/**
 * One Team Line leg's numbers — deliberately labeled "Team Line ..." on
 * every field, never bare "Safety Score"/"Probability", so it's never
 * confused with the player-prop formula.
 */
export function TeamLineLegRow({ leg, onRemove }: { leg: TeamLineLeg; onRemove?: () => void }) {
  const { option, coverProbability, safety, dataConfidence } = leg;
  return (
    <div className="p-3 border-b border-cyan-500/20 bg-cyan-500/5">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <span className="text-white font-medium text-sm flex items-center gap-1.5">
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 uppercase font-bold">Team Line</span>
          {option.teamName} {option.point > 0 ? '+' : ''}{option.point}
        </span>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-white font-bold">${option.odds.toFixed(2)}</span>
          {onRemove && (
            <button onClick={onRemove} title="Remove this Team Line" className="text-gray-500 hover:text-red-400 transition">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
      <div className="mt-1.5 grid grid-cols-1 sm:grid-cols-3 gap-2 text-[10px]">
        <span className="text-gray-400">
          Team Line Cover Probability: <span className="text-white font-semibold">
            {coverProbability.coverProbability !== null ? `${(coverProbability.coverProbability * 100).toFixed(0)}%` : 'Insufficient sample'}
          </span>
        </span>
        <span className="text-gray-400">
          Team Line Safety Score: <span className="text-white font-semibold">{safety.score ?? 'Unrated'}</span>
        </span>
        <span className="text-gray-400">
          Team Line Data Confidence: <span className="text-white font-semibold">{dataConfidence}%</span>
        </span>
      </div>
      <p className="mt-1 text-[9px] text-gray-500">{option.bookmaker} · sample: {coverProbability.sampleSize} comparable past line{coverProbability.sampleSize === 1 ? '' : 's'}</p>
    </div>
  );
}

/** Always enabled regardless of Allow Team Lines — manual add must work even
 * when automatic recommendations don't use Team Lines. */
export function TeamMarketsPicker({
  options, current, onAdd, onRemove,
}: {
  options: TeamLineLeg[];
  current: TeamLineLeg | null;
  onAdd: (leg: TeamLineLeg) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);

  if (options.length === 0) {
    return <p className="px-3 py-2 text-[10px] text-gray-500">No Team Line odds synced for this match yet — use "Sync Match Odds" on the Import page.</p>;
  }

  return (
    <div className="border-t border-gray-800">
      <div className="px-3 py-2 flex items-center justify-between">
        <span className="text-[10px] text-gray-500 uppercase font-semibold">Team Markets</span>
        {!current && (
          <button onClick={() => setOpen(o => !o)} className="flex items-center gap-1 text-[10px] text-cyan-400 hover:text-cyan-300 transition">
            <Plus className="w-3 h-3" /> {open ? 'Cancel' : 'Add a Team Line'}
          </button>
        )}
      </div>
      {current && <TeamLineLegRow leg={current} onRemove={onRemove} />}
      {!current && open && (
        <div className="px-3 pb-2 space-y-1">
          {options.map(leg => (
            <button
              key={leg.option.team}
              onClick={() => { onAdd(leg); setOpen(false); }}
              className="w-full flex items-center justify-between gap-2 px-2 py-1.5 bg-gray-900 hover:bg-gray-800 rounded text-left transition"
            >
              <span className="text-xs text-white">{leg.option.teamName} {leg.option.point > 0 ? '+' : ''}{leg.option.point}</span>
              <span className="text-[10px] text-gray-400">
                ${leg.option.odds.toFixed(2)} · {leg.coverProbability.coverProbability !== null ? `${(leg.coverProbability.coverProbability * 100).toFixed(0)}% cover` : 'insufficient sample'}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function TeamLineSettingsPanel({
  settings, onChange,
}: {
  settings: GameGetUpTeamLineSettings;
  onChange: (next: GameGetUpTeamLineSettings) => void;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-3">
      <label className="flex items-center gap-2 text-[10px] text-gray-400">
        <input
          type="checkbox" checked={settings.allowTeamLines}
          onChange={e => onChange({ ...settings, allowTeamLines: e.target.checked })}
        />
        Allow Team Lines in automatic recommendations
      </label>
      <label className="flex items-center gap-2 text-[10px] text-gray-400">
        <input
          type="checkbox" checked={settings.preferTeamLines} disabled={!settings.allowTeamLines}
          onChange={e => onChange({ ...settings, preferTeamLines: e.target.checked })}
        />
        Prefer Team Lines
      </label>
      <label className="flex items-center gap-2 text-[10px] text-gray-400">
        <input
          type="checkbox" checked={settings.teamLinesOnly} disabled={!settings.allowTeamLines}
          onChange={e => onChange({ ...settings, teamLinesOnly: e.target.checked })}
        />
        Team Lines Only
      </label>
      <div />
      <label className="text-[10px] text-gray-500 uppercase">
        Minimum Team Line Safety Score
        <input
          type="number" min={0} max={100} placeholder="None"
          value={settings.minTeamLineSafetyScore ?? ''}
          onChange={e => onChange({ ...settings, minTeamLineSafetyScore: e.target.value === '' ? null : Number(e.target.value) })}
          className="w-full mt-1 bg-gray-800 border border-gray-700 text-white text-xs rounded px-2 py-1"
        />
      </label>
      <label className="text-[10px] text-gray-500 uppercase">
        Minimum Team Line Cover Probability
        <input
          type="number" min={0} max={100} placeholder="None"
          value={settings.minTeamLineCoverProbability !== null ? Math.round(settings.minTeamLineCoverProbability * 100) : ''}
          onChange={e => onChange({ ...settings, minTeamLineCoverProbability: e.target.value === '' ? null : Number(e.target.value) / 100 })}
          className="w-full mt-1 bg-gray-800 border border-gray-700 text-white text-xs rounded px-2 py-1"
        />
      </label>
    </div>
  );
}
