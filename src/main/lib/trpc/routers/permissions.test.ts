import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  getProjectByIdMock,
  durableSyncMock,
  hasAllowMock,
} = vi.hoisted(() => ({
  getProjectDocMock: vi.fn(),
  getUserDocMock: vi.fn(),
  addProjectRuleMock: vi.fn(),
  addUserRuleMock: vi.fn(),
  removeProjectRuleMock: vi.fn(),
  removeUserRuleMock: vi.fn(),
  getPolicyDocMock: vi.fn(),
  getProjectByIdMock: vi.fn(),
  durableSyncMock: vi.fn(),
  hasAllowMock: vi.fn(),
}));

vi.mock('../../permissions/v2/store-local', () => ({
  getProjectDoc: (...args: unknown[]) => getProjectDocMock(...args),
  getUserDoc: (...args: unknown[]) => getUserDocMock(...args),
  addProjectRule: (...args: unknown[]) => addProjectRuleMock(...args),
  addUserRule: (...args: unknown[]) => addUserRuleMock(...args),
  removeProjectRule: (...args: unknown[]) => removeProjectRuleMock(...args),
  removeUserRule: (...args: unknown[]) => removeUserRuleMock(...args),
  hasProjectAllowRuleIgnoringPadding: (...args: unknown[]) => hasAllowMock(...args),
}));

vi.mock('../../permissions/v2/store-policy', () => ({
  getPolicyDoc: (...args: unknown[]) => getPolicyDocMock(...args),
}));

vi.mock('../../db/repos/projects', () => ({
  getProjectById: (...args: unknown[]) => getProjectByIdMock(...args),
}));

// Spy on the Cursor sync seam but keep the real module available so the
// wiring test can run the actual DB-checked file write end-to-end.
vi.mock('../../permissions/cursor-sync-pending', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../permissions/cursor-sync-pending')>();
  return {
    ...actual,
    syncProjectRuleToCursorDurably: (...args: unknown[]) => durableSyncMock(...args),
  };
});

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'home' ? '/mock/home' : '/mock'),
  },
}));

import * as cursorConfigSync from '../../permissions/cursor-config-sync';
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
    getProjectByIdMock.mockReset();
    getProjectByIdMock.mockResolvedValue(null);
    durableSyncMock.mockReset();
    durableSyncMock.mockResolvedValue(undefined);
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

