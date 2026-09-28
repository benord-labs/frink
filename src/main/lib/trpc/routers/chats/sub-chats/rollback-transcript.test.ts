import { describe, expect, it } from 'vitest';
import type { Message } from '../../../../db/repos/sub-chats';
import {
  findRollbackCheckpoint,
  findRollbackTarget,
  truncateForRollback,
} from './rollback-transcript';

const user = (id: string, metadata?: Record<string, unknown>): Message => ({
  id,
  role: 'user',
  parts: [],
  ...(metadata && { metadata }),
});
const assistant = (id: string, metadata?: Record<string, unknown>): Message => ({
  id,
  role: 'assistant',
  parts: [],
  ...(metadata && { metadata }),
});

const transcript: Message[] = [
  user('u1'),
  assistant('a1', { sdkMessageUuid: 'sdk-1' }),
  user('u2'),
  assistant('a2', { sdkMessageUuid: 'sdk-2' }),
];

describe('findRollbackTarget', () => {
  it('prefers userMessageId when both ids are supplied, matching the user-message path', () => {
    // The input schema allows both. The lookup, the slice and the checkpoint must all agree on
    // which one wins, or the worktree and the transcript rewind to different points.
    const target = { userMessageId: 'u2', sdkMessageUuid: 'sdk-1' };
    expect(findRollbackTarget(transcript, target)).toEqual({ index: 2 });
    expect(truncateForRollback(transcript, target)?.map((m) => m.id)).toEqual(['u1', 'a1']);
    // The explicit sdk uuid still names the checkpoint, as before the refactor.
    expect(findRollbackCheckpoint(transcript, target, 2)).toBe('sdk-1');
  });

  it('reports an empty transcript as not found', () => {
    expect(findRollbackTarget([], { userMessageId: 'u1' })).toEqual({
      error: 'Message not found',
    });
  });
});

describe('findRollbackCheckpoint', () => {
  it('walks back past messages with no metadata at all', () => {
    // Renderer-created user messages and flow chat_reply messages carry no metadata object.
    const messages = [
      assistant('a0', { sdkMessageUuid: 'sdk-0' }),
      user('u1'),
      assistant('a1'),
      user('u2'),
    ];
    expect(findRollbackCheckpoint(messages, { userMessageId: 'u2' }, 3)).toBe('sdk-0');
  });

  it('returns undefined when rolling back to the very first message', () => {
    expect(findRollbackCheckpoint(transcript, { userMessageId: 'u1' }, 0)).toBeUndefined();
  });
});

describe('truncateForRollback', () => {
  it('returns null when the target is gone from the fresh row', () => {
    expect(truncateForRollback([user('u1')], { userMessageId: 'u2' })).toBeNull();
    expect(truncateForRollback([user('u1')], { sdkMessageUuid: 'sdk-2' })).toBeNull();
  });

  it('returns null when the target id now names a non-user message', () => {
    expect(truncateForRollback(transcript, { userMessageId: 'a1' })).toBeNull();
  });

  it('keeps the sdk-uuid target itself (inclusive) and flags it for resume', () => {
    const out = truncateForRollback(transcript, { sdkMessageUuid: 'sdk-1' });
    expect(out?.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect((out?.[1].metadata as Record<string, unknown>).shouldResume).toBe(true);
  });

  it('leaves exactly one shouldResume, clearing a stale flag from an earlier rollback', () => {
    const messages = [
      user('u1'),
      assistant('a1', { sdkMessageUuid: 'sdk-1', shouldResume: true }),
      user('u2'),
      assistant('a2', { sdkMessageUuid: 'sdk-2' }),
      user('u3'),
    ];
    const out = truncateForRollback(messages, { userMessageId: 'u3' }) ?? [];
    const flagged = out.filter((m) => (m.metadata as Record<string, unknown>).shouldResume);
    expect(flagged.map((m) => m.id)).toEqual(['a2']);
  });

  it('keeps edits the fresh row carries on messages before the target', () => {
    const fresh = [
      user('u1'),
      { ...assistant('a1', { sdkMessageUuid: 'sdk-1' }), parts: [{ status: 'approved' }] },
      user('u2'),
    ];
    const out = truncateForRollback(fresh, { userMessageId: 'u2' });
    expect(out?.[1].parts).toEqual([{ status: 'approved' }]);
  });

  it('does not mutate the array it was given', () => {
    const messages = [user('u1'), assistant('a1', { sdkMessageUuid: 'sdk-1' }), user('u2')];
    const snapshot = JSON.stringify(messages);
    truncateForRollback(messages, { userMessageId: 'u2' });
    expect(JSON.stringify(messages)).toBe(snapshot);
  });
});
