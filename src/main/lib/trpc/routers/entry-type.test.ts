import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findEntryType } from './entry-type';

async function write(root: string, relativePath: string): Promise<void> {
  await mkdir(dirname(join(root, relativePath)), { recursive: true });
  await writeFile(join(root, relativePath), 'x', 'utf8');
}

describe('findEntryType', () => {
  let project: string;
  let outside: string;

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'frink-entry-type-proj-'));
    outside = await mkdtemp(join(tmpdir(), 'frink-entry-type-out-'));
  });

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('tells a file from a folder, and reports nothing where neither is', async () => {
    await write(project, 'src/main/index.ts');

    await expect(findEntryType(project, 'src/main/index.ts')).resolves.toBe('file');
    await expect(findEntryType(project, 'src/main')).resolves.toBe('folder');
    await expect(findEntryType(project, 'src/main/gone.ts')).resolves.toBeNull();
    await expect(findEntryType(project, 'src/main/index.ts/inside')).resolves.toBeNull();
  });

  // The project file search skips build output, tool folders, logs and lock files.
  it.each([
    'build/entitlements.mac.plist',
    'dist/index.js',
    '.vscode/settings.json',
    'vendor/lib/x.go',
    'coverage/lcov.info',
    'logs/app.log',
    'bun.lock',
  ])('finds %s, which the project file search leaves out', async (relativePath) => {
    await write(project, relativePath);

    await expect(findEntryType(project, relativePath)).resolves.toBe('file');
  });

  it('follows a linked file and a linked folder to what they point at', async () => {
    await write(outside, 'notes/today.md');
    await symlink(join(outside, 'notes/today.md'), join(project, 'today.md'));
    await symlink(join(outside, 'notes'), join(project, 'notes'));
    await symlink(join(outside, 'gone.md'), join(project, 'dangling.md'));

    await expect(findEntryType(project, 'today.md')).resolves.toBe('file');
    await expect(findEntryType(project, 'notes')).resolves.toBe('folder');
    await expect(findEntryType(project, 'notes/today.md')).resolves.toBe('file');
    await expect(findEntryType(project, 'dangling.md')).resolves.toBeNull();
  });

  it('reports nothing for a path that leaves the project', async () => {
    await write(outside, 'secret.txt');
    const secret = join(outside, 'secret.txt');

    await expect(findEntryType(project, relative(project, secret))).resolves.toBeNull();
    await expect(findEntryType(project, secret)).resolves.toBeNull();
  });
});
