import { describe, expect, it } from 'vitest';
import { compareReleases, releaseName } from './release';

describe('releaseName', () => {
  it("is a release's date and run", () => {
    expect(releaseName('20261119.1.0')).toBe('20261119.1');
    expect(releaseName('20261231.12.0')).toBe('20261231.12');
  });

  it("is null for a version that isn't a release", () => {
    expect(releaseName('0.1.0')).toBeNull();
    expect(releaseName('20261119.1')).toBeNull();
    expect(releaseName('20261119.1.2')).toBeNull();
  });
});

describe('compareReleases', () => {
  it('orders by day, then by run as a number', () => {
    expect(compareReleases('20261119.2', '20261120.1')).toBeLessThan(0);
    expect(compareReleases('20261120.10', '20261120.9')).toBeGreaterThan(0);
    expect(compareReleases('20261120.1', '20261120.1')).toBe(0);
  });
});
