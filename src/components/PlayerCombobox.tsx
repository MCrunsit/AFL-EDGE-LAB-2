import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Search, ChevronDown, X } from 'lucide-react';
import type { Player } from '../lib/types';

interface PlayerComboboxProps {
  players: Player[];
  value: string;
  onChange: (playerId: string) => void;
  placeholder?: string;
}

const ITEM_HEIGHT = 44;
const MAX_HEIGHT = 320;

export default function PlayerCombobox({ players, value, onChange, placeholder = 'Search players...' }: PlayerComboboxProps) {
  const safePlayers = Array.isArray(players) ? players : [];
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlightIdx, setHighlightIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = safePlayers.find(p => p?.id === value);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return safePlayers;
    return safePlayers.filter(p =>
      p?.name?.toLowerCase().includes(q) ||
      p?.team?.toLowerCase().includes(q) ||
      (p?.position?.toLowerCase().includes(q) ?? false)
    );
  }, [safePlayers, query]);

  // Reset highlight when filter changes
  useEffect(() => setHighlightIdx(0), [query]);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (!open || !listRef.current) return;
    const scrollTop = listRef.current.scrollTop;
    const targetTop = highlightIdx * ITEM_HEIGHT;
    const targetBottom = targetTop + ITEM_HEIGHT;
    if (targetTop < scrollTop) {
      listRef.current.scrollTop = targetTop;
    } else if (targetBottom > scrollTop + MAX_HEIGHT) {
      listRef.current.scrollTop = targetBottom - MAX_HEIGHT;
    }
  }, [highlightIdx, open]);

  const selectPlayer = useCallback((player: Player) => {
    onChange(player.id);
    setOpen(false);
    setQuery('');
  }, [onChange]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'Enter' || e.key === 'ArrowDown') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIdx(i => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIdx(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[highlightIdx]) selectPlayer(filtered[highlightIdx]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  // Virtualization: only render visible items
  const [scrollTop, setScrollTop] = useState(0);
  const visibleStart = Math.floor(scrollTop / ITEM_HEIGHT);
  const visibleCount = Math.ceil(MAX_HEIGHT / ITEM_HEIGHT) + 2; // buffer
  const startIdx = Math.max(0, visibleStart - 1);
  const endIdx = Math.min(filtered.length, startIdx + visibleCount);
  const visibleItems = filtered.slice(startIdx, endIdx);

  return (
    <div ref={containerRef} className="relative">
      {/* Trigger / Search input */}
      <div
        className="flex items-center gap-2 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 cursor-text"
        onClick={() => { setOpen(true); inputRef.current?.focus(); }}
      >
        <Search className="w-4 h-4 text-gray-500 shrink-0" />
        {open ? (
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="flex-1 bg-transparent text-white text-sm outline-none placeholder-gray-600"
            autoFocus
          />
        ) : selected ? (
          <span className="flex-1 text-white text-sm truncate">
            {selected.name} <span className="text-gray-500">— {selected.team}{selected.position ? ` — ${selected.position}` : ''}</span>
          </span>
        ) : (
          <span className="flex-1 text-gray-600 text-sm">{placeholder}</span>
        )}
        {selected && !open && (
          <button
            onClick={(e) => { e.stopPropagation(); onChange(''); }}
            className="text-gray-600 hover:text-gray-400"
          >
            <X className="w-4 h-4" />
          </button>
        )}
        <ChevronDown className={`w-4 h-4 text-gray-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </div>

      {/* Dropdown */}
      {open && (
        <div className="absolute z-50 left-0 right-0 mt-1 bg-gray-900 border border-gray-700 rounded-lg shadow-2xl overflow-hidden">
          {/* Results count */}
          <div className="px-3 py-1.5 text-xs text-gray-600 border-b border-gray-800 bg-gray-900">
            {filtered.length} player{filtered.length !== 1 ? 's' : ''}{query ? ` for "${query}"` : ''}
          </div>

          {filtered.length === 0 ? (
            <div className="px-3 py-8 text-center text-gray-600 text-sm">No players found</div>
          ) : (
            <div
              ref={listRef}
              className="overflow-y-auto"
              style={{ maxHeight: MAX_HEIGHT }}
              onScroll={e => setScrollTop((e.target as HTMLDivElement).scrollTop)}
            >
              {/* Spacer for virtualized items above */
                <div style={{ height: startIdx * ITEM_HEIGHT }} />
              }
              {visibleItems.map((p, i) => {
                if (!p) return null;
                const idx = startIdx + i;
                const isSelected = p.id === value;
                const isHighlighted = idx === highlightIdx;
                return (
                  <div
                    key={p.id}
                    style={{ height: ITEM_HEIGHT }}
                    className={`flex items-center px-3 cursor-pointer transition-colors ${
                      isHighlighted ? 'bg-emerald-500/10' : 'hover:bg-gray-800/50'
                    } ${isSelected ? 'border-l-2 border-emerald-500' : ''}`}
                    onClick={() => selectPlayer(p)}
                    onMouseEnter={() => setHighlightIdx(idx)}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-white text-sm font-medium truncate">{p.name}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-2">
                      <span className="text-gray-500 text-xs">{p.team}</span>
                      {p.position && <span className="text-gray-600 text-xs">{p.position}</span>}
                    </div>
                  </div>
                );
              })}
              {/* Spacer for virtualized items below */
                <div style={{ height: (filtered.length - endIdx) * ITEM_HEIGHT }} />
              }
            </div>
          )}
        </div>
      )}
    </div>
  );
}
