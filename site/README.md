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

## Deploy

It runs on Cloudflare Workers: `main` builds staging (only the owner can open it), and running the Release site action with a commit on `main` ships production at https://oh-my-f1-viewer.yueyao.run. See [DEPLOY.md](DEPLOY.md).

## Layout

| Path | What's there |
| --- | --- |
| `src/pages/` | One file per route: `index.astro`, `download.astro`, `404.astro` |
| `src/layouts/Base.astro` | `<head>`, meta and Open Graph tags, global CSS |
| `src/components/` | Page sections, top to bottom: `Header`, `Hero`, `Story`, `Need`, `Footer` |
| `src/components/Story.astro` | What the app does, in four steps: each a headline over a screen recording on Vimeo that plays by itself and loops |
| `src/site.ts` | Where Download, "Star on GitHub", X and Discord go (Discord shows only once its invite is set) and the platforms a release builds for |
| `src/release.ts` | The latest app release for `/download`: read from GitHub as the site builds, and again in the browser, since the app is released apart from the site |
| `src/assets/` | Images Astro optimises (import them) |
| `src/assets/shots/` | Notes from collecting screenshots for the page: race moments worth showing, and the raw shots on the `assets/landing-shots` branch. The page no longer uses the shots |
| `src/styles/global.css` | Tailwind import and `@theme` tokens |
| `public/` | Copied as-is: favicon, OG image |
| `wrangler.jsonc` | The production and staging Workers and their domains. See [DEPLOY.md](DEPLOY.md) |
