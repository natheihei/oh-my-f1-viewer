/** Scattered white dots, a share of them slowly twinkling. */
import Type from 'typebox';
import { defineBackground } from '../host';
import { seeded } from './random';

interface Params {
  [key: string]: number | boolean;
  density: number;
  brightness: number;
  twinkling: number;
  speed: number;
}

interface Star {
  x: number;
  y: number;
  r: number;
  /** Its brightness as a share of the setting. */
  a: number;
  /** It twinkles when this is under the twinkling share. */
  roll: number;
  phase: number;
  rate: number;
}

export default defineBackground<Params, Star[]>({
  name: 'stars',
  title: 'Starfield',
  params: Type.Object({
    density: Type.Number({
      title: 'Density',
      minimum: 0.5,
      maximum: 30,
      step: 0.1,
      default: 3.8,
      unit: '/10k px²',
    }),
    brightness: Type.Number({
      title: 'Brightness',
      minimum: 0.05,
      maximum: 1,
      step: 0.01,
      default: 0.5,
      unit: '%',
    }),
    twinkling: Type.Number({
      title: 'Twinkling',
      minimum: 0,
      maximum: 1,
      step: 0.01,
      default: 0.22,
      unit: '%',
    }),
    speed: Type.Number({
      title: 'Twinkle speed',
      minimum: 0.1,
      maximum: 2,
      step: 0.05,
      default: 0.5,
      unit: '×',
      shownWhen: 'twinkling',
    }),
  }),
  animated: (p) => p.twinkling > 0,
  prepare({ width, height }, p) {
    const random = seeded(7);
    return Array.from({ length: Math.round(((width * height) / 10_000) * p.density) }, () => ({
      x: random() * width,
      y: random() * height,
      r: 0.5 + random() * 0.7,
      a: 0.25 + random() * 0.75,
      roll: random(),
      phase: random() * Math.PI * 2,
      rate: 0.5 + random(),
    }));
  },
  draw(ctx, { t }, p, stars) {
    for (const s of stars) {
      const twinkle = s.roll < p.twinkling ? 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * p.speed * s.rate + s.phase)) : 1;
      ctx.fillStyle = `rgba(255,255,255,${p.brightness * s.a * twinkle})`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
  },
});
