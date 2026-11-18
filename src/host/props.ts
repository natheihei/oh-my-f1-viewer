/**
 * The props a component takes about drivers. A component declares what it needs and whoever puts it on
 * screen fills it in: the agent, from the user's words, or a check script. The component never picks a
 * driver from the data itself, unless following one (the leader, say) is what it is for. See
 * docs/COMPONENTS.md.
 *
 * A prop holds drivers when its name says so: `driver`, `drivers`, or a name starting `driver_` or
 * `drivers_`. Its value is car numbers: one for `driver…`, a list for `drivers…`. The agent passes codes,
 * surnames or numbers, and the host turns them into car numbers. The usual ones:
 *
 * - `driver`: the one driver a chart is about.
 * - `driver_a`, `driver_b`: the two a comparison is about, when which is which matters.
 * - `drivers`: those to highlight among everyone drawn.
 * - `drivers_to_display`: those to draw, when a chart can show just some. Left out, everyone.
 */
import Type from 'typebox';

/** Whether a prop holds drivers, by its name. */
export const isDriverProp = (name: string): boolean => /^drivers?(_|$)/.test(name);

/** Whether a driver prop holds a list, by its name: `drivers…` does, `driver…` holds one. */
export const isDriverList = (name: string): boolean => /^drivers(_|$)/.test(name);

/** One driver, as a car number. */
export const Driver = (description: string) => Type.Integer({ description: `${description}, as a car number` });

/** Some drivers, as car numbers, at most `max`. */
export const DriverList = (description: string, max?: number) =>
  Type.Array(Type.Integer({ description: 'A car number' }), {
    minItems: 1,
    ...(max != null ? { maxItems: max } : {}),
    uniqueItems: true,
    description: `${description}, as car numbers`,
  });

/** The usual `drivers` prop: those to highlight among everyone drawn, at most `max`. */
export const Highlighted = (max?: number, more = '') =>
  Type.Optional(DriverList(`Drivers to highlight among those drawn${more}. Left out, none is`, max));

/** The usual `drivers_to_display` prop: those to draw. */
export const Displayed = (more = '') =>
  Type.Optional(DriverList(`Drivers to draw${more}, only when the user asked to see just some. Left out, everyone`));

/** A driver-prop value for a key: car numbers joined, or a placeholder when left out. */
export const keyPart = (value: number | readonly number[] | undefined, none = 'all'): string =>
  value == null ? none : Array.isArray(value) ? (value.length ? value.join('-') : none) : String(value);

