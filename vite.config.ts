import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * Content-Security-Policy for the packaged app (the dev server needs inline scripts). The window
 * runs with relaxed web security because F1's CDN and DRM need it, so this is what stops injected
 * script from reaching anything else: network only to F1 hosts and the local license proxy
 * (ports 18765-18775; CSP has no port ranges, so they are listed).
 */
const LICENSE_PROXY = Array.from({ length: 11 }, (_, i) => `http://127.0.0.1:${18765 + i}`).join(' ');
const F1_MEDIA = 'https://*.formula1.com https://*.akamaized.net https://*.akamaihd.net';
const CSP = [
  "default-src 'self'",
  // Mods are compiled by the main process and imported from their own scheme: see docs/MODS.md.
  "script-src 'self' omfv-mod:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.formula1.com",
  `media-src 'self' blob: data: ${F1_MEDIA}`,
  "font-src 'self' data:",
  `connect-src 'self' ${F1_MEDIA} ${LICENSE_PROXY}`,
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ');

function csp(): Plugin {
  return {
    name: 'omfv-csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), csp()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000 },
  test: {
    include: ['src/**/*.test.ts', 'electron/**/*.test.js', 'electron/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
  },
} as never);
