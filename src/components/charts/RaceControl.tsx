/**
 * Race control's messages, newest first, as a list that scrolls: a line on top for what is in force, then
 * each lap's messages under its heading, each with a small flag where it carries one.
 */
import { useMemo } from 'react';
import Type from 'typebox';
import { defineComponent, useSql } from '../../host';
import { ChartFrame, num, styleOf, useDriverStyles, type DriverStyle } from './kit';
import {
  caseText,
  parseCase,
  sameCase,
  sentenceCase,
  shorten,
  signalOf,
  stageLabel,
  standing,
  type Signal,
  type Stage,
  type Standing,
} from './raceControlMessages';

export { signalOf } from './raceControlMessages';

const NEEDS = ['timing' as const];

export const SQL = `SELECT date, lap_number, category, flag, scope, sector, driver_number, message FROM race_control ORDER BY date`;

export type Line =
  | { kind: 'message'; lap: number | null; signal: Signal; message: string }
  /** A stewards' case: noted, investigated and decided, on one line that moves up as it changes. */
  | {
      kind: 'case';
      lap: number | null;
      time: string;
      cars: number[];
      turn: number | null;
      reason: string;
      steps: Array<{ stage: Stage; penalty: string | null }>;
      /** The latest message, as sent. */
      message: string;
    }
  /** A run of sector yellows until every one is cleared, on one line. */
  | { kind: 'flags'; lap: number | null; parts: Array<{ sector: number; flag: 'yellow' | 'double' }>; live: number[]; messages: string[] }
  /** A run of blue flags between other messages. */
  | { kind: 'blue'; lap: number | null; count: number; drivers: number[] };

/**
 * The rows of `SQL`, oldest first, as lines, newest first. A case's messages fold into one line, and so
 * does a run of yellows with their clears; each moves up to where it last changed. Unless `blue` is set,
 * each run of blue flags between other lines is counted on one.
 */
export function messagesModel(rows: ReadonlyArray<Record<string, unknown>>, blue = false): Line[] {
  const lines: Array<Line | { kind: 'blueRow'; lap: number | null; driver: number | null }> = [];
  const moveUp = (line: Line) => {
    lines.splice(lines.indexOf(line), 1);
    lines.push(line);
  };
  for (const r of rows) {
    const lap = num(r.lap_number);
    const message = typeof r.message === 'string' ? r.message : '';
    const signal = signalOf(r);
    const sector = num(r.sector);
    if (r.scope === 'Sector' && sector !== null && (signal === 'yellow' || signal === 'double' || signal === 'green')) {
      let run = lines.findLast((l): l is Extract<Line, { kind: 'flags' }> => l.kind === 'flags' && l.live.length > 0);
      if (signal !== 'green' || run?.live.includes(sector)) {
        if (!run) {
          run = { kind: 'flags', lap, parts: [], live: [], messages: [] };
          lines.push(run);
        }
        if (signal === 'green') run.live = run.live.filter((s) => s !== sector);
        else {
          if (!run.live.includes(sector)) run.live.push(sector);
          const flag = signal === 'double' ? 'double' : 'yellow';
          if (!run.parts.some((p) => p.sector === sector && p.flag === flag)) run.parts.push({ sector, flag });
        }
        run.lap = lap;
        run.messages.push(message);
        moveUp(run);
        continue;
      }
    }
    const step = parseCase(message);
    if (step) {
      const known = lines.find((l): l is Extract<Line, { kind: 'case' }> => l.kind === 'case' && sameCase(l, step));
      const line = known ?? { kind: 'case', lap, time: step.time, cars: step.cars, turn: step.turn, reason: step.reason, steps: [], message };
      line.steps.push({ stage: step.stage, penalty: step.penalty });
      line.lap = lap;
      line.message = message;
      if (!line.reason) line.reason = step.reason;
      if (known) moveUp(known);
      else lines.push(line);
      continue;
    }
    if (signal === 'blue' && !blue) lines.push({ kind: 'blueRow', lap, driver: num(r.driver_number) });
    else lines.push({ kind: 'message', lap, signal, message });
  }
  const out: Line[] = [];
  for (const l of lines.reverse()) {
    if (l.kind !== 'blueRow') {
      out.push(l);
      continue;
    }
    const last = out.at(-1);
    if (last?.kind === 'blue') {
      last.count += 1;
      if (l.driver !== null && !last.drivers.includes(l.driver)) last.drivers.push(l.driver);
    } else out.push({ kind: 'blue', lap: l.lap, count: 1, drivers: l.driver === null ? [] : [l.driver] });
  }
  return out;
}

