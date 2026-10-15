import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { lockedPlatformPackage, stagePlatformPackage } from './stage-cursor-platform.mjs';

const dirs: string[] = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-stage-test-'));
  dirs.push(dir);
  return dir;
}

/** An npm-style tarball (everything under `package/`) holding a cursorsandbox file. */
function tarball() {
  const src = tempDir();
  fs.mkdirSync(path.join(src, 'package', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(src, 'package', 'bin', 'cursorsandbox'), 'binary');
  execFileSync('tar', ['-czf', path.join(src, 'p.tgz'), '-C', src, 'package']);
  return fs.readFileSync(path.join(src, 'p.tgz'));
}

const integrityOf = (buf: Buffer) =>
  `sha512-${crypto.createHash('sha512').update(buf).digest('base64')}`;
const lockWith = (integrity: string) =>
  `    "@cursor/sdk-darwin-x64": ["@cursor/sdk-darwin-x64@1.0.37", "", { "os": "darwin", "bin": { "rg": "bin/rg" } }, "${integrity}"],\n`;

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('stage-cursor-platform', () => {
  it('reads both Mac platform packages pinned in the repo lockfile', () => {
    const lockText = fs.readFileSync(new URL('../../bun.lock', import.meta.url), 'utf8');
    for (const key of ['darwin-arm64', 'darwin-x64']) {
      expect(lockedPlatformPackage(lockText, key)).toMatchObject({
        version: '1.0.37',
        integrity: expect.stringMatching(/^sha512-/),
      });
    }
  });

  it('unpacks the verified tarball for the requested arch', async () => {
    const buf = tarball();
    const urls: string[] = [];
    const dest = await stagePlatformPackage('darwin-x64', {
      lockText: lockWith(integrityOf(buf)),
      destRoot: tempDir(),
      fetchTarball: async (url: string) => (urls.push(url), buf),
    });
    expect(urls).toEqual([
      'https://registry.npmjs.org/@cursor/sdk-darwin-x64/-/sdk-darwin-x64-1.0.37.tgz',
    ]);
    expect(fs.readFileSync(path.join(dest, 'bin', 'cursorsandbox'), 'utf8')).toBe('binary');
  });

  it('refuses a tarball that does not match the lockfile and stages nothing', async () => {
    const destRoot = tempDir();
    const staging = stagePlatformPackage('darwin-x64', {
      lockText: lockWith(integrityOf(Buffer.from('other'))),
      destRoot,
      fetchTarball: async () => tarball(),
    });
    await expect(staging).rejects.toThrow('does not match bun.lock');
    expect(fs.readdirSync(destRoot)).toEqual([]);
  });
});
