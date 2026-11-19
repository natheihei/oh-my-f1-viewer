// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://oh-my-f1-viewer.yueyao.run',
  output: 'static',
  vite: {
    plugins: [tailwindcss()],
  },
});
