/** A dim field of made-up lap times. One cell at a time changes, flashes purple and fades back. */
import Type from 'typebox';
import { defineBackground } from '../host';
import { seeded } from './random';

interface Params {
  [key: string]: number | boolean;
  brightness: number;
  rate: number;
}

interface Field {
  cells: Array<{ x: number; y: number; text: string; changedAt: number }>;
  next: number;
  random: () => number;
}

const COLUMN = 78;
const ROW = 22;
const FADE_S = 2;
const FLASH_S = 0.6;
/** Made up, so it never reads as the session's own. */
const lapTime = (random: () => number) =>
  `1:${String(14 + Math.floor(random() * 4)).padStart(2, '0')}.${String(Math.floor(random() * 1000)).padStart(3, '0')}`;

export default defineBackground<Params, Field>({
  name: 'timing',
  title: 'Timing ghost',
  params: Type.Object({
    brightness: Type.Number({
      title: 'Brightness',
      minimum: 0.02,
      maximum: 1,
      step: 0.005,
      default: 0.095,
      unit: '%',
    }),
    rate: Type.Number({
      title: 'Updates',
      minimum: 0.2,
      maximum: 10,
      step: 0.1,
      default: 2.2,
      unit: '/s',
    }),
  }),
  animated: () => true,
  prepare({ width, height }) {
    const random = seeded(3);
    const cells: Field['cells'] = [];
    for (let y = ROW; y < height; y += ROW)
      for (let x = 10; x < width; x += COLUMN) cells.push({ x, y, text: lapTime(random), changedAt: -Infinity });
    return { cells, next: 0, random };
  },
  draw(ctx, { t }, p, field) {
    if (t >= field.next && field.cells.length > 0) {
      const cell = field.cells[Math.floor(field.random() * field.cells.length)];
      cell.text = lapTime(field.random);
      cell.changedAt = t;
      field.next = t + 1 / p.rate;
    }
    ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    for (const c of field.cells) {
      const age = t - c.changedAt;
      const a = Math.min(1, p.brightness * (1 + (age < FADE_S ? 2.8 * (1 - age / FADE_S) : 0)));
      ctx.fillStyle = age < FLASH_S ? `rgba(180,90,255,${Math.min(1, a + 0.04)})` : `rgba(255,255,255,${a})`;
      ctx.fillText(c.text, c.x, c.y);
    }
  },
});
