// @vitest-environment happy-dom
import { createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('jotai', async () => {
  const actual = await vi.importActual<typeof import('jotai')>('jotai');
  return actual;
});

import { renderHook } from '@testing-library/react';
import { Provider } from 'jotai';
import { createElement } from 'react';
import {
  isCreatingPrAtomFamily,
  pendingConflictResolutionMessageAtomFamily,
  pendingMoveChatContinuationAtom,
  pendingPrMessageAtomFamily,
  pendingReviewMessageAtomFamily,
} from '../../../atoms';
import { usePendingMessageHandlers } from './usePendingMessageHandlers';

// The hook under test belongs to chat 'parent-1' (see baseProps)
const pendingPrMessageAtom = pendingPrMessageAtomFamily('parent-1');
const pendingReviewMessageAtom = pendingReviewMessageAtomFamily('parent-1');
const pendingConflictResolutionMessageAtom = pendingConflictResolutionMessageAtomFamily('parent-1');

function createWrapper(store: ReturnType<typeof createStore>) {
  return ({ children }: { children: React.ReactNode }) =>
    createElement(Provider, { store }, children);
}

describe('usePendingMessageHandlers', () => {
  let store: ReturnType<typeof createStore>;
  type SendMessage = Parameters<typeof usePendingMessageHandlers>[0]['sendMessage'];
  let sendMessage: ReturnType<typeof vi.fn<SendMessage>>;

  const baseProps = () => ({
    subChatId: 'sub-1',
    parentChatId: 'parent-1',
    isActive: true,
    isStreaming: false,
    sendMessage,
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
    isResolvedExecutionAccountReady: true,
  });

  beforeEach(() => {
    store = createStore();
    sendMessage = vi.fn<SendMessage>();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isActive guard', () => {
    it('sends pending PR message when active', () => {
      store.set(pendingPrMessageAtom, 'create pr please');

      renderHook(() => usePendingMessageHandlers(baseProps()), {
        wrapper: createWrapper(store),
      });

      expect(sendMessage).toHaveBeenCalledWith({
        role: 'user',
        parts: [{ type: 'text', text: 'create pr please' }],
      });
      expect(store.get(pendingPrMessageAtom)).toBeNull();
      expect(store.get(isCreatingPrAtomFamily('parent-1'))).toBe(false);
    });

    it('does NOT send pending PR message when inactive', () => {
      store.set(pendingPrMessageAtom, 'create pr please');

      renderHook(() => usePendingMessageHandlers({ ...baseProps(), isActive: false }), {
        wrapper: createWrapper(store),
      });

      expect(sendMessage).not.toHaveBeenCalled();
      expect(store.get(pendingPrMessageAtom)).toBe('create pr please');
    });

    it('does NOT send pending review message when inactive', () => {
      store.set(pendingReviewMessageAtom, 'review this');

      renderHook(() => usePendingMessageHandlers({ ...baseProps(), isActive: false }), {
        wrapper: createWrapper(store),
      });

      expect(sendMessage).not.toHaveBeenCalled();
      expect(store.get(pendingReviewMessageAtom)).toBe('review this');
    });

    it('sends pending review message when active', () => {
      store.set(pendingReviewMessageAtom, 'review this');

      renderHook(() => usePendingMessageHandlers(baseProps()), {
        wrapper: createWrapper(store),
      });

      expect(sendMessage).toHaveBeenCalledWith({
        role: 'user',
        parts: [{ type: 'text', text: 'review this' }],
      });
      expect(store.get(pendingReviewMessageAtom)).toBeNull();
    });

    it('does NOT send pending conflict message when inactive', () => {
      store.set(pendingConflictResolutionMessageAtom, 'fix conflicts');

      renderHook(() => usePendingMessageHandlers({ ...baseProps(), isActive: false }), {
        wrapper: createWrapper(store),
      });

      expect(sendMessage).not.toHaveBeenCalled();
      expect(store.get(pendingConflictResolutionMessageAtom)).toBe('fix conflicts');
    });

    // The initial task prompt is now delivered headlessly via the global message queue
    // (use-task-ipc-handler → QueueProcessor), not this isActive-gated effect. Its tests live
    // in use-task-ipc-handler.test.tsx. Only user-action follow-ups remain here.
  });

  describe('empty messages guard (chat transition race)', () => {
    it('does NOT send pending PR message when messages is empty', () => {
      store.set(pendingPrMessageAtom, 'create pr please');

      renderHook(() => usePendingMessageHandlers({ ...baseProps(), messages: [] }), {
        wrapper: createWrapper(store),
      });

      expect(sendMessage).not.toHaveBeenCalled();
      expect(store.get(pendingPrMessageAtom)).toBe('create pr please');
    });

    it('does NOT send pending review message when messages is empty', () => {
      store.set(pendingReviewMessageAtom, 'review this');

      renderHook(() => usePendingMessageHandlers({ ...baseProps(), messages: [] }), {
        wrapper: createWrapper(store),
      });

      expect(sendMessage).not.toHaveBeenCalled();
      expect(store.get(pendingReviewMessageAtom)).toBe('review this');
    });

    it('does NOT send pending conflict message when messages is empty', () => {
      store.set(pendingConflictResolutionMessageAtom, 'fix conflicts');

      renderHook(() => usePendingMessageHandlers({ ...baseProps(), messages: [] }), {
        wrapper: createWrapper(store),
      });

      expect(sendMessage).not.toHaveBeenCalled();
      expect(store.get(pendingConflictResolutionMessageAtom)).toBe('fix conflicts');
    });

    it('sends pending PR message once messages load after chat transition', () => {
      store.set(pendingPrMessageAtom, 'create pr please');

      const { rerender } = renderHook(
        (props) => usePendingMessageHandlers({ ...baseProps(), ...props }),
        {
          wrapper: createWrapper(store),
          initialProps: {
            messages: [] as Array<{
              role?: string;
              parts?: Array<{ type?: string; text?: string }>;
            }>,
          },
        },
      );

      expect(sendMessage).not.toHaveBeenCalled();

      rerender({ messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }] });

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith({
        role: 'user',
        parts: [{ type: 'text', text: 'create pr please' }],
      });
      expect(store.get(pendingPrMessageAtom)).toBeNull();
    });

    it('sends pending conflict message once messages load after chat transition', () => {
      store.set(pendingConflictResolutionMessageAtom, 'fix conflicts');

      const { rerender } = renderHook(
        (props) => usePendingMessageHandlers({ ...baseProps(), ...props }),
        {
          wrapper: createWrapper(store),
          initialProps: {
            messages: [] as Array<{
              role?: string;
              parts?: Array<{ type?: string; text?: string }>;
            }>,
          },
        },
      );

      expect(sendMessage).not.toHaveBeenCalled();

      rerender({ messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }] });

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith({
        role: 'user',
        parts: [{ type: 'text', text: 'fix conflicts' }],
      });
      expect(store.get(pendingConflictResolutionMessageAtom)).toBeNull();
    });
  });

  describe('isStreaming guard', () => {
    it('does NOT send when streaming even if active', () => {
      store.set(pendingPrMessageAtom, 'create pr');

      renderHook(() => usePendingMessageHandlers({ ...baseProps(), isStreaming: true }), {
        wrapper: createWrapper(store),
      });

      expect(sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('move-chat continuation', () => {
    it('sends continuation message when active, not streaming, and matching chat', () => {
      store.set(pendingMoveChatContinuationAtom, {
        chatId: 'parent-1',
        subChatId: 'sub-1',
        projectName: 'Hackathon',
        projectPath: '/new/path',
      });

      renderHook(() => usePendingMessageHandlers(baseProps()), {
        wrapper: createWrapper(store),
      });

      expect(sendMessage).toHaveBeenCalledWith({
        role: 'system',
        parts: [
          {
            type: 'text',
            text: 'Continue working. You have been moved to project "Hackathon". Your working directory is now /new/path.',
          },
        ],
      });
      expect(store.get(pendingMoveChatContinuationAtom)).toBeNull();
    });

    it('does NOT send continuation when inactive', () => {
      store.set(pendingMoveChatContinuationAtom, {
        chatId: 'parent-1',
        subChatId: 'sub-1',
        projectName: 'Hackathon',
        projectPath: '/new/path',
      });

      renderHook(() => usePendingMessageHandlers({ ...baseProps(), isActive: false }), {
        wrapper: createWrapper(store),
      });

      expect(sendMessage).not.toHaveBeenCalled();
      expect(store.get(pendingMoveChatContinuationAtom)).not.toBeNull();
    });

    it('does NOT send continuation when streaming', () => {
      store.set(pendingMoveChatContinuationAtom, {
        chatId: 'parent-1',
        subChatId: 'sub-1',
        projectName: 'Hackathon',
        projectPath: '/new/path',
      });

      renderHook(() => usePendingMessageHandlers({ ...baseProps(), isStreaming: true }), {
        wrapper: createWrapper(store),
      });

      expect(sendMessage).not.toHaveBeenCalled();
      expect(store.get(pendingMoveChatContinuationAtom)).not.toBeNull();
    });

    it('does NOT send continuation when chatId mismatches', () => {
      store.set(pendingMoveChatContinuationAtom, {
        chatId: 'other-chat',
        subChatId: 'sub-1',
        projectName: 'Hackathon',
        projectPath: '/new/path',
      });

      renderHook(() => usePendingMessageHandlers(baseProps()), {
        wrapper: createWrapper(store),
      });

      expect(sendMessage).not.toHaveBeenCalled();
      expect(store.get(pendingMoveChatContinuationAtom)).not.toBeNull();
    });

    it('does NOT send continuation when subChatId mismatches', () => {
      store.set(pendingMoveChatContinuationAtom, {
        chatId: 'parent-1',
        subChatId: 'other-sub',
        projectName: 'Hackathon',
        projectPath: '/new/path',
      });

      renderHook(() => usePendingMessageHandlers(baseProps()), {
        wrapper: createWrapper(store),
      });

      expect(sendMessage).not.toHaveBeenCalled();
      expect(store.get(pendingMoveChatContinuationAtom)).not.toBeNull();
    });

    it('consumes continuation atom only once across duplicate mounts', () => {
      store.set(pendingMoveChatContinuationAtom, {
        chatId: 'parent-1',
        subChatId: 'sub-1',
        projectName: 'Hackathon',
        projectPath: '/new/path',
      });

      renderHook(() => usePendingMessageHandlers(baseProps()), {
        wrapper: createWrapper(store),
      });

      renderHook(() => usePendingMessageHandlers(baseProps()), {
        wrapper: createWrapper(store),
      });

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(store.get(pendingMoveChatContinuationAtom)).toBeNull();
    });

    it('sends continuation when streaming stops after being set', () => {
      store.set(pendingMoveChatContinuationAtom, {
        chatId: 'parent-1',
        subChatId: 'sub-1',
        projectName: 'Hackathon',
        projectPath: '/new/path',
      });

      const { rerender } = renderHook(
        (props) => usePendingMessageHandlers({ ...baseProps(), ...props }),
        {
          wrapper: createWrapper(store),
          initialProps: { isStreaming: true },
        },
      );

      expect(sendMessage).not.toHaveBeenCalled();

      rerender({ isStreaming: false });

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(store.get(pendingMoveChatContinuationAtom)).toBeNull();
    });

    it('sends continuation when becomes active after being set', () => {
      store.set(pendingMoveChatContinuationAtom, {
        chatId: 'parent-1',
        subChatId: 'sub-1',
        projectName: 'Hackathon',
        projectPath: '/new/path',
      });

      const { rerender } = renderHook(
        (props) => usePendingMessageHandlers({ ...baseProps(), ...props }),
        {
          wrapper: createWrapper(store),
          initialProps: { isActive: false },
        },
      );

      expect(sendMessage).not.toHaveBeenCalled();

      rerender({ isActive: true });

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(store.get(pendingMoveChatContinuationAtom)).toBeNull();
    });
  });

  it("leaves another chat's pending request for that chat to send", () => {
    store.set(pendingPrMessageAtomFamily('other-chat'), 'commit for the other chat');

    renderHook(() => usePendingMessageHandlers(baseProps()), {
      wrapper: createWrapper(store),
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(store.get(pendingPrMessageAtomFamily('other-chat'))).toBe('commit for the other chat');
  });
});
