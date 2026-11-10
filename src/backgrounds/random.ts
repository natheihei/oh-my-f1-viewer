/** A seeded random sequence, so a background looks the same each time it's prepared at a size. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}
