import { beforeEach, describe, expect, it, vi } from 'vitest';

const { addProjectRuleMock, addUserRuleMock, durableSyncMock } = vi.hoisted(() => ({
  addProjectRuleMock: vi.fn(),
  addUserRuleMock: vi.fn(),
  durableSyncMock: vi.fn(),
}));

vi.mock('./store-local', () => ({
  addProjectRule: (...args: unknown[]) => addProjectRuleMock(...args),
  addUserRule: (...args: unknown[]) => addUserRuleMock(...args),
}));

vi.mock('../cursor-sync-pending', () => ({
  syncProjectRuleToCursorDurably: (...args: unknown[]) => durableSyncMock(...args),
}));

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { persistApprovedRule } from './persist-approved-rule';

const db = {} as Parameters<typeof persistApprovedRule>[0]['db'];

function persist(overrides: Partial<Parameters<typeof persistApprovedRule>[0]> = {}) {
  return persistApprovedRule({
    db,
    projectPath: '/repo',
    project: { id: 'p1' },
    promptResult: { scope: 'project', ruleString: 'Bash(npm:*)', ruleType: 'allow' },
    isBash: true,
    logTag: '[test]',
    ...overrides,
  });
}

describe('persistApprovedRule — Cursor mirror (sc-3267)', () => {
  beforeEach(() => {
    addProjectRuleMock.mockReset().mockResolvedValue({ inserted: true });
    addUserRuleMock.mockReset().mockResolvedValue({ inserted: true });
    durableSyncMock.mockReset().mockResolvedValue(undefined);
  });

  it('durably syncs a project Bash grant after the DB insert', async () => {
    await persist();
    expect(durableSyncMock).toHaveBeenCalledWith(db, 'p1', 'Bash(npm:*)');
    expect(addProjectRuleMock.mock.invocationCallOrder[0]).toBeLessThan(
      durableSyncMock.mock.invocationCallOrder[0],
    );
  });

  it('does not mirror non-Bash, user-scope, or allow-once approvals', async () => {
    await persist({
      isBash: false,
      promptResult: { scope: 'project', ruleString: 'Edit(src/**)' },
    });
    await persist({ promptResult: { scope: 'user', ruleString: 'Bash(npm:*)' } });
    await persist({ promptResult: {} });
    expect(durableSyncMock).not.toHaveBeenCalled();
  });

  it('does not mirror when the project context is missing or the rule is invalid', async () => {
    await persist({ project: null });
    await persist({ promptResult: { scope: 'project', ruleString: 'not(valid' } });
    expect(addProjectRuleMock).not.toHaveBeenCalled();
    expect(durableSyncMock).not.toHaveBeenCalled();
  });

  it('does not sync when the DB insert fails', async () => {
    addProjectRuleMock.mockRejectedValue(new Error('SQLITE_BUSY'));
    await expect(persist()).resolves.toBeUndefined();
    expect(durableSyncMock).not.toHaveBeenCalled();
  });
});
