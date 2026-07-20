/**
 * Player Name Aliases
 *
 * Maps common nicknames and bookmaker variations to canonical player names.
 * Used in player search to ensure players are found regardless of which
 * name variation the bookmaker uses or user searches for.
 */

export const PLAYER_ALIASES: Record<string, string[]> = {
  // Sydney
  'Isaac Heeney': ['I.Heeney', 'Heeney'],
  'Errol Gulden': ['E.Gulden', 'Gulden'],
  'Chad Warner': ['C.Warner', 'Warner'],
  'Brodie Grundy': ['B.Grundy', 'Grundy'],
  'Jake Lloyd': ['J.Lloyd', 'Lloyd'],
  'James Rowbottom': ['J.Rowbottom', 'Rowbottom'],
  'Tom Papley': ['T.Papley', 'Papley'],
  'Will Hayward': ['W.Hayward', 'Hayward'],
  'Justin McInerney': ['J.McInerney', 'McInerney'],
  'Dane Rampe': ['D.Rampe', 'Rampe'],

  // Fremantle
  'Caleb Serong': ['C.Serong', 'Serong'],
  'Luke Jackson': ['L.Jackson', 'Jackson'],
  'Andrew Brayshaw': ['A.Brayshaw', 'Andy Brayshaw', 'Brayshaw'],
  'Hayden Young': ['H.Young', 'Young'],
  'Jordan Clark': ['J.Clark', 'Clark'],
  'Jye Amiss': ['J.Amiss', 'Amiss'],
  'Jaeger OMeara': ['J.OMeara', 'Jaeger OMeara', 'OMeara'],
  'Nat Fyfe': ['N.Fyfe', 'Fyfe'],
  'Sean Darcy': ['S.Darcy', 'Darcy'],
  'Michael Walters': ['M.Walters', 'Walters', 'Son Son'],

  // Carlton
  'Patrick Cripps': ['P.Cripps', 'Cripps'],
  'Sam Walsh': ['S.Walsh', 'Walsh'],
  'Charlie Curnow': ['C.Curnow', 'Curnow'],
  'Harry McKay': ['H.McKay', 'McKay'],
  'Adam Cerra': ['A.Cerra', 'Cerra'],
  'Marc Murphy': ['M.Murphy', 'Murphy'],
  'Jacob Weitering': ['J.Weitering', 'Weitering'],
  'George Hewett': ['G.Hewett', 'Hewett'],
  'Matt Kennedy': ['M.Kennedy', 'Kennedy'],
  'Nic Newman': ['N.Newman', 'Newman'],

  // Hawthorn
  'James Sicily': ['J.Sicily', 'Sicily'],
  'Karl Amon': ['K.Amon', 'Amon'],
  'Jai Newcombe': ['J.Newcombe', 'Newcombe'],
  'Josh Battle': ['J.Battle', 'Battle'],
  'Jack Gunston': ['J.Gunston', 'Gunston'],
  'Dylan Moore': ['D.Moore', 'Moore'],
  'Tom Mitchell': ['T.Mitchell', 'Mitchell'],
  'Changkuoth Jiath': ['C.Jiath', 'Jiath', 'Chang Jiath'],
  'James Worpel': ['J.Worpel', 'Worpel', 'The Worpedo'],

  // St Kilda
  'Jack Higgins': ['J.Higgins', 'Higgins'],
  'Bradley Hill': ['B.Hill', 'Hill'],
  'Jack Sinclair': ['J.Sinclair', 'Sinclair'],
  'Marcus Windhager': ['M.Windhager', 'Windhager'],
  'Nasiah Wanganeen-Milera': ['N.Wanganeen-Milera', 'NW Milera', 'Wanganeen Milera'],
  'Callum Wilkie': ['C.Wilkie', 'Wilkie'],
  'Rowan Marshall': ['R.Marshall', 'Marshall'],
  'Max King': ['M.King', 'King'],
  'Tim Membrey': ['T.Membrey', 'Membrey'],

  // Port Adelaide
  'Connor Rozee': ['C.Rozee', 'Rozee'],
  'Jason Horne-Francis': ['J.Horne-Francis', 'Horne-Francis', 'Horne Francis', 'Jason Horne Francis'],
  'Zak Butters': ['Z.Butters', 'Butters', 'Zak Butters Butters'],
  'Junior Rioli': ['J.Rioli', 'Rioli'],
  'Travis Boak': ['T.Boak', 'Boak'],
  'Ollie Wines': ['O.Wines', 'Wines'],
  'Charlie Dixon': ['C.Dixon', 'Dixon'],
  'Todd Marshall': ['T.Marshall', 'Marshall'],
  'Kane Farrell': ['K.Farrell', 'Farrell'],

  // Collingwood
  'Nick Daicos': ['N.Daicos', 'Daicos', 'N.Daicos Jnr'],
  'Josh Daicos': ['J.Daicos', 'Daicos'],
  'Jeremy Howe': ['J.Howe', 'Howe'],
  'Scott Pendlebury': ['S.Pendlebury', 'Pendlebury', 'Pendles'],
  'Patrick Lipinski': ['P.Lipinski', 'Lipinski'],
  'Jordan De Goey': ['J.De Goey', 'De Goey', 'DeGoey'],
  'Darcy Moore': ['D.Moore', 'Moore'],
  'Bobby Hill': ['B.Hill', 'Hill'],
  'Brody Mihocek': ['B.Mihocek', 'Mihocek'],
  'Lachlan Schultz': ['L.Schultz', 'Schultz'],
  'Will Hoskin-Elliott': ['W.Hoskin-Elliott', 'Hoskin-Elliott', 'Hoskin Elliott'],

  // North Melbourne
  'Harry Sheezel': ['H.Sheezel', 'Sheezel'],
  'Luke Davies-Uniacke': ['L.Davies-Uniacke', 'Davies-Uniacke', 'LDU'],
  'Jy Simpkin': ['J.Simpkin', 'Simpkin'],
  'Curtis Scott': ['C.Scott', 'Scott'],
  'Bailey Scott': ['B.Scott', 'Scott'],
  'Nick Larkey': ['N.Larkey', 'Larkey'],
  'Cam Zurhaar': ['C.Zurhaar', 'Zurhaar'],
  'Tarryn Thomas': ['T.Thomas', 'Thomas'],
  'Kayne Turner': ['K.Turner', 'Turner'],

  // Essendon
  'Zach Merrett': ['Z.Merrett', 'Merrett'],
  'Darcy Parish': ['D.Parish', 'Parish'],
  'Andrew McGrath': ['A.McGrath', 'McGrath'],
  'Jake Stringer': ['J.Stringer', 'Stringer'],
  'Sam Draper': ['S.Draper', 'Draper'],
  'Peter Wright': ['P.Wright', 'Wright', 'Wrighty'],
  'Jordan Ridley': ['J.Ridley', 'Ridley'],
  'Mason Redman': ['M.Redman', 'Redman'],

  // Geelong
  'Tom Atkins': ['T.Atkins', 'Atkins'],
  'Mark Blicavs': ['M.Blicavs', 'Blicavs'],
  'Patrick Dangerfield': ['P.Dangerfield', 'Dangerfield'],
  'Tom Hawkins': ['T.Hawkins', 'Hawkins'],
  'Jeremy Cameron': ['J.Cameron', 'Cameron'],
  'Cam Guthrie': ['C.Guthrie', 'Guthrie'],
  'Tom Stewart': ['T.Stewart', 'Stewart'],
  'Mitch Duncan': ['M.Duncan', 'Duncan'],

  // Brisbane
  'Lachie Neale': ['L.Neale', 'Neale'],
  'Hugh McCluggage': ['H.McCluggage', 'McCluggage'],
  'Joe Daniher': ['J.Daniher', 'Daniher'],
  'Charlie Cameron': ['C.Cameron', 'Cameron'],
  'Dayne Zorko': ['D.Zorko', 'Zorko'],
  'Oscar McInerney': ['O.McInerney', 'McInerney'],
  'Brandon Starcevich': ['B.Starcevich', 'Starcevich'],

  // Melbourne
  'Clayton Oliver': ['Clutz', 'C.Oliver', 'Oliver'],
  'Christian Petracca': ['Trac', 'C.Petracca', 'Petracca'],
  'Marcus Bontempelli': ['The Bont', 'M.Bontempelli', 'Bont', 'Bontempelli'],
  'Max Gawn': ['M.Gawn', 'Gawn', 'Gawnsey'],
  'Jack Viney': ['J.Viney', 'Viney'],
  'Ed Langdon': ['E.Langdon', 'Langdon'],
  'Jake Bowey': ['J.Bowey', 'Bowey'],
  'Bayley Fritsch': ['B.Fritsch', 'Fritsch'],

  // Richmond
  'Dustin Martin': ['D.Martin', 'Martin', 'Dusty'],
  'Trent Cotchin': ['T.Cotchin', 'Cotchin'],
  'Jack Riewoldt': ['J.Riewoldt', 'Riewoldt'],
  'Shai Bolton': ['S.Bolton', 'Bolton'],
  'Liam Baker': ['L.Baker', 'Baker'],
  'Noah Balta': ['N.Balta', 'Balta'],
  'Nick Vlastuin': ['N.Vlastuin', 'Vlastuin'],

  // West Coast
  'Tim Kelly': ['T.Kelly', 'Kelly'],
  'Andrew Gaff': ['A.Gaff', 'Gaff'],
  'Jack Darling': ['J.Darling', 'Darling'],
  'Jeremy McGovern': ['J.McGovern', 'McGovern'],
  'Tom Barrass': ['T.Barrass', 'Barrass'],
  'Liam Duggan': ['L.Duggan', 'Duggan'],

  // Western Bulldogs (Marcus Bontempelli already defined under Melbourne)
  'Tom Liberatore': ['T.Liberatore', 'Liberatore'],
  'Jack Macrae': ['J.Macrae', 'Macrae'],
  'Aaron Naughton': ['A.Naughton', 'Naughton'],
  'Josh Dunkley': ['J.Dunkley', 'Dunkley'],
  'Bailey Smith': ['B.Smith', 'Smith'],
  'Caleb Daniel': ['C.Daniel', 'Daniel'],
  'Ed Richards': ['E.Richards', 'Richards'],

  // Gold Coast
  'Touk Miller': ['T.Miller', 'Miller'],
  'Noah Anderson': ['N.Anderson', 'Anderson'],
  'Matt Rowell': ['M.Rowell', 'Rowell'],
  'David Swallow': ['D.Swallow', 'Swallow'],
  'Jarrod Witts': ['J.Witts', 'Witts'],
  'Ben King': ['B.King', 'King'],
  'Mabior Chol': ['M.Chol', 'Chol'],

  // GWS
  'Josh Kelly': ['J.Kelly', 'Kelly'],
  'Stephen Coniglio': ['S.Coniglio', 'Coniglio'],
  'Lachie Whitfield': ['L.Whitfield', 'Whitfield'],
  'Toby Greene': ['T.Greene', 'Greene'],
  'Jesse Hogan': ['J.Hogan', 'Hogan'],
  'Harry Himmelberg': ['H.Himmelberg', 'Himmelberg'],
  'Tom Green': ['T.Green', 'Green'],
  'Callan Ward': ['C.Ward', 'Ward'],
  'Nick Haynes': ['N.Haynes', 'Haynes'],

  // Adelaide
  'Jordan Dawson': ['J.Dawson', 'Dawson'],
  'Rory Laird': ['R.Laird', 'Laird'],
  'Matt Crouch': ['M.Crouch', 'Crouch'],
  'Brother Smith': ['B.Smith', 'Smith'],
  'Taylor Walker': ['T.Walker', 'Walker', 'Tex Walker', 'Tex'],
  'Darcy Fogarty': ['D.Fogarty', 'Fogarty'],
  'Izak Rankine': ['I.Rankine', 'Rankine'],

  // Special characters and names with apostrophes/hyphens
  'Massimo DAmbrosio': ['M.DAmbrosio', "M.D'Ambrosio", 'Massimo D Ambrosio', "Massimo D'Ambrosio", 'D Ambrosio'],
  'Brandon Zerk-Thatcher': ['B.Zerk-Thatcher', 'Zerk-Thatcher', 'Brandon Zerk Thatcher', 'Zerk Thatcher'],
  'Aliir Aliir': ['A.Aliir', 'Aliir'],
  'Kysaiah Pickett': ['Kozzy Pickett', 'Kosi Pickett', 'Kossie Pickett', 'K.Pickett', 'K.Pickett Jnr', 'Pickett'],
  'Naicos Daicos': ['N.Daicos', 'Daicos'],
};

