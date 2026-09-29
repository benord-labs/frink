import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chats, projects, subChats, tasks } from '../../db/schema';
import { seedFlowRun } from '../../db/test-utils/flow-fixtures';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';

const fixture = vi.hoisted(() => ({
  db: null as unknown,
  pending: vi.fn(),
  questions: vi.fn(),
  list: vi.fn(),
  counts: vi.fn(),
  activity: vi.fn(),
  agents: vi.fn(),
}));
vi.mock('electron', () => ({ app: { getVersion: () => '9.9.9' } }));
vi.mock('../../db', () => ({ getDatabase: () => fixture.db }));
vi.mock('./chat', () => ({ subChatActivity: fixture.activity }));
vi.mock('../../claude/ask-user-question-approval', () => ({
  listPendingQuestionSubChatIds: fixture.pending,
}));
vi.mock('./context', () => ({
  executionReady: () => true,
  mobileCallers: {
    tasks: { listPaginated: fixture.list, workQueueOverviewCounts: fixture.counts },
  },
  record: (value: unknown) => (value && typeof value === 'object' ? value : {}),
  text: (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback),
}));
vi.mock('./questions', () => ({
  mobileQuestions: fixture.questions,
  mobilePermissions: () => [],
  parkedQuestion: () => null,
}));
// The lookup stays real; only the counts are stubbed so each test controls its queries.
vi.mock('../live-activity/counts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../live-activity/counts')>()),
  readAgentCounts: fixture.agents,
}));
import { readMobileChats, readMobileOverview } from './read';

let db: TestDb;
beforeEach(() => {
  vi.clearAllMocks();
  db = freshDb();
  fixture.db = db;
  fixture.pending.mockReturnValue([]);
  fixture.list.mockResolvedValue({ items: [], hasMore: false });
  fixture.counts.mockResolvedValue({ review: 0, inbox: 0, running: 0, queued: 0 });
  fixture.activity.mockReturnValue('idle');
  fixture.agents.mockResolvedValue({ running: 0, needsYou: 0 });
  fixture.questions.mockImplementation(async (chatId: string, subChatId: string) => [
    { id: subChatId, chatId, subChatId },
  ]);
});

const at = (seconds: number) => new Date(seconds * 1000);

describe('mobile chat list', () => {
  beforeEach(async () => {
    await db.insert(projects).values({ id: 'project', name: 'Frink', path: '/tmp/frink' });
    await db.insert(chats).values([
      { id: 'chat-a', name: 'Alpha', projectId: 'project', createdAt: at(1000) },
      { id: 'chat-b', name: null, createdAt: at(5000) },
      // A recent rename moves chats.updated_at, which must not reorder the list.
      { id: 'chat-c', name: 'Gamma', createdAt: at(1000), updatedAt: at(9900) },
      { id: 'chat-d', name: 'Delta', createdAt: at(1000) },
      { id: 'archived', name: 'Hidden', createdAt: at(9000), archivedAt: at(9000) },
    ]);
    await db.insert(subChats).values([
      { id: 'sub-a1', chatId: 'chat-a', updatedAt: at(2000) },
      { id: 'sub-a2', chatId: 'chat-a', updatedAt: at(7000) },
      { id: 'sub-c', chatId: 'chat-c', updatedAt: at(3000) },
      { id: 'sub-d', chatId: 'chat-d', updatedAt: at(3000) },
    ]);
  });

  it('orders by last message activity, breaks same-second ties by id, and pages by limit', async () => {
    fixture.activity.mockImplementation((id: string) => (id === 'sub-d' ? 'running' : 'idle'));
    const queries = vi.spyOn(db.$client, 'prepare');
    const page = await readMobileChats({ limit: 3 });
    expect(page).toEqual({
      items: [
        {
          id: 'chat-a',
          name: 'Alpha',
          projectId: 'project',
          projectName: 'Frink',
          lastActiveAt: at(7000).toISOString(),
          activity: 'idle',
          kind: 'chat',
        },
        {
          id: 'chat-b',
          name: 'Untitled chat',
          projectId: null,
          projectName: null,
          lastActiveAt: at(5000).toISOString(),
          activity: 'idle',
          kind: 'chat',
        },
        expect.objectContaining({ id: 'chat-d', activity: 'running' }),
      ],
      hasMore: true,
    });
    // One page query plus one sub-chat lookup for the page's activity.
    expect(queries).toHaveBeenCalledTimes(2);
    expect(queries.mock.calls[0][0]).toMatch(
      /order by "last_active_at" desc, "chats"\."id" desc limit \?$/,
    );
    expect(queries.mock.calls[0][0]).not.toContain('messages');

    const all = await readMobileChats({ limit: 4 });
    expect(all.items.map((chat) => chat.id)).toEqual(['chat-a', 'chat-b', 'chat-d', 'chat-c']);
    expect(all.hasMore).toBe(false);
  });

  it('reports the busiest conversation and marks only Flow-run chats as Flows', async () => {
    const { flowRunId } = await seedFlowRun(db, { nodes: [], edges: [] });
    await db.insert(tasks).values([
      { id: 'flow-task', description: 'Step', source: 'flow', flowRunId },
      { id: 'manual-task', description: 'Fix it', source: 'manual' },
    ]);
    await db.insert(chats).values([
      { id: 'flow-chat', name: 'Step', taskId: 'flow-task', createdAt: at(9990) },
      { id: 'task-chat', name: 'Fix it', taskId: 'manual-task', createdAt: at(9980) },
    ]);
    fixture.activity.mockImplementation((id: string) =>
      id === 'sub-a1' ? 'background' : id === 'sub-a2' ? 'running' : 'idle',
    );
    const page = await readMobileChats({ limit: 3 });
    expect(page.items.map(({ id, kind, activity }) => ({ id, kind, activity }))).toEqual([
      { id: 'flow-chat', kind: 'flow', activity: 'idle' },
      { id: 'task-chat', kind: 'chat', activity: 'idle' },
      { id: 'chat-a', kind: 'chat', activity: 'running' },
    ]);
  });

  it('returns the newest 30 by default', async () => {
    await db
      .insert(chats)
      .values(
        Array.from({ length: 27 }, (_, index) => ({ id: `extra-${index}`, createdAt: at(1) })),
      );
    const page = await readMobileChats();
    expect(page.items).toHaveLength(30);
    expect(page.hasMore).toBe(true);
  });

  it('searches chat and project names case-insensitively, taking LIKE wildcards literally', async () => {
    await db.insert(projects).values({ id: 'payments', name: 'Payments_API', path: '/tmp/pay' });
    await db.insert(chats).values([
      { id: 'percent', name: 'Ship 100% coverage' },
      { id: 'thousand', name: 'Ship 1000 tests' },
      { id: 'path', name: 'Fix C:\\temp path' },
      { id: 'underscore', name: 'Refactor', projectId: 'payments' },
      { id: 'lookalike', name: 'PaymentsXAPI notes' },
    ]);
    const ids = async (query: string) =>
      (await readMobileChats({ query })).items.map((chat) => chat.id).sort();
    expect(await ids('100%')).toEqual(['percent']);
    expect(await ids('payments_api')).toEqual(['underscore']);
    expect(await ids('c:\\t')).toEqual(['path']);
    expect(await ids('SHIP')).toEqual(['percent', 'thousand']);
    expect(await ids('frink')).toEqual(['chat-a']);
  });
});

