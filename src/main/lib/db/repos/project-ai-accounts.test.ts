import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../schema';
import { freshDb, type TestDb } from '../test-utils/fresh-db';
import {
  getProjectAiAccount,
  getProjectAiAccountsBatch,
  setChatAiAccount,
  setProjectAiAccount,
} from './project-ai-accounts';

let db: TestDb;

const seedProject = (id: string) =>
  db.insert(schema.projects).values({ id, name: id, path: `/repos/${id}` });

const seedAccount = (id: string, accountLabel: string, type: 'claude-code' | 'codex') =>
  db.insert(schema.claudeCodeCredentials).values({ id, accountLabel, type });

beforeEach(async () => {
  db = freshDb();
  await seedProject('p1');
});

describe('project AI account overrides', () => {
  // The reported defect: two providers both labelled "Personal". Keyed by label the override
  // could not name one of them, so resolution ranked candidates and could run the other
  // provider than the one picked in Settings.
  it('resolves each of two same-labelled accounts to the one that was picked', async () => {
    await seedAccount('cred-claude', 'Personal', 'claude-code');
    await seedAccount('cred-codex', 'Personal', 'codex');

    await setProjectAiAccount(db, 'p1', 'cred-codex');
    expect(await getProjectAiAccount(db, 'p1')).toEqual({ id: 'cred-codex', label: 'Personal' });

    await setProjectAiAccount(db, 'p1', 'cred-claude');
    expect(await getProjectAiAccount(db, 'p1')).toEqual({ id: 'cred-claude', label: 'Personal' });
  });

  it('returns null when the project has no override', async () => {
    expect(await getProjectAiAccount(db, 'p1')).toBeNull();
  });

  it('clears the override when passed null', async () => {
    await seedAccount('cred-1', 'Work', 'claude-code');
    await setProjectAiAccount(db, 'p1', 'cred-1');

    await setProjectAiAccount(db, 'p1', null);

    expect(await getProjectAiAccount(db, 'p1')).toBeNull();
  });

  // Replaces deleteProjectAiAccountsByLabel: the FK does the cleanup, so no caller has to
  // remember to sweep, and a same-labelled sibling account is no longer collateral damage.
  it('cascades the override away when its account is deleted, leaving siblings alone', async () => {
    await seedAccount('cred-claude', 'Personal', 'claude-code');
    await seedAccount('cred-codex', 'Personal', 'codex');
    await seedProject('p2');
    await setProjectAiAccount(db, 'p1', 'cred-codex');
    await setProjectAiAccount(db, 'p2', 'cred-claude');

    await db
      .delete(schema.claudeCodeCredentials)
      .where(eq(schema.claudeCodeCredentials.id, 'cred-codex'));

    expect(await getProjectAiAccount(db, 'p1')).toBeNull();
    expect(await getProjectAiAccount(db, 'p2')).toEqual({ id: 'cred-claude', label: 'Personal' });
  });

  // Justifies deleting renameProjectAiAccountsByLabel — the override tracks an immutable key,
  // so a rename cannot invalidate it and needs no follow-up write.
  it('survives a rename of the account it points at', async () => {
    await seedAccount('cred-1', 'Work', 'claude-code');
    await setProjectAiAccount(db, 'p1', 'cred-1');

    await db
      .update(schema.claudeCodeCredentials)
      .set({ accountLabel: 'Work (personal)' })
      .where(eq(schema.claudeCodeCredentials.id, 'cred-1'));

    expect(await getProjectAiAccount(db, 'p1')).toEqual({
      id: 'cred-1',
      label: 'Work (personal)',
    });
  });

  // A reconnect deletes the row and mints a fresh id, so the override is correctly dropped
  // rather than silently re-binding to a credential the user never picked.
  it('does not re-bind when the account is deleted and re-created under the same label', async () => {
    await seedAccount('cred-old', 'Personal', 'claude-code');
    await setProjectAiAccount(db, 'p1', 'cred-old');

    await db
      .delete(schema.claudeCodeCredentials)
      .where(eq(schema.claudeCodeCredentials.id, 'cred-old'));
    await seedAccount('cred-new', 'Personal', 'claude-code');

    expect(await getProjectAiAccount(db, 'p1')).toBeNull();
  });

  it('rejects an override pointing at an account that does not exist', async () => {
    await expect(setProjectAiAccount(db, 'p1', 'does-not-exist')).rejects.toThrow(
      /FOREIGN KEY constraint failed/i,
    );
  });

  // The writer clears the old row before inserting the new one, and the FK makes that insert
  // able to fail. Un-transacted, a rejected write would leave the project with no override at
  // all — silently downgrading it to the workspace default on a call that reported failure.
  it('leaves the existing override intact when the new account id is rejected', async () => {
    await seedAccount('cred-1', 'Work', 'claude-code');
    await setProjectAiAccount(db, 'p1', 'cred-1');

    await expect(setProjectAiAccount(db, 'p1', 'does-not-exist')).rejects.toThrow(
      /FOREIGN KEY constraint failed/i,
    );

    expect(await getProjectAiAccount(db, 'p1')).toEqual({ id: 'cred-1', label: 'Work' });
  });

  // The writer's delete-then-insert would keep one row with or without the index, so assert
  // the constraint itself rather than the writer's behaviour.
  it('enforces one override per project at the schema level', async () => {
    await seedAccount('cred-1', 'Work', 'claude-code');
    await seedAccount('cred-2', 'Home', 'claude-code');
    await setProjectAiAccount(db, 'p1', 'cred-1');

    expect(() =>
      db.insert(schema.projectAiAccounts).values({ projectId: 'p1', accountId: 'cred-2' }).run(),
    ).toThrow(/UNIQUE constraint failed/i);
  });

  it('batch-maps only the projects that have an override', async () => {
    await seedAccount('cred-1', 'Work', 'claude-code');
    await seedProject('p2');
    await setProjectAiAccount(db, 'p1', 'cred-1');

    const map = await getProjectAiAccountsBatch(db, ['p1', 'p2']);

    expect(map).toEqual(new Map([['p1', 'cred-1']]));
  });

  it('returns an empty map for no project ids', async () => {
    expect(await getProjectAiAccountsBatch(db, [])).toEqual(new Map());
  });
});

