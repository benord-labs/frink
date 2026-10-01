import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chats, subChats } from '../../db/schema';
import { freshDb } from '../../db/test-utils/fresh-db';

const fixture = vi.hoisted(() => ({
  db: null as unknown,
  questions: vi.fn(),
  permissions: vi.fn(),
  moves: vi.fn(),
  executions: vi.fn(),
  list: vi.fn(),
}));
vi.mock('../../db', () => ({ getDatabase: () => fixture.db }));
vi.mock('../../claude/ask-user-question-approval', () => ({
  listPendingQuestionSubChatIds: fixture.questions,
}));
vi.mock('../../socket/streaming/pending-permission', () => ({
  listPendingPermissionRequests: fixture.permissions,
  listPendingMoveChatRequests: fixture.moves,
}));
vi.mock('../../socket/streaming/execution-registry', () => ({
  listActiveExecutionHeaders: fixture.executions,
}));
vi.mock('../domain/context', () => ({
  mobileCallers: { tasks: { listPaginated: fixture.list } },
  record: (value: unknown) => (value && typeof value === 'object' ? value : {}),
  text: (value: unknown) => (typeof value === 'string' ? value : ''),
}));
import { readAgentCounts, readWaitingChats } from './counts';

const execution = (chatId: string, subChatId = `${chatId}-sub`) => ({ chatId, subChatId });
const task = (id: string, effectiveStatus: string, linkedChatId: string | null = null) => ({
  id,
  effectiveStatus,
  linkedChatId,
  result: null,
});

beforeEach(async () => {
  vi.clearAllMocks();
  const db = freshDb();
  fixture.db = db;
  await db.insert(chats).values({ id: 'asking' });
  await db.insert(subChats).values({ id: 'asking-sub', chatId: 'asking' });
  fixture.questions.mockReturnValue([]);
  fixture.permissions.mockReturnValue([]);
  fixture.moves.mockReturnValue([]);
  fixture.executions.mockReturnValue([]);
  fixture.list.mockResolvedValue({ items: [], hasMore: false });
});

describe('readAgentCounts', () => {
  it('counts a chat blocked on a permission as needing you, not also as running', async () => {
    fixture.executions.mockReturnValue([execution('a'), execution('b')]);
    fixture.permissions.mockReturnValue([{ chatId: 'b' }]);
    expect(await readAgentCounts()).toEqual({ running: 1, needsYou: 1 });
  });

  it('counts a Flow step or second session as its chat, and a wake-held chat as neither', async () => {
    // A wake-held chat has no execution and no pending request, so nothing counts it.
    fixture.executions.mockReturnValue([execution('a', 'one'), execution('a', 'two')]);
    expect(await readAgentCounts()).toEqual({ running: 1, needsYou: 0 });
  });

  it('leaves finished work out: done, failed and interrupted are outcomes', async () => {
    fixture.list.mockResolvedValue({
      items: [task('1', 'done', 'x'), task('2', 'failed', 'y'), task('3', 'interrupted', 'z')],
      hasMore: false,
    });
    expect(await readAgentCounts()).toEqual({ running: 0, needsYou: 0 });
  });

  it('counts a live question and the task parked on it once', async () => {
    fixture.questions.mockReturnValue(['asking-sub', 'deleted-sub']);
    fixture.list.mockResolvedValue({
      items: [task('parked', 'needs_attention', 'asking')],
      hasMore: false,
    });
    fixture.moves.mockReturnValue([{ chatId: 'asking' }]);
    expect(await readAgentCounts()).toEqual({ running: 0, needsYou: 1 });
  });

  it('counts every waiting task regardless of the overview page size', async () => {
    fixture.list.mockResolvedValue({
      items: Array.from({ length: 25 }, (_, index) =>
        task(`t${index}`, index % 2 ? 'plan_ready' : 'needs_attention'),
      ),
      hasMore: false,
    });
    expect(await readAgentCounts()).toEqual({ running: 0, needsYou: 25 });
    expect(fixture.list).toHaveBeenCalledWith({
      workQueueSection: 'attention',
      collapseByFlow: true,
      limit: 200,
    });
  });

  it('names what each chat waits for, the most specific wait winning', async () => {
    fixture.questions.mockReturnValue(['asking-sub']);
    fixture.permissions.mockReturnValue([{ chatId: 'b', subChatId: 'b-sub' }]);
    fixture.moves.mockReturnValue([{ chatId: 'c' }]);
    fixture.list.mockResolvedValue({
      items: [
        task('1', 'plan_ready', 'asking'),
        task('2', 'plan_ready', 'd'),
        task('3', 'needs_attention'),
      ],
      hasMore: false,
    });
    expect(await readWaitingChats()).toEqual(
      new Map([
        ['asking', { kind: 'question', subChatId: 'asking-sub' }],
        ['d', { kind: 'plan' }],
        ['task:3', { kind: 'attention' }],
        ['c', { kind: 'permission' }],
        ['b', { kind: 'permission', subChatId: 'b-sub' }],
      ]),
    );
  });
});
