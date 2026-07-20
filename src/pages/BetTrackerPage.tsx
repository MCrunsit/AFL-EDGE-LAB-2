import { useState, useEffect, useMemo, useCallback, Fragment } from 'react';
import { Bookmark, TrendingUp, TrendingDown, Minus, CheckCircle, XCircle, Clock, Trash2, Info, AlertTriangle, FileText } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { createBetSignature, createMultiSignature, checkDuplicateSingle, checkDuplicateMulti } from '../lib/betTracking';
import LoadingSpinner from '../components/LoadingSpinner';

interface TrackedBet {
  id: string;
  created_at: string;
  match_name: string;
  match_id: string | null;
  venue: string | null;
  player_name: string;
  player_id: string | null;
  market: string | null;
  line: string | null;
  display_label: string | null;
  odds_taken: number;
  base_conservative_probability: number | null;
  venue_adjustment: number | null;
  opponent_adjustment: number | null;
  adjusted_probability: number | null;
  adjusted_ev: number | null;
  confidence: string | null;
  sample_size: number | null;
  hit_count: number | null;
  stake_units: number;
  result: string;
  payout: number | null;
  profit_loss: number | null;
  closing_odds: number | null;
  clv_percent: number | null;
  notes: string | null;
  context_tags: string[] | null;
  position_group: string | null;
  position_edge_value: number | null;
  position_edge_significance: string | null;
  position_edge_adjustment: number | null;
  final_probability: number | null;
  final_ev: number | null;
  use_position_edge: boolean | null;
}

interface TrackedMulti {
  id: string;
  created_at: string;
  combined_odds: number;
  estimated_adjusted_probability: number | null;
  estimated_adjusted_ev: number | null;
  use_position_edge: boolean | null;
  estimated_final_probability: number | null;
  estimated_final_ev: number | null;
  stake_units: number;
  result: string;
  payout: number | null;
  profit_loss: number | null;
  closing_odds: number | null;
  clv_percent: number | null;
  notes: string | null;
  legs: TrackedMultiLeg[];
}

interface TrackedMultiLeg {
  id: string;
  multi_id: string;
  player_name: string;
  player_id: string | null;
  market: string | null;
  display_label: string | null;
  odds: number;
  adjusted_probability: number | null;
  adjusted_ev: number | null;
  match_name: string | null;
  position_group: string | null;
  position_edge_value: number | null;
  position_edge_significance: string | null;
  position_edge_adjustment: number | null;
  final_probability: number | null;
  final_ev: number | null;
}

type TabType = 'singles' | 'multis' | 'results';

