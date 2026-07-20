/*
# Add sample window columns to tracked_bets, tracked_multis, watchlist

1. Purpose
   Store which sample window was selected when a bet was tracked or watched,
   so the user can later see whether the bet came from Weighted Model, Last 10,
   Last 30, Current Season, or Custom Date Range.

2. Modified Tables
   - tracked_bets: add selected_sample_window (text), model_type (text)
   - tracked_multis: add selected_sample_window (text), model_type (text)
   - watchlist: add selected_sample_window (text), model_type (text)

   All columns are nullable (existing rows have no sample window).
   selected_sample_window stores values like 'weighted', 'last10', 'last30', 'season', 'custom'.
   model_type stores a human-readable label like 'Weighted Model', 'Last 10', etc.

3. Security
   No RLS policy changes — existing policies cover the new columns.
*/

ALTER TABLE tracked_bets
  ADD COLUMN IF NOT EXISTS selected_sample_window text,
  ADD COLUMN IF NOT EXISTS model_type text;

ALTER TABLE tracked_multis
  ADD COLUMN IF NOT EXISTS selected_sample_window text,
  ADD COLUMN IF NOT EXISTS model_type text;

ALTER TABLE watchlist
  ADD COLUMN IF NOT EXISTS selected_sample_window text,
  ADD COLUMN IF NOT EXISTS model_type text;
