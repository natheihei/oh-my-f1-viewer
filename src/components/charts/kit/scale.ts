/** Linear scales and the ticks an axis labels. Pure, so they're tested on their own. */

export interface Scale {
  (value: number): number;
  domain: [number, number];
  range: [number, number];
}

/** Maps `domain` onto `range` in a straight line. A domain with no span maps everything to the range's start. */
export function linear(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  const scale = ((value: number) => r0 + (value - d0) * k) as Scale;
  scale.domain = domain;
  scale.range = range;
  return scale;
}

/** A round step (1, 2 or 5 times a power of ten) that splits `span` into about `count` parts. */
export function niceStep(span: number, count: number): number {
  if (!(span > 0) || !(count > 0)) return 1;
  const raw = span / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
}

/** Round values from `min` to `max`, about `count` of them, using `step` when given. */
export function ticks(min: number, max: number, count: number, step = niceStep(max - min, count)): number[] {
  if (!(max >= min) || !(step > 0)) return [];
  const out: number[] = [];
  const first = Math.ceil(min / step - 1e-9);
  for (let i = first; i * step <= max + step * 1e-9; i++) out.push(Number((i * step).toPrecision(12)));
  return out;
}

/** The smallest round number at or above `value`, on the grid `ticks` would use for 0 to `value`. */
export function niceCeil(value: number, count = 5): number {
  if (!(value > 0)) return 0;
  const step = niceStep(value, count);
  return Math.ceil(value / step - 1e-9) * step;
}
