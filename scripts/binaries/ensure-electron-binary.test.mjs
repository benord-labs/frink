import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { electronBinaryPath, ensureElectronBinary } from './ensure-electron-binary.mjs';

// Built with join(), not literals: the module under test joins paths, so on win32 it would probe
// backslash-separated keys that POSIX-literal fixtures never contain — the seam would then report
// the electron dir as missing and every case would fail for the wrong reason.
const DIR = join('/repo', 'node_modules', 'electron');
const PATH_TXT = join(DIR, 'path.txt');
const INSTALLER = join(DIR, 'install.js');
const RELATIVE_BINARY = join('Electron.app', 'Contents', 'MacOS', 'Electron');
const BINARY = join(DIR, 'dist', RELATIVE_BINARY);

// Hoisted per biome lint/performance/useTopLevelRegex.
const CAUSE_AND_REMEDY = /getaddrinfo ENOTFOUND github\.com[\s\S]*electron:download/;
const NOT_RESOLVABLE = /no binary is resolvable/;
const RUN_BUN_INSTALL = /bun install/;

/** Seams over a virtual fs: `present` is the set of paths that exist. */
const seams = (present, overrides = {}) => ({
  electronDir: DIR,
  existsSync: (p) => present.has(String(p)),
  readFileSync: () => RELATIVE_BINARY,
  log: () => {},
  ...overrides,
});

describe('electronBinaryPath', () => {
  it('resolves the binary through path.txt, as electron getElectronPath() does', () => {
    expect(electronBinaryPath(DIR, seams(new Set([DIR, PATH_TXT, BINARY])))).toBe(BINARY);
  });

  it('reports absent when path.txt is missing', () => {
    expect(electronBinaryPath(DIR, seams(new Set()))).toBeNull();
  });

  it('reports absent when path.txt exists but the binary it names does not', () => {
    // A half-extracted download: checking dist/ alone would read this as success and make every
    // later run a false no-op.
    expect(electronBinaryPath(DIR, seams(new Set([PATH_TXT])))).toBeNull();
  });

  it('reports absent when path.txt is empty', () => {
    expect(
      electronBinaryPath(
        DIR,
        seams(new Set([DIR, PATH_TXT, BINARY]), { readFileSync: () => '  ' }),
      ),
    ).toBeNull();
  });
});

describe('ensureElectronBinary', () => {
  it('is a no-op when the binary is already present — never spawns the installer', () => {
    const runInstall = vi.fn();
    const result = ensureElectronBinary(seams(new Set([DIR, PATH_TXT, BINARY]), { runInstall }));

    expect(result).toEqual({ status: 'present', binaryPath: BINARY });
    expect(runInstall).not.toHaveBeenCalled();
  });

  it('runs the installer once when the binary is absent, then resolves it', () => {
    const present = new Set([DIR, INSTALLER]);
    const runInstall = vi.fn(() => {
      present.add(PATH_TXT);
      present.add(BINARY);
    });

    const result = ensureElectronBinary(seams(present, { runInstall }));

    expect(runInstall).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: 'installed', binaryPath: BINARY });
  });

  it('surfaces the installer failure with both cause and remedy', () => {
    const runInstall = vi.fn(() => {
      throw new Error('getaddrinfo ENOTFOUND github.com');
    });

    expect(() => ensureElectronBinary(seams(new Set([DIR, INSTALLER]), { runInstall }))).toThrow(
      CAUSE_AND_REMEDY,
    );
  });

  it('fails loudly when the installer exits 0 but leaves no resolvable binary', () => {
    // Partial state must never be reported as success — that is the silent-breakage mode.
    const runInstall = vi.fn(() => {
      /* exits 0, writes nothing */
    });

    expect(() => ensureElectronBinary(seams(new Set([DIR, INSTALLER]), { runInstall }))).toThrow(
      NOT_RESOLVABLE,
    );
  });

  it('tells the user to run bun install when node_modules/electron is absent', () => {
    const runInstall = vi.fn();
    expect(() => ensureElectronBinary(seams(new Set(), { runInstall }))).toThrow(RUN_BUN_INSTALL);
    expect(runInstall).not.toHaveBeenCalled();
  });
});
