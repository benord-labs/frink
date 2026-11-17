// Dev/isolation flag: `electron-vite dev` (ELECTRON_RENDERER_URL) or an isolated built bundle
// (FRINK_CDP_PORT). Readers isolate the instance: own userData, CDP, mock keychain, frink-dev://.
export const IS_DEV = !!process.env.ELECTRON_RENDERER_URL || !!process.env.FRINK_CDP_PORT;

// Deep-link protocol (must match package.json build.protocols.schemes); dev/QA use their own
// scheme so they never collide with an installed production app. index.ts and debug.ts import this.
export const PROTOCOL = IS_DEV ? 'frink-dev' : 'frink';

const port = (value: string | undefined) => (/^[1-9]\d*$/.test(value ?? '') ? Number(value) : 0);

// Names a dev instance's profile ("Frink Dev-<port>"), so several can run side by side. A launch
// names one with FRINK_AUTH_SERVER_PORT, a build with MAIN_VITE_AUTH_SERVER_PORT.
export const AUTH_SERVER_PORT =
  (IS_DEV && port(process.env.FRINK_AUTH_SERVER_PORT)) ||
  port(import.meta.env.MAIN_VITE_AUTH_SERVER_PORT) ||
  (IS_DEV ? 21322 : 21321);
