/**
 * getBundledBinaryPath resolves the bundled-binary location for BOTH shapes that differ
 * from CI (which only runs dev + darwin): a packaged app reading process.resourcesPath flat,
 * and Windows appending .exe. The download script (download-codex-binary.mjs) writes the
 * win asset as codex.exe and packs the host binary flat, so these contracts are real.
 */

import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  app: { isPackaged: false, getAppPath: () => '/mock/app' },
  isWindows: vi.fn(() => false),
}));
vi.mock('electron', () => ({ app: h.app }));
vi.mock('../platform', () => ({ isWindows: h.isWindows }));

import { getBundledBinaryPath } from './bundled-binary';

const proc = process as { resourcesPath?: string };
const origResourcesPath = proc.resourcesPath;

describe('getBundledBinaryPath', () => {
  afterEach(() => {
    h.app.isPackaged = false;
    h.isWindows.mockReturnValue(false);
    proc.resourcesPath = origResourcesPath;
  });

  it('dev build: resources/bin/{platform}-{arch}/<name> under the app path', () => {
    h.app.isPackaged = false;
    expect(getBundledBinaryPath('codex')).toBe(
      path.join('/mock/app', 'resources/bin', `${process.platform}-${process.arch}`, 'codex'),
    );
  });

  it('packaged build: {resourcesPath}/bin/<name>, flat (matches the download-script pack layout)', () => {
    h.app.isPackaged = true;
    proc.resourcesPath = '/mock/resources';
    expect(getBundledBinaryPath('codex')).toBe(path.join('/mock/resources', 'bin', 'codex'));
  });

  it('Windows appends .exe (the bundled raw exe, vs the npm `codex.cmd` a PATH lookup finds)', () => {
    h.isWindows.mockReturnValue(true);
    expect(getBundledBinaryPath('codex').endsWith('codex.exe')).toBe(true);
  });
});
