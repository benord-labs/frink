import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeLocalChat } from '../../trpc/routers/chats/test-factories';
import * as schema from '../schema';
import { freshDb, type TestDb } from '../test-utils/fresh-db';
import {
  countChatsByProject,
  createChat,
  forkChatWithSubChats,
  getChatWithProjectAccount,
  getOrCreateFlowChat,
  hasOtherChatsSharingWorktree,
  listAllArchivedChats,
  pageChatsForProjects,
} from './chats';
import * as projectAiAccountsRepo from './project-ai-accounts';

let db: TestDb;

const seed = (overrides: Parameters<typeof makeLocalChat>[0]) =>
  db.insert(schema.chats).values(makeLocalChat(overrides));

// chats.projectId is an FK → projects.id, so a project must exist before a chat references it.
const seedProject = (id: string) =>
  db.insert(schema.projects).values({ id, name: id, path: `/repos/${id}` });

// project_ai_accounts.accountId is an FK → claude_code_credentials.id.
const seedAccount = (id: string, accountLabel: string) =>
  db.insert(schema.claudeCodeCredentials).values({ id, accountLabel, type: 'claude-code' });

const at = (iso: string) => new Date(iso);

describe('pageChatsForProjects', () => {
  beforeEach(() => {
    db = freshDb();
  });

  it('orders by updatedAt desc, then id desc as the tie-break', async () => {
    const same = at('2026-01-02T00:00:00.000Z');
    await seed({ id: 'a', updatedAt: same });
    await seed({ id: 'b', updatedAt: same });
    await seed({ id: 'c', updatedAt: at('2026-01-01T00:00:00.000Z') });

    const rows = await pageChatsForProjects(db, { projectIds: [null], limit: 10 });

    // Equal updatedAt → higher id first ('b' before 'a'); older updatedAt ('c') last.
    expect(rows.map((r) => r.id)).toEqual(['b', 'a', 'c']);
  });

  it('respects the limit', async () => {
    await seed({ id: 'a', updatedAt: at('2026-01-03T00:00:00.000Z') });
    await seed({ id: 'b', updatedAt: at('2026-01-02T00:00:00.000Z') });
    await seed({ id: 'c', updatedAt: at('2026-01-01T00:00:00.000Z') });

    const rows = await pageChatsForProjects(db, { projectIds: [null], limit: 2 });

    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('continues from the cursor, excluding the cursor row', async () => {
    await seed({ id: 'a', updatedAt: at('2026-01-03T00:00:00.000Z') });
    await seed({ id: 'b', updatedAt: at('2026-01-02T00:00:00.000Z') });
    await seed({ id: 'c', updatedAt: at('2026-01-01T00:00:00.000Z') });

    const rows = await pageChatsForProjects(db, {
      projectIds: [null],
      limit: 10,
      cursor: { updatedAt: at('2026-01-03T00:00:00.000Z'), id: 'a' },
    });

    expect(rows.map((r) => r.id)).toEqual(['b', 'c']);
  });

  it('applies the cursor secondary key on identical updatedAt (id strictly less than cursor)', async () => {
    const same = at('2026-01-02T00:00:00.000Z');
    await seed({ id: 'a', updatedAt: same }); // id < 'b' → included
    await seed({ id: 'b', updatedAt: same }); // id === cursor → excluded
    await seed({ id: 'c', updatedAt: same }); // id > 'b' → excluded
    await seed({ id: 'z', updatedAt: at('2026-01-01T00:00:00.000Z') }); // older → included

    const rows = await pageChatsForProjects(db, {
      projectIds: [null],
      limit: 10,
      cursor: { updatedAt: same, id: 'b' },
    });

    expect(rows.map((r) => r.id)).toEqual(['a', 'z']);
  });

  it('returns [] for an empty projectIds list (distinct from [null])', async () => {
    await seed({ id: 'a' });

    expect(await pageChatsForProjects(db, { projectIds: [], limit: 10 })).toEqual([]);
  });

  it('scopes [null] to no-project chats only', async () => {
    await seedProject('p1');
    await seed({ id: 'general', projectId: null });
    await seed({ id: 'owned', projectId: 'p1' });

    const rows = await pageChatsForProjects(db, { projectIds: [null], limit: 10 });

    expect(rows.map((r) => r.id)).toEqual(['general']);
  });

  it('scopes [p1] to that project only, and unions [null, p1]', async () => {
    await seedProject('p1');
    await seedProject('p2');
    await seed({ id: 'general', projectId: null });
    await seed({ id: 'owned', projectId: 'p1' });
    await seed({ id: 'other', projectId: 'p2' });

    const onlyP1 = await pageChatsForProjects(db, { projectIds: ['p1'], limit: 10 });
    expect(onlyP1.map((r) => r.id)).toEqual(['owned']);

    const union = await pageChatsForProjects(db, { projectIds: [null, 'p1'], limit: 10 });
    expect(union.map((r) => r.id).sort()).toEqual(['general', 'owned']);
  });

  it('includes pinned chats — pinning is a separate query, de-duped by the frontend', async () => {
    await seed({ id: 'pinned', pinnedAt: at('2026-01-01T00:00:00.000Z') });

    const rows = await pageChatsForProjects(db, { projectIds: [null], limit: 10 });

    expect(rows.map((r) => r.id)).toEqual(['pinned']);
  });

  it('excludes archived chats', async () => {
    await seed({ id: 'active' });
    await seed({ id: 'archived', archivedAt: at('2026-01-01T00:00:00.000Z') });

    const rows = await pageChatsForProjects(db, { projectIds: [null], limit: 10 });

    expect(rows.map((r) => r.id)).toEqual(['active']);
  });

  it('interleaves multiple projects by updatedAt and paginates the union with a cursor', async () => {
    await seedProject('p1');
    await seedProject('p2');
    // A union whose global updatedAt order alternates between the two projects, so a per-project
    // sort would produce the wrong page. The cursor must resume across the project boundary.
    await seed({ id: 'p1-newest', projectId: 'p1', updatedAt: at('2026-01-05T00:00:00.000Z') });
    await seed({ id: 'p2-second', projectId: 'p2', updatedAt: at('2026-01-04T00:00:00.000Z') });
    await seed({ id: 'p1-third', projectId: 'p1', updatedAt: at('2026-01-03T00:00:00.000Z') });
    await seed({ id: 'p2-oldest', projectId: 'p2', updatedAt: at('2026-01-02T00:00:00.000Z') });

    const page1 = await pageChatsForProjects(db, { projectIds: ['p1', 'p2'], limit: 2 });
    expect(page1.map((r) => r.id)).toEqual(['p1-newest', 'p2-second']);

    const last = page1[page1.length - 1];
    const page2 = await pageChatsForProjects(db, {
      projectIds: ['p1', 'p2'],
      limit: 2,
      cursor: { updatedAt: last.updatedAt as Date, id: last.id },
    });
    expect(page2.map((r) => r.id)).toEqual(['p1-third', 'p2-oldest']);
  });

  it('keyset cursor neither skips nor duplicates rows that share an updatedAt across a page boundary', async () => {
    // Three rows with identical updatedAt split across a page boundary is the classic keyset
    // pagination failure mode: a naive (updatedAt-only) cursor would re-emit or drop the tied row.
    const same = at('2026-01-02T00:00:00.000Z');
    await seed({ id: 'aaa', updatedAt: same });
    await seed({ id: 'bbb', updatedAt: same });
    await seed({ id: 'ccc', updatedAt: same });

    const page1 = await pageChatsForProjects(db, { projectIds: [null], limit: 2 });
    expect(page1.map((r) => r.id)).toEqual(['ccc', 'bbb']);

    const last = page1[page1.length - 1];
    const page2 = await pageChatsForProjects(db, {
      projectIds: [null],
      limit: 2,
      cursor: { updatedAt: last.updatedAt as Date, id: last.id },
    });
    expect(page2.map((r) => r.id)).toEqual(['aaa']);
  });
});

describe('countChatsByProject', () => {
  beforeEach(() => {
    db = freshDb();
  });

  it('aggregates counts per project including the null (general) bucket', async () => {
    await seedProject('p1');
    await seed({ id: 'g1', projectId: null });
    await seed({ id: 'g2', projectId: null });
    await seed({ id: 'p1a', projectId: 'p1' });

    const counts = await countChatsByProject(db);
    const byProject = new Map(counts.map((c) => [c.projectId, c.count]));

    expect(byProject.get(null)).toBe(2);
    expect(byProject.get('p1')).toBe(1);
  });

  it('excludes archived chats — filter parity with pageChatsForProjects', async () => {
    await seedProject('p1');
    await seed({ id: 'active', projectId: 'p1' });
    await seed({ id: 'archived', projectId: 'p1', archivedAt: at('2026-01-01T00:00:00.000Z') });

    const counts = await countChatsByProject(db);
    const page = await pageChatsForProjects(db, { projectIds: ['p1'], limit: 10 });

    expect(counts.find((c) => c.projectId === 'p1')?.count).toBe(1);
    expect(page.map((r) => r.id)).toEqual(['active']);
  });

  it('counts pinned chats — only archived are excluded, keeping parity with the page', async () => {
    // Pinning is a separate query; the count must NOT drop pinned rows or it would disagree with
    // pageChatsForProjects (which also returns pinned), causing sidebar count drift.
    await seed({ id: 'plain', projectId: null });
    await seed({ id: 'pinned', projectId: null, pinnedAt: at('2026-01-01T00:00:00.000Z') });

    const counts = await countChatsByProject(db);

    expect(counts.find((c) => c.projectId === null)?.count).toBe(2);
  });
});

describe('listAllArchivedChats', () => {
  beforeEach(() => {
    db = freshDb();
  });

  it('returns archived chats across all projects (including project-owned), newest archived first', async () => {
    // Regression guard: the sidebar's Archived list is global, so a project-owned archived chat
    // MUST surface — otherwise Complete & Archive looks like a delete (the chat vanishes entirely).
    await seedProject('p1');
    await seed({ id: 'active', projectId: 'p1' });
    await seed({ id: 'general', projectId: null, archivedAt: at('2026-01-01T00:00:00.000Z') });
    await seed({ id: 'owned', projectId: 'p1', archivedAt: at('2026-01-02T00:00:00.000Z') });

    const rows = await listAllArchivedChats(db);

    // Both archived buckets present; active excluded; ordered by archivedAt desc.
    expect(rows.map((r) => r.id)).toEqual(['owned', 'general']);
  });

  it('breaks archivedAt ties by id desc so the list order is stable across refetches', async () => {
    // Batch archives (or rapid Complete & Archive across panes) can stamp the same archivedAt
    // millisecond; without a secondary key the rows would shuffle between refetches, moving the
    // restore buttons under the cursor. Mirrors listAllChats' desc(updatedAt), desc(id) tie-break.
    const sameInstant = at('2026-01-01T00:00:00.000Z');
    await seed({ id: 'a', archivedAt: sameInstant });
    await seed({ id: 'b', archivedAt: sameInstant });
    await seed({ id: 'c', archivedAt: sameInstant });

    const rows = await listAllArchivedChats(db);

    expect(rows.map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });

  it('returns an empty array when nothing is archived', async () => {
    await seed({ id: 'active' });

    expect(await listAllArchivedChats(db)).toEqual([]);
  });
});

describe('getChatWithProjectAccount', () => {
  beforeEach(() => {
    db = freshDb();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves the project-assigned account for the chat', async () => {
    // The regression this fixes: the executor reads this to pick the provider. When a
    // project has an override, returning null routes the turn to the wrong (default) account.
    await seedProject('p1');
    await seedAccount('cred-1', 'Personal Claude');
    await projectAiAccountsRepo.setProjectAiAccount(db, 'p1', 'cred-1');
    await seed({ id: 'c', projectId: 'p1' });

    const result = await getChatWithProjectAccount(db, 'c');

    expect(result?.account).toEqual({ id: 'cred-1', label: 'Personal Claude' });
    expect(result?.chat.id).toBe('c');
  });

  it('returns a null account when the project has no override (falls back to default)', async () => {
    await seedProject('p1');
    await seed({ id: 'c', projectId: 'p1' });

    expect((await getChatWithProjectAccount(db, 'c'))?.account).toBeNull();
  });

  it('returns a null account for a chat with no project, keeping the chat', async () => {
    await seed({ id: 'c', projectId: null });

    const result = await getChatWithProjectAccount(db, 'c');

    expect(result?.account).toBeNull();
    expect(result?.chat.id).toBe('c');
  });

  it('returns null for a missing chat', async () => {
    expect(await getChatWithProjectAccount(db, 'nope')).toBeNull();
  });

  // The caller wraps this in `.catch(() => null)`, so letting the account read reject would
  // also discard worktreePath and run the agent against the project's main checkout.
  it('isolates an account-read failure — null account, chat context intact', async () => {
    await seedProject('p1');
    await seed({ id: 'c', projectId: 'p1', worktreePath: '/tmp/wt/c', taskId: 't1' });
    vi.spyOn(projectAiAccountsRepo, 'getChatAiAccount').mockRejectedValueOnce(
      new Error('db error'),
    );

    const result = await getChatWithProjectAccount(db, 'c');

    expect(result?.account).toBeNull();
    expect(result?.chat.id).toBe('c');
    expect(result?.chat.worktreePath).toBe('/tmp/wt/c');
    expect(result?.chat.taskId).toBe('t1');
  });
});

describe('chat account stamping', () => {
  beforeEach(async () => {
    db = freshDb();
    await seedProject('p1');
    await seedAccount('cred-work', 'Work');
    await seedAccount('cred-home', 'Home');
    await db.insert(schema.claudeCodeCredentials).values({
      id: 'cred-default',
      accountLabel: 'Default',
      type: 'claude-code',
      isDefault: true,
    });
  });

  const accountOf = async (chatId: string) =>
    (await getChatWithProjectAccount(db, chatId))?.account?.id ?? null;

  it('stamps the project override, and a later project change leaves the chat alone', async () => {
    await projectAiAccountsRepo.setProjectAiAccount(db, 'p1', 'cred-work');
    const chat = await createChat(db, { projectId: 'p1', name: 'c' });

    await projectAiAccountsRepo.setProjectAiAccount(db, 'p1', 'cred-home');

    expect(chat.accountId).toBe('cred-work');
    expect(await accountOf(chat.id)).toBe('cred-work');
  });

  it('stamps the workspace default when there is no project override', async () => {
    const general = await createChat(db, { projectId: null, name: 'g' });
    const project = await createChat(db, { projectId: 'p1', name: 'p' });

    expect([general.accountId, project.accountId]).toEqual(['cred-default', 'cred-default']);
  });

  it('stamps a new Flow chat, and reuses an existing one as it is', async () => {
    await projectAiAccountsRepo.setProjectAiAccount(db, 'p1', 'cred-work');
    const input = { projectId: 'p1', name: 'flow', worktreePath: '/tmp/wt/flow' };
    const { chatId } = await getOrCreateFlowChat(db, input);
    await projectAiAccountsRepo.setProjectAiAccount(db, 'p1', 'cred-home');

    expect((await getOrCreateFlowChat(db, input)).chatId).toBe(chatId);
    expect(await accountOf(chatId)).toBe('cred-work');
  });

  it('forks onto the source account and name, with no session ids', async () => {
    const source = await createChat(db, { projectId: 'p1', name: 'src', accountId: 'cred-work' });
    await db
      .insert(schema.subChats)
      .values({ chatId: source.id, name: 'src', sessionId: 'sess-1', messages: '[]' });

    const forked = await forkChatWithSubChats(db, source.id);

    expect([forked.chat.accountId, forked.chat.name]).toEqual(['cred-work', 'src']);
    expect(forked.subChats.map((sub) => [sub.name, sub.sessionId])).toEqual([['src', null]]);
  });

  it("hands a deleted login's chats to the same provider's default login", async () => {
    const chat = await createChat(db, { projectId: 'p1', name: 'c', accountId: 'cred-work' });

    await db
      .delete(schema.claudeCodeCredentials)
      .where(eq(schema.claudeCodeCredentials.id, 'cred-work'));

    expect(await accountOf(chat.id)).toBe('cred-default');
  });

  it("falls back to the project override once the provider's last login is deleted", async () => {
    await db
      .insert(schema.claudeCodeCredentials)
      .values({ id: 'cred-codex', accountLabel: 'Codex', type: 'codex' });
    await projectAiAccountsRepo.setProjectAiAccount(db, 'p1', 'cred-home');
    const chat = await createChat(db, { projectId: 'p1', name: 'c', accountId: 'cred-codex' });

    await db
      .delete(schema.claudeCodeCredentials)
      .where(eq(schema.claudeCodeCredentials.id, 'cred-codex'));

    expect((await getChatWithProjectAccount(db, chat.id))?.chat.accountId).toBeNull();
    expect(await accountOf(chat.id)).toBe('cred-home');
  });
});

describe('hasOtherChatsSharingWorktree', () => {
  beforeEach(() => {
    db = freshDb();
  });

  it('counts an archived fork as a holder — archive is undoable, so its worktree must survive', async () => {
    await seed({ id: 'a', worktreePath: '/wt/shared' });
    await seed({ id: 'b', worktreePath: '/wt/shared', archivedAt: at('2026-01-01T00:00:00.000Z') });

    expect(await hasOtherChatsSharingWorktree(db, 'a', '/wt/shared')).toBe(true);
  });

  it('counts an active fork as a holder', async () => {
    await seed({ id: 'a', worktreePath: '/wt/shared' });
    await seed({ id: 'b', worktreePath: '/wt/shared' });

    expect(await hasOtherChatsSharingWorktree(db, 'a', '/wt/shared')).toBe(true);
  });

  it('excludes the chat being torn down, so the last holder can still release the worktree', async () => {
    await seed({ id: 'a', worktreePath: '/wt/shared', archivedAt: at('2026-01-01T00:00:00.000Z') });

    expect(await hasOtherChatsSharingWorktree(db, 'a', '/wt/shared')).toBe(false);
  });

  it('ignores chats on a different or prefix-similar path', async () => {
    await seed({ id: 'a', worktreePath: '/wt/shared' });
    await seed({
      id: 'b',
      worktreePath: '/wt/shared-2',
      archivedAt: at('2026-01-01T00:00:00.000Z'),
    });
    await seed({ id: 'c', worktreePath: '/wt/other' });

    expect(await hasOtherChatsSharingWorktree(db, 'a', '/wt/shared')).toBe(false);
  });

  it('ignores an archived fork whose worktree was already released (worktreePath nulled)', async () => {
    await seed({ id: 'a', worktreePath: '/wt/shared' });
    await seed({ id: 'b', worktreePath: null, archivedAt: at('2026-01-01T00:00:00.000Z') });

    expect(await hasOtherChatsSharingWorktree(db, 'a', '/wt/shared')).toBe(false);
  });
});
