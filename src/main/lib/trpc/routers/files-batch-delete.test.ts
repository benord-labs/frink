import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const trashItem = vi.fn<(path: string) => Promise<void>>();
const captureMainException = vi.fn();

vi.mock('../../sentry/init', () => ({ captureMainException }));

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
  shell: {
    trashItem: (path: string) => trashItem(path),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}));

describe('filesRouter delete goes to the OS trash', () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await mkdtemp(join(tmpdir(), 'frink-files-trash-'));
    trashItem.mockReset();
    captureMainException.mockReset();
    trashItem.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await rm(projectPath, { recursive: true, force: true });
  });

  it('trashes each item in a batch by absolute path', async () => {
    await writeFile(join(projectPath, 'a.txt'), 'a', 'utf8');
    await mkdir(join(projectPath, 'nested'), { recursive: true });
    await writeFile(join(projectPath, 'nested', 'b.txt'), 'b', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.batchDeleteFiles({
      projectPath,
      relativePaths: ['a.txt', 'nested/b.txt'],
    });

    expect(result.results.every((r) => r.success)).toBe(true);
    expect(trashItem).toHaveBeenCalledTimes(2);
    expect(trashItem.mock.calls.map(([p]) => p).sort()).toEqual(
      [join(projectPath, 'a.txt'), join(projectPath, 'nested', 'b.txt')].sort(),
    );
  });

  it('reports a failed trash without permanently deleting the file', async () => {
    await writeFile(join(projectPath, 'keep.txt'), 'keep', 'utf8');
    trashItem.mockRejectedValue(new Error('no trash available'));

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.batchDeleteFiles({
      projectPath,
      relativePaths: ['keep.txt'],
    });

    expect(result.results[0].success).toBe(false);
    // The guarantee that matters: a trash we could not perform must never
    // escalate to an unrecoverable rm().
    await expect(access(join(projectPath, 'keep.txt'))).resolves.toBeUndefined();
    // The user only sees "1 failed", so the reason has to reach telemetry.
    expect(captureMainException).toHaveBeenCalledWith(expect.any(Error), {
      area: 'files-batch-delete',
    });
  });

  it('reports missing paths instead of trashing them', async () => {
    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.batchDeleteFiles({
      projectPath,
      relativePaths: ['ghost.txt'],
    });

    expect(result.results[0].success).toBe(false);
    expect(trashItem).not.toHaveBeenCalled();
  });

  it('trashes a folder as one item rather than walking its contents', async () => {
    await mkdir(join(projectPath, 'nested', 'deep'), { recursive: true });
    await writeFile(join(projectPath, 'nested', 'deep', 'c.txt'), 'c', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.batchDeleteFiles({
      projectPath,
      relativePaths: ['nested'],
    });

    expect(result.results[0].success).toBe(true);
    // shell.trashItem takes the folder itself — it replaces the old
    // rm({recursive:true}) wholesale, not once per descendant.
    expect(trashItem).toHaveBeenCalledTimes(1);
    expect(trashItem).toHaveBeenCalledWith(join(projectPath, 'nested'));
  });

  it('keeps per-item results aligned with input order when one item fails mid-batch', async () => {
    await writeFile(join(projectPath, 'a.txt'), 'a', 'utf8');
    await writeFile(join(projectPath, 'b.txt'), 'b', 'utf8');
    await writeFile(join(projectPath, 'c.txt'), 'c', 'utf8');
    trashItem.mockImplementation((p: string) =>
      p.endsWith('b.txt') ? Promise.reject(new Error('locked')) : Promise.resolve(),
    );

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.batchDeleteFiles({
      projectPath,
      relativePaths: ['a.txt', 'b.txt', 'c.txt'],
    });

    // Bounded-concurrency workers can complete out of order; results must stay
    // keyed by input index or the UI blames the wrong file for a failure.
    expect(result.results.map((r) => [r.path, r.success])).toEqual([
      ['a.txt', true],
      ['b.txt', false],
      ['c.txt', true],
    ]);
    await expect(access(join(projectPath, 'b.txt'))).resolves.toBeUndefined();
  });

  it('rejects a path escaping the project without trashing anything', async () => {
    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.batchDeleteFiles({
      projectPath,
      relativePaths: ['../escape.txt'],
    });

    expect(result.results[0].success).toBe(false);
    expect(trashItem).not.toHaveBeenCalled();
  });

  it('trashes a single-file delete too, so it matches batch behaviour', async () => {
    await writeFile(join(projectPath, 'solo.txt'), 'solo', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.deleteFile({ projectPath, relativePath: 'solo.txt' });

    expect(result.success).toBe(true);
    expect(trashItem).toHaveBeenCalledWith(join(projectPath, 'solo.txt'));
  });

  it('surfaces a single-delete trash failure without deleting the file', async () => {
    await writeFile(join(projectPath, 'solo.txt'), 'solo', 'utf8');
    trashItem.mockRejectedValue(new Error('no trash available'));

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });

    await expect(caller.deleteFile({ projectPath, relativePath: 'solo.txt' })).rejects.toThrow(
      /Trash/,
    );
    await expect(access(join(projectPath, 'solo.txt'))).resolves.toBeUndefined();
  });
});
