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
  it('mirrors an ACTIVE sub-chat broadcast into the chat-mode atom and sub-chat store', () => {
    mountHook();
    useAgentSubChatStore.setState({ activeSubChatId: 's1' });
    act(() => handler?.({ chatId: 'c1', subChatId: 's1', mode: 'plan' }));
    expect(appStore.get(chatModeAtomFamily('c1'))).toBe('plan');
    expect(useAgentSubChatStore.getState().subChatsById.s1?.mode).toBe('plan');
  });

  it("keeps the footer atom untouched for a background SIBLING's broadcast", () => {
    // A sibling tab's flip must not move the active tab's footer: useChatMode's reactive
    // persist would then write the sibling's mode onto the active row.
    mountHook();
    useAgentSubChatStore.setState({ activeSubChatId: 's1' });
    appStore.set(chatModeAtomFamily('c1'), 'agent');
    act(() => handler?.({ chatId: 'c1', subChatId: 's-sibling', mode: 'plan' }));
    expect(appStore.get(chatModeAtomFamily('c1'))).toBe('agent');
    expect(useAgentSubChatStore.getState().subChatsById['s-sibling']?.mode).toBe('plan');
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
