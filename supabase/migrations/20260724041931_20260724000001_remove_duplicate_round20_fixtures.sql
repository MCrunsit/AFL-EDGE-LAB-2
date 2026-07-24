-- Remove 9 duplicate Round 20 fixtures that have alternate team-name suffixes
-- (e.g. "Collingwood Magpies", "Fremantle Dockers"), no venue, and zero odds.
-- These are garbage duplicates of the 9 genuine Round 20 matches that have
-- proper venues, commence times, and bookmaker odds.
-- Verified: zero player_game_stats, zero bookmaker_odds, zero player_role_data
-- reference any of these 9 match IDs.

DELETE FROM matches
WHERE id IN (
  '55d137f3-b07f-4071-930b-ebb9cb7fd1d7',
  'fb2c08d0-a3bf-4e38-94c7-654597bc137c',
  '36a096d0-899f-4c8e-8da9-f413359cb5c5',
  '8b03be53-b26d-4a6d-8a58-cff9bc8d3197',
  'b3248019-b44e-4a16-a464-a085e43a496a',
  '7e44c44c-fd62-4295-bd01-5a07571a3964',
  'fea279a5-a3ee-45eb-a2ec-bc1343ff3102',
  'a285ee2e-de88-4243-b73a-ff54d8eebb67',
  'f1785672-30f3-471a-8d2c-79a9629d4fdf'
);
