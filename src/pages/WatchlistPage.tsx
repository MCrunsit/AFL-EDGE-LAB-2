import { useState, useEffect, useCallback } from 'react';
import { Eye, Trash2, TrendingUp, TrendingDown, RefreshCw, ArrowUp, ArrowDown, Minus } from 'lucide-react';
import { supabase } from '../lib/supabase';
import LoadingSpinner from '../components/LoadingSpinner';

interface WatchlistItem {
  id: string;
  player_name: string;
  market: string | null;
  line: string | null;
  display_label: string | null;
  match_name: string | null;
  odds_at_watch: number;
  latest_odds: number | null;
  model_probability: number | null;
  adjusted_ev: number | null;
  position_group: string | null;
  position_edge_value: number | null;
  position_edge_significance: string | null;
  position_edge_adjustment: number | null;
  final_probability: number | null;
  final_ev: number | null;
  use_position_edge: boolean | null;
  quality_score: number | null;
  risk_level: string | null;
  notes: string | null;
  created_at: string;
}

export default function WatchlistPage() {
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editingNotes, setEditingNotes] = useState<string | null>(null);
  const [notesDraft, setNotesDraft] = useState('');

  const loadWatchlist = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('watchlist')
      .select('*')
      .order('created_at', { ascending: false });
    setItems((data ?? []) as unknown as WatchlistItem[]);
    setLoading(false);
  }, []);

  useEffect(() => { loadWatchlist(); }, [loadWatchlist]);

  async function deleteItem(id: string) {
    await supabase.from('watchlist').delete().eq('id', id);
    setItems(prev => prev.filter(i => i.id !== id));
    setMessage('Removed from watchlist');
    setTimeout(() => setMessage(null), 3000);
  }

  async function saveNotes(id: string) {
    await supabase.from('watchlist').update({ notes: notesDraft }).eq('id', id);
    setItems(prev => prev.map(i => i.id === id ? { ...i, notes: notesDraft } : i));
    setEditingNotes(null);
  }

  function clvPreview(watched: number, latest: number | null): number | null {
    if (!latest || latest <= 0) return null;
    return watched / latest - 1;
  }

  if (loading) return <LoadingSpinner message="Loading watchlist..." />;

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-center gap-3 flex-wrap">
        <Eye className="w-5 h-5 text-amber-400" />
        <h2 className="text-white font-bold text-lg">CLV Watchlist</h2>
        <span className="text-xs text-gray-600">Track odds movement before placing</span>
        {message && (
          <span className="text-xs px-3 py-1 rounded-full bg-blue-500/20 text-blue-400">{message}</span>
        )}
      </div>

      {items.length === 0 ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center">
          <Eye className="w-10 h-10 text-gray-700 mx-auto mb-3" />
          <p className="text-gray-400 font-medium">No watched bets yet</p>
          <p className="text-xs mt-1 text-gray-600">Watch bets from the EV Calculator to track odds movement</p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map(item => {
            const clv = clvPreview(item.odds_at_watch, item.latest_odds);
            const movement = item.latest_odds !== null ? item.latest_odds - item.odds_at_watch : null;
            const positiveMovement = item.latest_odds !== null && item.odds_at_watch > item.latest_odds;

            return (
              <div key={item.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-white font-medium text-sm">{item.player_name}</p>
                    <p className="text-gray-500 text-xs">{item.market} {item.display_label || item.line}</p>
                    {item.match_name && <p className="text-gray-600 text-xs mt-0.5">{item.match_name}</p>}
                  </div>
                  <button onClick={() => deleteItem(item.id)} className="p-1.5 bg-red-500/20 text-red-400 rounded hover:bg-red-500/30 shrink-0" title="Remove">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">
                  <div className="bg-gray-800/40 rounded-lg p-2">
                    <p className="text-xs text-gray-500">Watched Odds</p>
                    <p className="text-white font-mono font-bold">{item.odds_at_watch.toFixed(2)}</p>
                  </div>
                  <div className="bg-gray-800/40 rounded-lg p-2">
                    <p className="text-xs text-gray-500">Latest Odds</p>
                    <p className={`font-mono font-bold ${item.latest_odds === null ? 'text-gray-600' : movement !== null && movement > 0 ? 'text-red-400' : movement !== null && movement < 0 ? 'text-emerald-400' : 'text-white'}`}>
                      {item.latest_odds !== null ? item.latest_odds.toFixed(2) : '—'}
                    </p>
                  </div>
                  <div className="bg-gray-800/40 rounded-lg p-2">
                    <p className="text-xs text-gray-500">Movement</p>
                    {movement === null ? (
                      <p className="text-gray-600 font-mono">—</p>
                    ) : movement > 0 ? (
                      <p className="text-red-400 font-mono flex items-center gap-1"><ArrowUp className="w-3 h-3" />+{movement.toFixed(2)}</p>
                    ) : movement < 0 ? (
                      <p className="text-emerald-400 font-mono flex items-center gap-1"><ArrowDown className="w-3 h-3" />{movement.toFixed(2)}</p>
                    ) : (
                      <p className="text-gray-400 font-mono flex items-center gap-1"><Minus className="w-3 h-3" />0.00</p>
                    )}
                  </div>
                  <div className="bg-gray-800/40 rounded-lg p-2">
                    <p className="text-xs text-gray-500">CLV Preview</p>
                    {clv === null ? (
                      <p className="text-gray-600 font-mono">—</p>
                    ) : (
                      <p className={`font-mono font-bold ${clv > 0 ? 'text-emerald-400' : clv < 0 ? 'text-red-400' : 'text-gray-400'}`}>
                        {clv >= 0 ? '+' : ''}{(clv * 100).toFixed(1)}%
                      </p>
                    )}
                  </div>
                </div>

                {item.latest_odds !== null && positiveMovement && (
                  <div className="mt-2 flex items-center gap-2 text-xs text-emerald-400 bg-emerald-500/10 rounded-lg px-3 py-2">
                    <TrendingUp className="w-3 h-3" />
                    Positive movement — you beat the market.
                  </div>
                )}
                {item.latest_odds !== null && !positiveMovement && item.latest_odds !== item.odds_at_watch && (
                  <div className="mt-2 flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 rounded-lg px-3 py-2">
                    <TrendingDown className="w-3 h-3" />
                    Odds drifted — market moved against you.
                  </div>
                )}

                <div className="flex items-center gap-3 mt-3 text-xs text-gray-500">
                  {item.model_probability && <span>Adj P: {(item.model_probability * 100).toFixed(1)}%</span>}
                  {item.adjusted_ev && <span className="text-emerald-400">EV: +{(item.adjusted_ev * 100).toFixed(1)}%</span>}
                  {item.use_position_edge && item.position_group && (
                    <span className="text-gray-400">
                      Pos: {item.position_group}
                      {item.position_edge_adjustment !== null && item.position_edge_adjustment !== 0 && (
                        <span className={`ml-1 font-bold ${item.position_edge_adjustment > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {item.position_edge_adjustment > 0 ? '+' : ''}{(item.position_edge_adjustment * 100).toFixed(1)}%
                        </span>
                      )}
                    </span>
                  )}
                  {item.quality_score !== null && <span className="text-blue-400">Q: {item.quality_score.toFixed(0)}</span>}
                  {item.risk_level && (
                    <span className={`px-1.5 py-0.5 rounded ${item.risk_level === 'Low' ? 'bg-emerald-500/20 text-emerald-400' : item.risk_level === 'Medium' ? 'bg-amber-500/20 text-amber-400' : 'bg-red-500/20 text-red-400'}`}>
                      {item.risk_level}
                    </span>
                  )}
                  <span className="ml-auto text-gray-600">{new Date(item.created_at).toLocaleDateString()}</span>
                </div>

                {/* Notes */}
                <div className="mt-2">
                  {editingNotes === item.id ? (
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={notesDraft}
                        onChange={e => setNotesDraft(e.target.value)}
                        placeholder="Add notes..."
                        className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white"
                        autoFocus
                      />
                      <button onClick={() => saveNotes(item.id)} className="px-3 py-1.5 bg-emerald-500/20 text-emerald-400 rounded-lg text-xs hover:bg-emerald-500/30">Save</button>
                      <button onClick={() => setEditingNotes(null)} className="px-3 py-1.5 bg-gray-800 text-gray-400 rounded-lg text-xs">Cancel</button>
                    </div>
                  ) : (
                    <button
                      onClick={() => { setEditingNotes(item.id); setNotesDraft(item.notes || ''); }}
                      className="text-xs text-gray-600 hover:text-gray-400"
                    >
                      {item.notes ? `Notes: ${item.notes}` : '+ Add notes'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
