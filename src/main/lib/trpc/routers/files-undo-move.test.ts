import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  shell: {
    trashItem: vi.fn(),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}));

/**
 * `undoFileMove` was originally cross-project only. These cover the degenerate
 * same-project case that same-project batch-move undo relies on.
 */
describe('filesRouter.undoFileMove within a single project', () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await mkdtemp(join(tmpdir(), 'frink-files-undo-'));
    await mkdir(join(projectPath, 'src'), { recursive: true });
    await mkdir(join(projectPath, 'dst'), { recursive: true });
  });

  afterEach(async () => {
    await rm(projectPath, { recursive: true, force: true });
  });

  it('returns a moved file to its original folder', async () => {
    await writeFile(join(projectPath, 'dst', 'a.txt'), 'contents', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.undoFileMove({
      sourceProjectPath: projectPath,
      sourcePath: 'src/a.txt',
      destProjectPath: projectPath,
      destPath: 'dst/a.txt',
    });

    expect(result.success).toBe(true);
    expect(await readFile(join(projectPath, 'src', 'a.txt'), 'utf8')).toBe('contents');
    await expect(access(join(projectPath, 'dst', 'a.txt'))).rejects.toThrow();
  });

  it('refuses when the file is no longer at the destination', async () => {
    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });

    await expect(
      caller.undoFileMove({
        sourceProjectPath: projectPath,
        sourcePath: 'src/gone.txt',
        destProjectPath: projectPath,
        destPath: 'dst/gone.txt',
      }),
    ).rejects.toThrow(/no longer exists/);
  });

  it('returns a moved folder, contents intact', async () => {
    await mkdir(join(projectPath, 'dst', 'rules'), { recursive: true });
    await writeFile(join(projectPath, 'dst', 'rules', 'inner.txt'), 'inner', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.undoFileMove({
      sourceProjectPath: projectPath,
      sourcePath: 'src/rules',
      destProjectPath: projectPath,
      destPath: 'dst/rules',
    });

    expect(result.success).toBe(true);
    expect(await readFile(join(projectPath, 'src', 'rules', 'inner.txt'), 'utf8')).toBe('inner');
  });

  it('recreates the original parent folder when it was removed after the move', async () => {
    await writeFile(join(projectPath, 'dst', 'a.txt'), 'contents', 'utf8');
    // Moving the only file out can leave the source folder empty; the user may
    // then delete it before undoing.
    await rm(join(projectPath, 'src'), { recursive: true, force: true });

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.undoFileMove({
      sourceProjectPath: projectPath,
      sourcePath: 'src/a.txt',
      destProjectPath: projectPath,
      destPath: 'dst/a.txt',
    });

    expect(result.success).toBe(true);
    expect(await readFile(join(projectPath, 'src', 'a.txt'), 'utf8')).toBe('contents');
  });

  it('refuses when a different file now occupies the original path', async () => {
    await writeFile(join(projectPath, 'dst', 'a.txt'), 'moved', 'utf8');
    await writeFile(join(projectPath, 'src', 'a.txt'), 'recreated', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });

    await expect(
      caller.undoFileMove({
        sourceProjectPath: projectPath,
        sourcePath: 'src/a.txt',
        destProjectPath: projectPath,
        destPath: 'dst/a.txt',
      }),
    ).rejects.toThrow(/different file/);
    // The file that was recreated in the meantime must survive untouched.
    expect(await readFile(join(projectPath, 'src', 'a.txt'), 'utf8')).toBe('recreated');
  });
});

describe('filesRouter.batchMoveFiles reports where each item landed', () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await mkdtemp(join(tmpdir(), 'frink-files-batchmove-'));
    await mkdir(join(projectPath, 'src'), { recursive: true });
    await mkdir(join(projectPath, 'dst'), { recursive: true });
  });

  afterEach(async () => {
    await rm(projectPath, { recursive: true, force: true });
  });

  it('returns destPath for real moves and omits it for no-ops', async () => {
    await writeFile(join(projectPath, 'src', 'a.txt'), 'a', 'utf8');
    await writeFile(join(projectPath, 'dst', 'b.txt'), 'b', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.batchMoveFiles({
      projectPath,
      // 'dst/b.txt' is already in the destination — nothing to move, nothing to undo.
      sourcePaths: ['src/a.txt', 'dst/b.txt'],
      destinationFolder: 'dst',
    });

    expect(result.results).toEqual([
      { sourcePath: 'src/a.txt', destPath: 'dst/a.txt', success: true },
      { sourcePath: 'dst/b.txt', success: true },
    ]);
  });

  it('reports a bare filename as destPath when moving to the project root', async () => {
    await writeFile(join(projectPath, 'src', 'a.txt'), 'a', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.batchMoveFiles({
      projectPath,
      sourcePaths: ['src/a.txt'],
      // Root is the empty-string destination — the boundary the destPath
      // ternary exists for.
      destinationFolder: '',
    });

    expect(result.results[0].destPath).toBe('a.txt');

    // The undo round-trip has to accept that bare path back.
    const undone = await caller.undoFileMove({
      sourceProjectPath: projectPath,
      sourcePath: 'src/a.txt',
      destProjectPath: projectPath,
      destPath: 'a.txt',
    });
    expect(undone.success).toBe(true);
    expect(await readFile(join(projectPath, 'src', 'a.txt'), 'utf8')).toBe('a');
  });

  it('marks a failed item without a destPath so undo cannot act on it', async () => {
    await writeFile(join(projectPath, 'src', 'a.txt'), 'a', 'utf8');
    await writeFile(join(projectPath, 'dst', 'a.txt'), 'occupied', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.batchMoveFiles({
      projectPath,
      sourcePaths: ['src/a.txt'],
      destinationFolder: 'dst',
    });

    expect(result.results[0].success).toBe(false);
    expect(result.results[0].destPath).toBeUndefined();
    // The collision must not have clobbered the file already sitting there.
    expect(await readFile(join(projectPath, 'dst', 'a.txt'), 'utf8')).toBe('occupied');
  });
});
