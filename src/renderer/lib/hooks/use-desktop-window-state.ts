import { useAtom } from 'jotai';
import { useEffect } from 'react';
import { isDesktopAtom, isFullscreenAtom } from '../atoms';
import { isDesktopApp } from '../utils/platform';

/** How often dev builds re-poll fullscreen state; changes are infrequent so 1s is ample. */
const DEV_FULLSCREEN_POLL_MS = 1000;

/**
 * Root-level Electron window state: marks the app as desktop, mirrors the native fullscreen flag
 * into `isFullscreenAtom`.
 * Mount once, from the root layout — these are global singletons, not per-view state.
 */
export function useDesktopWindowState(): void {
  const [isDesktop, setIsDesktop] = useAtom(isDesktopAtom);
  const [, setIsFullscreen] = useAtom(isFullscreenAtom);

  useEffect(() => {
    setIsDesktop(isDesktopApp());
  }, [setIsDesktop]);

  useEffect(() => {
    if (!isDesktop || typeof window === 'undefined' || !window.desktopApi?.windowIsFullscreen)
      return;

    window.desktopApi.windowIsFullscreen().then(setIsFullscreen);

    // HMR breaks IPC event subscriptions in dev, so poll there and use events in production.
    if (import.meta.env.DEV) {
      const interval = setInterval(() => {
        window.desktopApi?.windowIsFullscreen?.().then(setIsFullscreen);
      }, DEV_FULLSCREEN_POLL_MS);
      return () => clearInterval(interval);
    }

    return window.desktopApi.onFullscreenChange?.(setIsFullscreen);
  }, [isDesktop, setIsFullscreen]);
}
