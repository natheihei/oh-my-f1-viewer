/** Two drivers side by side in numbers: positions, the gap and its trend, laps, tyres, speed trap and DRS or Overtake range. */
import { useMemo } from 'react';
import Type from 'typebox';
import { defineComponent, useLive, useSql, type ChaseAid } from '../../host';
import {
  ChartCanvas,
  ChartFrame,
  compactSmall,
  codeOf,
  colors,
  compoundLetter,
  formatLapTime,
  gapSeconds,
  gapTrend,
  hline,
  num,
  styleOf,
  text,
  textWidth,
  toLeader,
  tyreAgeNow,
  tyreColour,
  useDriverStyles,
  type Box,
  type Ctx,
  type DriverStyle,
} from './kit';

const NEEDS = ['timing' as const];

/** The trend is the change over this many laps. */
const TREND_LAPS = 3;

// Both drivers' laps, then each one's best speed-trap reading so far.
export const SQL = `
SELECT 'lap' AS kind, driver_number, lap_number, date_end, lap_duration, position, gap_to_leader, interval, stint_number, compound, tyre_age, NULL AS trap
FROM lap_summary WHERE driver_number IN (?1, ?2)
UNION ALL
SELECT 'trap', driver_number, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, MAX(st_speed)
FROM laps WHERE driver_number IN (?1, ?2) GROUP BY driver_number`;

export interface BattleSide {
  driver: number;
  position: number | null;
  /** Seconds. */
  last: number | null;
  best: number | null;
  compound: string | null;
  age: number | null;
  /** The best speed-trap reading so far, km/h. */
  trap: number | null;
}

export interface BattleModel {
  /** In the order asked for. */
  sides: [BattleSide, BattleSide];
  /** Which side is ahead on the road, or null before either has a position. */
  ahead: 0 | 1 | null;
  /** Seconds between them, or null when it can't be told (a lapped car, or no gaps yet). */
  gap: number | null;
  /** How much the gap grew per lap over the last laps: negative is closing. */
  trend: number | null;
  /** The car behind is close enough for the season's DRS or Overtake. Null when the gap isn't known. */
  inRange: boolean | null;
}

/**
 * The rows of `SQL` as the two sides of the card, and what's between them. `within` is the gap, in seconds, under
 * which the car behind gets DRS or Overtake. It's from the interval, so it works live too.
 */
export function battleModel(rows: ReadonlyArray<Record<string, unknown>>, [a, b]: readonly [number, number], within: number): BattleModel {
  const laps = (driver: number) =>
    rows.filter((r) => r.kind === 'lap' && num(r.driver_number) === driver && num(r.lap_number) !== null).sort((x, y) => num(x.lap_number)! - num(y.lap_number)!);
  const own = [laps(a), laps(b)];

  const side = (driver: number, mine: Array<Record<string, unknown>>): BattleSide => {
    const latest = mine.at(-1);
    const times = mine.map((r) => num(r.lap_duration)).filter((t): t is number => t !== null && t > 0);
    const timed = mine.filter((r) => num(r.lap_duration) !== null);
    const trap = rows.find((r) => r.kind === 'trap' && num(r.driver_number) === driver);
    return {
      driver,
      position: latest ? num(latest.position) : null,
      last: num(timed.at(-1)?.lap_duration),
      best: times.length ? Math.min(...times) : null,
      compound: typeof latest?.compound === 'string' ? latest.compound : null,
      age: latest ? tyreAgeNow(latest) : null,
      trap: trap ? num(trap.trap) : null,
    };
  };
  const sides: [BattleSide, BattleSide] = [side(a, own[0]), side(b, own[1])];

  const [pa, pb] = [sides[0].position, sides[1].position];
  const ahead = pa === null && pb === null ? null : pb === null || (pa !== null && pa < pb) ? 0 : 1;

  // Now: the interval of the car behind when they run nose to tail, else the difference of their gaps to the leader.
  let gap: number | null = null;
  const [la, lb] = [own[0].at(-1), own[1].at(-1)];
  if (ahead !== null && la && lb && pa !== null && pb !== null) {
    const behind = ahead === 0 ? lb : la;
    if (Math.abs(pa - pb) === 1) gap = gapSeconds(behind.interval);
    if (gap === null) {
      const [ga, gb] = [toLeader(la), toLeader(lb)];
      gap = ga !== null && gb !== null ? Math.abs(gb - ga) : null;
    }
  }

  const trend = gapTrend([...own[0], ...own[1]], [a, b], TREND_LAPS);

  return { sides, ahead, gap, trend, inRange: gap === null ? null : gap < within };
}

interface Drawn extends BattleModel {
  styles: [DriverStyle, DriverStyle];
  /** The season's DRS or Overtake, from the spec. */
  aid: ChaseAid;
}

/** Which side has the better value, so it's set in weight: lower for times, higher for speed. */
function better(a: number | null, b: number | null, lowerWins: boolean): 0 | 1 | null {
  if (a === null || b === null || a === b) return null;
  return a < b === lowerWins ? 0 : 1;
}

