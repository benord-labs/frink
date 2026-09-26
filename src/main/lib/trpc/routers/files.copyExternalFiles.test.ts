import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}));

describe('filesRouter.copyExternalFiles', () => {
  let projectPath: string;
  let sourceDir: string;

  beforeEach(async () => {
    projectPath = await mkdtemp(join(tmpdir(), 'frink-copy-external-'));
    sourceDir = await mkdtemp(join(tmpdir(), 'frink-copy-source-'));
  });

  afterEach(async () => {
    await rm(projectPath, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  });

  it('keepBoth preserves the existing file and reports the rename', async () => {
    // Existing file in the project that the drop would otherwise overwrite.
    await writeFile(join(projectPath, 'a.txt'), 'original', 'utf8');
    // Incoming external file with the same basename but different content.
    const source = join(sourceDir, 'a.txt');
    await writeFile(source, 'incoming', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.copyExternalFiles({
      sourcePaths: [source],
      projectPath,
      destinationFolder: '',
      resolution: 'keepBoth',
    });

    expect(result.copied).toBe(1);
    expect(result.renamed).toBe(1);
    expect(result.errors).toEqual([]);
    // Original is untouched, no silent overwrite.
    await expect(readFile(join(projectPath, 'a.txt'), 'utf8')).resolves.toBe('original');
    // Incoming file landed under a non-colliding name.
    await expect(readFile(join(projectPath, 'a (1).txt'), 'utf8')).resolves.toBe('incoming');
  });

  it('does not report a rename when there is no collision', async () => {
    await mkdir(join(projectPath, 'dst'), { recursive: true });
    const source = join(sourceDir, 'b.txt');
    await writeFile(source, 'incoming', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.copyExternalFiles({
      sourcePaths: [source],
      projectPath,
      destinationFolder: 'dst',
      resolution: 'keepBoth',
    });

    expect(result.copied).toBe(1);
    expect(result.renamed).toBe(0);
    await expect(readFile(join(projectPath, 'dst', 'b.txt'), 'utf8')).resolves.toBe('incoming');
  });

  it('renames each colliding file in one batch sequentially (1), (2)', async () => {
    // Existing file plus two incoming files that all share the same basename.
    await writeFile(join(projectPath, 'a.txt'), 'original', 'utf8');
    const first = join(sourceDir, 'a.txt');
    const secondDir = join(sourceDir, 'nested');
    await mkdir(secondDir, { recursive: true });
    const second = join(secondDir, 'a.txt');
    await writeFile(first, 'first', 'utf8');
    await writeFile(second, 'second', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.copyExternalFiles({
      sourcePaths: [first, second],
      projectPath,
      destinationFolder: '',
      resolution: 'keepBoth',
    });

    expect(result.copied).toBe(2);
    expect(result.renamed).toBe(2);
    // Original untouched; the two incomers land under distinct non-colliding names.
    await expect(readFile(join(projectPath, 'a.txt'), 'utf8')).resolves.toBe('original');
    await expect(readFile(join(projectPath, 'a (1).txt'), 'utf8')).resolves.toBe('first');
    await expect(readFile(join(projectPath, 'a (2).txt'), 'utf8')).resolves.toBe('second');
  });

  it('keepBoth renames a colliding directory and copies it recursively', async () => {
    // Existing folder the drop must not clobber.
    await mkdir(join(projectPath, 'docs'), { recursive: true });
    await writeFile(join(projectPath, 'docs', 'old.txt'), 'old', 'utf8');
    // Incoming folder with the same name but different contents.
    await mkdir(join(sourceDir, 'docs'), { recursive: true });
    await writeFile(join(sourceDir, 'docs', 'new.txt'), 'new', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.copyExternalFiles({
      sourcePaths: [join(sourceDir, 'docs')],
      projectPath,
      destinationFolder: '',
      resolution: 'keepBoth',
    });

    expect(result.copied).toBe(1);
    expect(result.renamed).toBe(1);
    // Original folder is left intact; the incoming one lands under "docs (1)".
    await expect(readFile(join(projectPath, 'docs', 'old.txt'), 'utf8')).resolves.toBe('old');
    await expect(readFile(join(projectPath, 'docs (1)', 'new.txt'), 'utf8')).resolves.toBe('new');
  });

  it('overwrite replaces the existing file without counting a rename', async () => {
    await writeFile(join(projectPath, 'a.txt'), 'original', 'utf8');
    const source = join(sourceDir, 'a.txt');
    await writeFile(source, 'incoming', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.copyExternalFiles({
      sourcePaths: [source],
      projectPath,
      destinationFolder: '',
      resolution: 'overwrite',
    });

    expect(result.copied).toBe(1);
    expect(result.renamed).toBe(0);
    // Content is replaced in place; no "(1)" copy is created.
    await expect(readFile(join(projectPath, 'a.txt'), 'utf8')).resolves.toBe('incoming');
  });

  it('skip leaves the existing file and counts neither copy nor rename', async () => {
    await writeFile(join(projectPath, 'a.txt'), 'original', 'utf8');
    const source = join(sourceDir, 'a.txt');
    await writeFile(source, 'incoming', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.copyExternalFiles({
      sourcePaths: [source],
      projectPath,
      destinationFolder: '',
      resolution: 'skip',
    });

    expect(result.copied).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.renamed).toBe(0);
    await expect(readFile(join(projectPath, 'a.txt'), 'utf8')).resolves.toBe('original');
  });

  it('renames an extension-less file by appending the counter to the full name', async () => {
    await writeFile(join(projectPath, 'README'), 'original', 'utf8');
    const source = join(sourceDir, 'README');
    await writeFile(source, 'incoming', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.copyExternalFiles({
      sourcePaths: [source],
      projectPath,
      destinationFolder: '',
      resolution: 'keepBoth',
    });

    expect(result.copied).toBe(1);
    expect(result.renamed).toBe(1);
    await expect(readFile(join(projectPath, 'README'), 'utf8')).resolves.toBe('original');
    await expect(readFile(join(projectPath, 'README (1)'), 'utf8')).resolves.toBe('incoming');
  });
});
