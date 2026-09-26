import { useSyncExternalStore } from 'react';

// Matches the CSS that forces glass solid.
const QUERY = '(prefers-reduced-transparency: reduce), (prefers-contrast: more)';

function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia(QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

function getSnapshot(): boolean {
  return window.matchMedia(QUERY).matches;
}

/** True while the OS asks for solid surfaces or more contrast; the app then ignores the Transparency setting. */
export function usePrefersReducedTransparency(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot);
}
