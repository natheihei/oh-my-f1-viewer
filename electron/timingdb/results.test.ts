import { describe, expect, it } from 'vitest';
import { firstTable, parseResults, parseStartingGrid, resultPages } from './results';

const table = (headers: string[], rows: string[][]) =>
  `<html><table class="x"><thead><tr>${headers.map((h) => `<th class="a"><span>${h}</span></th>`).join('')}</tr></thead>` +
  `<tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td><p>${cell}</p></td>`).join('')}</tr>`).join('')}</tbody></table></html>`;

describe('results pages', () => {
  it('reads a table by its headings', () => {
    expect(firstTable(table(['Pos.', 'No.'], [['1', '44']]))).toEqual([{ 'POS.': '1', 'NO.': '44' }]);
  });

  it('treats a page with no results as empty', () => {
    expect(firstTable('<table><tbody><tr><td>No results available</td></tr></tbody></table>')).toEqual([]);
    expect(firstTable('<html>nothing</html>')).toEqual([]);
  });

  it('reads a race result, from gaps to retirements', () => {
    const html = table(
      ['Pos.', 'No.', 'Driver', 'Team', 'Laps', 'Time / Retired', 'Pts.'],
      [
        ['1', '4', 'A', 'T', '57', '1:30:00.500', '25'],
        ['2', '1', 'B', 'T', '57', '+2.500s', '18'],
        ['3', '16', 'C', 'T', '56', '+1 lap', '15'],
        ['NC', '44', 'D', 'T', '10', 'DNF', '0'],
        ['DQ', '63', 'E', 'T', '57', 'DSQ', '0'],
      ],
    );
    const [first, second, third, retired, disqualified] = parseResults(html);
    expect(first).toMatchObject({ driver_number: 4, position: 1, number_of_laps: 57, points: 25, duration: 5400.5, gap_to_leader: 0, dnf: false });
    expect(second).toMatchObject({ duration: 5403, gap_to_leader: 2.5 });
    expect(third).toMatchObject({ duration: null, gap_to_leader: '+1 LAP' });
    expect(retired).toMatchObject({ position: null, dnf: true, duration: null, gap_to_leader: null });
    expect(disqualified).toMatchObject({ position: null, dsq: true });
  });

  it('reads qualifying into one value per part', () => {
    const html = table(
      ['Pos.', 'No.', 'Driver', 'Team', 'Q1', 'Q2', 'Q3', 'Laps'],
      [
        ['1', '4', 'A', 'T', '1:20.000', '1:19.000', '1:18.000', '20'],
        ['2', '1', 'B', 'T', '1:20.500', '1:19.100', 'DNS', '15'],
        ['3', '16', 'C', 'T', '1:21.000', '', '', '8'],
      ],
    );
    const [first, second, third] = parseResults(html);
    expect(first).toMatchObject({ duration: [80, 79, 78], gap_to_leader: [0, 0, 0] });
    expect(second).toMatchObject({ duration: [80.5, 79.1, null], gap_to_leader: [0.5, 0.1, null], dns: true });
    expect(third).toMatchObject({ duration: [81, null, null], dns: false });
  });

  it('reads a starting grid', () => {
    expect(parseStartingGrid(table(['Pos.', 'No.', 'Driver', 'Team', 'Time'], [['1', '4', 'A', 'T', '1:18.000'], ['2', '1', 'B', 'T', '']]))).toEqual([
      { driver_number: 4, position: 1, lap_duration: 78 },
      { driver_number: 1, position: 2, lap_duration: null },
    ]);
  });

  it('finds the page for each kind of session', () => {
    const base = 'https://www.formula1.com/en/results/2026/races/7/aa';
    expect(resultPages(2026, 7, 'Race')).toEqual({ result: `${base}/race-result`, grid: `${base}/starting-grid` });
    expect(resultPages(2026, 7, 'Sprint')).toEqual({ result: `${base}/sprint-results`, grid: `${base}/sprint-grid` });
    expect(resultPages(2026, 7, 'Qualifying')).toEqual({ result: `${base}/qualifying`, grid: null });
    expect(resultPages(2026, 7, 'Sprint Shootout').result).toBe(`${base}/sprint-qualifying`);
    expect(resultPages(2026, 7, 'Sprint Qualifying').result).toBe(`${base}/sprint-qualifying`);
    expect(resultPages(2026, 7, 'Practice 2').result).toBe(`${base}/practice/2`);
    expect(resultPages(2026, 7, 'Day 1')).toEqual({ result: null, grid: null });
  });
});
