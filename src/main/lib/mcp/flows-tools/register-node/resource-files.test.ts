import { renameSync } from 'node:fs';
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { packageFileSystem } from './package/package-file-system';
import {
  consumeOpenFileAtMost,
  MAX_PACKAGE_DIRECTORIES,
  MAX_PACKAGE_FILES,
  MAX_PACKAGE_TOTAL_BYTES,
  packagePathError,
  readOpenFileAtMost,
  rehashPackageDirectory,
  stagePackageDirectory,
} from './resource-files';

const MANIFEST = {
  name: 'check-prs',
  displayName: 'Check PRs',
  entrypoint: 'index.js',
};

const temporaryDirectories: string[] = [];
let slowSourceReadStarted: (() => void) | undefined;

async function createProject(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'frink-package-test-'));
  temporaryDirectories.push(projectRoot);
  return projectRoot;
}

async function createPackage(
  files: Record<string, string | Buffer> = {},
): Promise<{ packageRoot: string; projectRoot: string; stagingRoot: string }> {
  const projectRoot = await createProject();
  const packageRoot = join(projectRoot, 'custom-nodes', 'check-prs');
  const stagingRoot = join(projectRoot, 'staging');
  await mkdir(packageRoot, { recursive: true });
  await mkdir(stagingRoot);
  const packageFiles = {
    'manifest.json': JSON.stringify(MANIFEST),
    'index.js': 'console.log("ok")',
    ...files,
  };
  for (const [path, content] of Object.entries(packageFiles)) {
    await mkdir(join(packageRoot, path, '..'), { recursive: true });
    await writeFile(join(packageRoot, path), content);
  }
  return { packageRoot, projectRoot, stagingRoot };
}

