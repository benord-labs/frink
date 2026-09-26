import os from 'node:os';
import { vi } from 'vitest';

/**
 * Shared test plumbing for handler tests that sandbox `os.homedir()`.
 *
 * `vi.mock` factories are hoisted, so they cannot reference module-scope imports —
 * but they CAN dynamically import this module, which gives every test file the same
 * `mockHome` instance. Usage in a test file:
 *
 *   vi.mock('node:os', async (importOriginal) =>
 *     (await import('./test-mock-home')).osModuleWithMockHome(importOriginal),
 *   );
 *   vi.mock('electron-log', async () => (await import('./test-mock-home')).electronLogMock());
 *   import { mockHome } from './test-mock-home';
 *   beforeEach(() => { mockHome.value = tmpDir; });
 */
let home = '';
/** Setting `value` also stubs FRINK_HOME: frinkUserHome() reads the env before os.homedir(). */
export const mockHome = {
  get value(): string {
    return home;
  },
  set value(dir: string) {
    home = dir;
    vi.stubEnv('FRINK_HOME', dir);
  },
};

type OsModuleMock = typeof import('node:os') & { default: typeof import('node:os') };

export async function osModuleWithMockHome(
  importOriginal: () => Promise<unknown>,
): Promise<OsModuleMock> {
  const actual = (await importOriginal()) as typeof import('node:os');
  const homedir = (): string => mockHome.value;
  // `default` too: a spread alone leaves it on the REAL module, so `import os from` reads the real home.
  return { ...actual, default: { ...actual, homedir }, homedir };
}

export function electronLogMock(): { default: { info: () => void; warn: () => void } } {
  return { default: { info: vi.fn(), warn: vi.fn() } };
}
