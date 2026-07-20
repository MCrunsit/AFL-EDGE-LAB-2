// supabase-js (postgrest-js 1.21+) only applies row typing when each table
// entry carries a `Relationships` field and the schema exposes `Views` and
// `Functions` keys. Without the full shape, `.from(...).select()` silently
// infers `never` for every row.
//
// `Simplify` is load-bearing, not cosmetic: postgrest-js requires each Row to
// satisfy `Record<string, unknown>`, and TS `interface` types (Match, Player,
// …) do NOT carry the implicit index signature that satisfies it — only object
// `type` aliases do. Mapping the interface through `{ [K in keyof T]: T[K] }`
// produces an equivalent alias that does satisfy it, so every Row below must be
// wrapped or the whole schema silently degrades back to `never`.
type Simplify<T> = { [K in keyof T]: T[K] };

// Insert/Update default to Partial<Row>: most columns have DB defaults
// (gen_random_uuid(), now(), DEFAULT values), so inserts legitimately omit
// them. A stricter Omit-based Insert would wrongly flag those valid partial
// inserts. Everything is run through Simplify — a raw `interface` in any of
// Row/Insert/Update fails the Record<string, unknown> constraint and silently
// degrades the ENTIRE schema back to `never`.
type TableDef<Row> = {
  Row: Simplify<Row>;
  Insert: Partial<Simplify<Row>>;
  Update: Partial<Simplify<Row>>;
  Relationships: [];
};

type ViewDef<Row> = {
  Row: Simplify<Row>;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      players: TableDef<Player>;
      matches: TableDef<Match>;
      player_game_stats: TableDef<PlayerGameStat>;
      player_prop_odds: TableDef<PlayerPropOdds>;
      sync_metadata: TableDef<SyncMetadata>;
      bookmaker_odds: TableDef<BookmakerOdds>;
      bookmakers: TableDef<Bookmaker>;
      match_odds: TableDef<MatchOdds>;
      odds_cache: TableDef<OddsCache>;
      player_position_overrides: TableDef<PlayerPositionOverride>;
      player_role_data: TableDef<PlayerRoleData>;
      position_edges: TableDef<PositionEdge>;
      raw_kali_player_game_stats: TableDef<RawKaliPlayerGameStat>;
      tracked_bets: TableDef<TrackedBet>;
      tracked_multis: TableDef<TrackedMulti>;
      tracked_multi_legs: TableDef<TrackedMultiLeg>;
      watchlist: TableDef<WatchlistItem>;
    };
    Views: {
      current_players: ViewDef<Player>;
      enriched_player_stats: ViewDef<EnrichedStat>;
    };
    Functions: {
      cleanup_expired_bookmaker_odds: {
        Args: Record<string, never>;
        Returns: undefined;
      };
      repair_bookmaker_player_links: {
        Args: Record<string, never>;
        Returns: {
          odds_rows_checked: number;
          already_correct: number;
          relinked_to_canonical: number;
          still_no_stats: number;
          errors: number;
        }[];
      };
    };
  };
};

export interface Player {
  id: string;
  name: string;
  team: string;
  position: string | null;
  position_group: string | null;
  is_active: boolean;
  last_season_played: number | null;
  games_last_two_seasons: number;
  created_at: string;
}

export type PositionGroup =
  | 'DEF-GEN'
  | 'DEF-KEY'
  | 'DEF-USER'
  | 'FWD-GEN'
  | 'FWD-KEY'
  | 'FWD-SML'
  | 'MID-FWD'
  | 'MID-INC'
  | 'MID-INU'
  | 'MID-OUT'
  | 'MID-TAG'
  | 'RUC-FWD'
  | 'RUC-MOB'
  | 'RUC-TAP'
  | 'WING'
  | 'UNKNOWN';

export const POSITION_GROUPS: PositionGroup[] = [
  'DEF-GEN',
  'DEF-KEY',
  'DEF-USER',
  'FWD-GEN',
  'FWD-KEY',
  'FWD-SML',
  'MID-FWD',
  'MID-INC',
  'MID-INU',
  'MID-OUT',
  'MID-TAG',
  'RUC-FWD',
  'RUC-MOB',
  'RUC-TAP',
  'WING',
  'UNKNOWN',
];

