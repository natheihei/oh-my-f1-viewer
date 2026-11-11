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
  children: ArrayLike<Box>;
}

/** Slack for subpixel layout, which can leave a box a pixel short of its content. */
const SLACK = 1;

/**
 * True if `root`, or anything in it that clips what it holds, has content below what it shows. Only
 * below: content scrolled off the top, or cut short sideways (a deliberate "…"), isn't marked. `clips`
 * says whether an element clips its content vertically; one that doesn't lets it spill into an
 * ancestor, which is checked in its place.
 */
export function hiddenBelow(root: Box, clips: (box: Box) => boolean): boolean {
  const stack: Box[] = [root];
  while (stack.length) {
    const box = stack.pop()!;
    if (box.scrollHeight - box.scrollTop - box.clientHeight > SLACK && (box === root || clips(box))) return true;
    for (let i = 0; i < box.children.length; i++) stack.push(box.children[i]);
  }
  return false;
}

const CLIPPING = new Set(['hidden', 'auto', 'scroll', 'clip']);
const clipsInBrowser = (box: Box) => CLIPPING.has(getComputedStyle(box as unknown as Element).overflowY);

/**
 * Watches the element `ref` holds, which must clip its own content, and says whether anything in it is
 * hidden below. It checks again, at most once a frame, when the element changes size, when anything in
 * it changes, and when anything in it scrolls.
 */
export function useHiddenBelow(ref: RefObject<HTMLElement | null>): boolean {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      setHidden(hiddenBelow(root, clipsInBrowser));
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
