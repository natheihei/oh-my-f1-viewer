/**
 * Whether a component has outgrown its tile. A component adapts to the room it has, by scrolling a
 * list, shortening a label or drawing a compact form, and when it can't go smaller its content runs
 * past the tile. The host checks only that: the frame it draws the component in, never what's inside.
 */
import { useEffect, useState, type RefObject } from 'react';

/** The parts of the frame the check reads, so it can be tested without a browser. */
export interface Box {
  scrollHeight: number;
  clientHeight: number;
  scrollWidth: number;
  clientWidth: number;
}

/** Which way content runs on past what a tile shows. */
export interface Hidden {
  below: boolean;
  right: boolean;
}

/** Slack for subpixel layout, which can leave a box a pixel short of its content. */
const SLACK = 1;

const NONE: Hidden = { below: false, right: false };

/** Which way the content of `frame` runs past what it shows. */
export function hiddenPast(frame: Box): Hidden {
  const below = frame.scrollHeight - frame.clientHeight > SLACK;
  const right = frame.scrollWidth - frame.clientWidth > SLACK;
  return below || right ? { below, right } : NONE;
}

/**
 * Watches the frame `ref` holds, which must clip its own content, and says which way the component in
 * it runs past it. It checks again, at most once a frame, when the frame changes size and when anything
 * in it changes.
 */
export function useHiddenPast(ref: RefObject<HTMLElement | null>): Hidden {
  const [hidden, setHidden] = useState<Hidden>(NONE);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      const next = hiddenPast(root);
      setHidden((prev) => (prev.below === next.below && prev.right === next.right ? prev : next));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    const resized = new ResizeObserver(schedule);
    resized.observe(root);
    const changed = new MutationObserver(schedule);
    changed.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
    schedule();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      resized.disconnect();
      changed.disconnect();
    };
  }, [ref]);
  return hidden;
}
