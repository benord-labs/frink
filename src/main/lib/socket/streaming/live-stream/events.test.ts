import { describe, expect, it } from 'vitest';
import { emitLiveChatEvent, onLiveChatEvent, type LiveChatEvent } from './events';

describe('live chat events', () => {
  it('repeats each broadcast with the conversation it names, until unsubscribed', () => {
    const seen: LiveChatEvent[] = [];
    const stop = onLiveChatEvent((event) => seen.push(event));
    emitLiveChatEvent('socket:stream-chunk', { chatId: 'chat', subChatId: 'sub-chat', chunk: {} });
    emitLiveChatEvent('socket:permission-dismiss', { requestId: 'request' });
    emitLiveChatEvent('composer:changed', null);
    stop();
    emitLiveChatEvent('socket:stream-chunk', { subChatId: 'sub-chat' });
    expect(seen).toEqual([
      { channel: 'socket:stream-chunk', subChatId: 'sub-chat' },
      { channel: 'socket:permission-dismiss', subChatId: null },
      { channel: 'composer:changed', subChatId: null },
    ]);
  });
});
