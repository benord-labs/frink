import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  listProjectsMock,
  upsertMock,
  bulkRemoveFromProjectsMock,
  getProjectsUsingAgentMock,
  copyUserSkillMock,
  copyUserAgentMock,
  resolveAgentSourceMock,
  anyCommittableDirMock,
} = vi.hoisted(() => ({
  listProjectsMock: vi.fn(),
  upsertMock: vi.fn(),
  bulkRemoveFromProjectsMock: vi.fn(),
  getProjectsUsingAgentMock: vi.fn(),
  copyUserSkillMock: vi.fn(),
  copyUserAgentMock: vi.fn(),
  resolveAgentSourceMock: vi.fn(),
  anyCommittableDirMock: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'home' ? '/mock/home' : '/mock') },
}));

vi.mock(import('../../db'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getDatabase: vi.fn(() => ({})) as unknown as typeof actual.getDatabase,
  };
});

vi.mock('../../db/repos/projects', () => ({
  listProjects: listProjectsMock,
}));

vi.mock('../../db/repos/project-agents', () => ({
  getProjectsUsingAgent: getProjectsUsingAgentMock,
  bulkRemoveFromProjects: bulkRemoveFromProjectsMock,
  upsert: upsertMock,
}));

vi.mock('../../skills/skill-projection', () => ({
  copyUserSkill: copyUserSkillMock,
  isFrinkProjection: () => false,
  isFrinkShipped: () => false,
  ORPHAN_NAME: /^never$/,
}));

vi.mock('../../git/git-utils', () => ({
  anyCommittableDir: anyCommittableDirMock,
}));

vi.mock('../../agents/agent-copy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agents/agent-copy')>();
  return {
    ...actual,
    copyUserAgent: copyUserAgentMock,
    resolveAgentSource: resolveAgentSourceMock,
  };
});

import { agentsRouter } from './agents';
import { hooksRouter } from './hooks';
import { skillsRouter } from './skills';
import { frinkUserHome } from '../../platform/frink-home';

describe('scope change mutations', () => {
  beforeEach(() => {
    listProjectsMock.mockReset();
    upsertMock.mockReset();
    bulkRemoveFromProjectsMock.mockReset();
    getProjectsUsingAgentMock.mockReset();
  });

  it('changeScopeAgent removes all projects when moving to global', async () => {
    getProjectsUsingAgentMock.mockResolvedValue([{ project_id: 'p1' }, { project_id: 'p2' }]);
    const caller = agentsRouter.createCaller({ getWindow: () => null });

    await expect(
      caller.changeScopeAgent({ agentName: 'reviewer', type: 'agent', scope: 'global' }),
    ).resolves.toEqual({ success: true });
    expect(bulkRemoveFromProjectsMock).toHaveBeenCalledTimes(1);
    expect(bulkRemoveFromProjectsMock).toHaveBeenCalledWith(
      expect.anything(),
      ['p1', 'p2'],
      'reviewer',
      'agent',
    );
    expect(upsertMock).toHaveBeenCalledTimes(0);
  });

  it('changeScopeAgent returns project-not-found for non-owned project', async () => {
    listProjectsMock.mockResolvedValue([{ id: 'other-project' }]);
    const caller = agentsRouter.createCaller({ getWindow: () => null });

    await expect(
      caller.changeScopeAgent({
        agentName: 'reviewer',
        type: 'agent',
        scope: 'project',
        projectId: 'target-project',
      }),
    ).resolves.toEqual({ success: false, error: 'Project not found' });
  });

  it('changeScopeAgent surfaces getProjectsUsingAgent failures', async () => {
    getProjectsUsingAgentMock.mockRejectedValue(new Error('Network error'));
    const caller = agentsRouter.createCaller({ getWindow: () => null });

    await expect(
      caller.changeScopeAgent({ agentName: 'reviewer', type: 'agent', scope: 'global' }),
    ).resolves.toEqual({ success: false, error: 'Network error' });
  });

  it('changeScopeHook removes other projects and adds target project', async () => {
    listProjectsMock.mockResolvedValue([{ id: 'target-project' }]);
    getProjectsUsingAgentMock.mockResolvedValue([
      { project_id: 'target-project' },
      { project_id: 'other-project' },
    ]);
    const caller = hooksRouter.createCaller({ getWindow: () => null });

    await expect(
      caller.changeScopeHook({
        hookName: 'pre-commit',
        scope: 'project',
        projectId: 'target-project',
      }),
    ).resolves.toEqual({ success: true });
    expect(bulkRemoveFromProjectsMock).toHaveBeenCalledWith(
      expect.anything(),
      ['other-project'],
      'pre-commit',
      'hook',
    );
    expect(upsertMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        projectId: 'target-project',
        agentName: 'pre-commit',
        type: 'hook',
      }),
    );
  });

  it('changeScopeHook surfaces listProjects failures', async () => {
    listProjectsMock.mockRejectedValue(new Error('Projects unavailable'));
    const caller = hooksRouter.createCaller({ getWindow: () => null });

    await expect(
      caller.changeScopeHook({
        hookName: 'pre-commit',
        scope: 'project',
        projectId: 'target-project',
      }),
    ).resolves.toEqual({ success: false, error: 'Projects unavailable' });
  });

  it('changeScopeSkill requires projectId for project scope', async () => {
    const caller = skillsRouter.createCaller({ getWindow: () => null });

    await expect(
      caller.changeScopeSkill({
        skillName: 'memory-manager',
        scope: 'project',
      }),
    ).resolves.toEqual({ success: false, error: 'Project ID required for project scope' });
  });

  it('changeScopeSkill surfaces listProjects failures', async () => {
    listProjectsMock.mockRejectedValue(new Error('User projects failed'));
    const caller = skillsRouter.createCaller({ getWindow: () => null });

    await expect(
      caller.changeScopeSkill({
        skillName: 'memory-manager',
        scope: 'project',
        projectId: 'target-project',
      }),
    ).resolves.toEqual({ success: false, error: 'User projects failed' });
  });
});