// Alias map: old/non-canonical names → canonical names
export const POSITION_GROUP_ALIASES: Record<string, PositionGroup> = {
  'MID-IN': 'MID-INC',
  'RUC': 'RUC-TAP',
  'DEF': 'DEF-GEN',
  'FWD': 'FWD-GEN',
  'MID': 'MID-OUT',
};

export interface PositionEdge {
  id: string;
  season: number;
  position_group: string;
  opponent_team: string;
  stat_type: string;
  games: number;
  avg_stat_against_opponent: number;
  league_avg_for_position: number;
  edge_value: number;
  consistency: number;
  significance: 'none' | 'significant' | 'very_significant';
  updated_at: string;
  confidence?: string | null;
  data_lens?: string | null;
}

export interface Match {
  id: string;
  season: number;
  round: string | null;
  home_team: string | null;
  away_team: string | null;
  venue: string | null;
  match_date: string | null;
  home_score: number | null;
  away_score: number | null;
  created_at: string;
  api_match_id?: string | null;
  commence_time_utc?: string | null;
}

export interface PlayerGameStat {
  id: string;
  player_id: string;
  match_id: string | null;
  match_date: string;
  team: string;
  opponent: string | null;
  venue: string | null;
  disposals: number;
  marks: number;
  tackles: number;
  goals: number;
  hitouts: number;
  created_at: string;
  player_name?: string | null;
  season?: number | null;
  round?: string | null;
  source?: string | null;
  imported_at?: string | null;
  updated_at?: string | null;
}

export type StatType = 'disposals' | 'goals' | 'tackles' | 'marks' | 'hitouts';

export interface PlayerWithStats extends Player {
  stats: PlayerGameStat[];
  avg_disposals?: number;
  avg_goals?: number;
  avg_marks?: number;
  avg_tackles?: number;
  avg_hitouts?: number;
  games_played?: number;
}

export interface PropAnalysis {
  hitRate: number;
  last5HitRate: number;
  last10HitRate: number;
  avgVsLine: number;
  confidenceScore: number;
  recommendation: 'YES' | 'NO' | 'MARGINAL';
  gamesAnalyzed: number;
  averageStat: number;
  maxStat: number;
  minStat: number;
}

export interface TrendPlayer {
  player: Player;
  stats: PlayerGameStat[];
  trend: 'improving' | 'declining' | 'breakout' | 'stable';
  trendScore: number;
  recent3Avg: number;
  recent10Avg: number;
  delta: number;
  statType: StatType;
}

export interface PlayerPropOdds {
  id: string;
  player_id: string;
  match_id: string | null;
  market: string;
  line: number;
  over_odds: number | null;
  under_odds: number | null;
  bookmaker: string | null;
  created_at: string;
}

export interface SyncMetadata {
  year: number;
  last_synced_at: string | null;
  stats_count: number;
  updated_at: string;
}

export interface UpcomingGame {
  match_id: string;
  opponent: string;
  venue: string | null;
  match_date: string;
  round: string | null;
  season: number;
  is_home: boolean;
}

export interface EnrichedStat extends PlayerGameStat {
  season: number | null;
  round: string | null;
  home_team: string | null;
  away_team: string | null;
  is_home: boolean | null;
}

export interface MatchupContext {
  avgVsOpponent: number;
  gamesVsOpponent: number;
  last3VsOpponent: number[];
  venueAvg: number;
  venueGames: number;
}

export interface MatchPlayerContext {
  player: Player;
  upcoming_match: {
    match_id: string;
    opponent: string;
    is_home: boolean;
    venue: string | null;
    match_date: string;
    round: string | null;
    season: number;
  } | null;
  last5_avg: number | null;
  season_avg: number | null;
  vs_opponent_avg: number | null;
  venue_split: { home: number | null; away: number | null; total: number | null };
  odds: PlayerPropOdds[];
}

