# OMFV product site

The landing page for oh-my-f1-viewer: Astro (static output) and Tailwind CSS v4. It's its own npm project and shares no code with the app. The logo and favicon are copies from `../icons/`.

## Run it

```bash
npm install
npm run dev        # http://localhost:4321
npm run check      # astro check (types)
npm run build      # writes dist/
npm run preview    # serve the built dist/
```

## Layout

| Path | What's there |
| --- | --- |
| `src/pages/` | One file per route: `index.astro`, `404.astro` |
| `src/layouts/Base.astro` | `<head>`, meta and Open Graph tags, global CSS |
| `src/components/` | Page sections, top to bottom: `Hero`, `Ask`, `Moment`, `Charts`, `Build`, `More`, `Need`, `Footer` |
| `src/site.ts` | Where "Join the beta" goes, and team colours |
| `src/assets/` | Images Astro optimises (import them) |
| `src/assets/shots/page/` | The crops the page uses, from the raw shots on the `assets/landing-shots` branch (see `shots/hero/SHOTS.md`) |
| `src/styles/global.css` | Tailwind import and `@theme` tokens |
| `public/` | Copied as-is: favicon, OG image |
