import { execFileSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile as readFileFs,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
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

  it('saves through a link that leaves the project and says where it went', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'frink-linked-project-'));
    const target = join(outsidePath, 'bashrc');
    await writeFile(target, 'before', 'utf8');
    const filePath = join(projectPath, 'config.yml');
    await symlink(target, filePath);

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });

    try {
      // The editor route informs; it never blocks the open or the save.
      await expect(caller.symlinkEscape({ projectPath, filePath })).resolves.toEqual({
        escapes: true,
        realPath: await realpath(target),
      });
      await expect(caller.readFile({ filePath })).resolves.toBe('before');
      await expect(caller.writeFile({ filePath, content: 'after' })).resolves.toEqual({
        success: true,
      });
      await expect(readFileFs(target, 'utf8')).resolves.toBe('after');
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it('reports no escape for a file that belongs to no project', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'frink-linked-project-'));
    const filePath = join(outsidePath, 'plan.md');
    await writeFile(filePath, '# plan', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });

    try {
      await expect(caller.symlinkEscape({ projectPath, filePath })).resolves.toEqual({
        escapes: false,
      });
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
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

const isWindows = process.platform === 'win32';

/** Windows needs no privilege for a junction, so folder links are junctions there. */
const linkFolder = (target: string, path: string) =>
  symlink(target, path, isWindows ? 'junction' : 'dir');

async function caller() {
  const { filesRouter } = await import('./files');
  return filesRouter.createCaller({ getWindow: () => null });
}

describe('filesRouter symlinked entries', () => {
  let root: string;
  let projectPath: string;
  let outside: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'frink-files-symlinks-'));
    projectPath = join(root, 'project');
    outside = join(root, 'outside');
    await mkdir(projectPath);
    await mkdir(outside);
    await writeFile(join(outside, 'notes.md'), 'outside', 'utf8');
    await linkFolder(outside, join(projectPath, 'linked'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('lists a folder link in name search without walking into it', async () => {
    const results = await (await caller()).search({ projectPath, query: '' });

    expect(results.map((entry) => [entry.path, entry.type])).toEqual([['linked', 'folder']]);
  });

  it('lists file and folder links by their target kind and skips broken links', async (ctx) => {
    await writeFile(join(projectPath, 'AGENTS.md'), '# agents', 'utf8');
    try {
      await symlink('missing', join(projectPath, 'dangling'));
      await symlink('loop', join(projectPath, 'loop'));
      await symlink('AGENTS.md', join(projectPath, 'CLAUDE.md'));
    } catch (error) {
      // Windows file links need Developer Mode or elevation.
      if (isWindows && error instanceof Error && 'code' in error && error.code === 'EPERM')
        ctx.skip();
      throw error;
    }

    const rows = await (await caller()).listDirectory({ projectPath });

    expect(rows.map((row) => [row.name, row.type])).toEqual([
      ['linked', 'folder'],
      ['AGENTS.md', 'file'],
      ['CLAUDE.md', 'file'],
    ]);
  });

  it('expands a linked folder inside a git repo and creates files through it', async () => {
    // git check-ignore refuses paths "beyond a symbolic link", which real projects hit.
    execFileSync('git', ['init', '-q'], { cwd: projectPath });
    const files = await caller();

    expect(await files.listDirectory({ projectPath, relativePath: 'linked' })).toMatchObject([
      { name: 'notes.md', path: join('linked', 'notes.md'), type: 'file' },
    ]);

    await files.createFile({ projectPath, relativePath: join('linked', 'new.md') });
    expect(await readdir(outside)).toContain('new.md');
  });

  it('copies a folder link to another project as the link, not its contents', async () => {
    const destProjectPath = join(root, 'dest');
    await mkdir(destProjectPath);
    const files = await caller();

    await files.crossProjectCopy({
      sourceProjectPath: projectPath,
      sourcePath: 'linked',
      destProjectPath,
      operationId: 'op-1',
    });

    const copied = join(destProjectPath, 'linked');
    expect((await lstat(copied)).isSymbolicLink()).toBe(true);
    expect(await readlink(copied)).toBe(await readlink(join(projectPath, 'linked')));
  });

  it('still copies a regular file to another project with progress', async () => {
    const destProjectPath = join(root, 'dest');
    await mkdir(destProjectPath);
    await writeFile(join(projectPath, 'plain.md'), 'plain', 'utf8');

    await (
      await caller()
    ).crossProjectCopy({
      sourceProjectPath: projectPath,
      sourcePath: 'plain.md',
      destProjectPath,
      operationId: 'op-2',
    });

    const copied = join(destProjectPath, 'plain.md');
    expect((await lstat(copied)).isFile()).toBe(true);
    expect(await readFileFs(copied, 'utf8')).toBe('plain');
  });

  it.skipIf(isWindows)('keeps links nested in a folder copied with progress', async () => {
    const destProjectPath = join(root, 'dest');
    await mkdir(destProjectPath);
    await mkdir(join(projectPath, 'docs'));
    await writeFile(join(projectPath, 'docs', 'guide.md'), 'guide', 'utf8');
    await symlink('guide.md', join(projectPath, 'docs', 'alias.md'));

    await (
      await caller()
    ).crossProjectCopy({
      sourceProjectPath: projectPath,
      sourcePath: 'docs',
      destProjectPath,
      operationId: 'op-3',
    });

    expect(await readlink(join(destProjectPath, 'docs', 'alias.md'))).toBe('guide.md');
    expect(await readFileFs(join(destProjectPath, 'docs', 'guide.md'), 'utf8')).toBe('guide');
  });

  // Windows only allows folder symlinks with Developer Mode; junctions need no privilege.
  it.skipIf(isWindows)('copies a folder link as an absolute junction on Windows', async () => {
    const destProjectPath = join(root, 'dest');
    await mkdir(destProjectPath);
    await symlink(join('..', 'outside'), join(projectPath, 'relative'), 'dir');
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      await (
        await caller()
      ).crossProjectCopy({
        sourceProjectPath: projectPath,
        sourcePath: 'relative',
        destProjectPath,
        operationId: 'op-4',
      });
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }

    expect(await readlink(join(destProjectPath, 'relative'))).toBe(outside);
  });
});