describe('mobile overview', () => {
  it('windows each section and reports server counts, more and item activity', async () => {
    fixture.counts.mockResolvedValue({ review: 45, inbox: 2, running: 1, queued: 7 });
    const task = {
      description: 'Review',
      result: null,
      effectiveStatus: 'done',
      linkedChatId: null,
      flowRunId: null,
      projectName: 'Frink',
      createdAt: at(1000),
      startedAt: at(2000),
      completedAt: at(3000),
    };
    fixture.list.mockImplementation(async ({ workQueueSection }: { workQueueSection: string }) =>
      workQueueSection === 'attention'
        ? {
            items: [
              { ...task, id: 'done' },
              { ...task, id: 'new', startedAt: null, completedAt: null, projectName: null },
            ],
            hasMore: true,
          }
        : { items: [], hasMore: false },
    );
    const result = await readMobileOverview({ limits: { attention: 50 } });
    expect(fixture.list.mock.calls.map(([input]) => input)).toEqual([
      { workQueueSection: 'attention', collapseByFlow: true, limit: 50 },
      { workQueueSection: 'inbox', collapseByFlow: true, limit: 20 },
      { workQueueSection: 'running', collapseByFlow: true, limit: 20 },
    ]);
    expect(result).toMatchObject({
      appVersion: '9.9.9',
      counts: { attention: 45, inbox: 2, running: 1 },
      more: { attention: true, inbox: false, running: false },
      queue: [
        {
          id: 'done',
          section: 'attention',
          projectName: 'Frink',
          activityAt: at(3000).toISOString(),
          // Row actions follow the queue's display status.
          actions: ['completeTask'],
        },
        { id: 'new', section: 'attention', projectName: null, activityAt: at(1000).toISOString() },
      ],
    });
  });

  it('batches pending identities without reading transcripts and preserves question order', async () => {
    await db.insert(chats).values({ id: 'chat' });
    await db.insert(subChats).values(
      Array.from({ length: 20 }, (_, index) => ({
        id: `sub-${index}`,
        chatId: 'chat',
      })),
    );
    const ids = Array.from({ length: 20 }, (_, index) => `sub-${19 - index}`);
    fixture.pending.mockReturnValue(['deleted-sub', ...ids]);
    const queries = vi.spyOn(db.$client, 'prepare');
    const result = await readMobileOverview();
    expect(result.questions.map((question) => question.id)).toEqual(ids);
    expect(result.executionReady).toBe(true);
    expect(fixture.questions).toHaveBeenCalledTimes(20);
    expect(fixture.questions).not.toHaveBeenCalledWith(
      expect.anything(),
      'deleted-sub',
      expect.anything(),
    );
    expect(queries).toHaveBeenCalledTimes(1);
    expect(queries.mock.calls[0][0]).not.toContain('messages');
  });

  it('reports the same agent counts as the Live Activity', async () => {
    fixture.agents.mockResolvedValue({ running: 3, needsYou: 1 });
    expect((await readMobileOverview({ limits: { attention: 1 } })).agents).toEqual({
      running: 3,
      needsYou: 1,
    });
  });

  it('does not query sub-chats when no questions are pending', async () => {
    const queries = vi.spyOn(db.$client, 'prepare');
    expect((await readMobileOverview()).questions).toEqual([]);
    expect(queries).not.toHaveBeenCalled();
  });
});