describe('skills.copyAcross', () => {
  const caller = () => skillsRouter.createCaller({ getWindow: () => null });
  const home = frinkUserHome();
  // A source under an allowed home skill root (passes the renderer-path containment guard).
  const homeSrc = (name: string) => path.join(home, '.cursor', 'skills', name, 'SKILL.md');
  const homeDir = (name: string) => path.join(home, '.cursor', 'skills', name);

  beforeEach(() => {
    listProjectsMock.mockReset();
    copyUserSkillMock.mockReset();
    anyCommittableDirMock.mockReset();
    listProjectsMock.mockResolvedValue([]);
    copyUserSkillMock.mockResolvedValue({ wrote: 1, kept: 0 });
    anyCommittableDirMock.mockResolvedValue(false);
  });

  it('copies skills to global scope without inspecting any repo', async () => {
    const res = await caller().copyAcross({
      skills: [
        { name: 'a', sourcePath: homeSrc('a') },
        { name: 'b', sourcePath: homeSrc('b') },
      ],
      target: 'global',
    });
    expect(res).toEqual({ copied: ['a', 'b'], skipped: [], committedRepo: false });
    expect(copyUserSkillMock).toHaveBeenCalledTimes(2);
    expect(anyCommittableDirMock).not.toHaveBeenCalled();
  });

  it('rejects a source path outside the allowed skill roots (no arbitrary-dir copy)', async () => {
    const res = await caller().copyAcross({
      skills: [{ name: 'a', sourcePath: '/etc/passwd' }],
      target: 'global',
    });
    expect(res.error).toContain('a');
    expect(copyUserSkillMock).not.toHaveBeenCalled();
  });

  it('uses the project path as the copy base and reports a committable repo', async () => {
    listProjectsMock.mockResolvedValue([{ id: 'p1', name: 'P', path: '/proj/p1' }]);
    anyCommittableDirMock.mockResolvedValue(true);

    const res = await caller().copyAcross({
      skills: [{ name: 'a', sourcePath: path.join('/proj/p1', '.cursor', 'skills', 'a') }],
      target: 'project',
      projectId: 'p1',
    });
    expect(res).toEqual({ copied: ['a'], skipped: [], committedRepo: true });
    // Portable (default) under the project base = .agents + .claude (Claude can't read .agents),
    // and NEVER the non-needed .cursor (Cursor reads .agents). The skill name is joined inside.
    expect(copyUserSkillMock).toHaveBeenCalledWith(
      'a',
      path.join('/proj/p1', '.cursor', 'skills', 'a'),
      [path.join('/proj/p1', '.agents', 'skills'), path.join('/proj/p1', '.claude', 'skills')],
    );
    // committedRepo derives from the dirs we actually wrote (absolute) — not a hardcoded `.claude/skills`.
    expect(anyCommittableDirMock).toHaveBeenCalledWith('/proj/p1', [
      path.join('/proj/p1', '.agents', 'skills'),
      path.join('/proj/p1', '.claude', 'skills'),
    ]);
  });

  it('expands a tilde SKILL.md display path to the absolute skill directory', async () => {
    // `~` is the operator's real home (shared expand-home), not Frink's FRINK_HOME.
    const tildeHome = os.homedir();
    listProjectsMock.mockResolvedValue([
      { id: 'x', name: 'X', path: path.join(tildeHome, 'proj') },
    ]);
    await caller().copyAcross({
      skills: [
        { name: 'frontend-design', sourcePath: '~/proj/.cursor/skills/frontend-design/SKILL.md' },
      ],
      target: 'global',
    });
    expect(copyUserSkillMock).toHaveBeenCalledWith(
      'frontend-design',
      path.join(tildeHome, 'proj/.cursor/skills/frontend-design'),
      expect.arrayContaining([path.join(home, '.claude', 'skills')]),
    );
  });

  it('native mode copies into only the active tool’s own dir', async () => {
    await caller().copyAcross({
      skills: [{ name: 'a', sourcePath: homeSrc('a') }],
      target: 'global',
      mode: 'native',
      activeTool: 'claude-code',
    });
    expect(copyUserSkillMock).toHaveBeenCalledWith('a', homeDir('a'), [
      path.join(home, '.claude', 'skills'),
    ]);
  });

  it('reports a real error when no copy could be made (never a false repo-add)', async () => {
    copyUserSkillMock.mockRejectedValue(new Error('boom'));
    const res = await caller().copyAcross({
      skills: [{ name: 'a', sourcePath: homeSrc('a') }],
      target: 'global',
    });
    expect(res.copied).toEqual([]);
    expect(res.committedRepo).toBe(false);
    expect(res.error).toContain('a');
  });

  it('counts a skill as copied when at least one dir was written (partial success)', async () => {
    copyUserSkillMock.mockResolvedValue({ wrote: 1, kept: 1 });
    const res = await caller().copyAcross({
      skills: [{ name: 'a', sourcePath: homeSrc('a') }],
      target: 'global',
    });
    expect(res.copied).toEqual(['a']);
    expect(res.skipped).toEqual([]);
  });

  it('reports skipped only when every dir held a preserved hand-edit (nothing written)', async () => {
    copyUserSkillMock.mockResolvedValue({ wrote: 0, kept: 1 });
    const res = await caller().copyAcross({
      skills: [{ name: 'a', sourcePath: homeSrc('a') }],
      target: 'global',
    });
    expect(res.copied).toEqual([]);
    expect(res.skipped).toEqual(['a']);
  });

  it('requires a projectId for a project target', async () => {
    const res = await caller().copyAcross({
      skills: [{ name: 'a', sourcePath: homeSrc('a') }],
      target: 'project',
    });
    expect(res).toEqual({
      copied: [],
      skipped: [],
      committedRepo: false,
      error: 'Project ID required',
    });
    expect(copyUserSkillMock).not.toHaveBeenCalled();
  });

  it('errors when the target project is not registered', async () => {
    listProjectsMock.mockResolvedValue([{ id: 'other', name: 'O', path: '/proj/o' }]);

    const res = await caller().copyAcross({
      skills: [{ name: 'a', sourcePath: homeSrc('a') }],
      target: 'project',
      projectId: 'missing',
    });
    expect(res.error).toBe('Project not found');
    expect(copyUserSkillMock).not.toHaveBeenCalled();
  });
});

