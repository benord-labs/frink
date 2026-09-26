// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  buildSubChatList,
  selectSubChatsForChat,
  type SubChatMeta,
  useAgentSubChatStore,
} from './sub-chat-store';

const record = (...rows: SubChatMeta[]): Record<string, SubChatMeta> =>
  Object.fromEntries(rows.map((row) => [row.id, row]));

describe('selectSubChatsForChat', () => {
  it('returns only the rows belonging to the given chat', () => {
    const byId = record(
      { id: 'a1', name: 'A1', chatId: 'chat-a' },
      { id: 'b1', name: 'B1', chatId: 'chat-b' },
      { id: 'a2', name: 'A2', chatId: 'chat-a' },
    );

    expect(selectSubChatsForChat(byId, 'chat-a').map((sc) => sc.id)).toEqual(['a1', 'a2']);
    expect(selectSubChatsForChat(byId, 'chat-b').map((sc) => sc.id)).toEqual(['b1']);
  });

  it('excludes rows that have no parent chat', () => {
    // An un-claimed stub belongs to no chat, so no pane may render it as one of its tabs.
    const byId = record({ id: 'orphan', name: '' }, { id: 'a1', name: 'A1', chatId: 'chat-a' });

    expect(selectSubChatsForChat(byId, 'chat-a').map((sc) => sc.id)).toEqual(['a1']);
  });

  it('returns the same array instance for repeated reads of one record', () => {
    // The result feeds useMemo dependency lists; a fresh array each call defeats them.
    const byId = record({ id: 'a1', name: 'A1', chatId: 'chat-a' });

    expect(selectSubChatsForChat(byId, 'chat-a')).toBe(selectSubChatsForChat(byId, 'chat-a'));
  });

  it('recomputes when the record identity changes', () => {
    const first = record({ id: 'a1', name: 'A1', chatId: 'chat-a' });
    const second = record(
      { id: 'a1', name: 'A1', chatId: 'chat-a' },
      { id: 'a2', name: 'A2', chatId: 'chat-a' },
    );

    expect(selectSubChatsForChat(first, 'chat-a')).toHaveLength(1);
    expect(selectSubChatsForChat(second, 'chat-a')).toHaveLength(2);
  });

  it('returns a stable empty array for an unknown or absent chat', () => {
    const byId = record({ id: 'a1', name: 'A1', chatId: 'chat-a' });

    expect(selectSubChatsForChat(byId, 'chat-zzz')).toEqual([]);
    expect(selectSubChatsForChat(byId, null)).toBe(selectSubChatsForChat(byId, 'chat-zzz'));
  });
});

describe('buildSubChatList', () => {
  it('stamps the parent chat onto every row', () => {
    const list = buildSubChatList([{ id: 's1', name: 'One' }], null, 'chat-a');

    expect(list).toEqual([{ id: 's1', name: 'One', chatId: 'chat-a' }]);
  });

  it('placeholders a pending sub-chat the server does not return yet', () => {
    // A just-created chat's sub-chat can be active before its row is persisted; without a
    // placeholder the pane has nothing to render until the next hydration.
    expect(buildSubChatList([], 's1', 'chat-a')).toEqual([
      { id: 's1', name: 'New Chat', chatId: 'chat-a' },
    ]);
    expect(buildSubChatList([{ id: 's1', name: 'One' }], 's1', 'chat-a')).toEqual([
      { id: 's1', name: 'One', chatId: 'chat-a' },
    ]);
  });

  it('omits blank timestamps rather than asserting them as undefined', () => {
    // The store merges these rows, so an explicit undefined would erase a value it holds.
    const [row] = buildSubChatList([{ id: 's1', name: 'One' }], null, 'chat-a');

    expect('createdAt' in row).toBe(false);
    expect('updatedAt' in row).toBe(false);
  });

  it('normalises Date timestamps to ISO strings', () => {
    const createdAt = new Date('2020-01-02T03:04:05.000Z');
    const [row] = buildSubChatList([{ id: 's1', name: 'One', createdAt }], null, 'chat-a');

    expect(row.createdAt).toBe('2020-01-02T03:04:05.000Z');
  });

  it('falls back to a placeholder name and leaves an absent mode unset', () => {
    const [row] = buildSubChatList([{ id: 's1', name: '' }], null, 'chat-a');

    expect(row.name).toBe('New Chat');
    expect('mode' in row).toBe(false);
  });

  it('keeps an unpersisted plan toggle when the server row carries no mode', () => {
    useAgentSubChatStore.getState().reset();
    useAgentSubChatStore.getState().updateSubChatMode('s1', 'plan', 'chat-a');

    useAgentSubChatStore
      .getState()
      .setSubChatsForChat('chat-a', buildSubChatList([{ id: 's1', name: 'One' }], null, 'chat-a'));

    expect(useAgentSubChatStore.getState().subChatsById.s1?.mode).toBe('plan');
  });
});

describe('setSubChatsForChat placeholder timestamps', () => {
  it('stays identity-stable when an unpersisted sub-chat rehydrates', () => {
    useAgentSubChatStore.getState().reset();
    const hydrate = () =>
      useAgentSubChatStore
        .getState()
        .setSubChatsForChat('chat-a', buildSubChatList([], 's1', 'chat-a'));
    hydrate();
    const first = useAgentSubChatStore.getState().subChatsById;

    hydrate();

    expect(useAgentSubChatStore.getState().subChatsById).toBe(first);
  });

  it('takes the server createdAt once the placeholder row is persisted', () => {
    useAgentSubChatStore.getState().reset();
    useAgentSubChatStore
      .getState()
      .setSubChatsForChat('chat-a', buildSubChatList([], 's1', 'chat-a'));

    const persisted = [{ id: 's1', name: 'One', createdAt: '2020-01-02T03:04:05.000Z' }];
    useAgentSubChatStore
      .getState()
      .setSubChatsForChat('chat-a', buildSubChatList(persisted, 's1', 'chat-a'));

    expect(useAgentSubChatStore.getState().subChatsById.s1?.createdAt).toBe(
      '2020-01-02T03:04:05.000Z',
    );
  });
});
