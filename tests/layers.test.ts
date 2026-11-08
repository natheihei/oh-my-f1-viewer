/** The layering is the architecture: this fails when a lower layer starts reaching upward. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) && !name.includes('.test.') ? [full] : [];
  });
}

function imports(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(/from\s+'([^']+)'|import\s+'([^']+)'/g)]
    .map((m) => m[1] ?? m[2])
    .filter((spec) => spec.startsWith('.'))
    .map((spec) => path.normalize(path.join(path.dirname(file), spec)));
}

const RULES: Record<string, string[]> = {
  // Data knows nothing above it.
  'src/data': ['src/layout', 'src/components', 'src/shell', 'src/agent'],
  // The layout draws whatever it is given: it knows neither video nor the data layer.
  'src/layout': ['src/data', 'src/components', 'src/shell', 'src/agent'],
  // Components render data inside the layout, and never drive the shell or agent.
  'src/components': ['src/shell', 'src/agent'],
};

describe('layer boundaries', () => {
  for (const [layer, forbidden] of Object.entries(RULES)) {
    it(`${layer} does not import ${forbidden.join(', ')}`, () => {
      const violations = sourceFiles(layer).flatMap((file) =>
        imports(file)
          .filter((target) => forbidden.some((f) => target.startsWith(f)))
          .map((target) => `${file} -> ${target}`),
      );
      expect(violations).toEqual([]);
    });
  }

  it('only the data layer talks to the F1 TV and timing bridges', () => {
    const offenders = ['src/layout', 'src/components']
      .flatMap(sourceFiles)
      .filter((file) => /window\.f1a\.(f1tv|timing)/.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
