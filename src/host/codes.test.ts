import { describe, expect, it } from 'vitest';
import type { DriverEntry } from '../../shared/sessionData';
import { driverStyles, labelText, partsText } from './codes';

const entry = (driver_number: number, name_acronym: string, team_name: string, team_colour: string | null): DriverEntry => ({
  driver_number,
  name_acronym,
  team_name,
  team_colour,
  broadcast_name: null,
  full_name: null,
  first_name: null,
  last_name: null,
  headshot_url: null,
  country_code: null,
});

describe('driver colours', () => {
  it('uses the team colour, and dashes the second driver of a team', () => {
    const styles = driverStyles([entry(4, 'NOR', 'McLaren', 'F47600'), entry(44, 'HAM', 'Ferrari', 'ED1131'), entry(81, 'PIA', 'McLaren', 'F47600')]);
    expect(styles.get(4)).toEqual({ number: 4, code: 'NOR', colour: '#F47600', dashed: false });
    expect(styles.get(81)?.dashed).toBe(true);
    expect(styles.get(44)?.dashed).toBe(false);
  });

  it('falls back when the roster has no colour', () => {
    expect(driverStyles([entry(1, 'VER', 'Red Bull', null)]).get(1)?.colour).toBe('#8a8a8a');
  });
});

describe('driver codes as text', () => {
  const code = (n: number) => ({ 44: 'HAM', 1: 'NOR', 81: 'PIA' })[n] ?? String(n);

  it("labels a tile with its name, then its drivers' codes", () => {
    expect(labelText('Gap', [1, 81], code)).toBe('Gap NOR · PIA');
    expect(labelText('Telemetry', [44], code)).toBe('Telemetry HAM');
    expect(labelText('', [44], code)).toBe('HAM');
  });

  it('writes parts out with each driver as its code', () => {
    expect(partsText([{ driver: 44 }, ' lap 20 deleted · T1 limits'], code)).toBe('HAM lap 20 deleted · T1 limits');
    expect(partsText(['T1 ', { driver: 1 }, ' & ', { driver: 81 }], code)).toBe('T1 NOR & PIA');
  });
});
