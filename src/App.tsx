import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import ErrorBoundary from './components/ErrorBoundary';
import DashboardPage from './pages/DashboardPage';
import PlayerSearchPage from './pages/PlayerSearchPage';
import PlayerProfilePage from './pages/PlayerProfilePage';
import TrendEnginePage from './pages/TrendEnginePage';
import ImportPage from './pages/ImportPage';
import MatchHubPage from './pages/MatchHubPage';
import MatchDetailPage from './pages/MatchDetailPage';
import OddsScreenPage from './pages/OddsScreenPage';
import EVCalculatorPage from './pages/EVCalculatorPage';
import MultiBuilderPage from './pages/MultiBuilderPage';
import TeamStatsPage from './pages/TeamStatsPage';
import RoleTrendsPage from './pages/RoleTrendsPage';
import PlayerFormPage from './pages/PlayerFormPage';
import BetTrackerPage from './pages/BetTrackerPage';
import WatchlistPage from './pages/WatchlistPage';
import PositionGroupsPage from './pages/PositionGroupsPage';
import PositionEdgePage from './pages/PositionEdgePage';
import MatchupDebugPage from './pages/MatchupDebugPage';
import DataFreshnessAuditPage from './pages/DataFreshnessAuditPage';
import SampleAuditPage from './pages/SampleAuditPage';
import MissingStatsRepairPage from './pages/MissingStatsRepairPage';

export default function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<MatchHubPage />} />
          <Route path="/matches" element={<MatchHubPage />} />
          <Route path="/matches/:matchId" element={<MatchDetailPage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/players" element={<PlayerSearchPage />} />
          <Route path="/players/:id" element={<PlayerProfilePage />} />
          <Route path="/odds" element={<OddsScreenPage />} />
          <Route path="/ev" element={<ErrorBoundary fallbackLabel="EV Calculator"><EVCalculatorPage /></ErrorBoundary>} />
          <Route path="/multi" element={<ErrorBoundary fallbackLabel="Multi Builder crashed. Open console and send the error."><MultiBuilderPage /></ErrorBoundary>} />
          <Route path="/team-stats" element={<ErrorBoundary fallbackLabel="Team Stats crashed. Open console and send the error."><TeamStatsPage /></ErrorBoundary>} />
          <Route path="/role-trends" element={<ErrorBoundary fallbackLabel="Role Trends crashed."><RoleTrendsPage /></ErrorBoundary>} />
          <Route path="/form" element={<PlayerFormPage />} />
          <Route path="/trends" element={<TrendEnginePage />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="/tracker" element={<BetTrackerPage />} />
          <Route path="/watchlist" element={<WatchlistPage />} />
          <Route path="/position-groups" element={<PositionGroupsPage />} />
          <Route path="/position-edge" element={<PositionEdgePage />} />
          <Route path="/matchup-debug" element={<MatchupDebugPage />} />
          <Route path="/data-freshness" element={<DataFreshnessAuditPage />} />
          <Route path="/sample-audit" element={<SampleAuditPage />} />
          <Route path="/missing-stats-repair" element={<MissingStatsRepairPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