function draw(ctx: Ctx, m: Drawn, box: Box): void {
  const { width, height } = box;
  const compact = compactSmall(box);
  const c = colors();
  const pad = compact ? 6 : 10;
  const [left, right] = [pad, width - pad];
  const mid = width / 2;
  const code = compact ? 13 : Math.min(18, Math.max(13, Math.floor(height / 10)));
  const big = compact ? 15 : Math.min(18, Math.max(14, Math.floor(height / 10)));

  // The header: each driver with a team bar and position, and the gap in the middle.
  const top = compact ? 6 : 8;
  const headY = top + code / 2 + 1;
  m.styles.forEach((style, i) => {
    const x = i === 0 ? left : right;
    ctx.fillStyle = style.colour;
    ctx.fillRect(i === 0 ? x : x - 3, top, 3, code + 2);
    const at = i === 0 ? x + 8 : x - 8;
    const align = i === 0 ? 'left' : 'right';
    text(ctx, style.code, at, headY, { align, color: c.ink, size: code, weight: 600 });
    const position = m.sides[i].position;
    if (position !== null) {
      // Beside the code, or under it in the strip.
      const shift = compact ? 0 : (textWidth(ctx, style.code, code, 600) + 6) * (i === 0 ? 1 : -1);
      text(ctx, `P${position}`, at + shift, compact ? headY + code + 2 : headY + 1, { align, color: c.ink, size: compact ? 10 : 11 });
    }
  });
  text(ctx, m.gap === null ? '—' : m.gap.toFixed(m.gap < 10 ? 2 : 1), mid, headY, { align: 'center', color: c.ink, size: big, weight: 600 });
  if (compact) {
    if (m.inRange) text(ctx, m.aid.label, mid, headY + big, { align: 'center', color: c.ink, size: 9, weight: 600 });
    return;
  }
  if (m.trend !== null) {
    const word = Math.abs(m.trend) < 0.005 ? 'steady' : m.trend < 0 ? 'closing' : 'opening';
    text(ctx, word === 'steady' ? 'steady' : `${word} ${Math.abs(m.trend).toFixed(2)}/lap`, mid, headY + big / 2 + 8, { align: 'center' });
  }

  // The rows: values either side, the label in the middle.
  const [a, b] = m.sides;
  const behind = m.ahead === null ? null : m.ahead === 0 ? 1 : 0;
  type Cell = { value: string; weight?: number };
  const pair = (va: string, vb: string, win: 0 | 1 | null): [Cell, Cell] => [
    { value: va, weight: win === 0 ? 600 : 400 },
    { value: vb, weight: win === 1 ? 600 : 400 },
  ];
  const range = (i: 0 | 1): Cell => ({ value: m.inRange === null || i !== behind ? '' : m.inRange ? 'IN RANGE' : '—', weight: m.inRange ? 600 : 400 });
  const rows: Array<[string, Cell, Cell]> = [
    ['LAST', ...pair(formatLapTime(a.last), formatLapTime(b.last), better(a.last, b.last, true))],
    ['BEST', ...pair(formatLapTime(a.best), formatLapTime(b.best), better(a.best, b.best, true))],
    ['TYRE', { value: '' }, { value: '' }],
    ['TRAP', ...pair(a.trap === null ? '' : `${a.trap}`, b.trap === null ? '' : `${b.trap}`, better(a.trap, b.trap, false))],
    [m.aid.label, range(0), range(1)],
  ];
  const first = headY + big / 2 + 18;
  const pitch = Math.min(26, Math.max(13, (height - first - 4) / rows.length));
  const size = pitch >= 22 ? 12 : pitch >= 16 ? 11 : 10;
  rows.forEach(([label, ca, cb], i) => {
    const y0 = first + i * pitch;
    if (y0 + pitch > height + 2) return;
    const y = y0 + pitch / 2 + 0.5;
    hline(ctx, left, right, y0);
    text(ctx, label, mid, y, { align: 'center', size: 10 });
    // A tyre's letter is in its colour, its age in ink.
    if (label === 'TYRE') {
      [a, b].forEach((side, k) => {
        if (!side.compound) return;
        const letter = compoundLetter(side.compound);
        const age = side.age === null ? '' : `${side.age} laps`;
        const colour = tyreColour(side.compound);
        if (k === 0) {
          text(ctx, letter, left, y, { color: colour, size, weight: 600 });
          text(ctx, age, left + textWidth(ctx, `${letter} `, size, 600), y, { color: c.ink, size });
        } else {
          text(ctx, age, right, y, { align: 'right', color: c.ink, size });
          text(ctx, letter, right - textWidth(ctx, ` ${age}`, size), y, { align: 'right', color: colour, size, weight: 600 });
        }
      });
      return;
    }
    text(ctx, ca.value, left, y, { color: c.ink, size, weight: ca.weight });
    text(ctx, cb.value, right, y, { align: 'right', color: c.ink, size, weight: cb.weight });
  });
}

const Drivers = Type.Array(Type.Integer({ description: 'A car number' }), {
  minItems: 2,
  maxItems: 2,
  description: 'The two drivers, as car numbers',
});

function BattleCard({ props }: { props: { drivers: number[] } }) {
  const [a, b] = props.drivers;
  const view = useSql(SQL, [a, b]);
  const styles = useDriverStyles();
  const aid = useLive((s) => s.spec.chaseAid);
  const model = useMemo(
    () =>
      view.state === 'ready'
        ? { ...battleModel(view.rows, [a, b], aid.within), styles: [styleOf(styles, a), styleOf(styles, b)] as [DriverStyle, DriverStyle], aid }
        : null,
    [view, styles, a, b, aid],
  );
  return (
    <ChartFrame needs={NEEDS} views={[view]}>
      {() => model && <ChartCanvas model={model} draw={draw} />}
    </ChartFrame>
  );
}

export default defineComponent({
  name: 'battle_card',
  title: 'Battle card',
  description:
    'Two drivers side by side in numbers: positions, the gap and whether it is closing, last and best lap, tyres and their age, speed trap, and whether the car behind is within range of DRS (Overtake from 2026). Suggest it with a battle when there is little room on screen.',
  args: Type.Object({ drivers: Drivers }),
  sessions: ['race', 'sprint'],
  needs: NEEDS,
  size: { aspect: 1.6, min: [6, 5] },
  spec: ({ drivers }) => ({ key: `battle_card:${drivers.join('-')}`, label: `${drivers.map(codeOf).join(' v ')}` }),
  View: BattleCard,
});
