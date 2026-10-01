import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appStore } from '../../../lib/jotai-store';
import { runSettlingAtomFamily } from '../../../lib/stores/active-transport-registry';
import { createQueueItem } from '../lib/queue-utils';
import { useMessageQueueStore } from './message-queue-store';

const SUB_A = 'sub-a';
const SUB_B = 'sub-b';

function resetStore() {
  useMessageQueueStore.setState({ queues: {}, editingItemIds: {} });
}

describe('message-queue-store — reorderQueue', () => {
  beforeEach(resetStore);

  it('moves item from a higher index to a lower index', () => {
    const a = createQueueItem('a', 'first');
    const b = createQueueItem('b', 'second');
    const c = createQueueItem('c', 'third');
    useMessageQueueStore.setState({ queues: { [SUB_A]: [a, b, c] } });

    useMessageQueueStore.getState().reorderQueue(SUB_A, 2, 0);

    const order = useMessageQueueStore.getState().queues[SUB_A]?.map((i) => i.id);
    expect(order).toEqual(['c', 'a', 'b']);
  });

  it('moves item from a lower index to a higher index', () => {
    const a = createQueueItem('a', 'first');
    const b = createQueueItem('b', 'second');
    const c = createQueueItem('c', 'third');
    useMessageQueueStore.setState({ queues: { [SUB_A]: [a, b, c] } });

    useMessageQueueStore.getState().reorderQueue(SUB_A, 0, 2);

    const order = useMessageQueueStore.getState().queues[SUB_A]?.map((i) => i.id);
    expect(order).toEqual(['b', 'c', 'a']);
  });

  it('is a no-op when fromIndex === toIndex (does not mutate queue reference)', () => {
    const a = createQueueItem('a', 'first');
    const b = createQueueItem('b', 'second');
    useMessageQueueStore.setState({ queues: { [SUB_A]: [a, b] } });
    const before = useMessageQueueStore.getState().queues[SUB_A];

    useMessageQueueStore.getState().reorderQueue(SUB_A, 1, 1);

    // Same array reference — important so QueueProcessor's queue subscription doesn't refire spuriously.
    expect(useMessageQueueStore.getState().queues[SUB_A]).toBe(before);
  });

  it('is a no-op when either index is out of range', () => {
    const a = createQueueItem('a', 'first');
    const b = createQueueItem('b', 'second');
    useMessageQueueStore.setState({ queues: { [SUB_A]: [a, b] } });
    const before = useMessageQueueStore.getState().queues[SUB_A];

    useMessageQueueStore.getState().reorderQueue(SUB_A, 0, 5);
    useMessageQueueStore.getState().reorderQueue(SUB_A, -1, 1);
    useMessageQueueStore.getState().reorderQueue(SUB_A, 5, 0);

    expect(useMessageQueueStore.getState().queues[SUB_A]).toBe(before);
  });

  it('is a no-op for an unknown sub-chat', () => {
    useMessageQueueStore.getState().reorderQueue('unknown-sub', 0, 1);
    expect(useMessageQueueStore.getState().queues['unknown-sub']).toBeUndefined();
  });

  it('does not affect other sub-chats when reordering one', () => {
    const a1 = createQueueItem('a1', 'a1');
    const a2 = createQueueItem('a2', 'a2');
    const b1 = createQueueItem('b1', 'b1');
    const b2 = createQueueItem('b2', 'b2');
    useMessageQueueStore.setState({
      queues: { [SUB_A]: [a1, a2], [SUB_B]: [b1, b2] },
    });
    const beforeB = useMessageQueueStore.getState().queues[SUB_B];

    useMessageQueueStore.getState().reorderQueue(SUB_A, 0, 1);

    expect(useMessageQueueStore.getState().queues[SUB_A]?.map((i) => i.id)).toEqual(['a2', 'a1']);
    // Other sub-chat queue must keep the same array reference (no spurious update fired by selectors).
    expect(useMessageQueueStore.getState().queues[SUB_B]).toBe(beforeB);
  });

  it('does not mutate editingItemIds when reordering (cross-slice isolation)', () => {
    // The drainer's editing-lock looks up `editingItemIds[subChatId]` by ID. If a reorder
    // accidentally clobbered or shuffled this map, the lock would silently break and the
    // drainer would pop the item the user is editing.
    const a = createQueueItem('a', 'first');
    const b = createQueueItem('b', 'editing me');
    useMessageQueueStore.setState({
      queues: { [SUB_A]: [a, b] },
      editingItemIds: { [SUB_A]: 'b' },
    });
    const beforeEditing = useMessageQueueStore.getState().editingItemIds;

    useMessageQueueStore.getState().reorderQueue(SUB_A, 0, 1);

    // editingItemIds must be untouched — same reference, same value.
    expect(useMessageQueueStore.getState().editingItemIds).toBe(beforeEditing);
    expect(useMessageQueueStore.getState().editingItemIds[SUB_A]).toBe('b');
    // Sanity: reorder did happen.
    expect(useMessageQueueStore.getState().queues[SUB_A]?.map((i) => i.id)).toEqual(['b', 'a']);
  });
});

