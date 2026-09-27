// First import: the modules below already report to Sentry while they load (stored themes decode).
import './lib/sentry/init';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { appStore } from './lib/jotai-store';
import { startUserTimingBound } from './lib/perf/bound-user-timing';
import { paintStoredTheme } from './lib/themes/paint-theme';
import './styles/globals.css';
import '@/lib/code-editor/monaco/monaco-loader-config';

// Remove deprecated storage keys from retired Custom Model Override/Profile system.
localStorage.removeItem('agents:claude-custom-config');
localStorage.removeItem('agents:model-profiles');
localStorage.removeItem('agents:active-profile-id');

// Suppress ResizeObserver loop error - this is a non-fatal browser warning
// that can occur when layout changes trigger observation callbacks
// Common with virtualization libraries and diff viewers
const resizeObserverErr = /ResizeObserver loop/;

// Handle both error event and unhandledrejection
window.addEventListener('error', (e) => {
  if (e.message && resizeObserverErr.test(e.message)) {
    e.stopImmediatePropagation();
    e.preventDefault();
    return false;
  }
});

// Also override window.onerror for broader coverage
const originalOnError = window.onerror;
window.onerror = (message, source, lineno, colno, error) => {
  if (typeof message === 'string' && resizeObserverErr.test(message)) {
    return true; // Suppress the error
  }
  if (originalOnError) {
    return originalOnError(message, source, lineno, colno, error);
  }
  return false;
};

startUserTimingBound();

const rootElement = document.getElementById('root');

if (rootElement) {
  // Paint the stored theme before the first render so the palette never flashes stock Frink.
  paintStoredTheme(appStore);
  ReactDOM.createRoot(rootElement).render(<App />);
}
