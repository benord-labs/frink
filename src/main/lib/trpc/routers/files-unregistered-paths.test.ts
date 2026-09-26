import { mkdir, mkdtemp, readFile as readFileFs, rm, writeFile } from 'node:fs/promises';
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

/**
 * The files router reaches any path the user could open in a terminal — it holds no
 * allowlist of "known" project roots. Frink's own generated files (session plans, MCP
 * config) live outside every project, so a registration gate here made them unopenable
 * in Frink's own editor. Operations that take a project path plus a *relative* path
 * still refuse to leave that project; those guards are asserted here too so a future
 * change cannot quietly drop them alongside the gate.
 */
describe('filesRouter path access', () => {
  let outsidePath: string;

  beforeEach(async () => {
    outsidePath = await mkdtemp(join(tmpdir(), 'frink-unregistered-'));
  });

  afterEach(async () => {
    await rm(outsidePath, { recursive: true, force: true });
  });

  it('reads a file that belongs to no project', async () => {
    const filePath = join(outsidePath, 'plan.md');
    await writeFile(filePath, '# plan', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });

    await expect(caller.readFile({ filePath })).resolves.toBe('# plan');
  });

  it('writes a file that belongs to no project', async () => {
    const filePath = join(outsidePath, 'plan.md');
    await writeFile(filePath, 'before', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });

    await expect(caller.writeFile({ filePath, content: 'after' })).resolves.toEqual({
      success: true,
    });
    await expect(readFileFs(filePath, 'utf8')).resolves.toBe('after');
  });

  it('lists a directory that belongs to no project', async () => {
    await writeFile(join(outsidePath, 'note.md'), 'x', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });

    const entries = await caller.listDirectory({ projectPath: outsidePath, relativePath: '' });
    expect(entries.map((entry) => entry.name)).toContain('note.md');
  });

  it('still refuses to move a file out of the project it was given', async () => {
    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });

    await expect(
      caller.moveFile({
        projectPath: outsidePath,
        sourcePath: '../escape.txt',
        destinationFolder: '',
      }),
    ).rejects.toThrow('traversal not allowed');
  });

  it('still refuses to list outside the project it was given', async () => {
    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });

    const entries = await caller.listDirectory({
      projectPath: outsidePath,
      relativePath: '../..',
    });
    expect(entries).toEqual([]);
  });

  /**
   * readFile has no restriction at all, so the binary readers are the only procedures
   * left holding a per-type guard. Removing the registration gate must not have made
   * them into general-purpose readers of arbitrary bytes.
   */
  it('reads an out-of-project image but still rejects a non-image', async () => {
    const imagePath = join(outsidePath, 'shot.png');
    await writeFile(imagePath, 'not-really-png-bytes', 'utf8');
    const textPath = join(outsidePath, 'notes.txt');
    await writeFile(textPath, 'plain', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });

    const { dataUrl } = await caller.readImageFile({ filePath: imagePath });
    expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);

    await expect(caller.readImageFile({ filePath: textPath })).rejects.toThrow(
      'Not an allowed image type',
    );
  });

  it('still rejects a non-PDF handed to the PDF reader', async () => {
    const textPath = join(outsidePath, 'notes.txt');
    await writeFile(textPath, 'plain', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });

    await expect(caller.readPdfFile({ filePath: textPath })).rejects.toThrow('Not a PDF file');
  });
});

/**
 * `search` accepts whatever root the renderer names, so its tree scan carries an entry
 * budget to bound the work an absurd root can cost. The budget object is threaded
 * through the recursion by reference; these assert it bounds nothing at ordinary sizes,
 * because a budget that leaked across siblings would silently truncate real results.
 */
describe('filesRouter search tree scan', () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await mkdtemp(join(tmpdir(), 'frink-scan-'));
    await mkdir(join(projectPath, 'sub', 'deeper'), { recursive: true });
    await writeFile(join(projectPath, 'a.txt'), 'a', 'utf8');
    await writeFile(join(projectPath, 'sub', 'b.txt'), 'b', 'utf8');
    await writeFile(join(projectPath, 'sub', 'deeper', 'c.txt'), 'c', 'utf8');
  });

  afterEach(async () => {
    await rm(projectPath, { recursive: true, force: true });
  });

  it('returns every file and folder at every depth', async () => {
    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });

    const results = await caller.search({ projectPath, query: '' });
    const paths = results.map((entry) => entry.path);

    expect(paths).toContain('a.txt');
    expect(paths).toContain('sub');
    expect(paths).toContain(join('sub', 'b.txt'));
    expect(paths).toContain(join('sub', 'deeper'));
    expect(paths).toContain(join('sub', 'deeper', 'c.txt'));
  });

  it('finds a deeply nested file by name', async () => {
    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });

    const results = await caller.search({ projectPath, query: 'c.txt' });

    expect(results.map((entry) => entry.path)).toContain(join('sub', 'deeper', 'c.txt'));
  });
});
