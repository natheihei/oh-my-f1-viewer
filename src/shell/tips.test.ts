import { describe, expect, it, vi } from 'vitest';

// The commands reach the host, which pulls in the browser-only player and grid.
vi.mock('shaka-player/dist/shaka-player.compiled-es2021', () => ({ default: {} }));
vi.mock('gridstack', () => ({ GridStack: {} }));
import { SLASH_COMMANDS } from './commands';
import { createTipDeck, tipParts, tipText, TIPS, type Tip } from './tips';

const PC = { palette: 'Ctrl+K', mac: false };
const MAC = { palette: '⌘K', mac: true };

describe('TIPS', () => {
  it('names each tip once', () => {
    expect(new Set(TIPS.map((t) => t.id)).size).toBe(TIPS.length);
  });

  it('names only commands the app has', () => {
    const known = new Set(SLASH_COMMANDS.map((c) => c.name));
    for (const tip of TIPS) {
      for (const part of tipParts(tip.text, PC)) {
        if (typeof part !== 'string' && 'command' in part) expect(known, tip.id).toContain(part.command);
      }
    }
  });

  it('fits the folded row', () => {
    for (const tip of TIPS) expect(tipText(tip, PC).length, tip.id).toBeLessThanOrEqual(64);
  });
});

describe('tipParts', () => {
  it('splits words, key caps and commands', () => {
    expect(tipParts('[Space] pauses · /auto-layout tidies', PC)).toEqual([{ key: 'Space' }, ' pauses · ', { command: '/auto-layout' }, ' tidies']);
  });

  it("writes the palette's shortcut as it's set now", () => {
    expect(tipParts('[palette] opens it', { palette: 'Ctrl+Shift+P', mac: false })[0]).toEqual({ key: 'Ctrl+Shift+P' });
  });

  it('writes Alt as Option on a Mac', () => {
    expect(tipText({ id: 'x', text: 'Hold [Alt] and drag' }, PC)).toBe('Hold Alt and drag');
    expect(tipText({ id: 'x', text: 'Hold [Alt] and drag' }, MAC)).toBe('Hold ⌥ and drag');
  });

  it('leaves a slash inside a word alone', () => {
    expect(tipParts('moves and/or resizes', PC)).toEqual(['moves and/or resizes']);
  });
});

describe('createTipDeck', () => {
  const tips: Tip[] = ['a', 'b', 'c', 'd'].map((id) => ({ id, text: id }));

  it('deals every tip once, then the placeholder, then every tip again', () => {
    const next = createTipDeck(tips);
    const round = () => [next(), next(), next(), next()].map((t) => t?.id).sort();
    expect(round()).toEqual(['a', 'b', 'c', 'd']);
    expect(next()).toBeNull();
    expect(round()).toEqual(['a', 'b', 'c', 'd']);
  });

  it("doesn't open a round on the tip the last one closed on", () => {
    for (const r of [0, 0.3, 0.7, 0.999]) {
      const next = createTipDeck(tips, () => r);
      const dealt = Array.from({ length: 14 }, () => next());
      for (let i = 2; i < dealt.length; i++) {
        if (dealt[i - 1] === null) expect(dealt[i]).not.toBe(dealt[i - 2]);
      }
    }
  });

  it('deals nothing from no tips', () => {
    expect(createTipDeck([])()).toBeNull();
  });
});
