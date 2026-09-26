import { beforeEach, describe, expect, it, vi } from 'vitest';

// A stateful fake of the local projects table: createProject enforces the UNIQUE(path)
// constraint the real SQLite schema has, so we can exercise collision + race handling.
const { state, getPathMock, mkdirMock, writeFileMock, existsSyncMock, deleteProjectMock } =
  vi.hoisted(() => {
    const state = {
      byPath: new Map<string, { id: string; name: string; path: string }>(),
      dirsOnDisk: new Set<string>(),
      seq: 0,
    };
    return {
      state,
      getPathMock: vi.fn(() => '/home/test'),
      mkdirMock: vi.fn(async (p: string) => {
        state.dirsOnDisk.add(p);
      }),
      writeFileMock: vi.fn(async (_path: string, _data: string) => undefined),
      existsSyncMock: vi.fn((p: string) => state.dirsOnDisk.has(p)),
      deleteProjectMock: vi.fn((_id: string) => undefined),
    };
  });

vi.mock('electron', () => ({ app: { getPath: getPathMock } }));
vi.mock('node:fs/promises', () => ({ mkdir: mkdirMock, writeFile: writeFileMock }));
vi.mock('node:fs', () => ({ existsSync: existsSyncMock }));
vi.mock('./db', () => ({ getDatabase: vi.fn(() => ({})) }));
vi.mock('./db/repos/projects', () => ({
  getProjectByPath: vi.fn(async (_db: unknown, path: string) => state.byPath.get(path) ?? null),
  createProject: vi.fn(async (_db: unknown, input: { name: string; path: string }) => {
    if (state.byPath.has(input.path)) {
      throw new Error(`UNIQUE constraint failed: projects.path (${input.path})`);
    }
    const row = { id: `p${++state.seq}`, name: input.name, path: input.path };
    state.byPath.set(input.path, row);
    return row;
  }),
  deleteProject: vi.fn(async (_db: unknown, id: string) => {
    for (const [p, row] of state.byPath) if (row.id === id) state.byPath.delete(p);
    deleteProjectMock(id);
  }),
}));

import { scaffoldBuild } from './project-scaffold';

const BUILDS = '/home/test/.frink/builds';

beforeEach(() => {
  // The builds root resolves through the home Frink owns, so sandbox that rather than app.getPath.
  vi.stubEnv('FRINK_HOME', '/home/test');
  state.byPath.clear();
  state.dirsOnDisk.clear();
  state.seq = 0;
  writeFileMock.mockClear();
  writeFileMock.mockResolvedValue(undefined);
  deleteProjectMock.mockClear();
});

describe('scaffoldBuild', () => {
  it('creates a gitless project and seeds AGENTS.md (no forced entry file)', async () => {
    const project = await scaffoldBuild('Build me a dashboard');

    expect(project.path).toBe(`${BUILDS}/build-me-a-dashboard`);
    // Display name is decoupled from the folder: starts as the placeholder (the chat auto-namer
    // replaces it with a friendly title), while the folder keeps the invisible slug.
    expect(project.name).toBe('New project');
    expect(project.name).not.toBe('build-me-a-dashboard');

    const written = writeFileMock.mock.calls.map((c) => String(c[0]));
    expect(written).toContain(`${project.path}/AGENTS.md`);
    // CLAUDE.md imports AGENTS.md so Claude Code (which loads CLAUDE.md, not AGENTS.md) respects it.
    expect(written).toContain(`${project.path}/CLAUDE.md`);
    // Project-agnostic: no index.html (or any entry file) is pre-seeded — the agent picks the shape.
    expect(written).not.toContain(`${project.path}/index.html`);
  });

  it('accepts a very long goal (a long first message must not throw) and slugs it to a safe folder', async () => {
    // The renderer sends the whole first message as the goal; length is unbounded because goal
    // only seeds the invisible folder slug (goalToSlug truncates), while the message itself
    // flows to the agent uncapped. A 2000-char message must scaffold, not error.
    const project = await scaffoldBuild('a'.repeat(2000));

    const slug = project.path.slice(`${BUILDS}/`.length);
    expect(slug.length).toBeGreaterThan(0);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it('de-dupes a slug collision against an existing DB row', async () => {
    const first = await scaffoldBuild('My App');
    const second = await scaffoldBuild('my app'); // same slug

    expect(first.path).toBe(`${BUILDS}/my-app`);
    expect(second.path).toBe(`${BUILDS}/my-app-2`);
  });

  it('de-dupes two un-sluggable goals that both fall back to the same folder', async () => {
    // First-timers/global users may open with an emoji- or non-Latin-only message. Both slug to
    // nothing, so goalToSlug falls back to the SAME 'my-project' name — the dedup loop must still
    // separate them (fallback slug wired through the collision path, not just real slugs).
    const emoji = await scaffoldBuild('🎨🎨');
    const cjk = await scaffoldBuild('日本語');

    expect(emoji.path).toBe(`${BUILDS}/my-project`);
    expect(cjk.path).toBe(`${BUILDS}/my-project-2`);
  });

  it('de-dupes against an orphan folder on disk with no DB row', async () => {
    state.dirsOnDisk.add(`${BUILDS}/notes`); // leftover from an abandoned build

    const project = await scaffoldBuild('Notes');

    expect(project.path).toBe(`${BUILDS}/notes-2`);
  });

  it('handles concurrent same-goal scaffolds without collision (multi-pane race)', async () => {
    const [a, b] = await Promise.all([scaffoldBuild('Same Goal'), scaffoldBuild('Same Goal')]);

    expect(a.path).not.toBe(b.path);
    expect(new Set([a.path, b.path]).size).toBe(2);
  });

  it('rolls back the DB row when seeding fails', async () => {
    writeFileMock.mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));

    await expect(scaffoldBuild('Disk Full')).rejects.toThrow('ENOSPC');

    // No orphan row pointing at a folder we failed to create…
    expect(deleteProjectMock).toHaveBeenCalledTimes(1);
    expect(state.byPath.size).toBe(0);
  });
});
