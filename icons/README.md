# Logo and icons

OMFV's logo is a helmet facing you, with the prompt (`>` and a block cursor) in its visor. The lettering is JetBrains
Mono converted to outlines, so the files need no font.

| File | What it is |
| --- | --- |
| `omfv-icon.svg`, `omfv-icon-light.svg` | The helmet on a square tile, 192 px, for dark and light ground |
| `omfv-favicon.svg` | 32 px, drawn heavier and without the vent so it holds at 16 px. The app's favicon; the site keeps a copy |
| `omfv-app-icon.svg`, `omfv-app-icon.png` | The Mac and Linux app icon: the tile on Apple's grid, with rounded corners and a shadow. The PNG is the SVG at 1024 px (`rsvg-convert -w 1024`); render it again when the SVG changes |
| `omfv-logo.svg`, `omfv-logo-light.svg` | The helmet, "omfv", and the full name under them. The site keeps a copy of the dark one, and `src/shell/OmfvMark.tsx` draws its helmet and "omfv" |
| `omfv-logo-build.svg` | Build mode: the visor lit yellow, and `/build` after the name |
| `omfv-logo-framed.svg` | The logo drawn like the app's chrome |
| `omfv-wordmark-dark.svg`, `omfv-wordmark-light.svg` | The helmet and the full name on one line, on no ground of its own: the README's header |

`alt-solid/` holds the same set in the other direction that was considered: a solid ink shell with the visor cut out
of it. Nothing uses it.
