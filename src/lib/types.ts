export type Database = {
  public: {
    Tables: {
      players: {
        Row: Player;
        Insert: Omit<Player, 'id' | 'created_at'>;
        Update: Partial<Omit<Player, 'id' | 'created_at'>>;
      };
      matches: {
        Row: Match;
        Insert: Omit<Match, 'id' | 'created_at'>;
        Update: Partial<Omit<Match, 'id' | 'created_at'>>;
      };
      player_game_stats: {
        Row: PlayerGameStat;
        Insert: Omit<PlayerGameStat, 'id' | 'created_at'>;
        Update: Partial<Omit<PlayerGameStat, 'id' | 'created_at'>>;
      };
      player_prop_odds: {
        Row: PlayerPropOdds;
        Insert: Omit<PlayerPropOdds, 'id' | 'created_at'>;
        Update: Partial<Omit<PlayerPropOdds, 'id' | 'created_at'>>;
      };
      sync_metadata: {
        Row: SyncMetadata;
        Insert: Omit<SyncMetadata, 'updated_at'>;
        Update: Partial<Omit<SyncMetadata, 'year' | 'updated_at'>>;
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
  bookmaker_player_name: string | null;
  fetched_at: string;
  valid_until: string | null;
  source: string;
  raw_api_response?: Record<string, unknown> | null;
  created_at: string;
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
