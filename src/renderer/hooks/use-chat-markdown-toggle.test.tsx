// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { type BubbleRole, useChatMarkdownToggle } from './use-chat-markdown-toggle';

function wrapperFor(store: ReturnType<typeof createStore>) {
  return ({ children }: { children: ReactNode }) => <Provider store={store}>{children}</Provider>;
}

function renderBoth(store: ReturnType<typeof createStore>) {
  const wrapper = wrapperFor(store);
  return {
    user: renderHook(() => useChatMarkdownToggle('user', '**md**'), { wrapper }),
    assistant: renderHook(() => useChatMarkdownToggle('assistant', '**md**'), { wrapper }),
  };
}

describe('useChatMarkdownToggle', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults: user is raw, assistant is rendered', () => {
    const { user, assistant } = renderBoth(createStore());

    expect(user.result.current.renderMarkdown).toBe(false);
    expect(assistant.result.current.renderMarkdown).toBe(true);
  });

  it('showToggle mirrors markdown detection', () => {
    const wrapper = wrapperFor(createStore());
    const withMd = renderHook(() => useChatMarkdownToggle('user', '**bold**'), { wrapper });
    const plain = renderHook(() => useChatMarkdownToggle('user', 'just words'), { wrapper });

    expect(withMd.result.current.showToggle).toBe(true);
    expect(plain.result.current.showToggle).toBe(false);
  });

  it('toggling an assistant bubble off and on again leaves user bubbles raw', () => {
    const { user, assistant } = renderBoth(createStore());

    act(() => assistant.result.current.toggle());
    expect(assistant.result.current.renderMarkdown).toBe(false);
    expect(user.result.current.renderMarkdown).toBe(false);

    act(() => assistant.result.current.toggle());
    expect(assistant.result.current.renderMarkdown).toBe(true);
    expect(user.result.current.renderMarkdown).toBe(false);
  });

  it('toggling a user bubble leaves assistant bubbles rendered', () => {
    const { user, assistant } = renderBoth(createStore());

    act(() => user.result.current.toggle());
    expect(user.result.current.renderMarkdown).toBe(true);
    expect(assistant.result.current.renderMarkdown).toBe(true);

    act(() => user.result.current.toggle());
    expect(user.result.current.renderMarkdown).toBe(false);
    expect(assistant.result.current.renderMarkdown).toBe(true);
  });

  it.each<[BubbleRole, string, boolean]>([
    ['user', 'preferences:chat-markdown-user', true],
    ['assistant', 'preferences:chat-markdown-assistant', false],
  ])('persists the %s choice under its own key', (role, key, flipped) => {
    const toggled = renderHook(() => useChatMarkdownToggle(role, '**md**'), {
      wrapper: wrapperFor(createStore()),
    });

    act(() => toggled.result.current.toggle());
    expect(JSON.parse(localStorage.getItem(key) ?? 'null')).toBe(flipped);

    // A fresh store re-reads the persisted value (getOnInit).
    const reloaded = renderHook(() => useChatMarkdownToggle(role, '**md**'), {
      wrapper: wrapperFor(createStore()),
    });
    expect(reloaded.result.current.renderMarkdown).toBe(flipped);
  });
});
