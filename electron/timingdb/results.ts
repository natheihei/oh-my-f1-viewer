/**
 * The official results and starting grid, which the timing feeds don't carry, read from the tables
 * on formula1.com's results pages. Adapted from OpenF1's scrapers.
 */
import type { SessionResultEntry, StartingGridEntry } from '../../shared/sessionData';
import { durationSeconds } from './processors';

const text = (html: string): string =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

/** The first table on the page, as one object per row keyed by upper-case column heading. */
export function firstTable(html: string): Array<Record<string, string>> {
  const table = /<table[\s\S]*?<\/table>/i.exec(html)?.[0];
  if (!table || /no results available/i.test(table)) return [];
  const head = /<thead[\s\S]*?<\/thead>/i.exec(table)?.[0] ?? '';
  const headers = [...head.matchAll(/<th\b[\s\S]*?<\/th>/gi)].map((m) => text(m[0]).toUpperCase());
  const body = /<tbody[\s\S]*?<\/tbody>/i.exec(table)?.[0] ?? '';
  return [...body.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map((row) => {
    const cells = [...row[0].matchAll(/<td\b[\s\S]*?<\/td>/gi)].map((m) => text(m[0]));
    return Object.fromEntries(headers.map((header, i) => [header, cells[i] ?? '']));
  });
}

const STATUSES = ['DNF', 'DNS', 'DSQ'];

const integer = (value: string | undefined): number | null => (value && /^\d+$/.test(value) ? Number(value) : null);

/** A lap time, "+0.281s", "+1 LAP" or a status. */
function timeOrGap(value: string | undefined): number | string | null {
  if (!value) return null;
  if (STATUSES.includes(value)) return value;
  if (value.startsWith('+')) {
    if (value.toUpperCase().includes('LAP')) return value.toUpperCase();
    return value.endsWith('s') ? Number(value.slice(1, -1)) : null;
  }
  return durationSeconds(value);
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

export function parseResults(html: string): SessionResultEntry[] {
  const rows = firstTable(html).filter((row) => integer(row['NO.']) !== null);
  if (!rows.length) return [];
  const base = (row: Record<string, string>) => {
    const points = Number(row['PTS.'] ?? row.PTS);
    return {
      driver_number: integer(row['NO.'])!,
      position: integer(row['POS.']),
      number_of_laps: integer(row.LAPS),
      points: Number.isFinite(points) && (row['PTS.'] ?? row.PTS) ? points : null,
    };
  };

  if ('Q1' in rows[0]) {
    const parts = ['Q1', 'Q2', 'Q3'];
    const times = rows.map((row) => parts.map((part) => timeOrGap(row[part])));
    const best = parts.map((_, i) => {
      const values = times.map((t) => t[i]).filter((t): t is number => typeof t === 'number');
      return values.length ? Math.min(...values) : null;
    });
    return rows.map((row, r) => {
      const statuses = times[r].filter((t) => typeof t === 'string');
      return {
        ...base(row),
        dnf: statuses.includes('DNF'),
        dns: statuses.includes('DNS'),
        dsq: statuses.includes('DSQ'),
        duration: times[r].map((t) => (typeof t === 'number' ? t : null)),
        gap_to_leader: times[r].map((t, i) => {
          const fastest = best[i];
          return typeof t === 'number' && fastest ? round3(t - fastest) : null;
        }),
      };
    });
  }

  const column = (row: Record<string, string>) => row['TIME / RETIRED'] ?? row['TIME/RETIRED'] ?? row['TIME / GAP'] ?? row.TIME;
  const leader = rows.find((row) => integer(row['POS.']) === 1);
  const leaderTime = leader ? timeOrGap(column(leader)) : null;
  const leaderSeconds = typeof leaderTime === 'number' ? leaderTime : null;
  return rows.map((row): SessionResultEntry => {
    const time = timeOrGap(column(row));
    const status = typeof time === 'string' && STATUSES.includes(time) ? time : null;
    const isLeader = integer(row['POS.']) === 1;
    const entry = { ...base(row), dnf: status === 'DNF', dns: status === 'DNS', dsq: status === 'DSQ' };
    if (isLeader && leaderSeconds !== null) return { ...entry, duration: leaderSeconds, gap_to_leader: 0 };
    if (typeof time === 'number' && leaderSeconds !== null) return { ...entry, duration: round3(leaderSeconds + time), gap_to_leader: time };
    return { ...entry, duration: null, gap_to_leader: status ? null : time };
  });
}

export function parseStartingGrid(html: string): StartingGridEntry[] {
  return firstTable(html).flatMap((row) => {
    const driver = integer(row['NO.']);
    return driver === null ? [] : [{ driver_number: driver, position: integer(row['POS.']), lap_duration: durationSeconds(row.TIME) }];
  });
}

/** The pages for a session, by name. Practice is numbered, and an unknown session, such as testing, has none. */
export function resultPages(year: number, meetingKey: number, sessionName: string): { result: string | null; grid: string | null } {
  const name = sessionName.toLowerCase();
  const base = `https://www.formula1.com/en/results/${year}/races/${meetingKey}/aa`;
  const practice = /^practice (\d)$/.exec(name);
  const page = (slug: string) => `${base}/${slug}`;
  if (practice) return { result: page(`practice/${practice[1]}`), grid: null };
  if (name === 'qualifying') return { result: page('qualifying'), grid: null };
  if (name === 'sprint qualifying' || name === 'sprint shootout') return { result: page('sprint-qualifying'), grid: null };
  if (name === 'sprint') return { result: page('sprint-results'), grid: page('sprint-grid') };
  if (name === 'race') return { result: page('race-result'), grid: page('starting-grid') };
  return { result: null, grid: null };
}
