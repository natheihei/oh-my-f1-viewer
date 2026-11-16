import { describe, expect, it } from 'vitest';
import type { DriverEntry } from '../../shared/sessionData';
import {
  mentionQuery,
  promptText,
  sayDriver,
  sayTeam,
  sayTile,
  searchDrivers,
  searchTeams,
  searchTiles,
  shortTeamName,
  teamsOf,
} from './mentions';

const driver = (driver_number: number, name_acronym: string, first_name: string, last_name: string): DriverEntry => ({
  driver_number,
  name_acronym,
  first_name,
  last_name,
  full_name: `${first_name} ${last_name.toUpperCase()}`,
  broadcast_name: null,
  team_name: null,
  team_colour: null,
  headshot_url: null,
  country_code: null,
});

const ROSTER = [
  driver(44, 'HAM', 'Lewis', 'Hamilton'),
  driver(1, 'NOR', 'Lando', 'Norris'),
  driver(16, 'LEC', 'Charles', 'Leclerc'),
  driver(10, 'GAS', 'Pierre', 'Gasly'),
  driver(14, 'ALO', 'Fernando', 'Alonso'),
  driver(27, 'HUL', 'Nico', 'Hülkenberg'),
  driver(4, 'PIA', 'Oscar', 'Piastri'),
];

const ids = (query: string) => searchDrivers(ROSTER, query).map((o) => o.id);

describe('mentionQuery', () => {
  it('finds the @ being typed', () => {
    expect(mentionQuery('compare @ham')).toEqual({ query: 'ham', start: 8 });
    expect(mentionQuery('@')).toEqual({ query: '', start: 0 });
    expect(mentionQuery('(@lew')).toEqual({ query: 'lew', start: 1 });
  });

  it('keeps spaces in the query', () => {
    expect(mentionQuery('@lewis ham')).toEqual({ query: 'lewis ham', start: 0 });
  });

  it('ignores an @ inside a word, or with nothing after it but a space', () => {
    expect(mentionQuery('mail me@home')).toBeNull();
    expect(mentionQuery('@ ham')).toBeNull();
    expect(mentionQuery('no mention')).toBeNull();
  });
});

describe('searchDrivers', () => {
  it('finds a driver by number, code, first name, surname or full name', () => {
    expect(ids('44')).toEqual(['44']);
    expect(ids('#44')).toEqual(['44']);
    expect(ids('HAM')).toEqual(['44']);
    expect(ids('lewis')).toEqual(['44']);
    expect(ids('Hamilton')).toEqual(['44']);
    expect(ids('lewis ham')).toEqual(['44']);
  });

  it('matches from the start of a name, ignoring accents', () => {
    expect(ids('lew')).toEqual(['44']);
    expect(ids('hulk')).toEqual(['27']);
    expect(ids('ilton')).toEqual([]);
  });

  it('puts an exact number first, then the numbers that start with it', () => {
    expect(ids('1')).toEqual(['1', '10', '14', '16']);
  });

  it('puts an exact code before a name that starts with it', () => {
    // NOR is Norris's code; nobody else starts with "nor", so one row.
    expect(ids('nor')).toEqual(['1']);
    // "pi": PIA by code, Pierre by first name; the code ranks first.
    expect(ids('pi')).toEqual(['4', '10']);
  });

  it('offers the whole roster for a bare @, by car number', () => {
    expect(ids('')).toEqual(['1', '4', '10', '14', '16', '27', '44']);
  });

  it('says who each row is', () => {
    expect(searchDrivers(ROSTER, 'ham')[0].detail).toBe('Lewis Hamilton  #44');
  });

  it('finds nothing in prose', () => {
    expect(ids('lewis is fast')).toEqual([]);
  });
});

describe('promptText', () => {
  it('says each mention as the agent reads it', () => {
    const say = (m: { id: string }) => sayDriver(m.id === '44' ? 'HAM' : 'RUS', Number(m.id));
    expect(promptText(['gap ', { kind: 'driver', id: '44' }, ' to ', { kind: 'driver', id: '63' }], say)).toBe('gap HAM (#44) to RUS (#63)');
  });

  it('says a driver with no code by number alone', () => {
    expect(sayDriver(null, 44)).toBe('#44');
    expect(sayDriver('44', 44)).toBe('#44');
  });
});

const member = (driver_number: number, name_acronym: string, team_name: string, team_colour: string): DriverEntry => ({
  ...driver(driver_number, name_acronym, name_acronym, name_acronym),
  team_name,
  team_colour,
});

