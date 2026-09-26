// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useChatMarkdownToggle } from './use-chat-markdown-toggle';

const STORAGE_KEY = 'preferences:chat-markdown-mode';

function wrapperFor(store: ReturnType<typeof createStore>) {
  return ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>;
}

describe('useChatMarkdownToggle', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults: user is raw, assistant is rendered (mode = null)', () => {
    const store = createStore();
    const wrapper = wrapperFor(store);
    const user = renderHook(() => useChatMarkdownToggle('user', '**md**'), { wrapper });
    const assistant = renderHook(() => useChatMarkdownToggle('assistant', '**md**'), { wrapper });

    expect(user.result.current.renderMarkdown).toBe(false);
    expect(assistant.result.current.renderMarkdown).toBe(true);
  });

  it('showToggle mirrors markdown detection', () => {
    const store = createStore();
    const wrapper = wrapperFor(store);
    const withMd = renderHook(() => useChatMarkdownToggle('user', '**bold**'), { wrapper });
    const plain = renderHook(() => useChatMarkdownToggle('user', 'just words'), { wrapper });

    expect(withMd.result.current.showToggle).toBe(true);
    expect(plain.result.current.showToggle).toBe(false);
  });

  it('toggling a user bubble flips assistant resolution too (global coupling)', () => {
    const store = createStore();
    const wrapper = wrapperFor(store);
    const user = renderHook(() => useChatMarkdownToggle('user', '**md**'), { wrapper });
    const assistant = renderHook(() => useChatMarkdownToggle('assistant', '**md**'), { wrapper });

    // User starts raw → toggling sets the global pref to 'rendered'.
    act(() => user.result.current.toggle());
    user.rerender();
    assistant.rerender();
    expect(user.result.current.renderMarkdown).toBe(true);
    expect(assistant.result.current.renderMarkdown).toBe(true);

    // Toggling the assistant now flips the shared pref to 'raw' → both go raw.
    act(() => assistant.result.current.toggle());
    user.rerender();
    assistant.rerender();
    expect(assistant.result.current.renderMarkdown).toBe(false);
    expect(user.result.current.renderMarkdown).toBe(false);
  });

  it('persists the choice to localStorage', () => {
    const store = createStore();
    const wrapper = wrapperFor(store);
    const user = renderHook(() => useChatMarkdownToggle('user', '**md**'), { wrapper });

    act(() => user.result.current.toggle());
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) as string)).toBe('rendered');

    // A fresh store re-reads the persisted value (getOnInit).
    const store2 = createStore();
    const reloaded = renderHook(() => useChatMarkdownToggle('user', '**md**'), {
      wrapper: wrapperFor(store2),
    });
    expect(reloaded.result.current.renderMarkdown).toBe(true);
  });
});
