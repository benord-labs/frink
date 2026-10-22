// @vitest-environment happy-dom
/**
 * The mode-change broadcast mirrors the row (the mode's owner — decision
 * `sub-chat-mode-ownership`) into the footer atom and sub-chat store. It is mirrors-ONLY: it
 * never touches the pending transition intent, which is cleared solely by its own correlated
 * acks (toggle mutation result / send success) because an echo cannot tell whose write it
 * announces.
 */
import { act, renderHook } from '@testing-library/react';
import { Provider } from 'jotai';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatModeAtomFamily, pendingModeIntentAtomFamily } from '../features/agents/atoms';
import { useAgentSubChatStore } from '../features/agents/stores/sub-chat-store';
import { appStore } from '../lib/jotai-store';
import { useSubChatModeSync } from './use-sub-chat-mode-sync';

const mountHook = () =>
  renderHook(() => useSubChatModeSync(), {
    wrapper: ({ children }) => createElement(Provider, { store: appStore }, children),
  });

vi.mock('../lib/utils/platform', () => ({ isDesktopApp: () => true }));

type ModeChangedHandler = (payload: {
  chatId: string;
  subChatId: string;
  mode: 'plan' | 'agent' | 'debug';
}) => void;

let handler: ModeChangedHandler | null = null;

beforeEach(() => {
  handler = null;
  (window as unknown as Record<string, unknown>).desktopApi = {
    onSubChatModeChanged: vi.fn((cb: ModeChangedHandler) => {
      handler = cb;
      return vi.fn();
    }),
  };
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).desktopApi;
});

describe('useSubChatModeSync', () => {
  it('mirrors a broadcast into the chat-mode atom and sub-chat store', () => {
    mountHook();
    useAgentSubChatStore.setState({ activeSubChatId: 's1' });
    act(() => handler?.({ chatId: 'c1', subChatId: 's1', mode: 'plan' }));
    expect(appStore.get(chatModeAtomFamily('c1'))).toBe('plan');
    expect(useAgentSubChatStore.getState().subChatsById.s1?.mode).toBe('plan');
  });

  it('flips the footer of a chat with no active sub-chat (split view, background chat)', () => {
    mountHook();
    useAgentSubChatStore.setState({ activeSubChatId: null });
    appStore.set(chatModeAtomFamily('c3'), 'agent');
    act(() => handler?.({ chatId: 'c3', subChatId: 's3', mode: 'plan' }));
    expect(appStore.get(chatModeAtomFamily('c3'))).toBe('plan');
    expect(useAgentSubChatStore.getState().subChatsById.s3?.mode).toBe('plan');
  });

  it('never touches the pending intent — an echo cannot tell whose write it announces', () => {
    // Disarming here either wiped a not-yet-persisted toggle (foreign flip's echo) or left a
    // stale one armed (value-matching). Intents are cleared only by their own correlated acks
    // (toggle mutation result / send success), so echoes are mirrors-only.
    mountHook();
    appStore.set(pendingModeIntentAtomFamily('s2'), 'agent');
    act(() => handler?.({ chatId: 'c1', subChatId: 's2', mode: 'agent' }));
    act(() => handler?.({ chatId: 'c1', subChatId: 's2', mode: 'plan' }));
    expect(appStore.get(pendingModeIntentAtomFamily('s2'))).toBe('agent');
  });
});
