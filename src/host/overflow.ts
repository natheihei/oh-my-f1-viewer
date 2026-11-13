/**
 * Whether a component draws more than its tile shows. The host checks every view it draws, on the
 * grid and in the strip, so a mod that hides its overflow, lets its scroll area collapse, or is
 * resized below its `size.min` still tells the viewer there's more.
 */
import { useEffect, useState, type RefObject } from 'react';

/** The parts of an element the check reads, so it can be tested without a browser. */
export interface Box {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  scrollWidth: number;
  clientWidth: number;
  scrollLeft: number;
  children: ArrayLike<Box>;
}

/** Which way content runs on past what a tile shows. */
export interface Hidden {
  below: boolean;
  right: boolean;
}

export type Axis = 'x' | 'y';

/** Slack for subpixel layout, which can leave a box a pixel short of its content. */
const SLACK = 1;

const NONE: Hidden = { below: false, right: false };

/**
 * Which way `root`, or anything in it that clips what it holds, has content past what it shows. Only
 * below and to the right: content scrolled off the top or the left, or cut short with a deliberate
 * "…", isn't marked. `clips` says whether an element clips its content along an axis; one that doesn't
 * lets it spill into an ancestor, which is checked in its place.
 */
export function hiddenPast(root: Box, clips: (box: Box, axis: Axis) => boolean): Hidden {
  let below = false;
  let right = false;
  const stack: Box[] = [root];
  while (stack.length && !(below && right)) {
    const box = stack.pop()!;
    if (!below && box.scrollHeight - box.scrollTop - box.clientHeight > SLACK && (box === root || clips(box, 'y'))) below = true;
    if (!right && box.scrollWidth - box.scrollLeft - box.clientWidth > SLACK && (box === root || clips(box, 'x'))) right = true;
    for (let i = 0; i < box.children.length; i++) stack.push(box.children[i]);
  }
  return below || right ? { below, right } : NONE;
}

const CLIPPING = new Set(['hidden', 'auto', 'scroll', 'clip']);
function clipsInBrowser(box: Box, axis: Axis): boolean {
  const style = getComputedStyle(box as unknown as Element);
  if (axis === 'y') return CLIPPING.has(style.overflowY);
  // A line cut short with "…" says so itself.
  return CLIPPING.has(style.overflowX) && style.textOverflow !== 'ellipsis';
}

/**
 * Watches the element `ref` holds, which must clip its own content, and says which way anything in it
 * is hidden. It checks again, at most once a frame, when the element changes size, when anything in
 * it changes, and when anything in it scrolls.
 */
export function useHiddenPast(ref: RefObject<HTMLElement | null>): Hidden {
  const [hidden, setHidden] = useState<Hidden>(NONE);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      const next = hiddenPast(root, clipsInBrowser);
      setHidden((prev) => (prev.below === next.below && prev.right === next.right ? prev : next));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    const resized = new ResizeObserver(schedule);
    resized.observe(root);
    const changed = new MutationObserver(schedule);
    changed.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
    // Scroll events don't bubble, so they're caught on the way down.
    root.addEventListener('scroll', schedule, { capture: true, passive: true });
    schedule();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      resized.disconnect();
      changed.disconnect();
      root.removeEventListener('scroll', schedule, { capture: true });
    };
  }, [ref]);
  return hidden;
}
