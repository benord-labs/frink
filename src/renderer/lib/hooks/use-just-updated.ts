import { useAtom } from 'jotai';
import { useCallback, useEffect } from 'react';
import { justUpdatedAtom, justUpdatedVersionAtom } from '../atoms';

const LAST_VERSION_KEY = 'app:last-version';

/**
 * Hook to detect if app was just updated
 * Compares current version with stored version and shows "What's New" banner
 */
export function useJustUpdated() {
  const [justUpdated, setJustUpdated] = useAtom(justUpdatedAtom);
  const [justUpdatedVersion, setJustUpdatedVersion] = useAtom(justUpdatedVersionAtom);

  // Check for update on mount
  useEffect(() => {
    const checkForUpdate = async () => {
      const api = window.desktopApi;
      if (!api) return;

      try {
        const currentVersion = await api.getVersion();
        const lastVersion = localStorage.getItem(LAST_VERSION_KEY);

        // If this is first launch or version changed, show "What's New"
        if (lastVersion && lastVersion !== currentVersion) {
          setJustUpdated(true);
          setJustUpdatedVersion(currentVersion);
        }

        // Always update stored version
        localStorage.setItem(LAST_VERSION_KEY, currentVersion);
      } catch (_error) {}
    };

    checkForUpdate();
  }, [setJustUpdated, setJustUpdatedVersion]);

  // Dismiss the "What's New" banner
  const dismissJustUpdated = useCallback(() => {
    setJustUpdated(false);
    setJustUpdatedVersion(null);
  }, [setJustUpdated, setJustUpdatedVersion]);

  // Open changelog in browser
  const openChangelog = useCallback(() => {
    const api = window.desktopApi;
    if (api) {
      const version = justUpdatedVersion ? `#v${justUpdatedVersion}` : '';
      api.openExternal(`https://www.frink.dev/changelog${version}`);
    }
    dismissJustUpdated();
  }, [justUpdatedVersion, dismissJustUpdated]);

  return {
    justUpdated,
    justUpdatedVersion,
    dismissJustUpdated,
    openChangelog,
  };
}
