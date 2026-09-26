// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { agentChatStore } from './agent-chat-store';
import { selectSubChatsForChat, useAgentSubChatStore } from './sub-chat-store';

const subChatsFor = (chatId: string) =>
  selectSubChatsForChat(useAgentSubChatStore.getState().subChatsById, chatId);

describe('useAgentSubChatStore.setChatId', () => {
  beforeEach(() => {
    useAgentSubChatStore.getState().reset();
    localStorage.clear();
  });

  it('keeps hydrated rows when called again for the chat already selected', () => {
    // Several call sites fire setChatId for the current chat. Resetting on those
    // calls wiped the hydrated sub-chat list and left the chat pane blank until an
    // unrelated refetch happened to repopulate it.
    useAgentSubChatStore.getState().setChatId('chat-a');
    useAgentSubChatStore.getState().setSubChatsForChat('chat-a', [{ id: 'sub-a1', name: 'First' }]);

    useAgentSubChatStore.getState().setChatId('chat-a');

    expect(subChatsFor('chat-a')).toEqual([{ id: 'sub-a1', name: 'First', chatId: 'chat-a' }]);
  });

  it('resets and reloads the persisted active sub-chat when switching to a different chat', () => {
    useAgentSubChatStore.getState().setChatId('chat-a');
    useAgentSubChatStore.getState().setActiveSubChat('sub-a1');
    useAgentSubChatStore.getState().setSubChatsForChat('chat-a', [{ id: 'sub-a1', name: 'First' }]);

    useAgentSubChatStore.getState().setChatId('chat-b');

    expect(useAgentSubChatStore.getState().chatId).toBe('chat-b');
    expect(useAgentSubChatStore.getState().activeSubChatId).toBeNull();
    expect(subChatsFor('chat-b')).toEqual([]);
    // chat-a's rows outlive the switch: a split pane may still be rendering them.
    expect(subChatsFor('chat-a')).toHaveLength(1);

    useAgentSubChatStore.getState().setChatId('chat-a');

    expect(useAgentSubChatStore.getState().activeSubChatId).toBe('sub-a1');
  });

  it('clears all state when deselecting', () => {
    useAgentSubChatStore.getState().setChatId('chat-a');
    useAgentSubChatStore.getState().setSubChatsForChat('chat-a', [{ id: 'sub-a1', name: 'First' }]);

    useAgentSubChatStore.getState().setChatId(null);

    expect(useAgentSubChatStore.getState()).toMatchObject({
      chatId: null,
      activeSubChatId: null,
      subChatsById: {},
    });
  });
});

describe('useAgentSubChatStore.updateSubChatMode', () => {
  beforeEach(() => {
    useAgentSubChatStore.getState().reset();
  });

  it('updates mode for a sub-chat that already exists in the store', () => {
    useAgentSubChatStore
      .getState()
      .setSubChatsForChat('chat-a', [{ id: 'sc-existing', name: 'Existing', mode: 'agent' }]);

    useAgentSubChatStore.getState().updateSubChatMode('sc-existing', 'plan');

    expect(useAgentSubChatStore.getState().subChatsById['sc-existing']?.mode).toBe('plan');
  });

  it('upserts a stub when toggling mode on a brand-new sub-chat not yet in the store', () => {
    // A brand-new sub-chat is not hydrated yet; without upsert the toggle is dropped.
    expect(useAgentSubChatStore.getState().subChatsById).toEqual({});

    useAgentSubChatStore.getState().updateSubChatMode('sc-new', 'plan', 'chat-a');

    const found = useAgentSubChatStore.getState().subChatsById['sc-new'];
    expect(found?.mode).toBe('plan');
    // Without the parent chat the stub belongs to no chat and no per-chat view can see it.
    expect(subChatsFor('chat-a')).toEqual([found]);
  });

  it('files an upsert under the Chat instance parent when the caller passes none', () => {
    // A stub with no parent would be missing from every per-chat list, hiding the new tab.
    // SAFETY: only the parent-chat registry is exercised; the Chat instance is never read.
    agentChatStore.set('sc-orphan', {} as never, 'chat-a');

    useAgentSubChatStore.getState().updateSubChatMode('sc-orphan', 'plan');

    expect(subChatsFor('chat-a').map((sc) => sc.id)).toEqual(['sc-orphan']);
    agentChatStore.delete('sc-orphan');
  });

  it('preserves an upserted mode toggle when the list hydrates afterwards', () => {
    // The toggle lands before a list query that carries no mode, so the local toggle survives.
    useAgentSubChatStore.getState().updateSubChatMode('sc-race', 'plan', 'chat-a');

    useAgentSubChatStore
      .getState()
      .setSubChatsForChat('chat-a', [{ id: 'sc-race', name: 'Hydrated Name' }]);

    const found = useAgentSubChatStore.getState().subChatsById['sc-race'];
    expect(found?.mode).toBe('plan');
    expect(found?.name).toBe('Hydrated Name');
  });

  it('keeps object identity when hydration changes nothing', () => {
    // The init effect re-runs on every chat-data refetch. Allocating a new record each
    // time would re-render every subscriber and, from an effect, loop.
    useAgentSubChatStore
      .getState()
      .setSubChatsForChat('chat-a', [{ id: 'sc-1', name: 'One', mode: 'agent' }]);
    const first = useAgentSubChatStore.getState().subChatsById;

    useAgentSubChatStore
      .getState()
      .setSubChatsForChat('chat-a', [{ id: 'sc-1', name: 'One', mode: 'agent' }]);

    expect(useAgentSubChatStore.getState().subChatsById).toBe(first);
  });

  it('replaces only the target chat rows, leaving other chats intact', () => {
    // Split-view panes hydrate concurrently; a whole-record replace would let each pane
    // wipe the others.
    useAgentSubChatStore.getState().setSubChatsForChat('chat-a', [{ id: 'sc-a', name: 'A' }]);
    useAgentSubChatStore.getState().setSubChatsForChat('chat-b', [{ id: 'sc-b', name: 'B' }]);

    useAgentSubChatStore.getState().setSubChatsForChat('chat-b', [{ id: 'sc-b2', name: 'B2' }]);

    expect(subChatsFor('chat-a').map((sc) => sc.id)).toEqual(['sc-a']);
    expect(subChatsFor('chat-b').map((sc) => sc.id)).toEqual(['sc-b2']);
  });
});
