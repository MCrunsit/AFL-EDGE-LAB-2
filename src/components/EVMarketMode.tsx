import { useEffect, useState } from 'react';
import { Filter, Info } from 'lucide-react';
import { buildDisposalLineRecommendations, type DisposalLineRecommendation } from '../lib/disposalLineSelector';
import type { ModelledOddsRow } from '../lib/modelResolver';

export type MarketMode = 'disposals' | 'all' | 'custom';

export const MARKET_MODE_KEY = 'ev_market_mode';

export function getStoredMarketMode(): MarketMode {
  try {
    const stored = localStorage.getItem(MARKET_MODE_KEY);
    if (stored === 'disposals' || stored === 'all' || stored === 'custom') return stored;
  } catch {}
  return 'disposals';
}

export function storeMarketMode(mode: MarketMode) {
  try { localStorage.setItem(MARKET_MODE_KEY, mode); } catch {}
}

interface Props {
  mode: MarketMode;
  onModeChange: (m: MarketMode) => void;
}

export function MarketModeSelector({ mode, onModeChange }: Props) {
  return (
    <div className="flex items-center gap-3">
      <Filter className="w-4 h-4 text-gray-500" />
      <label className="text-xs text-gray-500 uppercase tracking-wider">Market Mode</label>
      <select
        value={mode}
        onChange={e => onModeChange(e.target.value as MarketMode)}
        className="bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-1.5 focus:outline-none focus:border-emerald-500"
      >
        <option value="disposals">Disposals Only</option>
        <option value="all">All Markets — Experimental</option>
        <option value="custom">Custom</option>
      </select>
      {mode === 'all' && (
        <span className="text-xs text-amber-400 flex items-center gap-1">
          <Info className="w-3 h-3" />
          Marks, tackles, goals and hitouts are experimental and may be less reliable than disposals.
        </span>
      )}
    </div>
  );
}

/**
 * Filter modelled rows based on market mode.
 */
export function filterByMarketMode(rows: ModelledOddsRow[], mode: MarketMode): ModelledOddsRow[] {
  if (mode === 'all') return rows;
  if (mode === 'disposals') {
    return rows.filter(r => r.statType === 'disposals' || r.resolvedStatType === 'disposals');
  }
  // custom = no filter
  return rows;
}

/**
 * Render disposal line recommendations for EV Calculator.
 */
export function DisposalLineRecommendations({ rows }: { rows: ModelledOddsRow[] }) {
  const [recs, setRecs] = useState<DisposalLineRecommendation[]>([]);

  useEffect(() => {
    const recommendations = buildDisposalLineRecommendations(rows);
    setRecs(recommendations);
  }, [rows]);

  if (recs.length === 0) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-center">
        <p className="text-gray-500 text-sm">No disposal line recommendations available.</p>
      </div>
    );
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Disposal Line Recommendations</h4>
      <div className="max-h-80 overflow-y-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-500 border-b border-gray-800">
              <th className="text-left py-1.5 px-2">Player</th>
              <th className="text-right py-1.5 px-2">Safe Multi Line</th>
              <th className="text-right py-1.5 px-2">Balanced Line</th>
              <th className="text-right py-1.5 px-2">Best EV Line</th>
              <th className="text-right py-1.5 px-2">Season HR</th>
              <th className="text-right py-1.5 px-2">L10 HR</th>
            </tr>
          </thead>
          <tbody>
            {recs.map((rec, i) => (
              <tr key={i} className="border-b border-gray-800/30">
                <td className="py-1.5 px-2 text-gray-300">{rec.playerName}</td>
                <td className="py-1.5 px-2 text-right text-emerald-400">
                  {rec.safeLine ? `${rec.safeLine.line}+ @${rec.safeLine.over_odds.toFixed(2)}` : '—'}
                </td>
                <td className="py-1.5 px-2 text-right text-amber-400">
                  {rec.balancedLine ? `${rec.balancedLine.line}+ @${rec.balancedLine.over_odds.toFixed(2)}` : '—'}
                </td>
                <td className="py-1.5 px-2 text-right text-cyan-400">
                  {rec.valueLine ? `${rec.valueLine.line}+ @${rec.valueLine.over_odds.toFixed(2)}` : '—'}
                </td>
                <td className="py-1.5 px-2 text-right text-gray-400">{(rec.seasonHitRate * 100).toFixed(0)}%</td>
                <td className="py-1.5 px-2 text-right text-gray-400">{(rec.last10HitRate * 100).toFixed(0)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {recs.some(r => r.rejectionReasons.length > 0) && (
        <div className="mt-2 text-[10px] text-gray-600">
          {recs.filter(r => !r.safeLine).length} players without a Safe Multi Line (see rejection reasons in Multi Builder diagnostics)
        </div>
      )}
    </div>
  );
}
