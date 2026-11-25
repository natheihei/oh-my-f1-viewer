/**
 * Places in the running order, as a driver prop can hold them: "P1" is whoever is first at the playhead,
 * so a tile given one follows that place, not a car. See docs/COMPONENTS.md, "Driver props".
 *
 * A component never sees a place. The host checks and keys a spec with a stand-in car number for each
 * place (`standIns`), and swaps in the car that holds it just before the component draws
 * (`resolvePlaces`), so a chart or a mod written for car numbers follows a place with no code of its own.
 * The order is read as of the playhead, like any chart's data, so a place never tells the viewer more
 * than the timing tower would.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { sessionSql, useSessionData } from '../data/sessionData';
import { isDriverProp } from './props';

/** A place in the running order, as a driver prop holds it. */
export type Place = `P${number}`;

/** A driver as a prop or a title names one: a car number, or a place, whoever holds it. */
export type DriverRef = number | Place;

/** The most places there are: more cars than a grid has ever held. */
export const MAX_PLACE = 30;

/** The place a value names, as a number, or null when it names none. */
export function placeOf(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = /^P([1-9]\d?)$/.exec(value);
  return m && Number(m[1]) <= MAX_PLACE ? Number(m[1]) : null;
}

export const isPlace = (value: unknown): value is Place => placeOf(value) !== null;

/** The place for a position: 1 is "P1". */
export const placeName = (position: number): Place => `P${position}`;

// The cars still running, by their latest position. A car that has retired holds no place.
const ORDER_SQL = `
WITH pos AS (SELECT driver_number, position, MAX(date) FROM position GROUP BY driver_number),
out AS (SELECT DISTINCT driver_number FROM laps WHERE is_out)
SELECT pos.driver_number FROM pos LEFT JOIN out USING (driver_number)
WHERE out.driver_number IS NULL AND pos.position IS NOT NULL
ORDER BY pos.position`;

/** The cars in running order at the playhead: the first holds P1. Empty until the data has one. */
export const usePlaces = create<{ order: readonly number[] }>(() => ({ order: [] }));

const sameOrder = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((n, i) => n === b[i]);

let watchers = 0;
let stop: (() => void) | null = null;

/** Reads the order on every `sessionData.revision`, which moves as the playhead does and as data arrives. */
function start(): () => void {
  let asked: number | null = null;
  let cancelled = false;
  const read = () => {
    const data = useSessionData.getState();
    if (data.state !== 'ready') {
      asked = null;
      if (usePlaces.getState().order.length) usePlaces.setState({ order: [] });
      return;
    }
    if (data.revision === asked) return;
    asked = data.revision;
    sessionSql(ORDER_SQL).then(
      ({ rows }) => {
        if (cancelled || asked !== data.revision) return;
        const order = rows.map((r) => Number(r.driver_number)).filter((n) => Number.isInteger(n));
        if (!sameOrder(order, usePlaces.getState().order)) usePlaces.setState({ order });
      },
      // Nothing at the playhead yet: the places keep what they last held.
      () => {},
    );
  };
  read();
  const unsubscribe = useSessionData.subscribe(read);
  return () => {
    cancelled = true;
    unsubscribe();
  };
}

/** Keeps the order current while something follows a place. Returns how to stop. */
export function watchPlaces(): () => void {
  watchers += 1;
  if (watchers === 1) stop = start();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    watchers -= 1;
    if (watchers === 0) {
      stop?.();
      stop = null;
    }
  };
}

/** The order at the playhead, read while `active`: empty otherwise. */
export function useRunningOrder(active: boolean): readonly number[] {
  useEffect(() => (active ? watchPlaces() : undefined), [active]);
  const order = usePlaces((s) => s.order);
  return active ? order : NO_ORDER;
}
const NO_ORDER: readonly number[] = [];

/** The car in a place now, or null when nobody holds it yet. */
export const carIn = (place: Place, order: readonly number[] = usePlaces.getState().order): number | null => order[placeOf(place)! - 1] ?? null;

/** Whether any driver prop names a place. */
export function followsPlaces(props: Record<string, unknown>): boolean {
  return Object.entries(props).some(([name, value]) => isDriverProp(name) && (Array.isArray(value) ? value.some(isPlace) : isPlace(value)));
}

/**
 * The props with each place swapped for the car that holds it, and the places nobody holds yet. A list
 * keeps the cars it can and drops a repeat, so P1 and VER are one driver while VER leads; a list whose
 * places are all empty, and a single driver whose place is, count as waiting.
 */
export function resolvePlaces(props: Record<string, unknown>, order: readonly number[]): { props: Record<string, unknown>; waiting: Place[] } {
  if (!followsPlaces(props)) return { props, waiting: [] };
  const out: Record<string, unknown> = {};
  const waiting: Place[] = [];
  for (const [name, value] of Object.entries(props)) {
    if (!isDriverProp(name)) {
      out[name] = value;
      continue;
    }
    if (Array.isArray(value)) {
      const cars: unknown[] = [];
      const empty: Place[] = [];
      for (const v of value) {
        const car = isPlace(v) ? carIn(v, order) : v;
        if (car === null) empty.push(v as Place);
        else if (!cars.includes(car)) cars.push(car);
      }
      if (cars.length) out[name] = cars;
      else waiting.push(...empty);
      continue;
    }
    if (!isPlace(value)) {
      out[name] = value;
      continue;
    }
    const car = carIn(value, order);
    if (car === null) waiting.push(value);
    else out[name] = car;
  }
  return { props: out, waiting };
}

// A stand-in is a number no car has, one per place, in the places' order: P1's sorts before P2's.
const STAND_IN = 1_000_000;
const standInOf = (place: number) => STAND_IN + place;
const placeOfStandIn = (n: unknown): Place | null => (typeof n === 'number' && n > STAND_IN && n <= STAND_IN + MAX_PLACE ? placeName(n - STAND_IN) : null);

/**
 * The props with each place as a stand-in car number, to check against a component's args and build its
 * spec from, and how to turn what the spec made back: in its key, its label and its drivers, the
 * stand-ins become places again. A spec that sorts its drivers, or tells two apart, does so for places as for cars.
 */
export function standIns(props: Record<string, unknown>): {
  props: Record<string, unknown>;
  text: (text: string) => string;
  drivers: (drivers: readonly number[] | undefined) => DriverRef[] | undefined;
} {
  if (!followsPlaces(props)) return { props, text: (t) => t, drivers: (d) => (d ? [...d] : undefined) };
  const used = new Set<number>();
  const swap = (v: unknown) => {
    const p = placeOf(v);
    if (p === null) return v;
    used.add(p);
    return standInOf(p);
  };
  const out = Object.fromEntries(
    Object.entries(props).map(([name, value]) => [name, isDriverProp(name) ? (Array.isArray(value) ? value.map(swap) : swap(value)) : value]),
  );
  return {
    props: out,
    text: (text) => [...used].reduce((t, p) => t.replace(new RegExp(`(?<!\\d)${standInOf(p)}(?!\\d)`, 'g'), placeName(p)), text),
    drivers: (drivers) => drivers?.map((d) => placeOfStandIn(d) ?? d),
  };
}