describe('setChatAiAccount', () => {
  const seedChat = (accountId: string | null) =>
    db.insert(schema.chats).values({ id: 'c1', projectId: 'p1', accountId });

  beforeEach(async () => {
    await seedAccount('claude-a', 'Personal', 'claude-code');
    await seedAccount('claude-b', 'Work', 'claude-code');
    await seedAccount('codex', 'Codex', 'codex');
  });

  it('swaps the chat to another login of the same provider, leaving the project alone', async () => {
    await setProjectAiAccount(db, 'p1', 'claude-a');
    await seedChat('claude-a');

    expect(await setChatAiAccount(db, 'c1', 'claude-b')).toBe('ok');

    const [chat] = await db.select().from(schema.chats).where(eq(schema.chats.id, 'c1'));
    expect(chat.accountId).toBe('claude-b');
    expect(await getProjectAiAccount(db, 'p1')).toEqual({ id: 'claude-a', label: 'Personal' });
  });

  it('refuses another provider and keeps the chat on its account', async () => {
    await seedChat('claude-a');

    expect(await setChatAiAccount(db, 'c1', 'codex')).toBe('other-provider');

    const [chat] = await db.select().from(schema.chats).where(eq(schema.chats.id, 'c1'));
    expect(chat.accountId).toBe('claude-a');
  });

  // An unstamped chat lost its provider's last login, so no provider binds it any more.
  it('lets an unstamped chat take an account of any provider', async () => {
    await setProjectAiAccount(db, 'p1', 'codex');
    await seedChat(null);

    expect(await setChatAiAccount(db, 'c1', 'claude-b')).toBe('ok');
  });

  it('reports an unknown chat or account', async () => {
    await seedChat('claude-a');

    expect(await setChatAiAccount(db, 'missing', 'claude-b')).toBe('not-found');
    expect(await setChatAiAccount(db, 'c1', 'missing')).toBe('not-found');
  });
});
