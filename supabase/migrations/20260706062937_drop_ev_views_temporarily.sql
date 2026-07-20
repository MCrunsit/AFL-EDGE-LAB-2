-- Temporarily drop EV-derived views. Base tables (bookmaker_odds, player_prop_odds) are kept intact.
-- These views can be recreated later when EV/probability logic is explicitly re-enabled.

DROP VIEW IF EXISTS odds_with_ev;
DROP VIEW IF EXISTS best_available_odds;

-- Note: alt_lines_ladder table is kept (data preserved) but no longer queried by the app.
-- The app now reads ONLY from bookmaker_odds (raw).
