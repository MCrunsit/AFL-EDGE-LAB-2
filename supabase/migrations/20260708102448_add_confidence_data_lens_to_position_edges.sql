/*
# Add confidence and data_lens columns to position_edges

1. Modified Tables
- `position_edges`
  - Add `confidence` (text, default 'low') — confidence level: low/weak/moderate/strong
  - Add `data_lens` (text, default 'all_data') — data lens used: this_season/last_2_seasons/all_data
2. Notes
- These columns are nullable with defaults so existing rows are not broken.
- No data loss — only additive columns.
*/

DO $$ BEGIN
  ALTER TABLE position_edges ADD COLUMN IF NOT EXISTS confidence text DEFAULT 'low';
  ALTER TABLE position_edges ADD COLUMN IF NOT EXISTS data_lens text DEFAULT 'all_data';
END $$;
