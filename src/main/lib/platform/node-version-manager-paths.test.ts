import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeVersionManagerPaths } from './node-version-manager-paths';

const HOME = '/mock/home';

// path.join so the expectations hold with either path separator.
function underHome(relativePaths: string[]): string[] {
  return relativePaths.map((relativePath) => path.join(HOME, relativePath));
}

describe('nodeVersionManagerPaths', () => {
  it('lists fnm, volta, mise then asdf on macOS', () => {
    expect(nodeVersionManagerPaths(HOME, 'darwin')).toEqual(
      underHome([
        '.local/share/fnm/aliases/default/bin',
        '.fnm/aliases/default/bin',
        'Library/Application Support/fnm/aliases/default/bin',
        '.volta/bin',
        '.local/share/mise/shims',
        '.asdf/shims',
        '.asdf/bin',
      ]),
    );
  });

  it('lists the same on Linux, without the macOS-only fnm directory', () => {
    expect(nodeVersionManagerPaths(HOME, 'linux')).toEqual(
      underHome([
        '.local/share/fnm/aliases/default/bin',
        '.fnm/aliases/default/bin',
        '.volta/bin',
        '.local/share/mise/shims',
        '.asdf/shims',
        '.asdf/bin',
      ]),
    );
  });

  it.each(['darwin', 'linux'] as const)('has no wildcard entry on %s', (platform) => {
    // PATH entries are never glob-expanded, so a wildcard would be a dead entry.
    for (const entry of nodeVersionManagerPaths(HOME, platform)) {
      expect(entry).not.toContain('*');
    }
  });

  describe('with a home directory on disk', () => {
    let home: string;

    beforeEach(async () => {
      home = await mkdtemp(path.join(os.tmpdir(), 'frink-fnm-home-'));
    });

    afterEach(async () => {
      await rm(home, { recursive: true, force: true });
    });

    async function createFnmDir(): Promise<{ fnmDir: string; installation: string }> {
      const fnmDir = path.join(home, '.local', 'share', 'fnm');
      const installation = path.join(fnmDir, 'node-versions', 'v22.0.0', 'installation');
      await mkdir(path.join(fnmDir, 'aliases'), { recursive: true });
      return { fnmDir, installation };
    }

    it('reaches the installed node through the fnm alias symlink', async () => {
      const { fnmDir, installation } = await createFnmDir();
      await mkdir(path.join(installation, 'bin'), { recursive: true });
      await writeFile(path.join(installation, 'bin', 'node'), '');
      await symlink(installation, path.join(fnmDir, 'aliases', 'default'));

      const [fnmBin] = nodeVersionManagerPaths(home, 'linux');

      await expect(access(path.join(fnmBin, 'node'))).resolves.toBeUndefined();
    });

    it('leaves a dangling fnm alias as an entry that finds nothing', async () => {
      const { fnmDir, installation } = await createFnmDir();
      await symlink(installation, path.join(fnmDir, 'aliases', 'default'));

      const [fnmBin] = nodeVersionManagerPaths(home, 'linux');

      expect(fnmBin).toBe(path.join(fnmDir, 'aliases', 'default', 'bin'));
      await expect(access(path.join(fnmBin, 'node'))).rejects.toThrow();
    });

    it('returns the same entries whether or not the directories exist', async () => {
      // The list is never filtered by what is installed: it is built without reading the disk.
      const before = nodeVersionManagerPaths(home, 'darwin');
      await mkdir(path.join(home, '.volta', 'bin'), { recursive: true });
      await mkdir(path.join(home, '.asdf', 'shims'), { recursive: true });

      expect(nodeVersionManagerPaths(home, 'darwin')).toEqual(before);
      expect(before).toHaveLength(7);
    });
  });
});
