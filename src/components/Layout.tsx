import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  TrendingUp, LayoutDashboard, Search, Activity,
  Upload, Menu, X, ChevronRight, Calendar,
  BarChart3, Calculator, Layers, User, Bookmark, Eye,
  Users, Crosshair, Bug, Database, Trophy
} from 'lucide-react';

const navGroups = [
  {
    label: 'Fixtures',
    items: [
      { to: '/matches', label: 'Match Hub', icon: Calendar },
      { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    ],
  },
  {
    label: 'Odds',
    items: [
      { to: '/odds', label: 'Odds Screen', icon: BarChart3 },
      { to: '/ev', label: 'EV Calculator', icon: Calculator },
      { to: '/multi', label: 'Multi Builder', icon: Layers },
      { to: '/team-stats', label: 'Team Stats', icon: Trophy },
      { to: '/role-trends', label: 'Role Trends', icon: Users },
      { to: '/tracker', label: 'Bet Tracker', icon: Bookmark },
      { to: '/watchlist', label: 'Watchlist', icon: Eye },
    ],
  },
  {
    label: 'Analytics',
    items: [
      { to: '/form', label: 'Player Form', icon: User },
      { to: '/players', label: 'Player Search', icon: Search },
      { to: '/trends', label: 'Trend Engine', icon: Activity },
      { to: '/position-edge', label: 'Position Edge', icon: Crosshair },
    ],
  },
  {
    label: 'Data',
    items: [
      { to: '/import', label: 'Import Data', icon: Upload },
      { to: '/data-freshness', label: 'Data Freshness Audit', icon: Database },
      { to: '/position-groups', label: 'Position Groups', icon: Users },
      { to: '/matchup-debug', label: 'Matchup Debug', icon: Bug },
      { to: '/sample-audit', label: 'Sample Audit', icon: Layers },
      { to: '/missing-stats-repair', label: 'Missing Stats Repair', icon: Database },
    ],
  },
];

const allNavItems = navGroups.flatMap(g => g.items);

export default function Layout({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const location = useLocation();

  const activePage = allNavItems.find(n => location.pathname.startsWith(n.to));

  return (
    <div className="min-h-screen bg-gray-950 flex">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-20 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={`
        fixed inset-y-0 left-0 z-30 w-64 bg-gray-900 border-r border-gray-800 flex flex-col
        transform transition-transform duration-200 ease-in-out
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        lg:translate-x-0 lg:static lg:z-auto
      `}>
        {/* Logo */}
        <div className="flex items-center gap-3 px-5 py-5 border-b border-gray-800">
          <div className="w-9 h-9 bg-emerald-500/10 border border-emerald-500/30 rounded-lg flex items-center justify-center shrink-0">
            <TrendingUp className="w-5 h-5 text-emerald-400" />
          </div>
          <div>
            <p className="text-white font-bold text-sm tracking-tight">AFL Edge Lab</p>
            <p className="text-gray-600 text-xs uppercase tracking-widest">Analytics</p>
          </div>
          <button className="ml-auto lg:hidden text-gray-500" onClick={() => setSidebarOpen(false)}>
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-4 overflow-y-auto">
          {navGroups.map(group => (
            <div key={group.label}>
              <p className="px-3 mb-1 text-[10px] font-semibold text-gray-600 uppercase tracking-widest">{group.label}</p>
              <div className="space-y-0.5">
                {group.items.map(({ to, label, icon: Icon }) => (
                  <NavLink
                    key={to}
                    to={to}
                    onClick={() => setSidebarOpen(false)}
                    className={({ isActive }) =>
                      `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all group ${
                        isActive
                          ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                          : 'text-gray-400 hover:text-white hover:bg-gray-800'
                      }`
                    }
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    {label}
                    <ChevronRight className="w-3 h-3 ml-auto opacity-0 group-hover:opacity-50 transition" />
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="bg-gray-900/80 backdrop-blur border-b border-gray-800 px-4 lg:px-6 py-4 flex items-center gap-4 sticky top-0 z-10">
          <button
            className="lg:hidden text-gray-400 hover:text-white"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu className="w-5 h-5" />
          </button>
          <div>
            <p className="text-white font-semibold text-sm">{activePage?.label ?? 'AFL Edge Lab'}</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden sm:inline-flex items-center gap-1.5 text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-1 rounded-full">
              <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse" />
              Live
            </span>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 px-4 lg:px-6 py-6 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