afterEach(async () => {
  slowSourceReadStarted = undefined;
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('custom-node package snapshot', () => {
  it('bounds descriptor reads to one byte past the accepted limit', async () => {
    const projectRoot = await createProject();
    const path = join(projectRoot, 'growing.json');
    await writeFile(path, Buffer.alloc(32, 0x20));
    const handle = await open(path, 'r');
    try {
      await expect(readOpenFileAtMost(handle, 10)).resolves.toHaveLength(11);
    } finally {
      await handle.close();
    }
  });

  it('reads only one sentinel byte when a source grows during capture', async () => {
    const projectRoot = await createProject();
    const path = join(projectRoot, 'growing.bin');
    await writeFile(path, Buffer.from([1, 2, 3]));
    const handle = await open(path, 'r');
    const chunkLengths: number[] = [];
    try {
      const bytesRead = await consumeOpenFileAtMost(handle, 3, async (chunk) => {
        chunkLengths.push(chunk.byteLength);
        if (chunkLengths.length === 1) await appendFile(path, Buffer.alloc(8 * 1024, 0xff));
      });

      expect(bytesRead).toBe(4);
      expect(chunkLengths).toEqual([3, 1]);
    } finally {
      await handle.close();
    }
  });

  it('copies a 10 MiB binary resource from disk without encoding it into MCP input', async () => {
    const image = Buffer.alloc(10 * 1024 * 1024, 0xab);
    const { projectRoot, stagingRoot } = await createPackage({
      'assets/large.png': image,
    });

    const snapshot = await stagePackageDirectory({
      entrypoint: 'index.js',
      packagePath: 'custom-nodes/check-prs',
      projectRoot,
      stagingRoot,
    });

    const copiedImage = await readFile(join(stagingRoot, 'assets', 'large.png'));
    expect(copiedImage.byteLength).toBe(image.byteLength);
    expect(copiedImage[0]).toBe(0xab);
    expect(copiedImage.at(-1)).toBe(0xab);
    expect(snapshot.resourcePaths).toEqual(['assets/large.png']);
    expect(snapshot.resources).toEqual([
      expect.objectContaining({
        path: 'assets/large.png',
        bytes: image.byteLength,
      }),
    ]);
    expect(snapshot.manifestBytes.toString('utf8')).toBe(JSON.stringify(MANIFEST));
    expect(snapshot.totalBytes).toBeGreaterThan(10 * 1024 * 1024);
    expect(snapshot.sourceManifest).toEqual(MANIFEST);
    expect(snapshot.entrypointBytes.toString('utf8')).toBe('console.log("ok")');
    expect(snapshot.digest).toMatch(/^[a-f0-9]{64}$/);
    await expect(rehashPackageDirectory(stagingRoot, 'index.js')).resolves.toBe(snapshot.digest);
  });

  it('rejects packages above the file-count limit', async () => {
    const resources = Object.fromEntries(
      Array.from({ length: MAX_PACKAGE_FILES - 1 }, (_, index) => [
        `assets/${index.toString().padStart(3, '0')}.png`,
        '',
      ]),
    );
    const { projectRoot, stagingRoot } = await createPackage(resources);

    await expect(
      stagePackageDirectory({
        entrypoint: 'index.js',
        packagePath: 'custom-nodes/check-prs',
        projectRoot,
        stagingRoot,
      }),
    ).rejects.toThrow(`exceeds ${MAX_PACKAGE_FILES} file limit`);
  });

  it('rejects packages above the directory-count limit', async () => {
    const { packageRoot, projectRoot, stagingRoot } = await createPackage();
    await Promise.all(
      Array.from({ length: MAX_PACKAGE_DIRECTORIES }, (_, index) =>
        mkdir(join(packageRoot, 'assets', index.toString()), { recursive: true }),
      ),
    );

    await expect(
      stagePackageDirectory({
        entrypoint: 'index.js',
        packagePath: 'custom-nodes/check-prs',
        projectRoot,
        stagingRoot,
      }),
    ).rejects.toThrow(`exceeds ${MAX_PACKAGE_DIRECTORIES} directory limit`);
  });

  it('rejects sparse packages above the total-size limit before reading them', async () => {
    const { packageRoot, projectRoot, stagingRoot } = await createPackage();
    const oversized = join(packageRoot, 'oversized.png');
    await writeFile(oversized, '');
    await truncate(oversized, MAX_PACKAGE_TOTAL_BYTES);

    await expect(
      stagePackageDirectory({
        entrypoint: 'index.js',
        packagePath: 'custom-nodes/check-prs',
        projectRoot,
        stagingRoot,
      }),
    ).rejects.toThrow('exceeds 256 MiB total size limit');
  });

  it.each([
    ['', 'dedicated package subdirectory'],
    ['.', 'dedicated package subdirectory'],
    ['../outside', '".." segment'],
    ['/absolute', 'relative POSIX'],
    ['custom-nodes\\node', 'relative POSIX'],
    ['node_modules/node', 'outside .git and node_modules'],
  ])('rejects unsafe packagePath %j', (packagePath, message) => {
    expect(packagePathError(packagePath)).toContain(message);
  });

  it('rejects symlinks without reading their targets', async () => {
    const { packageRoot, projectRoot, stagingRoot } = await createPackage();
    await symlink('/etc/passwd', join(packageRoot, 'assets.txt'));

    await expect(
      stagePackageDirectory({
        entrypoint: 'index.js',
        packagePath: 'custom-nodes/check-prs',
        projectRoot,
        stagingRoot,
      }),
    ).rejects.toThrow('is a symbolic link');
  });

  it.each([
    ['package.json', '{}', 'Frink-managed metadata'],
    ['assets/no-extension', 'data', 'JavaScript module or non-executable data file'],
  ])('rejects unsafe package member %s', async (path, content, message) => {
    const { projectRoot, stagingRoot } = await createPackage({
      [path]: content,
    });
    await expect(
      stagePackageDirectory({
        entrypoint: 'index.js',
        packagePath: 'custom-nodes/check-prs',
        projectRoot,
        stagingRoot,
      }),
    ).rejects.toThrow(message);
  });

  it('captures local JavaScript modules separately from data resources', async () => {
    const { projectRoot, stagingRoot } = await createPackage({
      'lib/helper.js': 'export const value = 42;\n',
      'lib/nested.mjs': 'export const nested = true;\n',
      'image.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });

    const snapshot = await stagePackageDirectory({
      entrypoint: 'index.js',
      packagePath: 'custom-nodes/check-prs',
      projectRoot,
      stagingRoot,
    });

    expect(snapshot.modules.map(({ path, source }) => ({ path, source }))).toEqual([
      { path: 'lib/helper.js', source: 'export const value = 42;\n' },
      { path: 'lib/nested.mjs', source: 'export const nested = true;\n' },
    ]);
    expect(snapshot.resources).toEqual([expect.objectContaining({ path: 'image.png', bytes: 4 })]);
    expect(snapshot.resourcePaths).toEqual(['image.png', 'lib/helper.js', 'lib/nested.mjs']);
  });

  it('classifies mixed-case JavaScript extensions as executable modules', async () => {
    const { projectRoot, stagingRoot } = await createPackage({
      'lib/helper.JS': 'export const value = 42;\n',
      'lib/nested.MJS': 'export const nested = true;\n',
    });

    const snapshot = await stagePackageDirectory({
      entrypoint: 'index.js',
      packagePath: 'custom-nodes/check-prs',
      projectRoot,
      stagingRoot,
    });

    expect(snapshot.modules.map(({ path }) => path)).toEqual(['lib/helper.JS', 'lib/nested.MJS']);
    expect(snapshot.resources).toEqual([]);
  });

  it('rejects data files with executable permission bits', async () => {
    const { packageRoot, projectRoot, stagingRoot } = await createPackage({
      'assets/tool.txt': 'data',
    });
    await chmod(join(packageRoot, 'assets', 'tool.txt'), 0o755);

    await expect(
      stagePackageDirectory({
        entrypoint: 'index.js',
        packagePath: 'custom-nodes/check-prs',
        projectRoot,
        stagingRoot,
      }),
    ).rejects.toThrow('executable permission bits');
  });

  it('allows normal nested resource directories', async () => {
    const valid = await createPackage({
      'assets/icons/one.png': Buffer.from([1]),
    });
    await expect(
      stagePackageDirectory({
        entrypoint: 'index.js',
        packagePath: 'custom-nodes/check-prs',
        projectRoot: valid.projectRoot,
        stagingRoot: valid.stagingRoot,
      }),
    ).resolves.toEqual(expect.objectContaining({ resourcePaths: ['assets/icons/one.png'] }));
  });

  it('rejects a package ancestor swapped out and back during source capture', async () => {
    const context = await createPackage({
      'assets/000-slow.png': Buffer.alloc(64 * 1024 * 1024, 0xab),
    });
    const packageParent = join(context.projectRoot, 'custom-nodes');
    const movedParent = join(context.projectRoot, 'custom-nodes-moved');

    vi.spyOn(packageFileSystem, 'open').mockImplementation(async (path, flags, mode) => {
      const handle = await open(path, flags, mode);
      if (String(path).endsWith('/assets/000-slow.png')) slowSourceReadStarted?.();
      return handle;
    });
    const sourceReadStarted = new Promise<void>((resolve) => {
      slowSourceReadStarted = resolve;
    });
    const capture = stagePackageDirectory({
      entrypoint: 'index.js',
      packagePath: 'custom-nodes/check-prs',
      projectRoot: context.projectRoot,
      stagingRoot: context.stagingRoot,
    });
    await sourceReadStarted;
    renameSync(packageParent, movedParent);
    renameSync(movedParent, packageParent);

    await expect(capture).rejects.toThrow(/changed while the package was being inspected/);
  }, 15_000);
});
