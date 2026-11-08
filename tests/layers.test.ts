/** The layering is the architecture: this fails when anything reaches around the host. See docs/DESIGN.md. */
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
  // The core knows nothing above it, and its two halves don't know each other.
  'src/data': ['src/layout', 'src/host', 'src/components', 'src/shell', 'src/agent'],
  'src/layout': ['src/data', 'src/host', 'src/components', 'src/shell', 'src/agent'],
  // The host serves consumers, and knows none of them.
  'src/host': ['src/components', 'src/shell', 'src/agent'],
  // Consumers use the host and nothing below it.
  'src/components': ['src/data', 'src/layout', 'src/shell', 'src/agent'],
  'src/agent': ['src/data', 'src/layout', 'src/components', 'src/shell'],
  'src/shell': ['src/data', 'src/layout'],
};

describe('layer boundaries', () => {
  for (const [layer, forbidden] of Object.entries(RULES)) {
    it(`${layer} does not import ${forbidden.join(', ')}`, () => {
      const violations = sourceFiles(layer).flatMap((file) =>
        imports(file)
          .filter((target) => forbidden.some((f) => target === f || target.startsWith(`${f}/`)))
          .map((target) => `${file} -> ${target}`),
      );
      expect(violations).toEqual([]);
    });
  }

  it('consumers only use the host through its one entry point', () => {
    const violations = ['src/components', 'src/agent', 'src/shell'].flatMap((layer) =>
      sourceFiles(layer).flatMap((file) =>
        imports(file)
          .filter((target) => target.startsWith('src/host/'))
          .map((target) => `${file} -> ${target}`),
      ),
    );
    expect(violations).toEqual([]);
  });

  it('the frame only reaches a component through the registry', () => {
    const violations = sourceFiles('src/shell').flatMap((file) =>
      imports(file)
        .filter((target) => target.startsWith('src/components') && target !== 'src/components/registry')
        .map((target) => `${file} -> ${target}`),
    );
    expect(violations).toEqual([]);
  });

  it('only the data layer talks to the main process', () => {
    const offenders = ['src/layout', 'src/host', 'src/components', 'src/agent', 'src/shell']
      .flatMap(sourceFiles)
      .filter((file) => /window\.f1a\b/.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
