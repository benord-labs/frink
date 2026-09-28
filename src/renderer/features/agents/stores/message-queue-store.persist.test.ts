// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupChatScopedState } from '../../../lib/atoms/atom-family-factory';
import { createQueueItem } from '../lib/queue-utils';
import type { AgentQueueItem } from '../lib/queue-utils';
import { agentChatStore } from './agent-chat-store';
import {
  MESSAGE_QUEUE_STORAGE_KEY,
  reviveQueueState,
  useMessageQueueStore,
} from './message-queue-store';

const SUB_A = 'sub-a';
const SUB_B = 'sub-b';

function resetStore() {
  useMessageQueueStore.setState({ queues: {}, editingItemIds: {}, chatIds: {} });
  sessionStorage.clear();
}

function saved(): { state: Record<string, unknown>; version: number } | null {
  const raw = sessionStorage.getItem(MESSAGE_QUEUE_STORAGE_KEY);
  return raw ? JSON.parse(raw) : null;
}

/** Simulate a renderer reload: wipe memory, then rehydrate from what sessionStorage kept. */
async function reload() {
  const raw = sessionStorage.getItem(MESSAGE_QUEUE_STORAGE_KEY);
  useMessageQueueStore.setState({ queues: {}, editingItemIds: {}, chatIds: {} });
  if (raw !== null) sessionStorage.setItem(MESSAGE_QUEUE_STORAGE_KEY, raw);
  await useMessageQueueStore.persist.rehydrate();
}

function ids(subChatId: string) {
  return useMessageQueueStore.getState().queues[subChatId]?.map((item) => item.id);
}

describe('message-queue-store — reload persistence', () => {
  beforeEach(resetStore);
  afterEach(() => vi.restoreAllMocks());

  it('keeps every sub-chat queue in order, and the editing flag, across a reload', async () => {
    const store = useMessageQueueStore.getState();
    store.addToQueue(SUB_A, createQueueItem('a1', 'first'));
    store.addToQueue(SUB_A, createQueueItem('a2', 'second'));
    store.addToQueue(SUB_A, createQueueItem('a3', 'third'));
    store.addToQueue(SUB_B, createQueueItem('b1', 'other chat'));
    store.setEditingItemId(SUB_A, 'a2');

    await reload();

    expect(ids(SUB_A)).toEqual(['a1', 'a2', 'a3']);
    expect(ids(SUB_B)).toEqual(['b1']);
    expect(useMessageQueueStore.getState().editingItemIds[SUB_A]).toBe('a2');
    expect(useMessageQueueStore.getState().queues[SUB_A]?.[0]?.timestamp).toBeInstanceOf(Date);
  });

  it('does not resurrect an item that was sent (popped) or removed before the reload', async () => {
    const store = useMessageQueueStore.getState();
    store.addToQueue(SUB_A, createQueueItem('sent', 'sent'));
    store.addToQueue(SUB_A, createQueueItem('removed', 'removed'));
    store.addToQueue(SUB_A, createQueueItem('kept', 'kept'));
    store.popItem(SUB_A, 'sent');
    store.removeFromQueue(SUB_A, 'removed');

    await reload();

    expect(ids(SUB_A)).toEqual(['kept']);
  });

  it('writes nothing for an emptied queue or a cleared editing flag', () => {
    const store = useMessageQueueStore.getState();
    store.addToQueue(SUB_A, createQueueItem('a', 'a'));
    store.setEditingItemId(SUB_A, 'a');
    store.setEditingItemId(SUB_A, null);
    store.popItem(SUB_A, 'a');

    expect(saved()?.state).toEqual({ queues: {}, editingItemIds: {}, chatIds: {} });
  });

  it('keeps working in memory when sessionStorage rejects the write (quota exceeded)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setItem = vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const store = useMessageQueueStore.getState();

    expect(() => store.addToQueue(SUB_A, createQueueItem('a', 'a'))).not.toThrow();
    expect(() => store.addToQueue(SUB_A, createQueueItem('b', 'b'))).not.toThrow();
    setItem.mockRestore();

    expect(ids(SUB_A)).toEqual(['a', 'b']);
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('drops the stale snapshot when a write fails, so a sent turn is not restored', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = useMessageQueueStore.getState();
    store.addToQueue(SUB_A, createQueueItem('sent', 'already sent'));
    expect(saved()?.state.queues).toHaveProperty(SUB_A);
    const setItem = vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });

    store.addToQueue(SUB_A, createQueueItem('big', 'large image'));
    store.popItem(SUB_A, 'sent');
    setItem.mockRestore();

    // A reload now restores nothing rather than the snapshot that still held the sent turn.
    expect(sessionStorage.getItem(MESSAGE_QUEUE_STORAGE_KEY)).toBeNull();
  });

  it('keeps working when storage is unusable altogether (SecurityError on write and remove)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const denied = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    const setItem = vi.spyOn(sessionStorage, 'setItem').mockImplementation(denied);
    const removeItem = vi.spyOn(sessionStorage, 'removeItem').mockImplementation(denied);

    try {
      expect(() =>
        useMessageQueueStore.getState().addToQueue(SUB_A, createQueueItem('a', 'a')),
      ).not.toThrow();
      expect(ids(SUB_A)).toEqual(['a']);
    } finally {
      // happy-dom's Storage is a proxy that restoreAllMocks does not unwind.
      setItem.mockRestore();
      removeItem.mockRestore();
    }
  });

  it('comes back empty rather than throwing when the stored value is corrupt', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    sessionStorage.setItem(MESSAGE_QUEUE_STORAGE_KEY, '{not json');

    await expect(useMessageQueueStore.persist.rehydrate()).resolves.not.toThrow();

    expect(useMessageQueueStore.getState().queues).toEqual({});
    useMessageQueueStore.getState().addToQueue(SUB_A, createQueueItem('a', 'a'));
    expect(ids(SUB_A)).toEqual(['a']);
    error.mockRestore();
  });

  it('ignores a stored value from another schema version', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    sessionStorage.setItem(
      MESSAGE_QUEUE_STORAGE_KEY,
      JSON.stringify({ state: { queues: { [SUB_A]: [createQueueItem('old', 'x')] } }, version: 0 }),
    );

    await useMessageQueueStore.persist.rehydrate();

    expect(ids(SUB_A)).toBeUndefined();
  });

  it('hydrates synchronously when the module loads, before any enqueue can race it', async () => {
    const item = { ...createQueueItem('flow', 'flow prompt'), dispatchTaskId: 'task-1' };
    sessionStorage.setItem(
      MESSAGE_QUEUE_STORAGE_KEY,
      JSON.stringify({ state: { queues: { [SUB_A]: [item] }, editingItemIds: {} }, version: 1 }),
    );
    vi.resetModules();

    const fresh = await import('./message-queue-store');

    // No await between import and read: the task:chat-ready dedup (`alreadyQueued`) must see it.
    const queue = fresh.useMessageQueueStore.getState().getQueue(SUB_A);
    expect(queue.map((i) => i.id)).toEqual(['flow']);
    expect(queue[0]?.dispatchTaskId).toBe('task-1');
  });
});

