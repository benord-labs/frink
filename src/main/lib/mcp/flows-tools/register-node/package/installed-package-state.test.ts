import { chmod, mkdir, mkdtemp, open, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_PACKAGE_FILES,
  MAX_PACKAGE_METADATA_BYTES,
  MAX_PACKAGE_TOTAL_BYTES,
} from '../resource-files';
import { readBoundedInstalledFile, readInstalledPackageState } from './installed-package-state';
import { packageFileSystem } from './package-file-system';

const temporaryDirectories: string[] = [];
let slowFileReadStarted: (() => void) | undefined;

async function createInstalledNode(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'frink-installed-state-'));
  temporaryDirectories.push(root);
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'manifest.json'), '{"entrypoint":"index.js"}');
  await writeFile(join(root, 'index.js'), 'console.log("ok")');
  await writeFile(join(root, 'assets', 'image.png'), Buffer.from([1, 2, 3]));
  return root;
}

afterEach(async () => {
  slowFileReadStarted = undefined;
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('installed custom-node state', () => {
  it('attests every installed file and changes when a resource changes', async () => {
    const root = await createInstalledNode();
    const before = await readInstalledPackageState(root);
    await writeFile(join(root, 'assets', 'image.png'), Buffer.from([1, 2, 4]));
    const after = await readInstalledPackageState(root);

    expect(before?.files.map((file) => file.path)).toEqual([
      'assets/image.png',
      'index.js',
      'manifest.json',
    ]);
    expect(after?.digest).not.toBe(before?.digest);
  });

  it('reads bounded regular files without following symlinks', async () => {
    const root = await createInstalledNode();
    expect((await readBoundedInstalledFile(root, 'index.js', 100)).toString('utf8')).toContain(
      'console.log',
    );
    await symlink('/etc/passwd', join(root, 'linked.js'));
    await expect(readBoundedInstalledFile(root, 'linked.js', 100_000)).rejects.toThrow(
      'not a regular file',
    );
  });

  it('rejects cumulative oversized state before opening a file for hashing', async () => {
    const root = await createInstalledNode();
    const oversized = join(root, '000-oversized.bin');
    await writeFile(oversized, '');
    await truncate(oversized, MAX_PACKAGE_TOTAL_BYTES + 2 * MAX_PACKAGE_METADATA_BYTES + 1);
    await chmod(oversized, 0o000);

    await expect(readInstalledPackageState(root)).rejects.toThrow('exceeds installed size limit');
  });

  it('accepts the source file limit plus generated package metadata and rejects one more file', async () => {
    const root = await createInstalledNode();
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    const existingFiles = 4;
    await Promise.all(
      Array.from({ length: MAX_PACKAGE_FILES + 1 - existingFiles }, (_, index) =>
        writeFile(join(root, `resource-${index.toString().padStart(3, '0')}.png`), ''),
      ),
    );

    const accepted = await readInstalledPackageState(root);
    expect(accepted?.files).toHaveLength(MAX_PACKAGE_FILES + 1);

    await writeFile(join(root, 'too-many.png'), '');
    await expect(readInstalledPackageState(root)).rejects.toThrow(
      `exceeds ${MAX_PACKAGE_FILES + 1} file limit`,
    );
  }, 15_000);

  it('rejects a nested directory changed while its children are being hashed', async () => {
    const root = await createInstalledNode();
    const slowFile = join(root, 'assets', '000-slow.bin');
    await writeFile(slowFile, '');
    await truncate(slowFile, 64 * 1024 * 1024);

    vi.spyOn(packageFileSystem, 'open').mockImplementation(async (path, flags, mode) => {
      const handle = await open(path, flags, mode);
      if (String(path).endsWith('/assets/000-slow.bin')) slowFileReadStarted?.();
      return handle;
    });
    const hashingStarted = new Promise<void>((resolve) => {
      slowFileReadStarted = resolve;
    });
    const inspection = readInstalledPackageState(root);
    await hashingStarted;
    await writeFile(join(root, 'assets', 'late-resource.png'), 'changed');
    slowFileReadStarted = undefined;

    await expect(inspection).rejects.toThrow(/directory "assets" changed/);
  }, 15_000);

  it('treats a missing target as an absent baseline', async () => {
    await expect(
      readInstalledPackageState(join(tmpdir(), 'frink-target-does-not-exist')),
    ).resolves.toBeNull();
  });
});
