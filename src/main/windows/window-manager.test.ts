import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LoginShellEnvResolver,
  REFRESH_MIN_INTERVAL_MS,
  resolveLoginShellEnv,
  type ShellOutcome,
  setLoginShellEnvResolver,
} from '../lib/platform/login-shell-env';
import { setKeepAwakeService } from '../lib/power';
import { windowManager } from './window-manager';

/** The parts of a BrowserWindow the manager touches: an id and its events. */
function fakeWindow(id: number): BrowserWindow {
  // SAFETY: register() reads only `id` and subscribes with `on`, both of which this emitter has.
  return Object.assign(new EventEmitter(), { id }) as BrowserWindow;
}

const realPlatform = process.platform;
const startKeepAwake = vi.fn();

beforeEach(() => {
  startKeepAwake.mockClear();
  setKeepAwakeService({
    start: startKeepAwake,
    stop: vi.fn(),
    isEnabled: () => true,
    setEnabled: (enabled) => enabled,
  });
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('windowManager', () => {
  it('re-reads the login shell when a window gains focus (sc-4772)', async () => {
    // A tool installed in a terminal while Frink ran is found once the user comes back.
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    vi.useFakeTimers();
    vi.stubEnv('PATH', '/usr/bin');
    const profile = { PATH: '/old/bin' };
    const spawnShell = vi.fn(async (): Promise<ShellOutcome> => ({
      ok: true,
      env: { PATH: profile.PATH },
    }));
    setLoginShellEnvResolver(new LoginShellEnvResolver({ spawnShell, extendPath: (p) => p ?? '' }));
    await resolveLoginShellEnv();
    const window = fakeWindow(4772);
    windowManager.register(window);

    profile.PATH = '/new/bin';
    vi.advanceTimersByTime(REFRESH_MIN_INTERVAL_MS);
    window.emit('focus');
    await vi.advanceTimersByTimeAsync(0);

    expect(spawnShell).toHaveBeenCalledTimes(2);
    expect(process.env.PATH).toBe('/new/bin:/usr/bin');
    windowManager.unregister(window);
  });

  it('starts keeping the Mac awake once the first window exists', () => {
    const window = fakeWindow(5692);
    windowManager.register(window);
    expect(startKeepAwake).toHaveBeenCalledTimes(1);
    windowManager.unregister(window);
  });
});