describe('message-queue-store — pruning', () => {
  beforeEach(resetStore);
  afterEach(() => agentChatStore.clear());

  it('clearQueue drops the sub-chat key and its editing flag instead of leaving []', () => {
    const store = useMessageQueueStore.getState();
    store.addToQueue(SUB_A, createQueueItem('a', 'a'));
    store.setEditingItemId(SUB_A, 'a');

    store.clearQueue(SUB_A);

    const state = useMessageQueueStore.getState();
    expect(Object.hasOwn(state.queues, SUB_A)).toBe(false);
    expect(Object.hasOwn(state.editingItemIds, SUB_A)).toBe(false);
  });

  it('archiving or deleting a chat removes all of its sub-chat queues, and only those', async () => {
    agentChatStore.set(SUB_A, {} as never, 'chat-1');
    agentChatStore.set(SUB_B, {} as never, 'chat-2');
    const store = useMessageQueueStore.getState();
    store.addToQueue(SUB_A, createQueueItem('a', 'a'));
    store.addToQueue(SUB_B, createQueueItem('b', 'b'));
    // After a reload agentChatStore no longer knows the sub-chat; the persisted map still does.
    agentChatStore.clear();
    await reload();

    cleanupChatScopedState('chat-1');

    expect(ids(SUB_A)).toBeUndefined();
    expect(ids(SUB_B)).toEqual(['b']);
    expect(Object.keys((saved()?.state.queues as object) ?? {})).toEqual([SUB_B]);
  });

  it('maps a turn queued just before its chat registers, so archiving still prunes it', () => {
    useMessageQueueStore.getState().prependItem(SUB_A, createQueueItem('recovery', 'plan'));
    expect(useMessageQueueStore.getState().chatIds[SUB_A]).toBeUndefined();

    agentChatStore.set(SUB_A, {} as never, 'chat-1');
    cleanupChatScopedState('chat-1');

    expect(ids(SUB_A)).toBeUndefined();
  });

  it('pruning a chat with no queues leaves the state untouched', () => {
    useMessageQueueStore.getState().addToQueue(SUB_A, createQueueItem('a', 'a'));
    const before = useMessageQueueStore.getState();

    cleanupChatScopedState('unknown-chat');

    expect(useMessageQueueStore.getState()).toBe(before);
  });
});

