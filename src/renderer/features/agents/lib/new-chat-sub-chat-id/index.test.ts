// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { newChatDraftKey, writeDraft } from '../drafts';
import { useNewChatSubChatId } from '.';

const SUB_CHAT_ID_PATTERN = /^[a-z0-9-]{10,64}$/i;

describe('useNewChatSubChatId', () => {
  beforeEach(() => localStorage.clear());

  it('mints an id that is safe as a session folder name and keeps it across renders', () => {
    const { result, rerender } = renderHook(() => useNewChatSubChatId(newChatDraftKey(0)));
    const first = result.current.subChatId;

    rerender();

    expect(first).toMatch(SUB_CHAT_ID_PATTERN);
    expect(result.current.subChatId).toBe(first);
  });

  it("adopts a stored draft's id, so its restored pastes stay in the chat's folder", () => {
    const key = newChatDraftKey(1);
    writeDraft(key, { text: 'restored', subChatId: 'stored-sub-chat-id' });

    const { result } = renderHook(() => useNewChatSubChatId(key));

    expect(result.current.subChatId).toBe('stored-sub-chat-id');
  });

  it('starts a fresh id once a chat has been created from the draft', () => {
    const { result } = renderHook(() => useNewChatSubChatId(newChatDraftKey(0)));
    const sent = result.current.subChatId;

    act(() => result.current.rotate());

    expect(result.current.subChatId).not.toBe(sent);
    expect(result.current.subChatId).toMatch(SUB_CHAT_ID_PATTERN);
  });
});