/** The mark a line carries: its flag, a run of yellows half green once cleared, or none for a plain note. */
export function markOf(line: Line): Signal | 'cleared' {
  if (line.kind === 'blue') return 'blue';
  if (line.kind === 'case') return 'note';
  if (line.kind === 'flags') return line.live.length === 0 ? 'cleared' : line.parts.some((p) => p.flag === 'double') ? 'double' : 'yellow';
  return line.signal === 'scEnd' || line.signal === 'vscEnd' ? 'cleared' : line.signal;
}

/** A red flag, a safety car or a VSC: always in ink and bold, wherever it is in the list. */
const NEUTRAL = new Set<string>(['red', 'sc', 'vsc', 'scEnd', 'vscEnd']);

interface Words {
  codeOf: (n: number) => string;
  isCode: (word: string) => boolean;
}

/** A line's text, in sentence case. */
export function lineText(line: Line, w: Words): string {
  const say = (s: string) => sentenceCase(s, w.isCode);
  if (line.kind === 'blue') return `${say(`BLUE ×${line.count}`)}  ${line.drivers.map(w.codeOf).join(' ')}`.trimEnd();
  if (line.kind === 'case') return say(caseText(line, w.codeOf));
  if (line.kind === 'flags') {
    const parts = line.parts.map((p) => `${p.flag === 'double' ? 'DOUBLE YELLOW' : 'YELLOW'} S${p.sector}`);
    return say([...parts, ...(line.live.length === 0 ? ['CLEARED'] : [])].join(' · '));
  }
  return say(shorten(line.message, w.codeOf));
}

/** The messages a line stands for, as sent, for the pointer. */
const rawOf = (line: Line): string =>
  line.kind === 'flags' ? line.messages.join('\n') : line.kind === 'blue' ? `${line.count} blue flags` : line.message;

function Flag({ mark }: { mark: Signal | 'cleared' }) {
  if (mark === 'note') return <span className="rc-flag rc-flag-none" />;
  return <span className={`rc-flag rc-flag-${mark}`} />;
}

const TRACK: Record<Exclude<Standing['track'], 'green'>, string> = {
  red: 'RED FLAG',
  sc: 'SC',
  vsc: 'VSC',
  scEnd: 'SC in',
  vscEnd: 'VSC ending',
};

/** What is in force now: the track, the sectors under yellow, grip, the season's aid, and cases not yet decided. */
function Now({ s }: { s: Standing }) {
  const sectors = [...s.sectors.entries()].sort((a, b) => a[0] - b[0]);
  return (
    <div className="rc-now">
      {s.track !== 'green' ? (
        <span className="rc-on">
          <Flag mark={s.track === 'scEnd' || s.track === 'vscEnd' ? 'cleared' : s.track} />
          {TRACK[s.track]}
        </span>
      ) : null}
      {sectors.length ? (
        <span className="rc-on">
          <Flag mark={sectors.some(([, k]) => k === 'double') ? 'double' : 'yellow'} />
          {sectors.map(([n]) => `S${n}`).join(' ')}
        </span>
      ) : s.track === 'green' ? (
        <span>
          <Flag mark="green" />
          Clear
        </span>
      ) : null}
      {s.grip ? <span className={s.grip === 'low' ? 'rc-on' : ''}>{s.grip === 'low' ? 'Low grip' : 'Grip ok'}</span> : null}
      {s.aid ? (
        <span className={s.aid.on ? '' : 'rc-on'}>
          {s.aid.name === 'DRS' ? 'DRS' : 'Overtake'} {s.aid.on ? 'on' : 'off'}
        </span>
      ) : null}
      <span className={s.open ? 'rc-on' : ''} title="Stewards' cases noted or under investigation">
        {s.open} open
      </span>
    </div>
  );
}

