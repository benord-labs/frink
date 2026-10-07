import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as database from '../../../db';
import { __resetSubChatLocks } from '../../../db/repos/sub-chat-mutex';
import { createSubChat, getSubChatById, updateSubChatMessages } from '../../../db/repos/sub-chats';
import * as schema from '../../../db/schema';
import { freshDb, type TestDb } from '../../../db/test-utils/fresh-db';
import {
  _clearLiveStreamRegistryForTests,
  getLiveStreamSeed,
  recordLiveStreamStart,
} from './index';
import { createLiveStreamTransport } from './transport';

// Real repo + registry + transport over an in-memory DB: the terminal write and what the renderer
// is handed afterwards are asserted together.
let db: TestDb;

const finalParts = [{ type: 'text', text: 'the turn that was rolled away' }];

async function startTurn(): Promise<string> {
  await db.insert(schema.chats).values({ id: 'chat-1' });
  const row = await createSubChat(db, {
    chatId: 'chat-1',
    messages: JSON.stringify([
      { id: 'u1', role: 'user', parts: [] },
      { id: 'a1', role: 'assistant', parts: [] },
      { id: 'u2', role: 'user', parts: [] },
    ]),
  });
  recordLiveStreamStart({
    chatId: 'chat-1',
    subChatId: row.id,
    assistantMessageId: 'a2',
    streamEpoch: 'epoch-1',
  });
  return row.id;
}

async function completeTurn(subChatId: string) {
  const broadcast = vi.fn();
  await createLiveStreamTransport({ broadcast }).sendExecuteCompleteDirect({
    chatId: 'chat-1',
    subChatId,
    assistantMessageId: 'a2',
    streamEpoch: 'epoch-1',
    finalParts,
  });
  const settled = broadcast.mock.calls.find(([channel]) => channel === 'socket:stream-settled');
  const stored = (await getSubChatById(db, subChatId))?.messages ?? [];
  return {
    storedIds: stored.map((message) => message.id),
    settled: settled?.[1],
    terminal: getLiveStreamSeed(subChatId).terminals[0],
  };
}

describe('a turn completing through the live-stream transport', () => {
  beforeEach(() => {
    db = freshDb();
    vi.spyOn(database, 'getDatabase').mockImplementation(() => db);
    __resetSubChatLocks();
    _clearLiveStreamRegistryForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('commits its message and reports the terminal as durable', async () => {
    const subChatId = await startTurn();

    const { storedIds, settled } = await completeTurn(subChatId);

    expect(storedIds).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(settled?.terminalDurability).toEqual({ durability: 'committed' });
  });

  it('neither writes a rolled-away turn back nor hands the renderer its parts', async () => {
    const subChatId = await startTurn();
    await updateSubChatMessages(db, subChatId, (messages) => messages.slice(0, 2));

    const { storedIds, settled, terminal } = await completeTurn(subChatId);

    expect(storedIds).toEqual(['u1', 'a1']);
    expect(settled?.terminalDurability).toEqual({ durability: 'non-durable' });
    expect(settled).not.toHaveProperty('parts');
    expect(terminal).toMatchObject({ durability: 'non-durable' });
    expect(terminal?.parts).toBeUndefined();
  });
});
