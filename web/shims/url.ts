/** `node:url`: the WHATWG classes, and file paths as `file:` URLs. */
const fileURLToPath = (url: string | URL): string => {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  if (parsed.protocol !== 'file:') throw new TypeError('The URL must be of scheme file');
  return decodeURIComponent(parsed.pathname);
};
const pathToFileURL = (path: string): URL => new URL('file://' + path.split('/').map(encodeURIComponent).join('/'));

module.exports = {
  URL,
  URLSearchParams,
  fileURLToPath,
  pathToFileURL,
  parse: (raw: string) => {
    try {
      const u = new URL(raw);
      return { href: u.href, protocol: u.protocol, host: u.host, hostname: u.hostname, port: u.port, pathname: u.pathname, search: u.search, hash: u.hash, query: u.search.slice(1), path: u.pathname + u.search };
    } catch {
      return { href: raw, pathname: raw, path: raw };
    }
  },
  format: (u: URL | string) => String(u),
  resolve: (from: string, to: string) => new URL(to, from).href,
  domainToASCII: (domain: string) => domain,
};
