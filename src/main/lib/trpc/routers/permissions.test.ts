import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({
  getDatabase: vi.fn(() => ({}) as unknown),
}));

// ============================================================================
// v2 store mocks
// ============================================================================
const {
  getProjectDocMock,
  getUserDocMock,
  addProjectRuleMock,
  addUserRuleMock,
  removeProjectRuleMock,
  removeUserRuleMock,
  getPolicyDocMock,
} = vi.hoisted(() => ({
  getProjectDocMock: vi.fn(),
  getUserDocMock: vi.fn(),
  addProjectRuleMock: vi.fn(),
  addUserRuleMock: vi.fn(),
  removeProjectRuleMock: vi.fn(),
  removeUserRuleMock: vi.fn(),
  getPolicyDocMock: vi.fn(),
}));

vi.mock('../../permissions/v2/store-local', () => ({
  getProjectDoc: (...args: unknown[]) => getProjectDocMock(...args),
  getUserDoc: (...args: unknown[]) => getUserDocMock(...args),
  addProjectRule: (...args: unknown[]) => addProjectRuleMock(...args),
  addUserRule: (...args: unknown[]) => addUserRuleMock(...args),
  removeProjectRule: (...args: unknown[]) => removeProjectRuleMock(...args),
  removeUserRule: (...args: unknown[]) => removeUserRuleMock(...args),
}));

vi.mock('../../permissions/v2/store-policy', () => ({
  getPolicyDoc: (...args: unknown[]) => getPolicyDocMock(...args),
}));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'home' ? '/mock/home' : '/mock'),
  },
}));

import { permissionsRouter } from './permissions';

describe('permissionsRouter — v2 rule procedures', () => {
  beforeEach(() => {
    getProjectDocMock.mockReset();
    getUserDocMock.mockReset();
    addProjectRuleMock.mockReset();
    addUserRuleMock.mockReset();
    removeProjectRuleMock.mockReset();
    removeUserRuleMock.mockReset();
    getPolicyDocMock.mockReset();
  });

  it('listProjectRules returns the PermissionsDoc from store-local', async () => {
    getProjectDocMock.mockResolvedValue({
      allow: ['Bash(npm:*)'],
      deny: ['Bash(rm:*)'],
      ask: [],
    });
    const caller = permissionsRouter.createCaller({ getWindow: () => null });
    const doc = await caller.listProjectRules({ projectId: 'p1' });
    expect(doc).toEqual({ allow: ['Bash(npm:*)'], deny: ['Bash(rm:*)'], ask: [] });
  });

  it('listUserRules returns the stored rules', async () => {
    getUserDocMock.mockResolvedValue({ allow: ['Bash(git:*)'], deny: [], ask: [] });
    const caller = permissionsRouter.createCaller({ getWindow: () => null });
    const doc = await caller.listUserRules();
    expect(doc.allow).toEqual(['Bash(git:*)']);
    expect(getUserDocMock).toHaveBeenCalledWith(expect.anything());
  });

  it('getPolicyDoc delegates to store-policy', async () => {
    getPolicyDocMock.mockResolvedValue({ allow: [], deny: ['Bash(rm -rf /:*)'], ask: [] });
    const caller = permissionsRouter.createCaller({ getWindow: () => null });
    const doc = await caller.getPolicyDoc();
    expect(doc.deny).toContain('Bash(rm -rf /:*)');
  });

  it('addProjectRule returns { ok: true } for a new rule', async () => {
    addProjectRuleMock.mockResolvedValue({ inserted: true });
    const caller = permissionsRouter.createCaller({ getWindow: () => null });
    const result = await caller.addProjectRule({
      projectId: 'p1',
      ruleString: 'Bash(npm:*)',
      ruleType: 'allow',
    });
    expect(result).toEqual({ ok: true });
  });

  it('addProjectRule returns { ok: false, error: duplicate } when rule already exists', async () => {
    addProjectRuleMock.mockResolvedValue({ inserted: false });
    const caller = permissionsRouter.createCaller({ getWindow: () => null });
    const result = await caller.addProjectRule({
      projectId: 'p1',
      ruleString: 'Bash(npm:*)',
      ruleType: 'allow',
    });
    expect(result).toEqual({
      ok: false,
      error: 'duplicate',
      message: expect.stringContaining('exists'),
    });
  });

  it('addProjectRule returns { ok: false, error: parse } when ruleString is malformed', async () => {
    const caller = permissionsRouter.createCaller({ getWindow: () => null });
    const result = await caller.addProjectRule({
      projectId: 'p1',
      ruleString: 'not(a valid rule',
      ruleType: 'allow',
    });
    expect(result).toMatchObject({ ok: false, error: 'validation' });
    expect(addProjectRuleMock).not.toHaveBeenCalled();
  });

  it('addUserRule still validates the rule string before writing', async () => {
    const caller = permissionsRouter.createCaller({ getWindow: () => null });
    const result = await caller.addUserRule({ ruleString: 'not(a valid rule', ruleType: 'allow' });
    expect(result).toMatchObject({ ok: false, error: 'validation' });
    expect(addUserRuleMock).not.toHaveBeenCalled();
  });

  it('addUserRule routes through to the store', async () => {
    addUserRuleMock.mockResolvedValue({ inserted: true });
    const caller = permissionsRouter.createCaller({ getWindow: () => null });
    const result = await caller.addUserRule({ ruleString: 'Bash(git:*)', ruleType: 'allow' });
    expect(result).toEqual({ ok: true });
    expect(addUserRuleMock).toHaveBeenCalledWith(expect.anything(), 'Bash(git:*)', 'allow');
  });

  it('removeProjectRule delegates to store', async () => {
    removeProjectRuleMock.mockResolvedValue(undefined);
    const caller = permissionsRouter.createCaller({ getWindow: () => null });
    await caller.removeProjectRule({
      projectId: 'p1',
      ruleString: 'Bash(npm:*)',
      ruleType: 'allow',
    });
    expect(removeProjectRuleMock).toHaveBeenCalledWith(
      expect.anything(),
      'p1',
      'Bash(npm:*)',
      'allow',
    );
  });

  it('removeUserRule reaches the store', async () => {
    const caller = permissionsRouter.createCaller({ getWindow: () => null });
    await caller.removeUserRule({ ruleString: 'Bash(npm:*)', ruleType: 'allow' });
    expect(removeUserRuleMock).toHaveBeenCalledWith(expect.anything(), 'Bash(npm:*)', 'allow');
  });

  it('addProjectRule zod-rejects an invalid ruleType', async () => {
    const caller = permissionsRouter.createCaller({ getWindow: () => null });
    await expect(
      caller.addProjectRule({
        projectId: 'p1',
        ruleString: 'Bash(npm:*)',
        ruleType: 'invalid' as 'allow',
      }),
    ).rejects.toThrow();
  });
});
