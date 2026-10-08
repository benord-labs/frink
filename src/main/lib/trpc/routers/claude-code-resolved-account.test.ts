import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../db/schema';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';

const { h } = vi.hoisted(() => ({ h: { db: null as unknown } }));

vi.mock('../../db', async (orig) => ({
  ...(await orig<typeof import('../../db')>()),
  getDatabase: () => h.db,
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../../claude-oauth-browser', () => ({ runClaudeOAuthBrowser: vi.fn() }));

import { claudeCodeRouter } from './claude-code';

let db: TestDb;
beforeEach(() => {
  db = freshDb();
  h.db = db;
});

const resolve = (chatId: string) =>
  claudeCodeRouter.createCaller({ getWindow: () => null }).getResolvedAccount({ chatId });
const seedLogin = (id: string, type: string, isDefault: boolean) =>
  db.insert(schema.claudeCodeCredentials).values({ id, type, isDefault, oauthToken: 'enc' });

describe('getResolvedAccount for a chat', () => {
  beforeEach(async () => {
    await seedLogin('claude-a', 'claude-code', true);
    await seedLogin('codex-a', 'codex', false);
  });

  it('shows the chat its own login', async () => {
    await db.insert(schema.chats).values({ id: 'c1', accountId: 'codex-a', provider: 'codex' });

    await expect(resolve('c1')).resolves.toMatchObject({ id: 'codex-a', isBlocked: false });
  });

  it("stands in only a login of the chat's own provider once its login was removed", async () => {
    await db.insert(schema.chats).values({ id: 'c1', accountId: null, provider: 'codex' });

    await expect(resolve('c1')).resolves.toMatchObject({
      id: 'codex-a',
      type: 'codex',
      isBlocked: true,
    });

    await db
      .delete(schema.claudeCodeCredentials)
      .where(eq(schema.claudeCodeCredentials.id, 'codex-a'));
    // The Claude default never stands in for a Codex chat.
    await expect(resolve('c1')).resolves.toBeNull();
  });
});
