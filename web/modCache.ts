/**
 * Where compiled mods wait for the page to import them. The page imports a build from the extension's own
 * origin, the service worker answers from this cache, and the page's main-process code fills it. The Cache
 * API only takes http(s) addresses, so each build is kept under a made-up one.
 */
export const MOD_CACHE = 'f1a-mods';
/** The path builds are imported from, under the extension's origin. */
export const MOD_PATH = '/mods-built/';
const KEY_ORIGIN = 'https://mods.f1a.invalid';

/** The cache key for a build's address. */
export function modCacheKey(url: string): string {
  const { pathname, search } = new URL(url);
  return KEY_ORIGIN + pathname + search;
}
