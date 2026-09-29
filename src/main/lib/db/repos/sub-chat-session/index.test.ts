import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../schema';
import { freshDb, type TestDb } from '../../test-utils/fresh-db';
import { createSubChat, finalizeAssistantMessage, getSubChatById } from '../sub-chats';
import { logSessionHandleChange, writeSubChatSession } from './index';

const logInfo = vi.fn();
const logger = { info: logInfo };

let db: TestDb;

async function seedSubChat(sessionId: string): Promise<string> {
  await db.insert(schema.chats).values({ id: 'chat-1' });
  const sub = await createSubChat(db, { chatId: 'chat-1', messages: '[]' });
  await db.update(schema.subChats).set({ sessionId }).where(eq(schema.subChats.id, sub.id));
  return sub.id;
}

describe('logSessionHandleChange', () => {
  beforeEach(() => logInfo.mockClear());

  it('names the cleared and the replaced outcomes', () => {
    logSessionHandleChange('sub-1', 'a', '', 'rollback', logger);
    logSessionHandleChange('sub-1', 'a', 'b', 'finalize', logger);
    expect(logInfo.mock.calls.map((c) => c[0])).toEqual([
      '[sub-chat session] sub-1: a cleared (rollback)',
      '[sub-chat session] sub-1: a replaced by b (finalize)',
    ]);
  });

  it('is silent for a first write, a same-id write, and a missing row', () => {
    logSessionHandleChange('sub-1', null, 'a', 'persist', logger);
    logSessionHandleChange('sub-1', '', 'a', 'persist', logger);
    logSessionHandleChange('sub-1', 'a', 'a', 'persist', logger);
    expect(logInfo).not.toHaveBeenCalled();
  });
});

describe('writeSubChatSession logging', () => {
  beforeEach(() => {
    db = freshDb();
    logInfo.mockClear();
  });

  it('logs the dropped id and the reason when the handle is cleared', async () => {
    const id = await seedSubChat('sess-old');
    await writeSubChatSession(db, id, '', 'rollback', logger);
    expect((await getSubChatById(db, id))?.sessionId).toBe('');
    expect(logInfo).toHaveBeenCalledTimes(1);
    expect(logInfo.mock.calls[0]?.[0]).toBe(
      `[sub-chat session] ${id}: sess-old cleared (rollback)`,
    );
  });

  it('logs a swap when a different id overwrites an existing one', async () => {
    const id = await seedSubChat('sess-old');
    await writeSubChatSession(db, id, 'sess-new', 'persist', logger);
    expect((await getSubChatById(db, id))?.sessionId).toBe('sess-new');
    expect(logInfo.mock.calls[0]?.[0]).toBe(
      `[sub-chat session] ${id}: sess-old replaced by sess-new (persist)`,
    );
  });

  it('stays silent when the same id is re-persisted or nothing was set', async () => {
    const id = await seedSubChat('sess-old');
    await writeSubChatSession(db, id, 'sess-old', 'persist', logger);
    const empty = await seedSubChatEmpty();
    await writeSubChatSession(db, empty, 'sess-first', 'persist', logger);
    expect(logInfo).not.toHaveBeenCalled();
  });
});

async function seedSubChatEmpty(): Promise<string> {
  await db.insert(schema.chats).values({ id: 'chat-2' });
  const sub = await createSubChat(db, { chatId: 'chat-2', messages: '[]' });
  return sub.id;
}
