// Dev/isolation flag: `electron-vite dev` (ELECTRON_RENDERER_URL) or an isolated built bundle
// (FRINK_CDP_PORT). Readers isolate the instance: own userData, CDP, mock keychain, frink-dev://.
export const IS_DEV = !!process.env.ELECTRON_RENDERER_URL || !!process.env.FRINK_CDP_PORT;

// Deep-link protocol (must match package.json build.protocols.schemes); dev/QA use their own
// scheme so they never collide with an installed production app. index.ts and debug.ts import this.
export const PROTOCOL = IS_DEV ? 'frink-dev' : 'frink';

// Auth server port - use different port in dev to allow running alongside production.
// Override with MAIN_VITE_AUTH_SERVER_PORT to run multiple dev instances (e.g. worktrees) side-by-side.
const envPort = Number(import.meta.env.MAIN_VITE_AUTH_SERVER_PORT);
export const AUTH_SERVER_PORT =
  Number.isFinite(envPort) && envPort > 0 ? envPort : IS_DEV ? 21322 : 21321;
