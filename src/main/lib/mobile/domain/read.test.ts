import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chats, subChats } from '../../db/schema';
import { freshDb, type TestDb } from '../../db/test-utils/fresh-db';

const fixture = vi.hoisted(() => ({
  db: null as unknown,
  pending: vi.fn(),
  questions: vi.fn(),
  list: vi.fn(),
}));
vi.mock('../../db', () => ({ getDatabase: () => fixture.db }));
vi.mock('../../claude/ask-user-question-approval', () => ({
  listPendingQuestionSubChatIds: fixture.pending,
}));
vi.mock('./context', () => ({
  executionReady: () => true,
  mobileCallers: { tasks: { listPaginated: fixture.list } },
  record: (value: unknown) => (value && typeof value === 'object' ? value : {}),
  text: (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback),
}));
vi.mock('./questions', () => ({
  mobileQuestions: fixture.questions,
  mobilePermissions: () => [],
  parkedQuestion: () => null,
}));
import { readMobileChats, readMobileOverview } from './read';

let db: TestDb;
beforeEach(() => {
  vi.clearAllMocks();
  db = freshDb();
  fixture.db = db;
  fixture.pending.mockReturnValue([]);
  fixture.list.mockResolvedValue({ items: [] });
  fixture.questions.mockImplementation(async (chatId: string, subChatId: string) => [
    { id: subChatId, chatId, subChatId },
  ]);
});

describe('mobile bounded reads', () => {
  it('fetches only the newest 100 non-archived chats with deterministic ties', async () => {
    await db.insert(chats).values(
      Array.from({ length: 110 }, (_, index) => ({
        id: `chat-${String(index).padStart(3, '0')}`,
        name: index === 109 ? null : `Chat ${index}`,
        updatedAt: new Date(1000),
      })),
    );
    await db.insert(chats).values({
      id: 'archived',
      name: 'Hidden',
      updatedAt: new Date(9000),
      archivedAt: new Date(),
    });
    const queries = vi.spyOn(db.$client, 'prepare');
    const result = await readMobileChats();
    expect(result).toHaveLength(100);
    expect(result[0]).toEqual({
      id: 'chat-109',
      name: 'Untitled chat',
      projectId: null,
    });
    expect(result.at(-1)?.id).toBe('chat-010');
    expect(queries).toHaveBeenCalledTimes(1);
    expect(queries.mock.calls[0][0]).toMatch(/order by.*updated_at.*desc.*id.*desc limit \?/);
    expect(queries.mock.calls[0][0]).not.toContain('messages');
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

  it('does not query sub-chats when no questions are pending', async () => {
    const queries = vi.spyOn(db.$client, 'prepare');
    expect((await readMobileOverview()).questions).toEqual([]);
    expect(queries).not.toHaveBeenCalled();
  });
});
