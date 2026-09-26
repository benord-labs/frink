// Global getter for use outside React (in atom definitions and store helpers)
// Cached after first call for the lifetime of the window
let globalWindowId: string | null = null;

/**
 * Get the unique window ID for this Electron window.
 * Can be called outside of React components (e.g., in atom definitions).
 *
 * Priority:
 * 1. URL query param (dev mode): ?windowId=main
 * 2. URL hash param (production): #windowId=main
 * 3. sessionStorage fallback (defaults to "main")
 */
export function getWindowId(): string {
  if (globalWindowId) return globalWindowId;

  // Try URL params first (dev mode)
  const urlParams = new URLSearchParams(window.location.search);
  let id = urlParams.get('windowId');

  // Try hash params (production file:// URLs)
  if (!id && window.location.hash) {
    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    id = hashParams.get('windowId');
  }

  // Fallback: use sessionStorage to preserve ID across page refresh
  if (!id) {
    id = sessionStorage.getItem('windowId');
    if (!id) {
      id = 'main';
      sessionStorage.setItem('windowId', id);
    }
  } else {
    sessionStorage.setItem('windowId', id);
  }

  globalWindowId = id;
  return id;
}
