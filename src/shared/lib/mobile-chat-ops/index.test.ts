import { describe, expect, it } from 'vitest';
import type { MobileChatDetail, MobileChatOp } from '../../types/remote/mobile';
import { applyChatOps } from '.';

const held: MobileChatDetail = {
  chat: { id: 'chat', name: 'Chat', projectId: null },
  subChatId: 'sub-chat',
  subChats: [],
  messages: [
    {
      id: 'reply',
      role: 'assistant',
      text: 'Hi',
      parts: [
        { type: 'text', text: 'Hi' },
        { type: 'tool', id: 'tool', name: 'Read', state: 'running' },
      ],
    },
  ],
  hasMore: false,
  activity: 'running',
  kind: 'chat',
  error: null,
  questions: [],
  permissions: [],
  pendingPlanId: null,
};

describe('applyChatOps', () => {
  it.each<[string, MobileChatOp]>([
    ['a resync', { op: 'resync' }],
    [
      'an append to a message it lacks',
      { op: 'append', messageId: 'gone', partIndex: 0, text: '!' },
    ],
    [
      'an append to a part that is not text',
      { op: 'append', messageId: 'reply', partIndex: 1, text: '!' },
    ],
    ['parts past the end', { op: 'parts', messageId: 'reply', from: 3, parts: [] }],
  ])('asks for a resync on %s', (_, op) => {
    expect(applyChatOps(held, [op])).toBe('resync');
  });

  it('rebuilds the text from the text parts, newline-joined', () => {
    const after = applyChatOps(held, [
      { op: 'parts', messageId: 'reply', from: 1, parts: [{ type: 'text', text: 'Done' }] },
    ]);
    expect(after !== 'resync' && after.messages[0].text).toBe('Hi\nDone');
  });
});
