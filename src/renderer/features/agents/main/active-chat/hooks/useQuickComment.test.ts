// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { createRef, StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appStore } from '../../../../../lib/jotai-store';
import { runLiveAtomFamily } from '../../../../../lib/stores/active-transport-registry';
import type { AgentsMentionsEditorHandle } from '../../../mentions/agents-mentions-editor';
import { useQuickComment } from './useQuickComment';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../../../lib/trpc', () => ({
  trpcClient: {
    commands: {
      list: { query: vi.fn(async () => []) },
      getContent: { query: vi.fn(async () => ({ content: '' })) },
    },
  },
}));

vi.mock('@/lib/commands/expand-slash-command', () => ({
  expandSlashCommand: vi.fn(async (text: string) => text),
}));

vi.mock('../utils', () => ({
  utf8ToBase64: vi.fn((text: string) => Buffer.from(text).toString('base64')),
}));

/** An idle quick-comment host whose next submit would send directly. */
function idleQuickCommentProps(send = vi.fn(), addToQueue = vi.fn()) {
  return {
    editorRef: createRef<AgentsMentionsEditorHandle | null>(),
    subChatId: 'sub-1',
    projectPath: '/tmp/project',
    isStreamingRef: { current: false },
    sendMessageRef: { current: send },
    addToQueue,
    isResolvedExecutionAccountReady: true,
  };
}

describe('useQuickComment', () => {
  describe('race condition guards', () => {
    it('does not send when component unmounts during expandSlashCommand', async () => {
      const { expandSlashCommand } = await import('@/lib/commands/expand-slash-command');
      const expandMock = vi.mocked(expandSlashCommand);

      let resolveExpand!: (value: string) => void;
      expandMock.mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveExpand = resolve;
          }),
      );

      const sendMessageMock = vi.fn();
      const editorRef = createRef<AgentsMentionsEditorHandle | null>();
      editorRef.current = { focus: vi.fn() } as unknown as AgentsMentionsEditorHandle;

      const { result, unmount } = renderHook(() =>
        useQuickComment({
          editorRef,
          subChatId: 'sub-1',
          projectPath: '/tmp/project',
          isStreamingRef: { current: false },
          sendMessageRef: { current: sendMessageMock },
          addToQueue: vi.fn(),
          isResolvedExecutionAccountReady: true,
        }),
      );

      // Start quick comment submit — blocks on expandSlashCommand
      const submitPromise = result.current.handleQuickCommentSubmit('fix this', 'selected code', {
        type: 'assistant-message',
        messageId: 'msg-1',
      });

      // Simulate pane switch: unmount during the async gap
      unmount();

      // Resolve expandSlashCommand after unmount
      resolveExpand('fix this');
      await submitPromise;

      // Unmount guard prevents sending to torn-down chat
      expect(sendMessageMock).not.toHaveBeenCalled();
    });

    it('uses snapshotted send function when sendMessageRef mutates during expandSlashCommand', async () => {
      const { expandSlashCommand } = await import('@/lib/commands/expand-slash-command');
      const expandMock = vi.mocked(expandSlashCommand);

      let resolveExpand!: (value: string) => void;
      expandMock.mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveExpand = resolve;
          }),
      );

      const originalSend = vi.fn();
      const replacedSend = vi.fn();
      const sendMessageRef = { current: originalSend };
      const editorRef = createRef<AgentsMentionsEditorHandle | null>();
      editorRef.current = { focus: vi.fn() } as unknown as AgentsMentionsEditorHandle;

      const { result } = renderHook(() =>
        useQuickComment({
          editorRef,
          subChatId: 'sub-1',
          projectPath: '/tmp/project',
          isStreamingRef: { current: false },
          sendMessageRef,
          addToQueue: vi.fn(),
          isResolvedExecutionAccountReady: true,
        }),
      );

      // Start submit — blocks on expandSlashCommand
      const submitPromise = result.current.handleQuickCommentSubmit('fix this', 'selected code', {
        type: 'assistant-message',
        messageId: 'msg-1',
      });

      // Simulate ref mutation (e.g. new useChat instance bound)
      sendMessageRef.current = replacedSend;

      // Resolve expandSlashCommand
      resolveExpand('fix this');
      await submitPromise;

      // Should use the snapshotted (original) function, not the replaced one
      expect(originalSend).toHaveBeenCalledTimes(1);
      expect(replacedSend).not.toHaveBeenCalled();
    });
  });

  describe('routing against a live run', () => {
    afterEach(() => appStore.set(runLiveAtomFamily('sub-1'), false));

    it('queues instead of sending when main still runs the turn but the renderer reads idle', async () => {
      appStore.set(runLiveAtomFamily('sub-1'), true);
      const send = vi.fn();
      const addToQueue = vi.fn();
      const props = idleQuickCommentProps(send, addToQueue);
      const { result } = renderHook(() => useQuickComment(props));

      await result.current.handleQuickCommentSubmit('fix this', 'code', {
        type: 'assistant-message',
        messageId: 'msg-1',
      });

      expect(addToQueue).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
    });

    it('still sends after its effects re-run cleanup then setup (hot update, StrictMode)', async () => {
      const send = vi.fn();
      const props = idleQuickCommentProps(send);
      const { result } = renderHook(() => useQuickComment(props), { wrapper: StrictMode });

      await result.current.handleQuickCommentSubmit('fix this', 'code', {
        type: 'assistant-message',
        messageId: 'msg-1',
      });

      expect(send).toHaveBeenCalledTimes(1);
    });
  });
});