// Build reverse lookup: alias -> canonical name
const aliasToCanonical = new Map<string, string>();
for (const [canonical, aliases] of Object.entries(PLAYER_ALIASES)) {
  // Add the canonical name itself
  const key = normalizeForAlias(canonical);
  aliasToCanonical.set(key, canonical);
  for (const alias of aliases) {
    aliasToCanonical.set(normalizeForAlias(alias), canonical);
  }
}

function normalizeForAlias(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * Given a search term, return all names that match (including aliases).
 * Used for odds lookup when bookmaker uses a nickname.
 */
export function findPlayerByAlias(searchTerm: string): string | null {
  const key = normalizeForAlias(searchTerm);
  return aliasToCanonical.get(key) ?? null;
}

/**
 * Check if two names match (including alias awareness).
 */
export function namesMatchViaAlias(name1: string, name2: string): boolean {
  const n1 = normalizeForAlias(name1);
  const n2 = normalizeForAlias(name2);
  if (n1 === n2) return true;

  const c1 = aliasToCanonical.get(n1);
  const c2 = aliasToCanonical.get(n2);
  if (c1 && c2 && c1 === c2) return true;
  if (c1 && c1 === name2) return true;
  if (c2 && c2 === name1) return true;

  return false;
}

/**
 * Expand a search term to include all aliases.
 * Returns the search term plus any aliases if found.
 */
export function expandSearchWithAliases(searchTerm: string): string[] {
  const results = [searchTerm];
  const canonical = findPlayerByAlias(searchTerm);
  if (canonical) {
    results.push(canonical);
    const aliases = PLAYER_ALIASES[canonical] ?? [];
    results.push(...aliases);
  }
  return results;
}

/**
 * Get all aliases for a canonical player name.
 */
export function getAliasesForPlayer(canonicalName: string): string[] {
  return PLAYER_ALIASES[canonicalName] ?? [];
}
