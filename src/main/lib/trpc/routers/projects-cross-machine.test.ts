import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';

let testDb: TestDb;

// Provide the real schema re-exports (pure table defs, no DB side effects) so the
// task-executor → credentials import chain (claudeCodeCredentials) resolves; override getDatabase.
vi.mock('../../db', async () => {
  const schema = await vi.importActual<typeof import('../../db/schema')>('../../db/schema');
  return { ...schema, getDatabase: () => testDb };
});

vi.mock('electron', () => ({
  app: { getPath: () => '/mock' },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  dialog: { showOpenDialog: vi.fn() },
}));

vi.mock('../../analytics', () => ({ trackProjectOpened: vi.fn() }));
vi.mock('../../cli', () => ({ getLaunchDirectory: vi.fn() }));
vi.mock('../../socket/executor', () => ({ abortActiveExecutionsForSubChats: vi.fn() }));
vi.mock('../../git', () => ({ getGitRemoteInfo: vi.fn() }));

import { createProject } from '../../db/repos/projects';
import { projectsRouter } from './projects';

const ctx = { getWindow: () => null };

describe('projectsRouter — is_cross_machine flag (ticket 01)', () => {
  beforeEach(() => {
    testDb = freshDb();
  });

  it('defaults isCrossMachine to false on new project', async () => {
    const project = await createProject(testDb, { name: 'p', path: '/tmp/p1' });
    const caller = projectsRouter.createCaller(ctx);
    const result = await caller.get({ id: project.id });
    expect(result?.isCrossMachine).toBe(false);
  });

  it('round-trips setCrossMachine → getCrossMachine', async () => {
    const project = await createProject(testDb, { name: 'p', path: '/tmp/p2' });
    const caller = projectsRouter.createCaller(ctx);

    await caller.setCrossMachine({ projectId: project.id, isCrossMachine: true });
    expect(await caller.getCrossMachine({ projectId: project.id })).toBe(true);

    await caller.setCrossMachine({ projectId: project.id, isCrossMachine: false });
    expect(await caller.getCrossMachine({ projectId: project.id })).toBe(false);
  });

  it('does not clobber the flag on unrelated patch updates', async () => {
    const project = await createProject(testDb, { name: 'p', path: '/tmp/p3' });
    const caller = projectsRouter.createCaller(ctx);

    await caller.setCrossMachine({ projectId: project.id, isCrossMachine: true });
    // Simulate an unrelated update path (e.g. rename) — must preserve the flag
    const { updateProject } = await import('../../db/repos/projects');
    await updateProject(testDb, project.id, { name: 'renamed' });

    expect(await caller.getCrossMachine({ projectId: project.id })).toBe(true);
  });

  it('throws NOT_FOUND when setCrossMachine targets a missing project', async () => {
    const caller = projectsRouter.createCaller(ctx);
    await expect(
      caller.setCrossMachine({ projectId: 'does-not-exist', isCrossMachine: true }),
    ).rejects.toThrow(TRPCError);
  });

  it('returns false for getCrossMachine on a missing project', async () => {
    const caller = projectsRouter.createCaller(ctx);
    expect(await caller.getCrossMachine({ projectId: 'does-not-exist' })).toBe(false);
  });

  // Edge case: ticket 11 UI iterates `projects.list` to render per-project toggles.
  // Guards against a future schema change accidentally hiding the column from the row.
  it('exposes isCrossMachine on every row from projects.list', async () => {
    const a = await createProject(testDb, { name: 'a', path: '/tmp/list-a' });
    const b = await createProject(testDb, { name: 'b', path: '/tmp/list-b' });
    const caller = projectsRouter.createCaller(ctx);

    await caller.setCrossMachine({ projectId: a.id, isCrossMachine: true });

    const rows = await caller.list();
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(a.id)?.isCrossMachine).toBe(true);
    expect(byId.get(b.id)?.isCrossMachine).toBe(false);
  });

  // Edge case: multi-pane race. Two panes can fire setCrossMachine + a rename
  // concurrently. SQLite serializes UPDATEs per-row; both writes must land and
  // neither field should clobber the other.
  it('preserves both fields under concurrent setCrossMachine + rename', async () => {
    const project = await createProject(testDb, { name: 'orig', path: '/tmp/race' });
    const caller = projectsRouter.createCaller(ctx);
    const { updateProject } = await import('../../db/repos/projects');

    await Promise.all([
      caller.setCrossMachine({ projectId: project.id, isCrossMachine: true }),
      updateProject(testDb, project.id, { name: 'renamed' }),
    ]);

    const final = await caller.get({ id: project.id });
    expect(final?.isCrossMachine).toBe(true);
    expect(final?.name).toBe('renamed');
  });
});