describe('message-queue-store — setEditingItemId', () => {
  beforeEach(resetStore);

  it('sets the editing id for a sub-chat', () => {
    useMessageQueueStore.getState().setEditingItemId(SUB_A, 'item-1');
    expect(useMessageQueueStore.getState().editingItemIds[SUB_A]).toBe('item-1');
  });

  it('clears the editing id when passed null', () => {
    useMessageQueueStore.getState().setEditingItemId(SUB_A, 'item-1');
    useMessageQueueStore.getState().setEditingItemId(SUB_A, null);
    expect(useMessageQueueStore.getState().editingItemIds[SUB_A]).toBeNull();
  });

  it('isolates editing state per sub-chat', () => {
    useMessageQueueStore.getState().setEditingItemId(SUB_A, 'a-edit');
    useMessageQueueStore.getState().setEditingItemId(SUB_B, 'b-edit');

    expect(useMessageQueueStore.getState().editingItemIds[SUB_A]).toBe('a-edit');
    expect(useMessageQueueStore.getState().editingItemIds[SUB_B]).toBe('b-edit');

    useMessageQueueStore.getState().setEditingItemId(SUB_A, null);
    expect(useMessageQueueStore.getState().editingItemIds[SUB_A]).toBeNull();
    // SUB_B unaffected
    expect(useMessageQueueStore.getState().editingItemIds[SUB_B]).toBe('b-edit');
  });

  it('overwriting an existing edit replaces the id (no merge)', () => {
    useMessageQueueStore.getState().setEditingItemId(SUB_A, 'first');
    useMessageQueueStore.getState().setEditingItemId(SUB_A, 'second');
    expect(useMessageQueueStore.getState().editingItemIds[SUB_A]).toBe('second');
  });
});

describe('message-queue-store — internal recovery items', () => {
  beforeEach(resetStore);

  it('cannot be removed, edited, or reordered through user queue actions', () => {
    const recovery = {
      ...createQueueItem('plan', 'approved plan trigger'),
      approvedPlanContext: { planId: 'plan-1', planText: 'Approved plan' },
    };
    const user = createQueueItem('user', 'normal prompt');
    useMessageQueueStore.setState({ queues: { [SUB_A]: [recovery, user] } });

    expect(useMessageQueueStore.getState().getVisibleQueue(SUB_A)).toEqual([user]);
    useMessageQueueStore.getState().removeFromQueue(SUB_A, recovery.id);
    useMessageQueueStore.getState().setEditingItemId(SUB_A, recovery.id);
    useMessageQueueStore.getState().reorderQueue(SUB_A, 0, 1);
    useMessageQueueStore.getState().reorderQueue(SUB_A, 1, 0);

    expect(useMessageQueueStore.getState().queues[SUB_A]).toEqual([recovery, user]);
    expect(useMessageQueueStore.getState().editingItemIds[SUB_A]).toBeUndefined();
  });

  it('maps visible reorder indices without moving the hidden recovery item', () => {
    const recovery = {
      ...createQueueItem('plan', 'approved plan trigger'),
      approvedPlanContext: { planText: 'Approved plan' },
    };
    const first = createQueueItem('first', 'first');
    const second = createQueueItem('second', 'second');
    useMessageQueueStore.setState({ queues: { [SUB_A]: [recovery, first, second] } });

    useMessageQueueStore.getState().reorderVisibleQueue(SUB_A, 1, 0);

    expect(useMessageQueueStore.getState().queues[SUB_A]).toEqual([recovery, second, first]);
  });

  it('remains poppable by the queue processor', () => {
    const recovery = {
      ...createQueueItem('plan', 'approved plan trigger'),
      approvedPlanContext: { planText: 'Approved plan' },
    };
    useMessageQueueStore.setState({ queues: { [SUB_A]: [recovery] } });

    expect(useMessageQueueStore.getState().popItem(SUB_A, recovery.id)).toEqual(recovery);
    expect(useMessageQueueStore.getState().queues[SUB_A]).toEqual([]);
  });
});

function marks() {
  return useMessageQueueStore.getState().queues[SUB_A]?.map((i) => [i.id, i.sendOnSettle]);
}