export interface MatchWithPlayers extends Match {
  is_upcoming: boolean;
  home_players: MatchPlayerContext[];
  away_players: MatchPlayerContext[];
}

export interface FixtureSyncResult {
  success: number;
  errors: string[];
  total: number;
  skipped: number;
}

// Bookmaker odds types
export interface BookmakerOdds {
  id: string;
  bookmaker_id: string;
  player_id: string;
  match_id: string;
  market: string;
  raw_market?: string | null;
  line: number;
  raw_line?: string | null;
  over_odds: number;
  under_odds: number | null;
  bookmaker_player_name: string; // NOT NULL in DB (backfilled 'unknown')
  fetched_at: string;
  valid_until: string | null;
  source: string;
  raw_api_response?: Record<string, unknown> | null;
  created_at: string;
  market_type?: 'ou_line' | 'alt_ladder';
  base_line?: number | null;
  display_label?: string | null;
  resolved_player_name?: string | null;
  resolution_status?: string | null;
  resolution_reason?: string | null;
}

export interface Bookmaker {
  id: string;
  name: string;
  api_endpoint: string | null;
  is_active: boolean;
  last_fetch_at: string | null;
  fetch_interval_seconds: number;
  created_at: string;
}

export interface BookmakerIngestResult {
  success: boolean;
  bookmaker_id: string;
  odds_count: number;
  errors: string[];
  skipped: number;
  ingest_id: string;
  duration_ms: number;
}

// ---------------------------------------------------------------------------
// Row types for tables previously missing from the Database declaration.
// Column lists derived from supabase/migrations/ (applied in timestamp order).
// Later-added nullable columns are optional so existing inserts still compile.
// ---------------------------------------------------------------------------

export interface MatchOdds {
  id: string;
  match_id: string | null;
  bookmaker: string;
  market: string;
  home_odds: number | null;
  away_odds: number | null;
  home_point: number | null;
  away_point: number | null;
  total_point: number | null;
  over_odds: number | null;
  under_odds: number | null;
  source: string;
  updated_at: string;
  created_at: string;
}

export interface OddsCache {
  sport: string;
  raw_response?: Record<string, unknown> | null;
  fetched_at?: string;
  processed_at?: string | null;
  inserted_count?: number;
  skipped_count?: number;
  requests_remaining?: number | null;
}

export interface PlayerPositionOverride {
  id: string;
  player_name: string;
  team?: string | null;
  position_group: string;
  confidence?: string;
  source?: string;
  updated_at?: string | null;
}

export interface PlayerRoleData {
  id: string;
  player_id?: string | null;
  match_id?: string | null;
  round?: string | null;
  season?: number | null;
  cba_percentage?: number | null;
  cba_count?: number | null;
  team_cba_total?: number | null;
  kick_in_count?: number | null;
  kick_in_play_on_count?: number | null;
  kick_in_share?: number | null;
  source?: string | null;
  updated_at?: string | null;
}

export interface RawKaliPlayerGameStat {
  id: string;
  season: number;
  round?: string | null;
  match_id?: string | null;
  match_date?: string | null;
  raw_player_name: string;
  normalized_player_name?: string | null;
  team?: string | null;
  normalized_team?: string | null;
  opponent?: string | null;
  venue?: string | null;
  disposals?: number | null;
  marks?: number | null;
  tackles?: number | null;
  goals?: number | null;
  hitouts?: number | null;
  source?: string | null;
  failure_reason?: string | null;
  created_at?: string | null;
  player_id?: string | null;
}

export interface WatchlistItem {
  id: string;
  player_name: string;
  player_id?: string | null;
  market?: string | null;
  line?: string | null;
  display_label?: string | null;
  match_id?: string | null;
  match_name?: string | null;
  odds_at_watch: number;
  latest_odds?: number | null;
  model_probability?: number | null;
  adjusted_ev?: number | null;
  quality_score?: number | null;
  risk_level?: string | null;
  notes?: string | null;
  created_at?: string | null;
  selected_sample_window?: string | null;
  model_type?: string | null;
  position_group?: string | null;
  position_edge_value?: number | null;
  position_edge_significance?: string | null;
  position_edge_adjustment?: number | null;
  final_probability?: number | null;
  final_ev?: number | null;
  use_position_edge?: boolean | null;
  venue_edge_value?: number | null;
  venue_edge_label?: string | null;
  venue_edge_adjustment?: number | null;
  opponent_edge_value?: number | null;
  opponent_edge_label?: string | null;
  opponent_edge_adjustment?: number | null;
  total_matchup_adjustment?: number | null;
  use_venue_edge?: boolean | null;
  use_opponent_edge?: boolean | null;
}

