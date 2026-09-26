import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  resolveProjectPathFromWorktree: vi.fn(),
  getProjectByPath: vi.fn(),
}));

vi.mock('../../claude-config', () => ({
  resolveProjectPathFromWorktree: state.resolveProjectPathFromWorktree,
}));
vi.mock('../../db', () => ({ getDatabase: vi.fn() }));
vi.mock('../../db/repos/projects', () => ({ getProjectByPath: state.getProjectByPath }));

import { resolveCreationProject } from './resolve-creation-project';

describe('resolveCreationProject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: paths pass through unchanged (not a worktree).
    state.resolveProjectPathFromWorktree.mockImplementation((p: string) => p);
  });

  it('explicit projectId wins over session path', async () => {
    state.getProjectByPath.mockResolvedValue({ id: 'other', name: 'Other', path: '/p' });
    await expect(
      resolveCreationProject({ explicitProjectId: 'proj-1', sessionProjectPath: '/p' }),
    ).resolves.toEqual({ projectId: 'proj-1', outcome: 'explicit' });
    expect(state.getProjectByPath).not.toHaveBeenCalled();
  });

  it('resolves the session project when no explicit id is given', async () => {
    state.getProjectByPath.mockResolvedValue({ id: 'p1', name: 'Frink', path: '/repo' });
    await expect(resolveCreationProject({ sessionProjectPath: '/repo' })).resolves.toEqual({
      projectId: 'p1',
      outcome: 'session-default',
      projectName: 'Frink',
    });
  });

  it('normalizes a worktree path to the project root before lookup', async () => {
    state.resolveProjectPathFromWorktree.mockReturnValue('/repo');
    state.getProjectByPath.mockResolvedValue({ id: 'p1', name: 'Frink', path: '/repo' });
    const r = await resolveCreationProject({ sessionProjectPath: '/wt/frink/branch' });
    expect(state.getProjectByPath).toHaveBeenCalledWith(undefined, '/repo');
    expect(r.projectId).toBe('p1');
  });

  it('falls back to the raw path when worktree resolution fails', async () => {
    state.resolveProjectPathFromWorktree.mockReturnValue(null);
    state.getProjectByPath.mockResolvedValue(null);
    await expect(resolveCreationProject({ sessionProjectPath: '/somewhere' })).resolves.toEqual({
      projectId: null,
      outcome: 'none',
    });
    expect(state.getProjectByPath).toHaveBeenCalledWith(undefined, '/somewhere');
  });

  it('returns none without a session path — never guesses', async () => {
    await expect(resolveCreationProject({})).resolves.toEqual({ projectId: null, outcome: 'none' });
    expect(state.getProjectByPath).not.toHaveBeenCalled();
  });

  // A transient lookup failure must not abort flow creation (and leak the
  // session's create-rate-limit slot) — discovery fails open to no project.
  it('returns none when the project lookup throws', async () => {
    state.getProjectByPath.mockRejectedValue(new Error('database is locked'));
    await expect(resolveCreationProject({ sessionProjectPath: '/repo' })).resolves.toEqual({
      projectId: null,
      outcome: 'none',
    });
  });

  it('returns none for virtual session paths and virtual project rows', async () => {
    await expect(resolveCreationProject({ sessionProjectPath: 'virtual://x' })).resolves.toEqual({
      projectId: null,
      outcome: 'none',
    });

    state.getProjectByPath.mockResolvedValue({ id: 'v1', name: 'V', path: 'virtual://x' });
    await expect(resolveCreationProject({ sessionProjectPath: '/repo' })).resolves.toEqual({
      projectId: null,
      outcome: 'none',
    });
  });
});
