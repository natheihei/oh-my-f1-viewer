/** A faint dot wherever the layout grid's lines cross: where tiles snap. Optionally only near the mouse. */
import Type from 'typebox';
import { defineBackground } from '../host';

interface Params {
  [key: string]: number | boolean;
  brightness: number;
  size: number;
  density: number;
  glow: boolean;
  radius: number;
}

export default defineBackground<Params>({
  name: 'grid',
  title: 'Layout grid',
  params: Type.Object({
    brightness: Type.Number({
      title: 'Brightness',
      minimum: 0.03,
      maximum: 1,
      step: 0.01,
      default: 0.5,
      unit: '%',
    }),
    size: Type.Number({
      title: 'Dot size',
      minimum: 0.6,
      maximum: 6,
      step: 0.1,
      default: 1.4,
      unit: 'px',
    }),
    density: Type.Union([Type.Literal(24), Type.Literal(48)], {
      title: 'Density',
      default: 24,
      unit: '/side',
    }),
    glow: Type.Boolean({ title: 'Glow near mouse', default: false }),
    radius: Type.Number({
      title: 'Glow radius',
      minimum: 60,
      maximum: 400,
      step: 10,
      default: 170,
      unit: 'px',
      shownWhen: 'glow',
    }),
  }),
  animated: () => false,
  followsPointer: (p) => p.glow,
  draw(ctx, { width, height, pointer }, p) {
    const n = p.density;
    const [cw, ch] = [width / n, height / n];
    for (let i = 1; i < n; i++) {
      for (let j = 1; j < n; j++) {
        const [x, y] = [i * cw, j * ch];
        let a = p.brightness;
        if (p.glow) {
          // At rest a third as bright, brightening towards the mouse.
          a *= 0.35;
          if (pointer) {
            const d = Math.hypot(x - pointer.x, y - pointer.y) / p.radius;
            if (d < 1) a += p.brightness * 2.2 * (1 - d) ** 2;
          }
        }
        ctx.fillStyle = `rgba(255,255,255,${Math.min(1, a)})`;
        ctx.fillRect(x - p.size / 2, y - p.size / 2, p.size, p.size);
      }
    }
  },
});
