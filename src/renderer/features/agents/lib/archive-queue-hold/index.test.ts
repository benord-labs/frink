import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMessageQueueStore } from '../../stores/message-queue-store';
import { _resetRestoredHoldsForTests, archiveWithQueueHold, reconcileRestoredHolds } from './index';
import { createQueueItem } from '../queue-utils';

const registered: Record<string, string> = { 'tab-open': 'chat-a' };
const hydratedRows: Record<string, { id: string; chatId?: string }> = {
  // A tab the sidebar hydrated but whose pane never mounted a Chat in this window.
  'tab-unmounted': { id: 'tab-unmounted', chatId: 'chat-a' },
  'tab-other': { id: 'tab-other', chatId: 'chat-b' },
  // Not yet linked to a parent: must not be treated as belonging to any chat.
  'tab-orphan': { id: 'tab-orphan' },
};

vi.mock('../../stores/agent-chat-store', () => ({
  onChatRegistered: () => () => {},
  agentChatStore: {
    getParentChatId: () => undefined,
    getSubChatIdsForChat: (chatId: string) =>
      Object.keys(registered).filter((id) => registered[id] === chatId),
  },
}));
const { chatsGet } = vi.hoisted(() => ({ chatsGet: vi.fn() }));
vi.mock('../../../../lib/trpc', () => ({
  trpcClient: { chats: { archiveOutcome: { query: chatsGet } } },
}));
vi.mock('../../stores/sub-chat-store', () => ({
  useAgentSubChatStore: { getState: () => ({ subChatsById: hydratedRows }) },
}));

const queued = (id: string) => [createQueueItem(id, id)];

describe('archiveWithQueueHold', () => {
  beforeEach(() => {
    useMessageQueueStore.setState({
      queues: {
        'tab-open': queued('q-open'),
        'tab-unmounted': queued('q-unmounted'),
        'tab-other': queued('q-other'),
        'tab-orphan': queued('q-orphan'),
      },
      editingItemIds: { 'tab-open': 'q-open', 'tab-other': 'q-other' },
      heldChatIds: {},
    });
  });

  it('drops queued and in-edit messages for every tab of the archived chat, and only that chat', async () => {
    await archiveWithQueueHold('chat-a', async () => ({ id: 'chat-a' }));

    const { queues, editingItemIds } = useMessageQueueStore.getState();
    expect(queues['tab-open']).toBeUndefined();
    expect(queues['tab-unmounted']).toBeUndefined();
    expect(editingItemIds['tab-open']).toBeUndefined();
    expect(queues['tab-other']?.map((i) => i.id)).toEqual(['q-other']);
    expect(editingItemIds['tab-other']).toBe('q-other');
    expect(queues['tab-orphan']?.map((i) => i.id)).toEqual(['q-orphan']);
  });

  it('holds the chat for exactly the duration of the mutation', async () => {
    let heldDuring = false;
    const result = await archiveWithQueueHold('chat-a', async () => {
      heldDuring = useMessageQueueStore.getState().isChatHeld('chat-a');
      return { id: 'chat-a' };
    });

    expect(heldDuring).toBe(true);
    expect(result).toEqual({ id: 'chat-a' });
    expect(useMessageQueueStore.getState().isChatHeld('chat-a')).toBe(false);
  });

  it('keeps the queue when the archive resolves without archiving anything (missing chat)', async () => {
    await archiveWithQueueHold('chat-a', async () => null);

    const state = useMessageQueueStore.getState();
    expect(state.queues['tab-open']?.map((i) => i.id)).toEqual(['q-open']);
    expect(state.isChatHeld('chat-a')).toBe(false);
  });

  it('keeps the queue and releases the hold when the archive fails', async () => {
    await expect(
      archiveWithQueueHold('chat-a', async () => {
        throw new Error('archive failed');
      }),
    ).rejects.toThrow('archive failed');

    const state = useMessageQueueStore.getState();
    expect(state.queues['tab-open']?.map((i) => i.id)).toEqual(['q-open']);
    expect(state.editingItemIds['tab-open']).toBe('q-open');
    expect(state.isChatHeld('chat-a')).toBe(false);
  });
});

describe('reconcileRestoredHolds (reload mid-archive)', () => {
  beforeEach(() => {
    chatsGet.mockReset();
    _resetRestoredHoldsForTests();
    useMessageQueueStore.setState({
      queues: { 'tab-open': queued('q-open'), 'tab-other': queued('q-other') },
      editingItemIds: {},
      chatIds: { 'tab-open': 'chat-a', 'tab-other': 'chat-b' },
      heldChatIds: { 'chat-a': 1 },
    });
  });

  it('drops the queue of a chat whose archive landed, then releases the hold', async () => {
    chatsGet.mockResolvedValue({ archived: true });

    await reconcileRestoredHolds();

    const state = useMessageQueueStore.getState();
    expect(chatsGet).toHaveBeenCalledWith({ id: 'chat-a' });
    expect(state.queues['tab-open']).toBeUndefined();
    expect(state.queues['tab-other']?.map((i) => i.id)).toEqual(['q-other']);
    expect(state.isChatHeld('chat-a')).toBe(false);
  });

  it('keeps the queue and releases the hold when the archive did not land', async () => {
    chatsGet.mockResolvedValue({ archived: false });

    await reconcileRestoredHolds();

    const state = useMessageQueueStore.getState();
    expect(state.queues['tab-open']?.map((i) => i.id)).toEqual(['q-open']);
    expect(state.isChatHeld('chat-a')).toBe(false);
  });

  it('drops the queue of a chat that no longer exists', async () => {
    chatsGet.mockResolvedValue(null);

    await reconcileRestoredHolds();

    expect(useMessageQueueStore.getState().queues['tab-open']).toBeUndefined();
  });

  it('keeps the queue but still releases when main cannot be asked', async () => {
    // main's admission guard still declines a send to an archived chat, so failing open is safe.
    chatsGet.mockRejectedValue(new Error('ipc closed'));

    await reconcileRestoredHolds();

    const state = useMessageQueueStore.getState();
    expect(state.queues['tab-open']?.map((i) => i.id)).toEqual(['q-open']);
    expect(state.isChatHeld('chat-a')).toBe(false);
  });

  it('reconciles once per document, so a re-run effect cannot release a live hold', async () => {
    chatsGet.mockResolvedValue({ archived: false });

    const first = reconcileRestoredHolds();
    const second = reconcileRestoredHolds(); // StrictMode / remount re-runs the effect
    await Promise.all([first, second]);
    // A new archive takes a live hold after the restored one settled; a later re-run must not touch it.
    useMessageQueueStore.getState().holdChats(['chat-a']);
    await reconcileRestoredHolds();

    expect(chatsGet).toHaveBeenCalledTimes(1);
    expect(useMessageQueueStore.getState().isChatHeld('chat-a')).toBe(true);
  });

  it('does nothing when no hold survived the reload', async () => {
    useMessageQueueStore.setState({ heldChatIds: {} });

    await reconcileRestoredHolds();

    expect(chatsGet).not.toHaveBeenCalled();
  });
});