describe('message-queue-store — turns held for lost attachments', () => {
  beforeEach(resetStore);

  it('refuses to pop a held turn for sending, from any caller', () => {
    const held = { ...createQueueItem('held', 'see attached'), attachmentsLost: true as const };
    useMessageQueueStore.setState({ queues: { [SUB_A]: [held] } });

    expect(useMessageQueueStore.getState().popItem(SUB_A, 'held')).toBeNull();
    expect(ids(SUB_A)).toEqual(['held']);
  });

  it('still lets the user remove a held turn', () => {
    const held = { ...createQueueItem('held', 'see attached'), attachmentsLost: true as const };
    useMessageQueueStore.setState({ queues: { [SUB_A]: [held] } });

    useMessageQueueStore.getState().removeFromQueue(SUB_A, 'held');

    expect(ids(SUB_A)).toEqual([]);
  });
});

describe('reviveQueueState', () => {
  const raw = (item: Partial<AgentQueueItem>) =>
    JSON.parse(JSON.stringify({ ...createQueueItem('x', 'msg'), ...item }));

  it('normalises an item that was mid-send and drops a stale settle mark from any position', () => {
    const state = reviveQueueState({
      queues: {
        [SUB_A]: [
          raw({ id: 'h', status: 'processing', sendOnSettle: true }),
          raw({ id: 't', sendOnSettle: true }),
        ],
      },
    });

    const [head, tail] = state.queues[SUB_A] ?? [];
    expect(head?.status).toBe('pending');
    expect(head?.sendOnSettle).toBeUndefined();
    expect(tail?.sendOnSettle).toBeUndefined();
  });

  it('turns a missing or invalid timestamp into a valid Date', () => {
    const state = reviveQueueState({
      queues: {
        [SUB_A]: [raw({ id: 'a', timestamp: 'nope' as never }), { id: 'b', message: 'm' }],
      },
    });

    for (const item of state.queues[SUB_A] ?? []) {
      expect(Number.isNaN(item.timestamp.getTime())).toBe(false);
    }
  });

  it('drops an editing flag whose item is gone or lives in a different sub-chat', () => {
    const state = reviveQueueState({
      queues: { [SUB_A]: [raw({ id: 'a' })], [SUB_B]: [raw({ id: 'b' })] },
      editingItemIds: { [SUB_A]: 'b', [SUB_B]: 'b', 'sub-c': 'gone' },
    });

    expect(state.editingItemIds).toEqual({ [SUB_B]: 'b' });
  });

  it('keeps inline image data but clears the dead blob url', () => {
    const state = reviveQueueState({
      queues: {
        [SUB_A]: [
          raw({
            images: [{ id: 'i', url: 'blob:dead', mediaType: 'image/png', base64Data: 'AAAA' }],
          }),
        ],
      },
    });

    const item = state.queues[SUB_A]?.[0];
    expect(item?.images?.[0]).toMatchObject({ url: '', base64Data: 'AAAA' });
    expect(item?.attachmentsLost).toBeUndefined();
  });

  it.each([
    ['a file (blob url only)', { files: [{ id: 'f', url: 'blob:dead', filename: 'a.txt' }] }],
    [
      'an image without inline data',
      { images: [{ id: 'i', url: 'blob:x', mediaType: 'image/png' }] },
    ],
    [
      'an image with empty inline data',
      { images: [{ id: 'i', url: 'blob:x', mediaType: 'image/png', base64Data: '' }] },
    ],
  ])('marks an item with %s as attachmentsLost', (_label, attachments) => {
    const state = reviveQueueState({ queues: { [SUB_A]: [raw(attachments)] } });

    expect(state.queues[SUB_A]?.[0]?.attachmentsLost).toBe(true);
  });

  it('restores every well-formed context list unchanged', () => {
    const lists = {
      textContexts: [{ id: 't', text: 'quoted', sourceMessageId: 'm1' }],
      diffTextContexts: [{ id: 'd', text: '+x', filePath: 'a.ts', lineNumber: 3 }],
      codeSelectionContexts: [
        {
          id: 'c',
          text: 'x',
          filePath: 'a.ts',
          fileName: 'a.ts',
          language: 'ts',
          startLine: 1,
          endLine: 2,
        },
      ],
    };
    const state = reviveQueueState({ queues: { [SUB_A]: [raw(lists as never)] } });

    expect(state.queues[SUB_A]?.[0]).toMatchObject(lists);
  });

  it('keeps internal recovery turns intact', () => {
    const approvedPlanContext = { planId: 'plan-1', planText: '# Plan' };
    const state = reviveQueueState({ queues: { [SUB_A]: [raw({ approvedPlanContext })] } });

    expect(state.queues[SUB_A]?.[0]?.approvedPlanContext).toEqual(approvedPlanContext);
  });

  it.each([
    ['undefined', undefined],
    ['a string', 'x'],
    ['queues as an array', { queues: [] }],
    ['a queue that is not an array', { queues: { [SUB_A]: 'x' } }],
    ['items missing id or message', { queues: { [SUB_A]: [{ id: 1 }, null, { message: 'm' }] } }],
    [
      'images that are not an array',
      { queues: { [SUB_A]: [{ id: 'q', message: 'm', images: {} }] } },
    ],
    ['files holding non-objects', { queues: { [SUB_A]: [{ id: 'q', message: 'm', files: [1] }] } }],
    [
      'text contexts that are not an array',
      { queues: { [SUB_A]: [{ id: 'q', message: 'm', textContexts: 'x' }] } },
    ],
    [
      'a plan context without its text',
      { queues: { [SUB_A]: [{ id: 'q', message: 'm', approvedPlanContext: { planId: 'p' } }] } },
    ],
    [
      'a plan context whose id is too long',
      {
        queues: {
          [SUB_A]: [
            {
              id: 'q',
              message: 'm',
              approvedPlanContext: { planId: 'x'.repeat(129), planText: 'plan' },
            },
          ],
        },
      },
    ],
    [
      'an image with a non-string filename',
      {
        queues: {
          [SUB_A]: [
            {
              id: 'q',
              message: 'm',
              images: [{ id: 'i', mediaType: 'image/png', base64Data: 'AA', filename: 3 }],
            },
          ],
        },
      },
    ],
    [
      'a file with a negative size',
      {
        queues: {
          [SUB_A]: [
            { id: 'q', message: 'm', files: [{ id: 'f', url: '', filename: 'a', size: -1 }] },
          ],
        },
      },
    ],
    [
      'a diff context with a fractional line number',
      {
        queues: {
          [SUB_A]: [
            {
              id: 'q',
              message: 'm',
              diffTextContexts: [{ id: 'd', text: 't', filePath: 'p', lineNumber: 1.5 }],
            },
          ],
        },
      },
    ],
    [
      'a diff context with an unknown line type',
      {
        queues: {
          [SUB_A]: [
            {
              id: 'q',
              message: 'm',
              diffTextContexts: [{ id: 'd', text: 't', filePath: 'p', lineType: 'both' }],
            },
          ],
        },
      },
    ],
    [
      'a whitespace-only plan text',
      { queues: { [SUB_A]: [{ id: 'q', message: 'm', approvedPlanContext: { planText: '  ' } }] } },
    ],
    ['an unknown source', { queues: { [SUB_A]: [{ id: 'q', message: 'm', source: 'user' }] } }],
    [
      'a non-string dispatch task id',
      { queues: { [SUB_A]: [{ id: 'q', message: 'm', dispatchTaskId: 7 }] } },
    ],
    [
      'a text context missing its text',
      { queues: { [SUB_A]: [{ id: 'q', message: 'm', textContexts: [{}] }] } },
    ],
    [
      'a non-image media type in images',
      {
        queues: {
          [SUB_A]: [
            {
              id: 'q',
              message: 'm',
              images: [{ id: 'i', url: '', mediaType: 'text/plain', base64Data: 'AAAA' }],
            },
          ],
        },
      },
    ],
    [
      'a code selection without line numbers',
      {
        queues: {
          [SUB_A]: [
            {
              id: 'q',
              message: 'm',
              codeSelectionContexts: [
                { id: 'c', text: 't', filePath: 'p', fileName: 'f', language: 'ts' },
              ],
            },
          ],
        },
      },
    ],
  ])('drops malformed input: %s', (_label, input) => {
    expect(reviveQueueState(input)).toEqual({ queues: {}, editingItemIds: {}, chatIds: {} });
  });
});
