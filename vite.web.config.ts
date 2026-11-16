import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The renderer for the browser build: the same `src/`, entered through `web/entry.ts`, which starts the
 * main-process code in the page first. `web/build.mjs` runs this and builds the rest. See docs/WEB.md.
 */
export default defineConfig({
  root: 'web',
  base: './',
  plugins: [react(), tailwindcss()],
  publicDir: false,
  build: { outDir: '../dist-web', emptyOutDir: false, chunkSizeWarningLimit: 4000, target: 'es2022' },
});
