import { beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../schema';
import { freshDb, type TestDb } from '../../test-utils/fresh-db';
import { createSubChat, getSubChatById } from '../sub-chats';
import {
  copyTranscript,
  latestAnsweredDispatchTaskId,
  readTranscripts,
  transcriptHasMessage,
  transcriptUnchanged,
} from './index';

let db: TestDb;
const transcript = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }];

beforeEach(async () => {
  db = freshDb();
  await db.insert(schema.chats).values({ id: 'chat-1' });
  await createSubChat(db, { id: 'sub-1', chatId: 'chat-1', messages: JSON.stringify(transcript) });
  await createSubChat(db, { id: 'sub-2', chatId: 'chat-1' });
  await db
    .insert(schema.subChatMessages)
    .values({ subChatId: 'sub-2', seq: 0, message: '{corrupt' });
});

describe('sub-chat transcript access', () => {
  it('reads transcripts by id and skips a corrupt message', () => {
    const read = readTranscripts(db, ['sub-1', 'sub-2', 'missing']);
    expect(read.get('sub-1')).toEqual(transcript);
    expect(read.get('sub-2')).toEqual([]);
    expect(read.has('missing')).toBe(false);
  });

  it('answers whether a message exists, and null for a missing sub-chat', () => {
    expect(transcriptHasMessage(db, 'sub-1', 'm1')).toBe(true);
    expect(transcriptHasMessage(db, 'sub-1', 'other')).toBe(false);
    expect(transcriptHasMessage(db, 'sub-1', undefined)).toBe(true);
    expect(transcriptHasMessage(db, 'missing', undefined)).toBeNull();
  });

  it('holds only while the transcript is unchanged', () => {
    const holds = (messages: unknown[]) =>
      db
        .select({ id: schema.subChats.id })
        .from(schema.subChats)
        .where(transcriptUnchanged(db, 'sub-1', messages))
        .all().length > 0;
    expect(holds(transcript)).toBe(true);
    expect(holds([...transcript, { id: 'm2', role: 'assistant', parts: [] }])).toBe(false);
  });

  it('copies a transcript onto another sub-chat', async () => {
    await createSubChat(db, { id: 'sub-3', chatId: 'chat-1' });
    copyTranscript(db, 'sub-1', 'sub-3');
    expect((await getSubChatById(db, 'sub-3'))?.messages).toEqual(transcript);
  });
});

describe('latestAnsweredDispatchTaskId', () => {
  const dispatched = (id: string, taskId: string) => ({
    id,
    role: 'user',
    parts: [{ type: 'text', text: `prompt for ${taskId}` }],
    metadata: { dispatchTaskId: taskId },
  });
  const typed = (id: string) => ({ id, role: 'user', parts: [{ type: 'text', text: 'typed' }] });
  const reply = (id: string) => ({ id, role: 'assistant', parts: [{ type: 'text', text: 'ok' }] });

  async function seed(messages: unknown[]): Promise<void> {
    await createSubChat(db, { id: 'sub-d', chatId: 'chat-1', messages: JSON.stringify(messages) });
  }

  it('returns the newest dispatched prompt the session replied to', async () => {
    await seed([dispatched('u1', 'task-a'), reply('a1'), dispatched('u2', 'task-b'), reply('a2')]);
    expect(latestAnsweredDispatchTaskId(db, 'sub-d')).toBe('task-b');
  });

  it('skips a dispatched prompt nothing replied to and returns the one before it', async () => {
    await seed([dispatched('u1', 'task-a'), reply('a1'), dispatched('u2', 'task-b')]);
    expect(latestAnsweredDispatchTaskId(db, 'sub-d')).toBe('task-a');
  });

  it('ignores typed replies, which carry no dispatch identity', async () => {
    await seed([dispatched('u1', 'task-a'), reply('a1'), typed('u2'), reply('a2')]);
    expect(latestAnsweredDispatchTaskId(db, 'sub-d')).toBe('task-a');
  });

  it('is null for a transcript with no dispatched prompt, or none answered', async () => {
    expect(latestAnsweredDispatchTaskId(db, 'sub-1')).toBeNull();
    await seed([reply('a0'), dispatched('u1', 'task-a')]);
    expect(latestAnsweredDispatchTaskId(db, 'sub-d')).toBeNull();
  });
});
