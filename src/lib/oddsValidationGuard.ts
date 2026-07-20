/**
 * Odds Sync Validation Guard
 *
 * MANDATORY CHECK: Called after every odds sync/ingest run.
 * Compares the raw API response values against the stored DB values.
 *
 * Assertions (NON-NEGOTIABLE):
 *   api.market === db.market  (exact string match, case-sensitive)
 *   api.line   === db.line    (exact numeric match)
 *
 * If ANY mismatch is found:
 *   - Logs a CRITICAL error with full details
 *   - Returns validation failure
 *   - The sync is considered corrupted
 *
 * This guard ensures the system is a transparent bookmaker data mirror.
 * No transformation, normalization, or inference is allowed.
 */

export interface OddsValidationEntry {
  bookmaker_id: string;
  player_id: string;
  match_id: string;
  api_market: string;
  db_market: string;
  api_line: number;
  db_line: number;
  market_match: boolean;
  line_match: boolean;
}

export interface OddsValidationResult {
  passed: boolean;
  total_checked: number;
  mismatches: number;
  entries: OddsValidationEntry[];
  critical_errors: string[];
}

/**
 * Validate that stored DB values exactly match the API response values.
 *
 * @param apiRows - The raw rows received from the bookmaker API
 * @param dbRows  - The rows as stored in bookmaker_odds after upsert
 *
 * @returns Validation result with per-row comparison
 */
export function validateOddsSync(
  apiRows: Array<{
    bookmaker_id: string;
    player_id: string;
    match_id: string;
    market: string;
    line: number;
  }>,
  dbRows: Array<{
    bookmaker_id: string;
    player_id: string;
    match_id: string;
    market: string;
    line: number;
  }>
): OddsValidationResult {
  const entries: OddsValidationEntry[] = [];
  const criticalErrors: string[] = [];
  let mismatches = 0;

  // Build a lookup of DB rows by (bookmaker_id, player_id, match_id, market, line)
  const dbLookup = new Map<string, typeof dbRows[0]>();
  for (const db of dbRows) {
    const key = `${db.bookmaker_id}|${db.player_id}|${db.match_id}|${db.market}|${db.line}`;
    dbLookup.set(key, db);
  }

  for (const api of apiRows) {
    const key = `${api.bookmaker_id}|${api.player_id}|${api.match_id}|${api.market}|${api.line}`;
    const db = dbLookup.get(key);

    if (!db) {
      mismatches++;
      const err = `MISSING in DB: bookmaker=${api.bookmaker_id} player=${api.player_id} market="${api.market}" line=${api.line}`;
      criticalErrors.push(err);
      console.error(`[ODDS VALIDATION] ${err}`);
      entries.push({
        bookmaker_id: api.bookmaker_id,
        player_id: api.player_id,
        match_id: api.match_id,
        api_market: api.market,
        db_market: '(not found)',
        api_line: api.line,
        db_line: NaN,
        market_match: false,
        line_match: false,
      });
      continue;
    }

    const marketMatch = api.market === db.market;
    const lineMatch = api.line === db.line;

    if (!marketMatch || !lineMatch) {
      mismatches++;
      const err = `MISMATCH: bookmaker=${api.bookmaker_id} player=${api.player_id} | api.market="${api.market}" db.market="${db.market}" match=${marketMatch} | api.line=${api.line} db.line=${db.line} match=${lineMatch}`;
      criticalErrors.push(err);
      console.error(`[ODDS VALIDATION] ${err}`);
    }

    entries.push({
      bookmaker_id: api.bookmaker_id,
      player_id: api.player_id,
      match_id: api.match_id,
      api_market: api.market,
      db_market: db.market,
      api_line: api.line,
      db_line: db.line,
      market_match: marketMatch,
      line_match: lineMatch,
    });
  }

  const result: OddsValidationResult = {
    passed: mismatches === 0,
    total_checked: apiRows.length,
    mismatches,
    entries,
    critical_errors: criticalErrors,
  };

  if (result.passed) {
    console.log(`[ODDS VALIDATION] PASSED — ${result.total_checked} rows verified, 0 mismatches`);
  } else {
    console.error(`[ODDS VALIDATION] FAILED — ${result.mismatches}/${result.total_checked} rows mismatched`);
  }

  return result;
}
