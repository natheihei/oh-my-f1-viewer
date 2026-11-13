import { describe, expect, it } from 'vitest';
import type { DriverEntry } from '../../shared/sessionData';
import { mentionQuery, promptText, sayDriver, searchDrivers } from './mentions';

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