describe('message-queue-store — queueing while main settles a finished run', () => {
  beforeEach(resetStore);
  afterEach(() => appStore.set(runSettlingAtomFamily(SUB_A), false));

  it('marks a turn with nothing queued ahead to go the moment main settles', () => {
    appStore.set(runSettlingAtomFamily(SUB_A), true);
    useMessageQueueStore.getState().addToQueue(SUB_A, createQueueItem('a', 'first'));
    useMessageQueueStore.getState().addToQueue(SUB_A, createQueueItem('b', 'second'));

    const flags = useMessageQueueStore.getState().queues[SUB_A]?.map((i) => i.sendOnSettle);
    expect(flags).toEqual([true, undefined]);
  });

  it('keeps the mark when the head is edited and its replacement sent', () => {
    appStore.set(runSettlingAtomFamily(SUB_A), true);
    const store = useMessageQueueStore.getState();
    store.addToQueue(SUB_A, createQueueItem('a', 'first'));
    store.setEditingItemId(SUB_A, 'a');
    store.addToQueue(SUB_A, createQueueItem('a2', 'first, edited'));
    store.removeFromQueue(SUB_A, 'a');

    const queue = useMessageQueueStore.getState().queues[SUB_A];
    expect(queue?.map((i) => [i.id, i.sendOnSettle])).toEqual([['a2', true]]);
  });

  it('marks a turn put back at the head, like a queued card whose Steer met the settle', () => {
    useMessageQueueStore.getState().addToQueue(SUB_A, createQueueItem('a', 'first'));
    appStore.set(runSettlingAtomFamily(SUB_A), true);
    useMessageQueueStore.getState().prependItem(SUB_A, createQueueItem('b', 'steered'));

    const flags = useMessageQueueStore.getState().queues[SUB_A]?.map((i) => i.sendOnSettle);
    expect(flags).toEqual([true, undefined]);
  });

  it('drops the mark once main has settled, from a turn put back at the head and the one it displaces', () => {
    appStore.set(runSettlingAtomFamily(SUB_A), true);
    useMessageQueueStore.getState().addToQueue(SUB_A, createQueueItem('a', 'first'));
    appStore.set(runSettlingAtomFamily(SUB_A), false);
    const failedSendNow = { ...createQueueItem('b', 'second'), sendOnSettle: true as const };
    useMessageQueueStore.getState().prependItem(SUB_A, failedSendNow);

    expect(marks()).toEqual([
      ['b', undefined],
      ['a', undefined],
    ]);
  });

  it('moves the mark to whichever turn a drag puts at the head', () => {
    appStore.set(runSettlingAtomFamily(SUB_A), true);
    const store = useMessageQueueStore.getState();
    store.addToQueue(SUB_A, createQueueItem('a', 'first'));
    store.addToQueue(SUB_A, createQueueItem('b', 'second'));
    store.reorderQueue(SUB_A, 1, 0);
    expect(marks()).toEqual([
      ['b', true],
      ['a', undefined],
    ]);

    appStore.set(runSettlingAtomFamily(SUB_A), false);
    store.reorderQueue(SUB_A, 0, 1);
    expect(marks()).toEqual([
      ['a', undefined],
      ['b', undefined],
    ]);
  });
});

describe('message-queue-store — archive holds', () => {
  beforeEach(() => useMessageQueueStore.setState({ heldChatIds: {} }));

  it('stays held until every overlapping hold on the chat is released', () => {
    const store = useMessageQueueStore.getState();
    // Two panes archive the same chat: the first to settle must not release the second's hold.
    store.holdChats(['chat-1']);
    store.holdChats(['chat-1']);
    store.releaseChats(['chat-1']);
    expect(useMessageQueueStore.getState().isChatHeld('chat-1')).toBe(true);

    store.releaseChats(['chat-1']);
    expect(useMessageQueueStore.getState().isChatHeld('chat-1')).toBe(false);
    expect(useMessageQueueStore.getState().heldChatIds).toEqual({});
  });

  it('does not bank a stray release against a later hold', () => {
    const store = useMessageQueueStore.getState();
    store.releaseChats(['chat-1']);
    store.holdChats(['chat-1']);

    expect(useMessageQueueStore.getState().isChatHeld('chat-1')).toBe(true);
  });

  it('holds only the named chats, and never an unknown parent', () => {
    useMessageQueueStore.getState().holdChats(['chat-1']);
    const { isChatHeld } = useMessageQueueStore.getState();

    expect(isChatHeld('chat-2')).toBe(false);
    // A sub-chat with no registered parent resolves to undefined; that must not read as held.
    expect(isChatHeld(undefined)).toBe(false);
  });
});

describe('message-queue-store — clear epochs', () => {
  it('bumps a sub-chat epoch on clear, so an in-flight send can tell its queue was dropped', () => {
    const store = useMessageQueueStore.getState();
    const before = store.getClearEpoch('sub-x');

    store.clearQueue('sub-x');

    expect(useMessageQueueStore.getState().getClearEpoch('sub-x')).toBe(before + 1);
    expect(useMessageQueueStore.getState().getClearEpoch('sub-y')).toBe(0);
  });
});