const GRID = [
  member(1, 'VER', 'Red Bull Racing', '3671C6'),
  member(16, 'LEC', 'Ferrari', 'E8002D'),
  member(22, 'TSU', 'Red Bull Racing', '3671C6'),
  member(44, 'HAM', 'Ferrari', 'E8002D'),
  member(30, 'LAW', 'Racing Bulls', '6692FF'),
  member(87, 'BEA', 'Haas F1 Team', 'B6BABD'),
];
const TEAMS = teamsOf(GRID);
const CODES: Record<number, string> = { 1: 'VER', 16: 'LEC', 22: 'TSU', 44: 'HAM', 30: 'LAW', 87: 'BEA' };
const teamIds = (query: string) => searchTeams(TEAMS, query, (n) => CODES[n]).map((o) => o.id);

describe('teams', () => {
  it('gathers each team and its drivers from the roster, in the order its first driver comes', () => {
    expect(TEAMS.map((t) => [t.name, t.drivers])).toEqual([
      ['Red Bull Racing', [1, 22]],
      ['Ferrari', [16, 44]],
      ['Racing Bulls', [30]],
      ['Haas F1 Team', [87]],
    ]);
  });

  it('finds a team by any word of its name, from its start', () => {
    expect(teamIds('fer')).toEqual(['Ferrari']);
    expect(teamIds('bull')).toEqual(['Red Bull Racing', 'Racing Bulls']);
    expect(teamIds('haas')).toEqual(['Haas F1 Team']);
    expect(teamIds('rari')).toEqual([]);
  });

  it('puts a whole word before a word that starts with the query', () => {
    // "Racing" is a whole word of both; "racing bu" is the start of one name only.
    expect(teamIds('racing')).toEqual(['Red Bull Racing', 'Racing Bulls']);
    expect(teamIds('bulls')).toEqual(['Racing Bulls']);
  });

  it('offers every team for a bare @, after the drivers', () => {
    expect(teamIds('')).toEqual(['Red Bull Racing', 'Ferrari', 'Racing Bulls', 'Haas F1 Team']);
    const lastDriver = Math.max(...searchDrivers(GRID, '').map((o) => o.rank));
    expect(searchTeams(TEAMS, '', (n) => CODES[n]).every((o) => o.rank > lastDriver)).toBe(true);
  });

  it("lists a team's drivers in its row", () => {
    expect(searchTeams(TEAMS, 'fer', (n) => CODES[n])[0].detail).toBe('LEC · HAM  Ferrari');
  });

  it('shortens a name for its tag', () => {
    expect(shortTeamName('Red Bull Racing')).toBe('Red Bull');
    expect(shortTeamName('Haas F1 Team')).toBe('Haas');
    expect(shortTeamName('Racing Bulls')).toBe('Racing Bulls');
    expect(shortTeamName('Ferrari')).toBe('Ferrari');
  });

  it('says a team with its drivers, so the agent needs no lookup', () => {
    expect(sayTeam('Ferrari', [{ code: 'LEC', number: 16 }, { code: 'HAM', number: 44 }])).toBe('team Ferrari (LEC #16, HAM #44)');
    expect(sayTeam('Ferrari', [])).toBe('team Ferrari');
  });
});

const TILES = [
  { id: 'tile-1', label: 'Onboard HAM' },
  { id: 'tile-2', label: 'Gap to leader' },
  { id: 'tile-3', label: 'Battle NOR · PIA' },
];
const tileIds = (query: string) => searchTiles(TILES, query).map((o) => o.id);

describe('tiles', () => {
  it('finds a tile by any word of its label, codes included', () => {
    expect(tileIds('gap')).toEqual(['tile-2']);
    expect(tileIds('ham')).toEqual(['tile-1']);
    expect(tileIds('pia')).toEqual(['tile-3']);
    expect(tileIds('lead')).toEqual(['tile-2']);
    expect(tileIds('onboard ham')).toEqual(['tile-1']);
  });

  it('offers every tile for a bare @, before the drivers, with no detail', () => {
    const rows = searchTiles(TILES, '');
    expect(rows.map((o) => o.id)).toEqual(['tile-1', 'tile-2', 'tile-3']);
    expect(rows.every((o) => o.detail === '')).toBe(true);
    const firstDriver = Math.min(...searchDrivers(ROSTER, '').map((o) => o.rank));
    expect(rows.every((o) => o.rank < firstDriver)).toBe(true);
  });

  it('marks a typed match as on screen', () => {
    expect(searchTiles(TILES, 'gap')[0].detail).toBe('on screen');
  });

  it("ranks a driver's exact code above a tile that names them", () => {
    const driverRank = searchDrivers(ROSTER, 'ham')[0].rank;
    expect(driverRank).toBeLessThan(searchTiles(TILES, 'ham')[0].rank);
  });

  it('says a tile by label and id, and whether it has closed', () => {
    expect(sayTile('tile-2', 'Gap to leader', true)).toBe('tile "Gap to leader" (tile-2)');
    expect(sayTile('tile-1', 'Onboard HAM', false)).toBe('tile "Onboard HAM" (tile-1, closed)');
  });
});