describe('permissionsRouter project rule changes — Cursor allow-list sync (sc-3267)', () => {
  const PROJECT = { id: 'p1', path: '/path/to/p1' };

  beforeEach(() => {
    addProjectRuleMock.mockReset();
    removeProjectRuleMock.mockReset();
    removeProjectRuleMock.mockResolvedValue(undefined);
    removeUserRuleMock.mockReset();
    getProjectByIdMock.mockReset();
    getProjectByIdMock.mockResolvedValue(PROJECT);
    durableSyncMock.mockReset();
    durableSyncMock.mockResolvedValue(undefined);
  });

  const caller = () => permissionsRouter.createCaller({ getWindow: () => null });

  it('re-syncs Cursor for the removed allow rule after the DB delete', async () => {
    await caller().removeProjectRule({
      projectId: 'p1',
      ruleString: 'Bash(npm:*)',
      ruleType: 'allow',
    });
    expect(durableSyncMock).toHaveBeenCalledWith(expect.anything(), 'p1', 'Bash(npm:*)');
    expect(removeProjectRuleMock.mock.invocationCallOrder[0]).toBeLessThan(
      durableSyncMock.mock.invocationCallOrder[0],
    );
  });

  it.each(['deny', 'ask'] as const)(
    'does not touch Cursor config for a %s rule',
    async (ruleType) => {
      await caller().removeProjectRule({ projectId: 'p1', ruleString: 'Bash(npm:*)', ruleType });
      expect(removeProjectRuleMock).toHaveBeenCalled();
      expect(durableSyncMock).not.toHaveBeenCalled();
    },
  );

  it('leaves Cursor config untouched when the DB delete fails, and surfaces the error', async () => {
    removeProjectRuleMock.mockRejectedValue(new Error('SQLITE_READONLY'));
    await expect(
      caller().removeProjectRule({ projectId: 'p1', ruleString: 'Bash(npm:*)', ruleType: 'allow' }),
    ).rejects.toThrow();
    expect(durableSyncMock).not.toHaveBeenCalled();
  });

  it('removeUserRule never touches Cursor config (user-scope grants are never mirrored)', async () => {
    await caller().removeUserRule({ ruleString: 'Bash(npm:*)', ruleType: 'allow' });
    expect(durableSyncMock).not.toHaveBeenCalled();
  });

  it('addProjectRule mirrors an allow rule to Cursor after the DB insert', async () => {
    addProjectRuleMock.mockResolvedValue({ inserted: true });
    const result = await caller().addProjectRule({
      projectId: 'p1',
      ruleString: 'Bash(npm:*)',
      ruleType: 'allow',
    });
    expect(result).toEqual({ ok: true });
    expect(durableSyncMock).toHaveBeenCalledWith(expect.anything(), 'p1', 'Bash(npm:*)');
    expect(addProjectRuleMock.mock.invocationCallOrder[0]).toBeLessThan(
      durableSyncMock.mock.invocationCallOrder[0],
    );
  });

  it('addProjectRule does not sync deny rules or rules that fail validation', async () => {
    addProjectRuleMock.mockResolvedValue({ inserted: true });
    await caller().addProjectRule({ projectId: 'p1', ruleString: 'Bash(rm:*)', ruleType: 'deny' });
    await caller().addProjectRule({ projectId: 'p1', ruleString: 'not(valid', ruleType: 'allow' });
    expect(durableSyncMock).not.toHaveBeenCalled();
  });

  describe('wiring against the real .cursor/cli.json', () => {
    let projectPath: string;
    const cliJson = () => join(projectPath, '.cursor', 'cli.json');

    beforeEach(async () => {
      projectPath = await mkdtemp(join(tmpdir(), 'frink-perm-router-'));
      getProjectByIdMock.mockResolvedValue({ id: 'p1', path: projectPath });
      hasAllowMock.mockReset().mockResolvedValue(false);
      const actual = await vi.importActual<typeof import('../../permissions/cursor-sync-pending')>(
        '../../permissions/cursor-sync-pending',
      );
      durableSyncMock.mockImplementation(actual.syncProjectRuleToCursorDurably);
    });

    it('a granted token is gone from cli.json after the rule is removed in Settings', async () => {
      await cursorConfigSync.addBashRuleToCursorConfig(projectPath, 'Bash(npm:*)');
      await cursorConfigSync.addBashRuleToCursorConfig(projectPath, 'Bash(git:*)');

      await caller().removeProjectRule({
        projectId: 'p1',
        ruleString: 'Bash(npm:*)',
        ruleType: 'allow',
      });

      const cfg = JSON.parse(await readFile(cliJson(), 'utf-8'));
      expect(cfg.permissions.allow).toEqual(['Shell(git)']);
    });

    it('keeps the token when the same rule was re-granted before the revoke synced', async () => {
      await cursorConfigSync.addBashRuleToCursorConfig(projectPath, 'Bash(npm:*)');
      // DB still (again) holds the allow rule by the time the file sync runs.
      hasAllowMock.mockResolvedValue(true);

      await caller().removeProjectRule({
        projectId: 'p1',
        ruleString: 'Bash(npm:*)',
        ruleType: 'allow',
      });

      const cfg = JSON.parse(await readFile(cliJson(), 'utf-8'));
      expect(cfg.permissions.allow).toEqual(['Shell(npm)']);
    });

    it('a Settings add then remove round-trips the Cursor token', async () => {
      addProjectRuleMock.mockResolvedValue({ inserted: true });
      hasAllowMock.mockResolvedValue(true);
      await caller().addProjectRule({
        projectId: 'p1',
        ruleString: 'Bash(npm:*)',
        ruleType: 'allow',
      });
      expect(JSON.parse(await readFile(cliJson(), 'utf-8')).permissions.allow).toEqual([
        'Shell(npm)',
      ]);

      hasAllowMock.mockResolvedValue(false);
      await caller().removeProjectRule({
        projectId: 'p1',
        ruleString: 'Bash(npm:*)',
        ruleType: 'allow',
      });
      expect(JSON.parse(await readFile(cliJson(), 'utf-8')).permissions.allow).toEqual([]);
    });

    it('keeps the token when a padded variant of the removed rule is still allowed', async () => {
      await cursorConfigSync.addBashRuleToCursorConfig(projectPath, 'Bash(npm:*)');
      hasAllowMock.mockImplementation(
        async (_db, _id, rule: string) => rule.trim() === 'Bash(npm:*)',
      );
      await caller().removeProjectRule({
        projectId: 'p1',
        ruleString: ' Bash(npm:*) ',
        ruleType: 'allow',
      });
      expect(JSON.parse(await readFile(cliJson(), 'utf-8')).permissions.allow).toEqual([
        'Shell(npm)',
      ]);
    });

    it('does not create .cursor/cli.json for projects that never used Cursor', async () => {
      await caller().removeProjectRule({
        projectId: 'p1',
        ruleString: 'Bash(npm:*)',
        ruleType: 'allow',
      });
      expect(existsSync(join(projectPath, '.cursor'))).toBe(false);
    });

    it('keeps the Settings removal working when cli.json is read-only-ish garbage', async () => {
      await mkdir(join(projectPath, '.cursor'), { recursive: true });
      await writeFile(cliJson(), '{ not json', 'utf-8');
      await expect(
        caller().removeProjectRule({
          projectId: 'p1',
          ruleString: 'Bash(npm:*)',
          ruleType: 'allow',
        }),
      ).resolves.toBeUndefined();
      expect(await readFile(cliJson(), 'utf-8')).toBe('{ not json');
    });
  });
});
