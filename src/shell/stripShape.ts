/**
 * The shape of a preview in the suggestion strip. It follows the component's `size.aspect`, so a
 * component is previewed in something like the tile it asks for, within limits that keep the strip
 * from growing: a card's width is fixed, and only its height gives. The user can resize a preview by
 * hand, in both directions, and then that size holds instead (see `clampPreviewSize`).
 */

/**
 * A card's width, and the least and most its preview may be tall, in pixels at a 16px root. The app's
 * root is 13px, so on screen a draft is 260 wide and 98 to 179 high, and a suggestion 182 wide and 78
 * to 137 high. A draft is wider, since it's there to be tried.
 */
export const STRIP_SHAPES = {
  suggestion: { width: 224, minHeight: 96, maxHeight: 168, aspect: 16 / 9 },
  draft: { width: 320, minHeight: 120, maxHeight: 220, aspect: 8 / 3 },
} as const;

/** The preview's width over its height. `aspect` is the component's hint, absent when it gave none. */
export function previewAspect(aspect: number | undefined, kind: keyof typeof STRIP_SHAPES): number {
  const shape = STRIP_SHAPES[kind];
  const wanted = aspect && Number.isFinite(aspect) && aspect > 0 ? aspect : shape.aspect;
  return Math.min(shape.width / shape.minHeight, Math.max(shape.width / shape.maxHeight, wanted));
}

/** A preview's size in CSS pixels, once the user has resized it by hand. */
export interface PreviewSize {
  width: number;
  height: number;
}

/** The least a hand-resized preview may be, in CSS pixels, so its grip stays usable. */
export const MIN_PREVIEW = { width: 120, height: 60 } as const;

/** The tallest a hand-resized preview may be, as a share of the window, so the palette's input stays on screen. */
export const MAX_PREVIEW_HEIGHT_OF_WINDOW = 0.5;

/**
 * Keeps a hand-picked size within limits: no smaller than `MIN_PREVIEW`, no wider than `maxWidth` (the
 * strip) and no taller than `maxHeight` (a share of the window). The least wins over the most when
 * there's no room for both.
 */
export function clampPreviewSize(size: PreviewSize, maxWidth: number, maxHeight: number): PreviewSize {
  const clamp = (v: number, min: number, max: number) => Math.round(Math.max(min, Math.min(max, v)));
  return { width: clamp(size.width, MIN_PREVIEW.width, maxWidth), height: clamp(size.height, MIN_PREVIEW.height, maxHeight) };
}

/**
 * The sizes the user gave previews by hand, by component key, for as long as the app runs: a
 * component suggested again in a later turn comes back at that size. Nothing carries to the tile.
 */
export const manualSizes = new Map<string, PreviewSize>();