describe('agents.copyAcross', () => {
  const caller = () => agentsRouter.createCaller({ getWindow: () => null });
  const home = frinkUserHome();
  const claudeAgents = path.join(home, '.claude', 'agents');
  const cursorAgents = path.join(home, '.cursor', 'agents');

  beforeEach(() => {
    listProjectsMock.mockReset();
    copyUserAgentMock.mockReset();
    resolveAgentSourceMock.mockReset();
    anyCommittableDirMock.mockReset();
    listProjectsMock.mockResolvedValue([]);
    // A plausible resolved source so copyOneAgent proceeds to copyUserAgent.
    resolveAgentSourceMock.mockResolvedValue(path.join(claudeAgents, 'x.md'));
    copyUserAgentMock.mockResolvedValue({ wrote: 1, kept: 0 });
    anyCommittableDirMock.mockResolvedValue(false);
  });

  it('copies agents globally into each tool’s OWN agents dir — .claude + .cursor, never .agents', async () => {
    const res = await caller().copyAcross({
      agents: [{ name: 'reviewer', sourcePath: path.join(cursorAgents, 'reviewer.md') }],
      target: 'global',
    });
    expect(res).toEqual({ copied: ['reviewer'], skipped: [], committedRepo: false });
    // Agent breadth: native dir per configured tool, NO universal `.agents` (the skill-map trap).
    expect(copyUserAgentMock).toHaveBeenCalledWith(path.join(claudeAgents, 'x.md'), [
      { dir: claudeAgents, flavor: 'claude' },
      { dir: cursorAgents, flavor: 'cursor' },
    ]);
    expect(anyCommittableDirMock).not.toHaveBeenCalled();
  });

  it('reports a committable repo from the agent dirs actually written (not a hardcoded path)', async () => {
    listProjectsMock.mockResolvedValue([{ id: 'p1', name: 'P', path: '/proj/p1' }]);
    anyCommittableDirMock.mockResolvedValue(true);

    const res = await caller().copyAcross({
      agents: [
        { name: 'reviewer', sourcePath: path.join('/proj/p1', '.cursor', 'agents', 'r.md') },
      ],
      target: 'project',
      projectId: 'p1',
    });
    expect(res.committedRepo).toBe(true);
    // Absolute agent dirs actually written (portable = .claude + .cursor), never a hardcoded path.
    expect(anyCommittableDirMock).toHaveBeenCalledWith('/proj/p1', [
      path.join('/proj/p1', '.claude', 'agents'),
      path.join('/proj/p1', '.cursor', 'agents'),
    ]);
  });

  it('native mode copies into only the active tool’s own agents dir', async () => {
    await caller().copyAcross({
      agents: [{ name: 'reviewer', sourcePath: path.join(cursorAgents, 'r.md') }],
      target: 'global',
      mode: 'native',
      activeTool: 'claude-code',
    });
    expect(copyUserAgentMock).toHaveBeenCalledWith(path.join(claudeAgents, 'x.md'), [
      { dir: claudeAgents, flavor: 'claude' },
    ]);
  });

  it('rejects an invalid agent name before resolving or copying', async () => {
    const res = await caller().copyAcross({
      agents: [{ name: 'bad name!', sourcePath: path.join(cursorAgents, 'x.md') }],
      target: 'global',
    });
    expect(res.error).toContain('bad name!');
    expect(resolveAgentSourceMock).not.toHaveBeenCalled();
    expect(copyUserAgentMock).not.toHaveBeenCalled();
  });

  it('surfaces a failure when the source resolves out of bounds (never a false repo-add)', async () => {
    resolveAgentSourceMock.mockRejectedValue(new Error('outside'));
    const res = await caller().copyAcross({
      agents: [{ name: 'reviewer', sourcePath: '/etc/passwd' }],
      target: 'global',
    });
    expect(res.copied).toEqual([]);
    expect(res.committedRepo).toBe(false);
    expect(res.error).toContain('reviewer');
  });

  it('reports skipped when every dir held a preserved mirror/hand-edit (nothing written)', async () => {
    copyUserAgentMock.mockResolvedValue({ wrote: 0, kept: 1 });
    const res = await caller().copyAcross({
      agents: [{ name: 'reviewer', sourcePath: path.join(cursorAgents, 'r.md') }],
      target: 'global',
    });
    expect(res.copied).toEqual([]);
    expect(res.skipped).toEqual(['reviewer']);
  });
});
