/** Sparse hairlines drifting right to left, like a slow pan down a straight. */
import Type from 'typebox';
import { defineBackground } from '../host';
import { seeded } from './random';

interface Params {
  [key: string]: number | boolean;
  density: number;
  brightness: number;
  speed: number;
}

interface Streak {
  x: number;
  y: number;
  length: number;
  /** Its speed and brightness as shares of the settings. */
  pace: number;
  a: number;
}

export default defineBackground<Params, Streak[]>({
  name: 'streaks',
  title: 'Speed streaks',
  params: Type.Object({
    density: Type.Number({
      title: 'Density',
      minimum: 5,
      maximum: 250,
      step: 1,
      default: 36,
      unit: '/1000px',
    }),
    brightness: Type.Number({
      title: 'Brightness',
      minimum: 0.02,
      maximum: 1,
      step: 0.005,
      default: 0.11,
      unit: '%',
    }),
    speed: Type.Number({
      title: 'Speed',
      minimum: 5,
      maximum: 200,
      step: 1,
      default: 34,
      unit: 'px/s',
    }),
  }),
  animated: () => true,
  prepare({ width, height }, p) {
    const random = seeded(11);
    return Array.from({ length: Math.round((width / 1000) * p.density) }, () => ({
      x: random() * width,
      y: random() * height,
      length: 40 + random() * 220,
      pace: 0.5 + random(),
      a: 0.4 + random() * 0.6,
    }));
  },
  draw(ctx, { width, t }, p, streaks) {
    for (const s of streaks) {
      const span = width + s.length;
      const x = ((((s.x - t * p.speed * s.pace) % span) + span) % span) - s.length;
      const fade = ctx.createLinearGradient(x, 0, x + s.length, 0);
      fade.addColorStop(0, `rgba(255,255,255,${p.brightness * s.a})`);
      fade.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = fade;
      ctx.fillRect(x, s.y, s.length, 0.8);
    }
  },
});
