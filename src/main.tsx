import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import * as typebox from 'typebox';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles.css';
import { backgrounds, DEFAULT_BACKGROUND } from './backgrounds/registry';
import * as kit from './components/charts/kit';
import { components } from './components/registry';
import * as f1a from './host';
import { host, startBuild, startHealth, startMods } from './host';
import { App } from './shell/App';
import { restoreBackground } from './shell/persistBackground';
import { restorePaletteHeight } from './shell/persistPaletteHeight';
import { restoreVolume } from './shell/persistVolume';

// Before the first render: the grid and the agent read components from the host.
host.components.register({ components });
host.backgrounds.register({ backgrounds });
// Mods import these as the app's own copies. See docs/MODS.md.
startMods({ f1a, 'f1a/kit': kit, react: React, 'react/jsx-runtime': jsxRuntime, typebox });
startBuild();
startHealth();
// Before the first render too, so the volume slider starts at the saved level rather than jumping from 100%.
restoreVolume();
// And the background, so the gaps don't flash black first. With nothing saved, the default shows.
host.appearance.setBackground({ style: DEFAULT_BACKGROUND });
restoreBackground();
// And the palette's history cap, so it opens at the height last chosen.
restorePaletteHeight();

// No StrictMode: effects own real streams, and a double mount would start each one twice.
createRoot(document.getElementById('root')!).render(<App />);
