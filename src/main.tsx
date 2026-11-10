import { createRoot } from 'react-dom/client';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles.css';
import { components } from './components/registry';
import { host } from './host';
import { App } from './shell/App';
import { restoreVolume } from './shell/persistVolume';

// Before the first render: the grid and the agent read components from the host.
host.components.register({ components });
// Before the first render too, so the volume slider starts at the saved level rather than jumping from 100%.
restoreVolume();

// No StrictMode: effects own real streams, and a double mount would start each one twice.
createRoot(document.getElementById('root')!).render(<App />);
