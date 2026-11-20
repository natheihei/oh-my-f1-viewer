import { describe, expect, it } from 'vitest';
import { releaseName } from './release';

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
