import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setProjectAiAccount } from '../db/repos/project-ai-accounts';
import * as schema from '../db/schema';
import { freshDb, type TestDb } from '../db/test-utils/fresh-db';

const { dbRef, getClaudeCodeTokenByIdMock, getDefaultClaudeCodeTokenMock } = vi.hoisted(() => ({
  dbRef: { current: null as unknown },
  getClaudeCodeTokenByIdMock: vi.fn(),
  getDefaultClaudeCodeTokenMock: vi.fn(),
}));

vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  getDatabase: () => dbRef.current,
}));
vi.mock('../credentials', () => ({
  getClaudeCodeTokenById: getClaudeCodeTokenByIdMock,
  getDefaultClaudeCodeToken: getDefaultClaudeCodeTokenMock,
  isResolvedCredential: (cred: { token?: string | null; passthrough?: boolean }) =>
    !!cred.token || cred.passthrough === true,
}));

import { resolveTaskAccount, resolveTaskAccountType } from './execution-account';

let db: TestDb;
const CREDENTIALS: Record<string, { type: string; token: string | null }> = {
  claude: { type: 'claude-code', token: 't' },
  codex: { type: 'codex', token: 't' },
  stale: { type: 'claude-code', token: null },
};

beforeEach(async () => {
  db = freshDb();
  dbRef.current = db;
  getClaudeCodeTokenByIdMock.mockImplementation(async (id: string) => CREDENTIALS[id]);
  await db.insert(schema.projects).values({ id: 'p1', name: 'p1', path: '/repos/p1' });
  await db.insert(schema.claudeCodeCredentials).values([
    { id: 'claude', accountLabel: 'Claude', type: 'claude-code' },
    { id: 'codex', accountLabel: 'Codex', type: 'codex' },
    { id: 'stale', accountLabel: 'Stale', type: 'claude-code' },
  ]);
});

describe('task execution account', () => {
  // A Flow's agents continue the Start Task's chat, so flipping the project mid-run must not
  // move the next agent to another provider.
  it('keeps a continued chat on its stamped account after the project account changes', async () => {
    await db.insert(schema.chats).values({ id: 'flow-chat', projectId: 'p1', accountId: 'claude' });
    await setProjectAiAccount(db, 'p1', 'codex');

    const account = await resolveTaskAccount('p1', 'flow-chat');

    expect(account?.id).toBe('claude');
    expect(await resolveTaskAccountType(account)).toBe('claude-code');
  });

  it('resolves a new chat from the project override', async () => {
    await setProjectAiAccount(db, 'p1', 'codex');

    expect(await resolveTaskAccountType(await resolveTaskAccount('p1', null))).toBe('codex');
  });

  it('runs on the default account when nothing is pinned', async () => {
    getDefaultClaudeCodeTokenMock.mockResolvedValue({ type: 'codex', token: 't' });

    expect(await resolveTaskAccountType(await resolveTaskAccount(null, null))).toBe('codex');
  });

  it('fails the task when its account is not connected on this machine', async () => {
    await expect(resolveTaskAccountType({ id: 'stale', label: 'Stale' })).rejects.toMatchObject({
      message: expect.stringContaining('"Stale" is not authenticated'),
      action: 'open-connect-account',
      permanent: true,
    });
  });
});
