/**
 * The shape of a preview in the suggestion strip. It follows the component's `size.aspect`, so a
 * component is previewed in something like the tile it asks for, within limits that keep the strip
 * from growing: a card's width is fixed, and only its height gives.
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