export interface TrackedBet {
  id: string;
  created_at?: string | null;
  match_id?: string | null;
  match_name?: string | null;
  venue?: string | null;
  opponent?: string | null;
  player_name: string;
  player_id?: string | null;
  market?: string | null;
  line?: string | null;
  display_label?: string | null;
  bookmaker?: string | null;
  odds_taken: number;
  base_conservative_probability?: number | null;
  venue_adjustment?: number | null;
  opponent_adjustment?: number | null;
  adjusted_probability?: number | null;
  fair_odds?: number | null;
  adjusted_ev?: number | null;
  confidence?: string | null;
  sample_size?: number | null;
  hit_count?: number | null;
  venue_games?: number | null;
  opponent_games?: number | null;
  context_tags?: string[] | null;
  stake_units?: number | null;
  result?: 'pending' | 'win' | 'loss' | 'push' | null;
  payout?: number | null;
  profit_loss?: number | null;
  closing_odds?: number | null;
  clv_percent?: number | null;
  notes?: string | null;
  selected_sample_window?: string | null;
  model_type?: string | null;
  position_group?: string | null;
  position_edge_value?: number | null;
  position_edge_significance?: string | null;
  position_edge_adjustment?: number | null;
  final_probability?: number | null;
  final_ev?: number | null;
  use_position_edge?: boolean | null;
  venue_edge_value?: number | null;
  venue_edge_label?: string | null;
  venue_edge_adjustment?: number | null;
  opponent_edge_value?: number | null;
  opponent_edge_label?: string | null;
  opponent_edge_adjustment?: number | null;
  total_matchup_adjustment?: number | null;
  use_venue_edge?: boolean | null;
  use_opponent_edge?: boolean | null;
}

export interface TrackedMulti {
  id: string;
  created_at?: string | null;
  combined_odds: number;
  estimated_adjusted_probability?: number | null;
  estimated_adjusted_ev?: number | null;
  stake_units?: number | null;
  result?: 'pending' | 'win' | 'loss' | 'push' | null;
  payout?: number | null;
  profit_loss?: number | null;
  closing_odds?: number | null;
  clv_percent?: number | null;
  notes?: string | null;
  match_ids?: string[] | null;
  selected_sample_window?: string | null;
  model_type?: string | null;
  use_position_edge?: boolean | null;
  estimated_final_probability?: number | null;
  estimated_final_ev?: number | null;
  use_venue_edge?: boolean | null;
  use_opponent_edge?: boolean | null;
  estimated_total_matchup_adjustment?: number | null;
}

export interface TrackedMultiLeg {
  id: string;
  multi_id?: string | null;
  player_name: string;
  player_id?: string | null;
  market?: string | null;
  line?: string | null;
  display_label?: string | null;
  odds: number;
  adjusted_probability?: number | null;
  adjusted_ev?: number | null;
  venue_adjustment?: number | null;
  opponent_adjustment?: number | null;
  context_tags?: string[] | null;
  match_id?: string | null;
  match_name?: string | null;
  position_group?: string | null;
  position_edge_value?: number | null;
  position_edge_significance?: string | null;
  position_edge_adjustment?: number | null;
  final_probability?: number | null;
  final_ev?: number | null;
  venue_edge_value?: number | null;
  venue_edge_label?: string | null;
  venue_edge_adjustment?: number | null;
  opponent_edge_value?: number | null;
  opponent_edge_label?: string | null;
  opponent_edge_adjustment?: number | null;
  total_matchup_adjustment?: number | null;
}
