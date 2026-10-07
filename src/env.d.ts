/// <reference types="vite/client" />
/// <reference types="./preload/index.d.ts" />

// Extend Vite's ImportMetaEnv with our custom env vars
declare global {
  interface ImportMetaEnv {
    // Main process (MAIN_VITE_ prefix)
    readonly MAIN_VITE_SENTRY_DSN?: string;
    readonly MAIN_VITE_POSTHOG_KEY?: string;
    readonly MAIN_VITE_POSTHOG_HOST?: string;
    readonly MAIN_VITE_UPDATE_FEED_URL?: string;
    // Renderer process (VITE_/RENDERER_VITE_ prefix)
    readonly RENDERER_VITE_SENTRY_DSN?: string;
  }

  // Global object extensions for Electron main process
  var __devToolsUnlocked: boolean | undefined;
  var __unlockDevTools: (() => void) | undefined;
  var __setUpdateAvailable: ((available: boolean, version?: string) => void) | undefined;
}

export {};
