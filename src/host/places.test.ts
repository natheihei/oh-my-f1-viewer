import { describe, expect, it } from 'vitest';
import { carIn, followsPlaces, placeOf, resolvePlaces, standIns } from './places';

describe('places', () => {
  it.each([
    ['P1', 1],
    ['P20', 20],
    ['P0', null],
    ['P31', null],
    ['p1', null],
    ['P01', null],
    [1, null],
    ['VER', null],
  ])('%s names place %s', (value, place) => {
    expect(placeOf(value)).toBe(place);
  });

  it('finds the car in a place, or none', () => {
    expect(carIn('P2', [1, 44, 10])).toBe(44);
    expect(carIn('P4', [1, 44, 10])).toBeNull();
    expect(carIn('P1', [])).toBeNull();
  });

  it('only follows places in driver props', () => {
    expect(followsPlaces({ driver: 'P1' })).toBe(true);
    expect(followsPlaces({ drivers: [44, 'P3'] })).toBe(true);
    expect(followsPlaces({ driver: 44, label: 'P1' })).toBe(false);
  });

  it('swaps each place for its car, and leaves everything else', () => {
    const props = { driver: 'P1', laps: 5 };
    expect(resolvePlaces(props, [1, 44])).toEqual({ props: { driver: 1, laps: 5 }, waiting: [] });
    // Props with no place come back as they were, so a view keeps them.
    const plain = { driver: 44 };
    expect(resolvePlaces(plain, [1, 44]).props).toBe(plain);
  });

  it('keeps the cars a list can find, once each, and waits when it finds none', () => {
    expect(resolvePlaces({ drivers: ['P1', 1, 'P5'] }, [1, 44]).props).toEqual({ drivers: [1] });
    expect(resolvePlaces({ drivers: ['P4', 'P5'] }, [1, 44])).toEqual({ props: {}, waiting: ['P4', 'P5'] });
    expect(resolvePlaces({ driver: 'P3' }, [])).toEqual({ props: {}, waiting: ['P3'] });
  });

  it('stands in a number for each place, in order, and turns it back in what the spec made', () => {
    const standIn = standIns({ driver_a: 'P2', driver_b: 'P1', laps: 1000002 });
    const [a, b] = [standIn.props.driver_a as number, standIn.props.driver_b as number];
    expect(Number.isInteger(a) && a > 99).toBe(true);
    expect(b).toBeLessThan(a);
    expect(standIn.props.laps).toBe(1000002);
    expect(standIn.text(`gap:${[a, b].sort((x, y) => x - y).join('-')}`)).toBe('gap:P1-P2');
    expect(standIn.drivers([a, 44])).toEqual(['P2', 44]);
  });
});
