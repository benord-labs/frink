import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

describe('filesRouter.duplicateFile', () => {
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await mkdtemp(join(tmpdir(), 'frink-files-duplicate-'));
  });

  afterEach(async () => {
    await rm(projectPath, { recursive: true, force: true });
  });

  it('duplicates into provided destination folder', async () => {
    await mkdir(join(projectPath, 'src'), { recursive: true });
    await mkdir(join(projectPath, 'dst'), { recursive: true });
    await mkdir(join(projectPath, 'src', 'rules'), { recursive: true });
    await writeFile(join(projectPath, 'src', 'rules', 'a.md'), 'hello', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.duplicateFile({
      projectPath,
      relativePath: 'src/rules',
      destinationFolder: 'dst',
    });

    expect(result.success).toBe(true);
    expect(result.newPath).toBe('dst/rules');
    await expect(access(join(projectPath, 'dst', 'rules', 'a.md'))).resolves.toBeUndefined();
  });

  it('duplicates in source folder when destination is omitted', async () => {
    await mkdir(join(projectPath, 'src'), { recursive: true });
    await writeFile(join(projectPath, 'src', 'settings.json'), '{}', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.duplicateFile({
      projectPath,
      relativePath: 'src/settings.json',
    });

    expect(result.success).toBe(true);
    expect(result.newPath).toBe('src/settings copy.json');
    await expect(access(join(projectPath, 'src', 'settings copy.json'))).resolves.toBeUndefined();
  });

  it('uses copy suffix when destinationFolder equals source parent folder', async () => {
    await mkdir(join(projectPath, 'src'), { recursive: true });
    await writeFile(join(projectPath, 'src', 'settings.json'), '{}', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.duplicateFile({
      projectPath,
      relativePath: 'src/settings.json',
      destinationFolder: 'src',
    });

    expect(result.success).toBe(true);
    expect(result.newPath).toBe('src/settings copy.json');
    await expect(access(join(projectPath, 'src', 'settings copy.json'))).resolves.toBeUndefined();
  });

  it('uses incremented copy naming when destination has collisions', async () => {
    await mkdir(join(projectPath, 'src'), { recursive: true });
    await mkdir(join(projectPath, 'dst'), { recursive: true });
    await mkdir(join(projectPath, 'src', 'rules'), { recursive: true });
    await mkdir(join(projectPath, 'dst', 'rules'), { recursive: true });
    await mkdir(join(projectPath, 'dst', 'rules copy'), { recursive: true });

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.duplicateFile({
      projectPath,
      relativePath: 'src/rules',
      destinationFolder: 'dst',
    });

    expect(result.success).toBe(true);
    expect(result.newPath).toBe('dst/rules copy 1');
    await expect(access(join(projectPath, 'dst', 'rules copy 1'))).resolves.toBeUndefined();
  });

  it('uses copy suffix when destination already has original name', async () => {
    await mkdir(join(projectPath, 'src'), { recursive: true });
    await mkdir(join(projectPath, 'dst'), { recursive: true });
    await mkdir(join(projectPath, 'src', 'rules'), { recursive: true });
    await mkdir(join(projectPath, 'dst', 'rules'), { recursive: true });

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.duplicateFile({
      projectPath,
      relativePath: 'src/rules',
      destinationFolder: 'dst',
    });

    expect(result.success).toBe(true);
    expect(result.newPath).toBe('dst/rules copy');
    await expect(access(join(projectPath, 'dst', 'rules copy'))).resolves.toBeUndefined();
  });

  it('duplicates into project root when destinationFolder is empty', async () => {
    await mkdir(join(projectPath, 'src', 'rules'), { recursive: true });
    await writeFile(join(projectPath, 'src', 'rules', 'a.md'), 'hello', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.duplicateFile({
      projectPath,
      relativePath: 'src/rules',
      destinationFolder: '',
    });

    expect(result.success).toBe(true);
    expect(result.newPath).toBe('rules');
    await expect(access(join(projectPath, 'rules', 'a.md'))).resolves.toBeUndefined();
  });

  it('duplicates file with extension into destination folder preserving base name', async () => {
    await mkdir(join(projectPath, 'src'), { recursive: true });
    await mkdir(join(projectPath, 'dst'), { recursive: true });
    await writeFile(join(projectPath, 'src', 'settings.json'), '{}', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const result = await caller.duplicateFile({
      projectPath,
      relativePath: 'src/settings.json',
      destinationFolder: 'dst',
    });

    expect(result.success).toBe(true);
    expect(result.newPath).toBe('dst/settings.json');
    await expect(access(join(projectPath, 'dst', 'settings.json'))).resolves.toBeUndefined();
  });

  it('rejects destinationFolder traversal', async () => {
    await mkdir(join(projectPath, 'src', 'rules'), { recursive: true });

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });

    await expect(
      caller.duplicateFile({
        projectPath,
        relativePath: 'src/rules',
        destinationFolder: '../outside',
      }),
    ).rejects.toThrow('Invalid path: traversal not allowed');
  });

  it('rejects absolute destinationFolder paths', async () => {
    await mkdir(join(projectPath, 'src', 'rules'), { recursive: true });

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });

    await expect(
      caller.duplicateFile({
        projectPath,
        relativePath: 'src/rules',
        destinationFolder: '/tmp',
      }),
    ).rejects.toThrow('Invalid path: must be relative');
  });

  it('fails when destination folder does not exist', async () => {
    await mkdir(join(projectPath, 'src', 'rules'), { recursive: true });

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });

    await expect(
      caller.duplicateFile({
        projectPath,
        relativePath: 'src/rules',
        destinationFolder: 'dst/missing',
      }),
    ).rejects.toThrow('Destination folder not found');
  });

  it('fails when destination path is a file', async () => {
    await mkdir(join(projectPath, 'src', 'rules'), { recursive: true });
    await mkdir(join(projectPath, 'dst'), { recursive: true });
    await writeFile(join(projectPath, 'dst', 'target.txt'), 'x', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });

    await expect(
      caller.duplicateFile({
        projectPath,
        relativePath: 'src/rules',
        destinationFolder: 'dst/target.txt',
      }),
    ).rejects.toThrow('Destination is not a folder');
  });

  it('fails cleanly when copied source no longer exists at paste time', async () => {
    await mkdir(join(projectPath, 'dst'), { recursive: true });

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });

    await expect(
      caller.duplicateFile({
        projectPath,
        relativePath: 'src/missing-rules',
        destinationFolder: 'dst',
      }),
    ).rejects.toThrow('File or folder not found: src/missing-rules');
  });

  it('assigns deterministic names for rapid repeated duplicates into same destination', async () => {
    await mkdir(join(projectPath, 'src'), { recursive: true });
    await mkdir(join(projectPath, 'dst'), { recursive: true });
    await mkdir(join(projectPath, 'src', 'rules'), { recursive: true });
    await writeFile(join(projectPath, 'src', 'rules', 'a.md'), 'hello', 'utf8');

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });
    const first = await caller.duplicateFile({
      projectPath,
      relativePath: 'src/rules',
      destinationFolder: 'dst',
    });
    const second = await caller.duplicateFile({
      projectPath,
      relativePath: 'src/rules',
      destinationFolder: 'dst',
    });

    expect(first.newPath).toBe('dst/rules');
    expect(second.newPath).toBe('dst/rules copy');
  });

  it('fails with a clear error after exhausting copy suffix attempts', async () => {
    await mkdir(join(projectPath, 'src'), { recursive: true });
    await writeFile(join(projectPath, 'src', 'settings.json'), '{}', 'utf8');

    const MAX_COPY_ATTEMPTS = 1000;
    for (let copyNum = 0; copyNum <= MAX_COPY_ATTEMPTS; copyNum++) {
      const suffix = copyNum === 0 ? ' copy' : ` copy ${copyNum}`;
      await writeFile(join(projectPath, 'src', `settings${suffix}.json`), '{}', 'utf8');
    }

    const { filesRouter } = await import('./files');
    const caller = filesRouter.createCaller({ getWindow: () => null });

    await expect(
      caller.duplicateFile({
        projectPath,
        relativePath: 'src/settings.json',
        destinationFolder: 'src',
      }),
    ).rejects.toThrow(
      'Failed to generate duplicate name after 1000 attempts in destination folder',
    );
  });
});
