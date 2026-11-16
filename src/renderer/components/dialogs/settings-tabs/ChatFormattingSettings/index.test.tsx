// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useChatMarkdownToggle } from '@/hooks/use-chat-markdown-toggle';
import { chatMarkdownAssistantAtom, chatMarkdownUserAtom } from '@/lib/atoms';
import { ChatFormattingSettings } from './index';

function renderInStore(store: ReturnType<typeof createStore>) {
  return render(
    <Provider store={store}>
      <ChatFormattingSettings />
    </Provider>,
  );
}

describe('ChatFormattingSettings', () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it('each switch writes only its own role', () => {
    const store = createStore();
    renderInStore(store);

    fireEvent.click(screen.getByRole('switch', { name: 'Format your messages' }));
    expect(store.get(chatMarkdownUserAtom)).toBe(true);
    expect(store.get(chatMarkdownAssistantAtom)).toBe(true);

    fireEvent.click(screen.getByRole('switch', { name: 'Format replies' }));
    expect(store.get(chatMarkdownAssistantAtom)).toBe(false);
    expect(store.get(chatMarkdownUserAtom)).toBe(true);
  });

  it('turning user formatting off restores raw user bubbles, even on a plain message', () => {
    const store = createStore();
    store.set(chatMarkdownUserAtom, true);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <Provider store={store}>{children}</Provider>
    );
    // A plain message shows no bubble toggle, so Settings is the only way back.
    const bubble = renderHook(() => useChatMarkdownToggle('user', 'just words'), { wrapper });
    expect(bubble.result.current.showToggle).toBe(false);
    expect(bubble.result.current.renderMarkdown).toBe(true);

    renderInStore(store);
    act(() => {
      fireEvent.click(screen.getByRole('switch', { name: 'Format your messages' }));
    });

    expect(bubble.result.current.renderMarkdown).toBe(false);
  });
});
