import { createRoot } from 'react-dom/client';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles.css';
import { App } from './shell/App';

// No StrictMode: effects own real streams, and a double mount would start each one twice.
createRoot(document.getElementById('root')!).render(<App />);