function Item({ line, first, words }: { line: Line; first: boolean; words: Words }) {
  const mark = markOf(line);
  const loud = line.kind === 'message' && NEUTRAL.has(line.signal);
  const tone = line.kind === 'blue' ? 'rc-quiet' : loud ? 'rc-loud' : first ? 'rc-first' : '';
  return (
    <div className={`rc-item ${tone}`} title={rawOf(line)}>
      <Flag mark={mark} />
      <div className="rc-text">
        {lineText(line, words)}
        {line.kind === 'case' ? (
          <div className="rc-steps">
            {line.steps.map((s, i) => (
              <span key={i} className={i === line.steps.length - 1 ? 'rc-step-now' : ''}>
                {i ? ' › ' : ''}
                {stageLabel(s.stage, s.penalty)}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function List({ rows, styles, blue }: { rows: ReadonlyArray<Record<string, unknown>>; styles: Map<number, DriverStyle>; blue: boolean }) {
  const lines = useMemo(() => messagesModel(rows, blue), [rows, blue]);
  const now = useMemo(() => standing(rows), [rows]);
  const words = useMemo<Words>(() => {
    const codes = new Set([...styles.values()].map((s) => s.code));
    for (const r of rows) for (const m of (typeof r.message === 'string' ? r.message : '').matchAll(/CARS? \d+ \((\w{3})\)|AND \d+ \((\w{3})\)/g)) codes.add(m[1] ?? m[2]);
    return { codeOf: (n) => styleOf(styles, n).code, isCode: (w) => codes.has(w) };
  }, [rows, styles]);
  let lap: number | null = null;
  return (
    <div className="rc">
      <Now s={now} />
      <div className="rc-list">
        {lines.map((line, i) => {
          const heading = line.lap !== null && line.lap !== lap;
          if (line.lap !== null) lap = line.lap;
          return (
            <div key={i}>
              {heading ? <div className="rc-lap">Lap {line.lap}</div> : null}
              <Item line={line} first={i === 0} words={words} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RaceControl({ props }: { props: { blue_flags?: boolean } }) {
  const view = useSql(SQL);
  const styles = useDriverStyles();
  return (
    <ChartFrame needs={NEEDS} views={[view]}>
      {() => view.state === 'ready' && <List rows={view.rows} styles={styles} blue={props.blue_flags ?? false} />}
    </ChartFrame>
  );
}

/** Least: the line for what's in force and four one-line messages at 11px. Past 520 wide, lines only get emptier. */
const LEAST = { width: 320, height: 160 };
const FIT = { width: 520 };

export default defineComponent({
  name: 'race_control',
  title: 'Race control',
  description:
    "Race control's messages as they were issued, newest first: flags, safety cars, red flags, the stewards' cases and their outcomes, penalties and deleted laps, with what is in force now on top. Suggest it when the user asks what a flag was for, or what happened.",
  args: Type.Object({
    blue_flags: Type.Optional(Type.Boolean({ description: 'Show each blue flag on its own line. Left out, runs of them are counted on one line.' })),
  }),
  sessions: ['race', 'sprint'],
  needs: NEEDS,
  size: { aspect: 0.8, min: LEAST },
  fit: FIT,
  spec: ({ blue_flags }) => ({ key: blue_flags ? 'race_control:blue' : 'race_control', label: 'Race control' }),
  View: RaceControl,
});
