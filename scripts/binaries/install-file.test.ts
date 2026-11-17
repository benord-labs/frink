import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installStaged, stagingPath, sweepStaging, writeFileAtomic } from './install-file.mjs';

// Above every platform's pid ceiling (macOS 99998, Linux pid_max ≤ 4194304).
const DEAD_PID = 9_999_999;

const dirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-file-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('installStaged', () => {
  it('replaces the target at a new inode instead of rewriting it in place', () => {
    const dir = tmpDir();
    const target = path.join(dir, 'claude');
    fs.writeFileSync(target, 'old');
    const before = fs.statSync(target).ino;

    const staged = stagingPath(dir, 'claude');
    fs.writeFileSync(staged, 'new');
    installStaged(staged, target, { mode: 0o755 });

    expect(fs.readFileSync(target, 'utf8')).toBe('new');
    expect(fs.statSync(target).ino).not.toBe(before);
    if (process.platform !== 'win32') expect(fs.statSync(target).mode & 0o777).toBe(0o755);
    expect(fs.existsSync(staged)).toBe(false);
  });

  it('removes the staged file when the rename fails', () => {
    const dir = tmpDir();
    const staged = stagingPath(dir, 'claude');
    fs.writeFileSync(staged, 'new');
    expect(() => installStaged(staged, path.join(dir, 'missing-dir', 'claude'))).toThrow();
    expect(fs.existsSync(staged)).toBe(false);
  });

  // Windows refuses to rename over a running .exe (a Frink chat using claude.exe). The raw EPERM
  // reads like a permissions bug; the developer needs to know to quit what is using it.
  it.each(['EPERM', 'EBUSY'])('names a Windows %s as the binary being in use', (code) => {
    const dir = tmpDir();
    const staged = stagingPath(dir, 'claude.exe');
    fs.writeFileSync(staged, 'new');
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error(code), { code });
    });
    try {
      expect(() => installStaged(staged, path.join(dir, 'claude.exe'))).toThrow(/in use/);
      expect(fs.existsSync(staged)).toBe(false);
    } finally {
      rename.mockRestore();
      platform.mockRestore();
    }
  });
});

describe('stagingPath / sweepStaging', () => {
  it('keeps the extension so a staged .exe stays executable on Windows', () => {
    expect(path.extname(stagingPath('/x', 'codex.exe'))).toBe('.exe');
  });

  // Worktrees share one resources/bin through a symlink, so two downloads can overlap. Sweeping a
  // live run's staging file would make its hash read ENOENT and fail that download.
  it("leaves a concurrently running process's in-flight staging file alone", () => {
    const dir = tmpDir();
    const live = stagingPath(dir, 'claude');
    fs.writeFileSync(live, 'partial');
    sweepStaging(dir, 'claude');
    expect(fs.existsSync(live)).toBe(true);
  });

  it('sweeps staging files whose owning process has exited, or that carry no pid', () => {
    const dir = tmpDir();
    const dead = path.join(dir, `.claude.staging-${DEAD_PID}-deadbeef`);
    const unparseable = path.join(dir, '.claude.staging-garbage');
    fs.writeFileSync(dead, '');
    fs.writeFileSync(unparseable, '');
    sweepStaging(dir, 'claude');
    expect(fs.existsSync(dead)).toBe(false);
    expect(fs.existsSync(unparseable)).toBe(false);
  });

  it('sweeps only staging files for the named binary', () => {
    const dir = tmpDir();
    const stale = path.join(dir, `.claude.staging-${DEAD_PID}-deadbeef`);
    const other = path.join(dir, `.codex.staging-${DEAD_PID}-deadbeef`);
    fs.writeFileSync(stale, '');
    fs.writeFileSync(other, '');
    fs.writeFileSync(path.join(dir, 'VERSION'), '');

    sweepStaging(dir, 'claude');

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'VERSION'))).toBe(true);
  });
});

describe('writeFileAtomic', () => {
  it('writes the contents through a fresh inode and leaves no staging file', () => {
    const dir = tmpDir();
    const target = path.join(dir, 'VERSION');
    fs.writeFileSync(target, 'old');
    const before = fs.statSync(target).ino;

    writeFileAtomic(target, '2.1.284\n');

    expect(fs.readFileSync(target, 'utf8')).toBe('2.1.284\n');
    expect(fs.statSync(target).ino).not.toBe(before);
    expect(fs.readdirSync(dir)).toEqual(['VERSION']);
  });
});