export default function BetTrackerPage() {
  const [bets, setBets] = useState<TrackedBet[]>([]);
  const [multis, setMultis] = useState<TrackedMulti[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabType>('singles');
  const [filterResult, setFilterResult] = useState<string>('all');
  const [filterMarket, setFilterMarket] = useState<string>('all');
  const [filterPlayer, setFilterPlayer] = useState<string>('all');
  const [filterConfidence, setFilterConfidence] = useState<string>('all');
  const [editingNotes, setEditingNotes] = useState<string | null>(null);
  const [notesDraft, setNotesDraft] = useState('');
  const [editingClosingOdds, setEditingClosingOdds] = useState<string | null>(null);
  const [closingOddsDraft, setClosingOddsDraft] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<{ type: 'single' | 'multi'; id: string; description: string } | null>(null);
  const [deleteInProgress, setDeleteInProgress] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  const showMessage = useCallback((msg: string) => {
    setMessage(msg);
    setTimeout(() => setMessage(null), 4000);
  }, []);

  async function loadData() {
    setLoading(true);

    const [betsRes, multisRes] = await Promise.all([
      supabase.from('tracked_bets').select('*').order('created_at', { ascending: false }),
      supabase.from('tracked_multis').select('*').order('created_at', { ascending: false }),
    ]);

    setBets((betsRes.data as TrackedBet[]) || []);

    const multiData = (multisRes.data || []) as TrackedMulti[];
    if (multiData.length > 0) {
      const multiIds = multiData.map(m => m.id);
      const { data: legsData } = await supabase
        .from('tracked_multi_legs')
        .select('*')
        .in('multi_id', multiIds);

      const legsByMulti = new Map<string, TrackedMultiLeg[]>();
      for (const leg of legsData || []) {
        const mid = leg.multi_id as string;
        if (!legsByMulti.has(mid)) legsByMulti.set(mid, []);
        legsByMulti.get(mid)!.push(leg as TrackedMultiLeg);
      }

      const multisWithLegs = multiData.map(m => ({
        ...m,
        legs: legsByMulti.get(m.id) || [],
      }));

      setMultis(multisWithLegs);
    } else {
      setMultis([]);
    }

    setLoading(false);
  }

  async function settleBet(id: string, result: 'win' | 'loss' | 'push') {
    const bet = bets.find(b => b.id === id);
    if (!bet) return;

    let payout: number | null = null;
    let profitLoss: number | null = null;

    if (result === 'win') {
      payout = bet.odds_taken * bet.stake_units;
      profitLoss = payout - bet.stake_units;
    } else if (result === 'loss') {
      payout = 0;
      profitLoss = -bet.stake_units;
    } else {
      payout = bet.stake_units;
      profitLoss = 0;
    }

    await supabase
      .from('tracked_bets')
      .update({ result, payout, profit_loss: profitLoss })
      .eq('id', id);

    loadData();
  }

  async function settleMulti(id: string, result: 'win' | 'loss' | 'push') {
    const multi = multis.find(m => m.id === id);
    if (!multi) return;

    let payout: number | null = null;
    let profitLoss: number | null = null;

    if (result === 'win') {
      payout = multi.combined_odds * multi.stake_units;
      profitLoss = payout - multi.stake_units;
    } else if (result === 'loss') {
      payout = 0;
      profitLoss = -multi.stake_units;
    } else {
      payout = multi.stake_units;
      profitLoss = 0;
    }

    await supabase
      .from('tracked_multis')
      .update({ result, payout, profit_loss: profitLoss })
      .eq('id', id);

    loadData();
  }

  async function confirmDelete() {
    if (!deleteConfirm) return;

    setDeleteInProgress(true);

    try {
      if (deleteConfirm.type === 'single') {
        await supabase.from('tracked_bets').delete().eq('id', deleteConfirm.id);
        showMessage('Bet deleted');
      } else {
        // Delete legs first, then multi
        await supabase.from('tracked_multi_legs').delete().eq('multi_id', deleteConfirm.id);
        await supabase.from('tracked_multis').delete().eq('id', deleteConfirm.id);
        showMessage('Multi deleted');
      }
      loadData();
    } catch (err) {
      showMessage('Error deleting');
    } finally {
      setDeleteInProgress(false);
      setDeleteConfirm(null);
    }
  }

  // Unique markets and players for filter dropdowns
  const uniqueMarkets = useMemo(() => {
    const set = new Set<string>();
    bets.forEach(b => { if (b.market) set.add(b.market); });
    multis.forEach(m => m.legs.forEach(l => { if (l.market) set.add(l.market); }));
    return Array.from(set).sort();
  }, [bets, multis]);

  const uniquePlayers = useMemo(() => {
    const set = new Set<string>();
    bets.forEach(b => set.add(b.player_name));
    multis.forEach(m => m.legs.forEach(l => set.add(l.player_name)));
    return Array.from(set).sort();
  }, [bets, multis]);

  // Filtered lists
  const filteredBets = useMemo(() => {
    let result = bets;
    if (filterResult !== 'all') result = result.filter(b => b.result === filterResult);
    if (filterMarket !== 'all') result = result.filter(b => b.market === filterMarket);
    if (filterPlayer !== 'all') result = result.filter(b => b.player_name === filterPlayer);
    if (filterConfidence !== 'all') {
      result = result.filter(b => {
        const ev = (b.adjusted_ev ?? 0) * 100;
        if (filterConfidence === 'low') return ev < 5;
        if (filterConfidence === 'medium') return ev >= 5 && ev < 12;
        if (filterConfidence === 'high') return ev >= 12;
        return true;
      });
    }
    return result;
  }, [bets, filterResult, filterMarket, filterPlayer, filterConfidence]);

  const filteredMultis = useMemo(() => {
    let result = multis;
    if (filterResult !== 'all') result = result.filter(m => m.result === filterResult);
    if (filterMarket !== 'all') result = result.filter(m => m.legs.some(l => l.market === filterMarket));
    if (filterPlayer !== 'all') result = result.filter(m => m.legs.some(l => l.player_name === filterPlayer));
    if (filterConfidence !== 'all') {
      result = result.filter(m => {
        const ev = (m.estimated_adjusted_ev ?? 0) * 100;
        if (filterConfidence === 'low') return ev < 5;
        if (filterConfidence === 'medium') return ev >= 5 && ev < 12;
        if (filterConfidence === 'high') return ev >= 12;
        return true;
      });
    }
    return result;
  }, [multis, filterResult, filterMarket, filterPlayer, filterConfidence]);

  async function saveNotes(id: string, type: 'single' | 'multi') {
    const table = type === 'single' ? 'tracked_bets' : 'tracked_multis';
    await supabase.from(table).update({ notes: notesDraft }).eq('id', id);
    if (type === 'single') {
      setBets(prev => prev.map(b => b.id === id ? { ...b, notes: notesDraft } : b));
    } else {
      setMultis(prev => prev.map(m => m.id === id ? { ...m, notes: notesDraft } : m));
    }
    setEditingNotes(null);
  }

  async function saveClosingOdds(id: string, type: 'single' | 'multi') {
    const closingOdds = parseFloat(closingOddsDraft);
    if (isNaN(closingOdds) || closingOdds <= 0) return;
    const table = type === 'single' ? 'tracked_bets' : 'tracked_multis';
    const bet = type === 'single' ? bets.find(b => b.id === id) : null;
    const multi = type === 'multi' ? multis.find(m => m.id === id) : null;
    const takenOdds = bet?.odds_taken ?? multi?.combined_odds ?? 0;
    const clvPercent = takenOdds > 0 ? (takenOdds / closingOdds - 1) * 100 : null;
    await supabase.from(table).update({ closing_odds: closingOdds, clv_percent: clvPercent }).eq('id', id);
    if (type === 'single') {
      setBets(prev => prev.map(b => b.id === id ? { ...b, closing_odds: closingOdds, clv_percent: clvPercent } : b));
    } else {
      setMultis(prev => prev.map(m => m.id === id ? { ...m, closing_odds: closingOdds, clv_percent: clvPercent } : m));
    }
    setEditingClosingOdds(null);
  }

  // Stats
  const stats = useMemo(() => {
    const settledBets = bets.filter(b => b.result !== 'pending');
    const settledMultis = multis.filter(m => m.result !== 'pending');

    const totalStaked = bets.reduce((sum, b) => sum + b.stake_units, 0) +
                        multis.reduce((sum, m) => sum + m.stake_units, 0);

    const totalPayout = settledBets.reduce((sum, b) => sum + (b.payout || 0), 0) +
                        settledMultis.reduce((sum, m) => sum + (m.payout || 0), 0);

    const totalPnL = settledBets.reduce((sum, b) => sum + (b.profit_loss || 0), 0) +
                     settledMultis.reduce((sum, m) => sum + (m.profit_loss || 0), 0);

    const wins = settledBets.filter(b => b.result === 'win').length +
                 settledMultis.filter(m => m.result === 'win').length;

    const totalSettled = settledBets.length + settledMultis.length;

    return {
      totalBets: bets.length,
      totalMultis: multis.length,
      pendingBets: bets.filter(b => b.result === 'pending').length,
      pendingMultis: multis.filter(m => m.result === 'pending').length,
      totalStaked,
      totalPayout,
      totalPnL,
      roi: totalStaked > 0 ? (totalPnL / totalStaked) * 100 : 0,
      strikeRate: totalSettled > 0 ? (wins / totalSettled) * 100 : 0,
      avgOdds: bets.length > 0 ? bets.reduce((sum, b) => sum + b.odds_taken, 0) / bets.length : 0,
      avgEv: bets.length > 0 ? bets.reduce((sum, b) => sum + (b.adjusted_ev || 0), 0) / bets.length : 0,
    };
  }, [bets, multis]);

  if (loading) return <LoadingSpinner message="Loading tracked bets..." />;

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-center gap-3 flex-wrap">
        <Bookmark className="w-5 h-5 text-blue-400" />
        <h2 className="text-white font-bold text-lg">Bet Tracker</h2>
        <span className="text-xs text-gray-600">Track singles and multis · Settle results · Calculate ROI</span>
        {message && (
          <span className={`text-xs px-3 py-1 rounded-full ${message.includes('deleted') || message.includes('deleted') ? 'bg-blue-500/20 text-blue-400' : 'bg-emerald-500/20 text-emerald-400'}`}>
            {message}
          </span>
        )}
      </div>

      {/* Stats Dashboard */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-3 text-center">
          <p className="text-2xl font-bold text-white">{stats.totalPnL.toFixed(1)}</p>
          <p className="text-xs text-gray-500">P&L (units)</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-3 text-center">
          <p className={`text-2xl font-bold ${stats.roi >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {stats.roi >= 0 ? '+' : ''}{stats.roi.toFixed(1)}%
          </p>
          <p className="text-xs text-gray-500">ROI</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-3 text-center">
          <p className="text-2xl font-bold text-blue-400">{stats.strikeRate.toFixed(1)}%</p>
          <p className="text-xs text-gray-500">Strike Rate</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-3 text-center">
          <p className="text-2xl font-bold text-white">{stats.totalBets}</p>
          <p className="text-xs text-gray-500">Singles</p>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-3 text-center">
          <p className="text-2xl font-bold text-white">{stats.totalMultis}</p>
          <p className="text-xs text-gray-500">Multis</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => setActiveTab('singles')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition ${activeTab === 'singles' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
        >
          Singles ({bets.length})
        </button>
        <button
          onClick={() => setActiveTab('multis')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition ${activeTab === 'multis' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
        >
          Multis ({multis.length})
        </button>
        <button
          onClick={() => setActiveTab('results')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition ${activeTab === 'results' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
        >
          Settled
        </button>
        <div className="ml-auto flex items-center gap-2 flex-wrap">
          <select
            value={filterResult}
            onChange={e => setFilterResult(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
          >
            <option value="all">All Results</option>
            <option value="pending">Pending</option>
            <option value="win">Wins</option>
            <option value="loss">Losses</option>
          </select>
          <select
            value={filterMarket}
            onChange={e => setFilterMarket(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
          >
            <option value="all">All Markets</option>
            {uniqueMarkets.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
          <select
            value={filterPlayer}
            onChange={e => setFilterPlayer(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
          >
            <option value="all">All Players</option>
            {uniquePlayers.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <select
            value={filterConfidence}
            onChange={e => setFilterConfidence(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
          >
            <option value="all">All Confidence</option>
            <option value="low">Low (EV &lt; 5%)</option>
            <option value="medium">Medium (5-12%)</option>
            <option value="high">High (12%+)</option>
          </select>
        </div>
      </div>

      {/* Singles Tab */}
      {activeTab === 'singles' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          {filteredBets.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              <Bookmark className="w-10 h-10 mx-auto mb-3 text-gray-700" />
              <p>No singles tracked yet</p>
              <p className="text-xs mt-1">Track bets from the EV Calculator</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-800">
                <tr className="text-xs text-gray-500 uppercase border-b border-gray-700">
                  <th className="text-left px-4 py-3">Player</th>
                  <th className="text-left px-3 py-3">Market</th>
                  <th className="text-center px-3 py-3">Odds</th>
                  <th className="text-center px-3 py-3">Adj P</th>
                  <th className="text-center px-3 py-3">EV%</th>
                  <th className="text-center px-3 py-3">Stake</th>
                  <th className="text-center px-3 py-3">Close</th>
                  <th className="text-center px-3 py-3">CLV%</th>
                  <th className="text-center px-3 py-3">Result</th>
                  <th className="text-center px-3 py-3">P&L</th>
                  <th className="text-left px-3 py-3 font-medium">Pos Edge</th>
                  <th className="text-center px-3 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredBets.map(bet => (
                  <Fragment key={bet.id}>
                  <tr className="border-b border-gray-800/30 hover:bg-gray-800/30">
                    <td className="px-4 py-3 text-white font-medium max-w-[140px] truncate">{bet.player_name}</td>
                    <td className="px-3 py-3 text-gray-400 text-xs">{bet.market} {bet.display_label}</td>
                    <td className="px-3 py-3 text-center text-emerald-400 font-mono">{bet.odds_taken.toFixed(2)}</td>
                    <td className="px-3 py-3 text-center text-xs">{bet.adjusted_probability ? `${(bet.adjusted_probability * 100).toFixed(1)}%` : '—'}</td>
                    <td className="px-3 py-3 text-center text-xs text-blue-400">{bet.adjusted_ev ? `+${(bet.adjusted_ev * 100).toFixed(1)}%` : '—'}</td>
                    <td className="px-3 py-3 text-center text-white">{bet.stake_units}u</td>
                    <td className="px-3 py-3 text-center">
                      {editingClosingOdds === bet.id ? (
                        <div className="flex gap-1">
                          <input type="text" value={closingOddsDraft} onChange={e => setClosingOddsDraft(e.target.value)} className="w-16 bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-white text-xs" placeholder="1.90" autoFocus />
                          <button onClick={() => saveClosingOdds(bet.id, 'single')} className="text-emerald-400 text-xs">OK</button>
                          <button onClick={() => setEditingClosingOdds(null)} className="text-gray-500 text-xs">x</button>
                        </div>
                      ) : (
                        <button onClick={() => { setEditingClosingOdds(bet.id); setClosingOddsDraft(bet.closing_odds?.toString() || ''); }} className="text-gray-400 text-xs hover:text-white">
                          {bet.closing_odds ? bet.closing_odds.toFixed(2) : '+ Add'}
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-3 text-center text-xs">
                      {bet.clv_percent !== null ? (
                        <span className={bet.clv_percent >= 0 ? 'text-emerald-400 font-mono' : 'text-red-400 font-mono'}>
                          {bet.clv_percent >= 0 ? '+' : ''}{bet.clv_percent.toFixed(1)}%
                        </span>
                      ) : (
                        <span className="text-gray-600">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-center">
                      {bet.result === 'pending' ? (
                        <span className="text-amber-400 text-xs"><Clock className="w-3 h-3 inline mr-1" />Pending</span>
                      ) : bet.result === 'win' ? (
                        <span className="text-emerald-400 text-xs"><CheckCircle className="w-3 h-3 inline mr-1" />Win</span>
                      ) : bet.result === 'loss' ? (
                        <span className="text-red-400 text-xs"><XCircle className="w-3 h-3 inline mr-1" />Loss</span>
                      ) : (
                        <span className="text-gray-400 text-xs"><Minus className="w-3 h-3 inline mr-1" />Push</span>
                      )}
                    </td>
                    <td className={`px-3 py-3 text-center font-mono ${(bet.profit_loss || 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {bet.profit_loss !== null ? (bet.profit_loss >= 0 ? '+' : '') + bet.profit_loss.toFixed(1) : '—'}
                    </td>
                    <td className="px-3 py-2.5">
                      {bet.use_position_edge && bet.position_group ? (
                        <div className="flex flex-col gap-0.5">
                          <span className="text-[10px] text-gray-400">{bet.position_group}</span>
                          {bet.position_edge_adjustment !== null && bet.position_edge_adjustment !== 0 && (
                            <span className={`text-[10px] font-bold ${bet.position_edge_adjustment > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {bet.position_edge_adjustment > 0 ? '+' : ''}{(bet.position_edge_adjustment * 100).toFixed(1)}%
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-gray-600 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-center">
                      <div className="flex gap-1 justify-center">
                        {bet.result === 'pending' && (
                          <>
                            <button onClick={() => settleBet(bet.id, 'win')} className="p-1 bg-emerald-500/20 text-emerald-400 rounded hover:bg-emerald-500/30" title="Settle Win">
                              <CheckCircle className="w-3.5 h-3.5" />
                            </button>
                            <button onClick={() => settleBet(bet.id, 'loss')} className="p-1 bg-red-500/20 text-red-400 rounded hover:bg-red-500/30" title="Settle Loss">
                              <XCircle className="w-3.5 h-3.5" />
                            </button>
                            <button onClick={() => settleBet(bet.id, 'push')} className="p-1 bg-gray-500/20 text-gray-400 rounded hover:bg-gray-500/30" title="Settle Push">
                              <Minus className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                        <button
                          onClick={() => { setEditingNotes(bet.id); setNotesDraft(bet.notes || ''); }}
                          className="p-1 bg-gray-500/20 text-gray-400 rounded hover:bg-gray-500/30"
                          title="Notes"
                        >
                          <FileText className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setDeleteConfirm({ type: 'single', id: bet.id, description: `${bet.player_name} ${bet.market} ${bet.display_label}` })}
                          className="p-1 bg-red-500/20 text-red-400 rounded hover:bg-red-500/30"
                          title="Delete"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                  {editingNotes === bet.id && (
                    <tr className="bg-gray-800/20">
                      <td colSpan={12} className="px-4 py-2">
                        <div className="flex gap-2">
                          <input type="text" value={notesDraft} onChange={e => setNotesDraft(e.target.value)} placeholder="Add notes..." className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-white" autoFocus />
                          <button onClick={() => saveNotes(bet.id, 'single')} className="px-3 py-1.5 bg-emerald-500/20 text-emerald-400 rounded-lg text-xs">Save</button>
                          <button onClick={() => setEditingNotes(null)} className="px-3 py-1.5 bg-gray-800 text-gray-400 rounded-lg text-xs">Cancel</button>
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Multis Tab */}
      {activeTab === 'multis' && (
        <div className="space-y-4">
          {filteredMultis.length === 0 ? (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center text-gray-500">
              <Bookmark className="w-10 h-10 mx-auto mb-3 text-gray-700" />
              <p>No multis tracked yet</p>
              <p className="text-xs mt-1">Track multis from the Multi Builder</p>
            </div>
          ) : (
            filteredMultis.map(multi => (
              <div key={multi.id} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                <div className="px-4 py-3 bg-gray-800/40 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-white font-bold font-mono">{multi.combined_odds.toFixed(2)}x</span>
                    <span className="text-xs text-blue-400">+{((multi.estimated_adjusted_ev || 0) * 100).toFixed(1)}% EV</span>
                    <span className="text-xs text-gray-500">{multi.legs.length} legs</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {multi.result === 'pending' ? (
                      <span className="text-amber-400 text-xs"><Clock className="w-3 h-3 inline mr-1" />Pending</span>
                    ) : (
                      <span className={`${multi.result === 'win' ? 'text-emerald-400' : multi.result === 'loss' ? 'text-red-400' : 'text-gray-400'} text-xs`}>
                        {multi.result.toUpperCase()}
                      </span>
                    )}
                    {multi.profit_loss !== null && (
                      <span className={`font-mono ${multi.profit_loss >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {multi.profit_loss >= 0 ? '+' : ''}{multi.profit_loss.toFixed(1)}
                      </span>
                    )}
                  </div>
                </div>
                <div className="p-3 space-y-1">
                  {multi.legs.map((leg, i) => (
                    <div key={leg.id || i} className="flex items-center gap-2 text-xs">
                      <span className="text-white font-medium truncate">{leg.player_name}</span>
                      <span className="text-amber-300 font-mono">{leg.market} {leg.display_label}</span>
                      <span className="text-gray-400 font-mono ml-auto">{leg.odds.toFixed(2)}</span>
                      {leg.position_group && (
                        <span className="text-[10px] text-gray-500 ml-1">{leg.position_group}</span>
                      )}
                    </div>
                  ))}
                </div>
                <div className="px-4 py-2 border-t border-gray-800/50 flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-3 text-xs">
                    {multi.stake_units && <span className="text-white">{multi.stake_units}u</span>}
                    {multi.closing_odds && (
                      <span className="text-gray-400">Close: {multi.closing_odds.toFixed(2)}</span>
                    )}
                    {multi.clv_percent !== null && (
                      <span className={`font-mono ${multi.clv_percent >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        CLV: {multi.clv_percent >= 0 ? '+' : ''}{multi.clv_percent.toFixed(1)}%
                      </span>
                    )}
                    {editingClosingOdds === multi.id ? (
                      <div className="flex gap-1">
                        <input type="text" value={closingOddsDraft} onChange={e => setClosingOddsDraft(e.target.value)} className="w-16 bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-white text-xs" placeholder="1.90" autoFocus />
                        <button onClick={() => saveClosingOdds(multi.id, 'multi')} className="text-emerald-400 text-xs">OK</button>
                        <button onClick={() => setEditingClosingOdds(null)} className="text-gray-500 text-xs">x</button>
                      </div>
                    ) : (
                      <button onClick={() => { setEditingClosingOdds(multi.id); setClosingOddsDraft(multi.closing_odds?.toString() || ''); }} className="text-gray-500 hover:text-gray-300">
                        {multi.closing_odds ? '' : '+ Closing odds'}
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {editingNotes === multi.id ? (
                      <div className="flex gap-1">
                        <input type="text" value={notesDraft} onChange={e => setNotesDraft(e.target.value)} placeholder="Add notes..." className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white text-xs" autoFocus />
                        <button onClick={() => saveNotes(multi.id, 'multi')} className="text-emerald-400 text-xs">Save</button>
                        <button onClick={() => setEditingNotes(null)} className="text-gray-500 text-xs">Cancel</button>
                      </div>
                    ) : (
                      <button onClick={() => { setEditingNotes(multi.id); setNotesDraft(multi.notes || ''); }} className="text-gray-500 hover:text-gray-300 text-xs">
                        {multi.notes ? multi.notes : '+ Notes'}
                      </button>
                    )}
                    {multi.result === 'pending' && (
                      <>
                        <button onClick={() => settleMulti(multi.id, 'win')} className="p-1.5 bg-emerald-500/20 text-emerald-400 rounded hover:bg-emerald-500/30 text-xs">
                          <CheckCircle className="w-3.5 h-3.5 inline mr-1" />Win
                        </button>
                        <button onClick={() => settleMulti(multi.id, 'loss')} className="p-1.5 bg-red-500/20 text-red-400 rounded hover:bg-red-500/30 text-xs">
                          <XCircle className="w-3.5 h-3.5 inline mr-1" />Loss
                        </button>
                      </>
                    )}
                    <button
                      onClick={() => setDeleteConfirm({
                        type: 'multi',
                        id: multi.id,
                        description: `${multi.legs.length}-leg multi @ ${multi.combined_odds.toFixed(2)}`
                      })}
                      className="p-1.5 bg-red-500/20 text-red-400 rounded hover:bg-red-500/30 text-xs"
                    >
                      <Trash2 className="w-3.5 h-3.5 inline mr-1" />Delete
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Results Tab */}
      {activeTab === 'results' && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
          <h3 className="text-white font-semibold text-sm mb-4">Performance Summary</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="text-center">
              <p className="text-3xl font-bold text-white">{stats.totalStaked.toFixed(0)}</p>
              <p className="text-xs text-gray-500">Total Staked (units)</p>
            </div>
            <div className="text-center">
              <p className="text-3xl font-bold text-white">{stats.totalPayout.toFixed(1)}</p>
              <p className="text-xs text-gray-500">Total Payout</p>
            </div>
            <div className="text-center">
              <p className={`text-3xl font-bold ${stats.totalPnL >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {stats.totalPnL >= 0 ? '+' : ''}{stats.totalPnL.toFixed(1)}
              </p>
              <p className="text-xs text-gray-500">Total P&L</p>
            </div>
            <div className="text-center">
              <p className="text-3xl font-bold text-blue-400">{stats.avgEv.toFixed(1)}%</p>
              <p className="text-xs text-gray-500">Avg EV%</p>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-md w-full mx-4">
            <div className="flex items-center gap-3 mb-4">
              <AlertTriangle className="w-5 h-5 text-amber-400" />
              <h3 className="text-white font-semibold">Delete {deleteConfirm.type === 'single' ? 'Bet' : 'Multi'}?</h3>
            </div>
            <p className="text-gray-400 text-sm mb-6">
              This will permanently delete: <span className="text-white">{deleteConfirm.description}</span>
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setDeleteConfirm(null)}
                disabled={deleteInProgress}
                className="px-4 py-2 bg-gray-800 text-gray-300 rounded-lg hover:bg-gray-700 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                disabled={deleteInProgress}
                className="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-400 disabled:opacity-50 flex items-center gap-2"
              >
                {deleteInProgress ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Export functions for use in other components

