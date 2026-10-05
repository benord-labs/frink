import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REQUIRED_CLAUDE_BINARY_ENV } from './binary-capabilities.mjs';
import { downloadPlatform } from './download-claude-binary.mjs';

const PLATFORM = 'darwin-arm64';
const GOOD = `bin ${REQUIRED_CLAUDE_BINARY_ENV.join(' ')} bin`;
const sha = (contents: string) => crypto.createHash('sha256').update(contents).digest('hex');
const manifestFor = (contents: string) => ({
  platforms: { [PLATFORM]: { checksum: sha(contents), size: contents.length } },
});

const dirs: string[] = [];
function binDirWith(existing?: string) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-download-'));
  dirs.push(binDir);
  const target = path.join(binDir, PLATFORM, 'claude');
  if (existing !== undefined) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, existing);
  }
  return { binDir, target };
}
const serving = (contents: string) =>
  vi.fn(async (_url: string, dest: string) => fs.writeFileSync(dest, contents));
const stagingLeft = (binDir: string) =>
  fs.readdirSync(binDir).filter((entry) => entry.includes('.staging-'));

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});
vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

describe('downloadPlatform', () => {
  it('installs an update at a new inode instead of rewriting the signed binary in place', async () => {
    const { binDir, target } = binDirWith('old build');
    const before = fs.statSync(target).ino;

    const ok = await downloadPlatform('2.1.284', PLATFORM, manifestFor(GOOD), {
      binDir,
      download: serving(GOOD),
    });

    expect(ok).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe(GOOD);
    expect(fs.statSync(target).ino).not.toBe(before);
    if (process.platform !== 'win32') expect(fs.statSync(target).mode & 0o777).toBe(0o755);
    expect(stagingLeft(binDir)).toEqual([]);
  });

  it('never stages inside the packaged per-platform directory', async () => {
    const { binDir, target } = binDirWith();
    const download = serving(GOOD);
    await downloadPlatform('2.1.284', PLATFORM, manifestFor(GOOD), { binDir, download });
    expect(path.dirname(download.mock.calls[0][1])).toBe(binDir);
    expect(fs.readdirSync(path.dirname(target))).toEqual(['claude']);
  });

  it('keeps the working binary untouched when the download fails its hash check', async () => {
    const { binDir, target } = binDirWith('old build');
    const before = fs.statSync(target).ino;

    const ok = await downloadPlatform('2.1.284', PLATFORM, manifestFor(GOOD), {
      binDir,
      download: serving(`${GOOD} tampered`),
    });

    expect(ok).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('old build');
    expect(fs.statSync(target).ino).toBe(before);
    expect(stagingLeft(binDir)).toEqual([]);
  });

  it('keeps the working binary untouched when the download lacks a required capability', async () => {
    const { binDir, target } = binDirWith('old build');
    const incapable = 'bin without the env vars';

    const ok = await downloadPlatform('2.1.284', PLATFORM, manifestFor(incapable), {
      binDir,
      download: serving(incapable),
    });

    expect(ok).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('old build');
    expect(stagingLeft(binDir)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    're-links an already-current binary at a fresh inode so one rewritten in place recovers',
    async () => {
      const { binDir, target } = binDirWith(GOOD);
      const before = fs.statSync(target).ino;
      const download = serving(GOOD);

      const ok = await downloadPlatform('2.1.284', PLATFORM, manifestFor(GOOD), {
        binDir,
        download,
      });

      expect(ok).toBe(true);
      expect(download).not.toHaveBeenCalled();
      expect(fs.readFileSync(target, 'utf8')).toBe(GOOD);
      expect(fs.statSync(target).ino).not.toBe(before);
      expect(stagingLeft(binDir)).toEqual([]);
    },
  );

  // A dropped connection rejects instead of returning false: the error must still reach main()
  // (exit 1, VERSION unwritten) with the working binary and no half-file left behind.
  it('keeps the working binary and propagates the error when the download itself fails', async () => {
    const { binDir, target } = binDirWith('old build');
    const download = vi.fn(async (_url: string, dest: string) => {
      fs.writeFileSync(dest, 'half a bina');
      throw new Error('socket hang up');
    });

    await expect(
      downloadPlatform('2.1.284', PLATFORM, manifestFor(GOOD), { binDir, download }),
    ).rejects.toThrow('socket hang up');

    expect(fs.readFileSync(target, 'utf8')).toBe('old build');
    expect(stagingLeft(binDir)).toEqual([]);
  });

  // The old in-place write followed a per-file symlink and rewrote the SHARED binary every
  // other checkout runs. The rename must replace the link itself and leave its target alone.
  it.skipIf(process.platform === 'win32')(
    'replaces a symlinked binary without writing through to the shared file it points at',
    async () => {
      const { binDir, target } = binDirWith();
      const shared = path.join(binDir, 'shared-claude');
      fs.writeFileSync(shared, 'shared build');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(shared, target);

      const ok = await downloadPlatform('2.1.284', PLATFORM, manifestFor(GOOD), {
        binDir,
        download: serving(GOOD),
      });

      expect(ok).toBe(true);
      expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(target, 'utf8')).toBe(GOOD);
      expect(fs.readFileSync(shared, 'utf8')).toBe('shared build');
    },
  );

  it('sweeps staging files an interrupted run left behind', async () => {
    const { binDir } = binDirWith();
    const stale = path.join(binDir, '.claude.staging-9999999-deadbeef');
    fs.writeFileSync(stale, 'partial');

    await downloadPlatform('2.1.284', PLATFORM, manifestFor(GOOD), {
      binDir,
      download: serving(GOOD),
    });

    expect(fs.existsSync(stale)).toBe(false);
  });
});
