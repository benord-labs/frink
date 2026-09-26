import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const localProjectGetMock = vi.fn();

vi.mock('../../db', () => ({
  getDatabase: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          get: localProjectGetMock,
        }),
      }),
    }),
  }),
  projects: { id: 'id' },
}));

describe('resolveLocalProjectOrThrow', () => {
  beforeEach(() => {
    localProjectGetMock.mockReset();
  });

  it('returns local project when found in sqlite', async () => {
    const localProject = { id: 'local-1', path: '/tmp/local' };
    localProjectGetMock.mockReturnValue(localProject);

    const { resolveLocalProjectOrThrow } = await import('./worktree-config');
    await expect(resolveLocalProjectOrThrow('local-1')).resolves.toEqual(localProject);
  });

  it('throws folder read-only message for virtual folder project', async () => {
    localProjectGetMock.mockReturnValue({ id: 'folder-1', path: 'virtual://folders/test' });

    const { resolveLocalProjectOrThrow } = await import('./worktree-config');
    await expect(resolveLocalProjectOrThrow('folder-1')).rejects.toThrow(
      'Folder settings are read-only in this view',
    );
  });

  it('throws project not found when missing locally (local-first: not local = not found)', async () => {
    localProjectGetMock.mockReturnValue(undefined);

    const { resolveLocalProjectOrThrow } = await import('./worktree-config');
    await expect(resolveLocalProjectOrThrow('missing')).rejects.toThrow('Project not found');
  });
});

describe('worktreeConfigRouter', () => {
  const tempDirs: string[] = [];

  async function createProjectWithConfig(config: unknown): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'frink-worktree-router-'));
    tempDirs.push(dir);
    const frinkPath = join(dir, '.frink', 'worktrees.json');
    await mkdir(dirname(frinkPath), { recursive: true });
    await writeFile(frinkPath, JSON.stringify(config, null, 2), 'utf-8');
    localProjectGetMock.mockReturnValue({ id: 'local-1', path: dir });
    return dir;
  }

  async function createCaller() {
    const { worktreeConfigRouter } = await import('./worktree-config');
    return worktreeConfigRouter.createCaller({ getWindow: () => null });
  }

  beforeEach(() => {
    localProjectGetMock.mockReset();
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  /**
   * The config object is the worktree file verbatim, so its keys are kebab-case. Routing `get`
   * through the default `publicProcedure` would apply `caseConvertOutput`, which rewrites `-` as
   * well as `_` inside nested objects — the renderer would read `setup-worktree` as undefined
   * while still type-checking. Guards the `publicProcedureRaw` opt-out.
   */
  it('returns config keys verbatim, not camelCased', async () => {
    await createProjectWithConfig({ 'setup-worktree': ['bun install'] });

    const result = await (await createCaller()).get({ projectId: 'local-1' });

    expect(result.config).toEqual({ 'setup-worktree': ['bun install'] });
    expect(result.config).not.toHaveProperty('setupWorktree');
  });

  it('save round-trips the kebab keys the renderer sends', async () => {
    const dir = await createProjectWithConfig({});

    await (
      await createCaller()
    ).save({
      projectId: 'local-1',
      patch: { 'setup-worktree': ['bun install'] },
    });

    const written = await readFile(join(dir, '.frink', 'worktrees.json'), 'utf-8');
    expect(JSON.parse(written)).toEqual({ 'setup-worktree': ['bun install'] });
  });

  it('rejects a project worktree base path that is not absolute', async () => {
    await createProjectWithConfig({});

    await expect(
      (await createCaller()).save({
        projectId: 'local-1',
        patch: { 'worktree-base-path': 'relative/path' },
      }),
    ).rejects.toThrow('must be absolute');
  });

  it('reports a file it cannot read instead of showing it as empty', async () => {
    const dir = await createProjectWithConfig({});
    await writeFile(join(dir, '.frink', 'worktrees.json'), '{ "setup-worktree": [], }', 'utf-8');

    await expect((await createCaller()).get({ projectId: 'local-1' })).rejects.toThrow(
      "Frink couldn't read .frink/worktrees.json",
    );
  });

  // A stored location the backend refuses (hand-written, or a teammate's Windows path) must not
  // block saving commands the user actually changed.
  it('saves commands without re-validating a stored location it was not asked to change', async () => {
    const dir = await createProjectWithConfig({ 'worktree-base-path': 'D:\\worktrees' });

    await (
      await createCaller()
    ).save({
      projectId: 'local-1',
      patch: { 'setup-worktree': ['bun install'] },
    });

    const written = await readFile(join(dir, '.frink', 'worktrees.json'), 'utf-8');
    expect(JSON.parse(written)).toEqual({
      'worktree-base-path': 'D:\\worktrees',
      'setup-worktree': ['bun install'],
    });
  });
});
