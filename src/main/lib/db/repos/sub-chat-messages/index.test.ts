import { beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../schema';
import { freshDb, type TestDb } from '../../test-utils/fresh-db';
import { createSubChat, getSubChatById } from '../sub-chats';
import {
  copyTranscript,
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
  await createSubChat(db, { id: 'sub-2', chatId: 'chat-1', messages: '{corrupt' });
});

describe('sub-chat transcript access', () => {
  it('reads transcripts by id and degrades a corrupt one to empty', () => {
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
