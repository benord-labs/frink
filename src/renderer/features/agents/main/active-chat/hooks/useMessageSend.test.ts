// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { createRef, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expandSlashCommand } from '@/lib/commands/expand-slash-command';
import { HIDDEN_WAKE_MARKER } from '../../../../../../shared/lib/message-markers/hidden-wake-marker';
import { pendingAccountAuthAtom } from '../../../../../lib/atoms';
import { appStore } from '../../../../../lib/jotai-store';
import { runLiveAtomFamily } from '../../../../../lib/stores/active-transport-registry';
import { pendingChatRetryAtomFamily } from '../../../atoms';
import type { AgentsMentionsEditorHandle } from '../../../mentions';
import { ACCOUNT_NOT_READY_TOAST_MESSAGE_SEND } from '../utils';
import { useMessageSend } from './useMessageSend';

const { clearPendingRetryMock, setPendingAccountAuthMock, toastErrorMock } = vi.hoisted(() => ({
  clearPendingRetryMock: vi.fn(),
  setPendingAccountAuthMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

/** Set before `renderHook` so the Jotai mock matches `pendingChatRetryAtomFamily(subChatId)`. */
const useMessageSendTestSubChatId = vi.hoisted(() => ({ value: 'sub-1' as string }));

const getAgentChatsSetDataMock = vi.fn();
const sendMessageMock = vi.fn(async () => undefined);

vi.mock('sonner', () => ({
  toast: { error: toastErrorMock },
}));

vi.mock('jotai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jotai')>();
  return {
    ...actual,
    useSetAtom: (atom: Parameters<typeof actual.useSetAtom>[0]) => {
      if (atom === pendingAccountAuthAtom) {
        return setPendingAccountAuthMock;
      }
      if (atom === pendingChatRetryAtomFamily(useMessageSendTestSubChatId.value)) {
        return clearPendingRetryMock;
      }
      // biome-ignore lint/correctness/useHookAtTopLevel: Jotai `useSetAtom` mock; calling real API for unknown atoms.
      return actual.useSetAtom(atom);
    },
  };
});

vi.mock('../../../../../lib/mock-api', () => ({
  api: {
    useUtils: () => ({
      agents: {
        getAgentChats: {
          setData: getAgentChatsSetDataMock,
        },
      },
    }),
  },
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

vi.mock('../../../lib/drafts', () => ({
  clearSubChatDraft: vi.fn(),
}));

vi.mock('../../../stores/sub-chat-store', () => ({
  useAgentSubChatStore: {
    getState: () => ({
      updateSubChatTimestamp: vi.fn(),
    }),
  },
}));

vi.mock('../../../../../contexts/TRPCProvider', () => ({
  getQueryClient: () => null,
}));

vi.mock('../../../../../lib/analytics', () => ({
  trackMessageSent: vi.fn(),
}));

/** An idle composer holding typed text, ready for a direct send. */
function idleComposerProps(addToQueue = vi.fn()): Parameters<typeof useMessageSend>[0] {
  const editorRef = createRef<AgentsMentionsEditorHandle | null>();
  editorRef.current = {
    getValue: () => 'hello',
    clear: vi.fn(),
  } as unknown as AgentsMentionsEditorHandle;
  return {
    subChatId: 'sub-1',
    parentChatId: 'chat-1',
    projectPath: '/tmp/project',
    isArchived: false,
    editorRef,
    chatModeRef: { current: 'agent' },
    isStreamingRef: { current: false },
    imagesRef: { current: [] },
    filesRef: { current: [] },
    textContextsRef: { current: [] },
    diffTextContextsRef: { current: [] },
    codeSelectionContextRef: { current: null },
    activeFileRef: { current: null },
    activeFileExcludedRef: { current: false },
    pastedTextsRef: { current: [] },
    sendMessageRef: { current: sendMessageMock },
    scrollToBottom: vi.fn(),
    clearAll: vi.fn(),
    clearTextContexts: vi.fn(),
    clearDiffTextContexts: vi.fn(),
    clearCodeSelectionContext: vi.fn(),
    clearPastedTexts: vi.fn(),
    addToQueue,
    isResolvedExecutionAccountReady: true,
  };
}

describe('useMessageSend', () => {
  beforeEach(() => {
    useMessageSendTestSubChatId.value = 'sub-1';
    clearPendingRetryMock.mockReset();
    setPendingAccountAuthMock.mockReset();
    toastErrorMock.mockReset();
    getAgentChatsSetDataMock.mockReset();
    sendMessageMock.mockReset();
    sendMessageMock.mockResolvedValue(undefined);
  });

  it('clears pending chat retry state on manual send', async () => {
    const editorRef = createRef<AgentsMentionsEditorHandle | null>();
    editorRef.current = {
      getValue: () => 'hello retry',
      clear: vi.fn(),
    } as unknown as AgentsMentionsEditorHandle;

    const sendMessageRef = { current: sendMessageMock };

    const { result } = renderHook(() =>
      useMessageSend({
        subChatId: 'sub-1',
        parentChatId: 'chat-1',
        projectPath: '/tmp/project',
        teamId: undefined,
        sandboxSetupStatus: 'ready',
        isArchived: false,
        onRestoreWorkspace: undefined,
        editorRef,
        chatModeRef: { current: 'agent' },
        isStreamingRef: { current: false },
        imagesRef: { current: [] },
        filesRef: { current: [] },
        textContextsRef: { current: [] },
        diffTextContextsRef: { current: [] },
        codeSelectionContextRef: { current: null },
        activeFileRef: { current: null },
        activeFileExcludedRef: { current: false },
        pastedTextsRef: { current: [] },
        sendMessageRef,
        scrollToBottom: vi.fn(),
        clearAll: vi.fn(),
        clearTextContexts: vi.fn(),
        clearDiffTextContexts: vi.fn(),
        clearCodeSelectionContext: vi.fn(),
        clearPastedTexts: vi.fn(),
        addToQueue: vi.fn(),
        isResolvedExecutionAccountReady: true,
      }),
    );

    await result.current();

    expect(clearPendingRetryMock).toHaveBeenCalledWith(null);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it('typed text starting with the internal hidden-wake marker is sanitized before send — it must never persist as a synthetic wake', async () => {
    const editorRef = createRef<AgentsMentionsEditorHandle | null>();
    editorRef.current = {
      getValue: () => `${HIDDEN_WAKE_MARKER}please continue with the migration`,
      clear: vi.fn(),
    } as unknown as AgentsMentionsEditorHandle;

    const sendMessageRef = { current: sendMessageMock };

    const { result } = renderHook(() =>
      useMessageSend({
        subChatId: 'sub-1',
        parentChatId: 'chat-1',
        projectPath: '/tmp/project',
        teamId: undefined,
        sandboxSetupStatus: 'ready',
        isArchived: false,
        onRestoreWorkspace: undefined,
        editorRef,
        chatModeRef: { current: 'agent' },
        isStreamingRef: { current: false },
        imagesRef: { current: [] },
        filesRef: { current: [] },
        textContextsRef: { current: [] },
        diffTextContextsRef: { current: [] },
        codeSelectionContextRef: { current: null },
        activeFileRef: { current: null },
        activeFileExcludedRef: { current: false },
        pastedTextsRef: { current: [] },
        sendMessageRef,
        scrollToBottom: vi.fn(),
        clearAll: vi.fn(),
        clearTextContexts: vi.fn(),
        clearDiffTextContexts: vi.fn(),
        clearCodeSelectionContext: vi.fn(),
        clearPastedTexts: vi.fn(),
        addToQueue: vi.fn(),
        isResolvedExecutionAccountReady: true,
      }),
    );

    await result.current();

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [payload] = sendMessageMock.mock.calls[0] as unknown as [
      { parts: Array<{ type: string; text?: string }> },
    ];
    const text = payload.parts.find((p) => p.type === 'text')?.text;
    expect(text).toBe('please continue with the migration');
  });

  it('clears pending chat retry for the hook’s subChatId (multi-pane / non-default id)', async () => {
    const otherSubId = '550e8400-e29b-41d4-a716-4466554400aa';
    useMessageSendTestSubChatId.value = otherSubId;

    const editorRef = createRef<AgentsMentionsEditorHandle | null>();
    editorRef.current = {
      getValue: () => 'hello other pane',
      clear: vi.fn(),
    } as unknown as AgentsMentionsEditorHandle;

    const sendMessageRef = { current: sendMessageMock };

    const { result } = renderHook(() =>
      useMessageSend({
        subChatId: otherSubId,
        parentChatId: 'chat-1',
        projectPath: '/tmp/project',
        teamId: undefined,
        sandboxSetupStatus: 'ready',
        isArchived: false,
        onRestoreWorkspace: undefined,
        editorRef,
        chatModeRef: { current: 'agent' },
        isStreamingRef: { current: false },
        imagesRef: { current: [] },
        filesRef: { current: [] },
        textContextsRef: { current: [] },
        diffTextContextsRef: { current: [] },
        codeSelectionContextRef: { current: null },
        activeFileRef: { current: null },
        activeFileExcludedRef: { current: false },
        pastedTextsRef: { current: [] },
        sendMessageRef,
        scrollToBottom: vi.fn(),
        clearAll: vi.fn(),
        clearTextContexts: vi.fn(),
        clearDiffTextContexts: vi.fn(),
        clearCodeSelectionContext: vi.fn(),
        clearPastedTexts: vi.fn(),
        addToQueue: vi.fn(),
        isResolvedExecutionAccountReady: true,
      }),
    );

    await result.current();

    expect(clearPendingRetryMock).toHaveBeenCalledWith(null);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it('does not call sendMessage when resolved execution account is not ready (direct send path)', async () => {
    const editorRef = createRef<AgentsMentionsEditorHandle | null>();
    const clear = vi.fn();
    editorRef.current = {
      getValue: () => 'hello blocked',
      clear,
    } as unknown as AgentsMentionsEditorHandle;

    const sendMessageRef = { current: sendMessageMock };

    const { result } = renderHook(() =>
      useMessageSend({
        subChatId: 'sub-1',
        parentChatId: 'chat-1',
        projectPath: '/tmp/project',
        teamId: undefined,
        sandboxSetupStatus: 'ready',
        isArchived: false,
        onRestoreWorkspace: undefined,
        editorRef,
        chatModeRef: { current: 'agent' },
        isStreamingRef: { current: false },
        imagesRef: { current: [] },
        filesRef: { current: [] },
        textContextsRef: { current: [] },
        diffTextContextsRef: { current: [] },
        codeSelectionContextRef: { current: null },
        activeFileRef: { current: null },
        activeFileExcludedRef: { current: false },
        pastedTextsRef: { current: [] },
        sendMessageRef,
        scrollToBottom: vi.fn(),
        clearAll: vi.fn(),
        clearTextContexts: vi.fn(),
        clearDiffTextContexts: vi.fn(),
        clearCodeSelectionContext: vi.fn(),
        clearPastedTexts: vi.fn(),
        addToQueue: vi.fn(),
        isResolvedExecutionAccountReady: false,
      }),
    );

    await result.current();

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith(
      ACCOUNT_NOT_READY_TOAST_MESSAGE_SEND,
      expect.objectContaining({ action: expect.objectContaining({ label: 'Connect' }) }),
    );
  });

  it('toast Connect action calls setPendingAccountAuth', async () => {
    const editorRef = createRef<AgentsMentionsEditorHandle | null>();
    editorRef.current = {
      getValue: () => 'hello',
      clear: vi.fn(),
    } as unknown as AgentsMentionsEditorHandle;

    const { result } = renderHook(() =>
      useMessageSend({
        subChatId: 'sub-1',
        parentChatId: 'chat-1',
        projectPath: '/tmp/project',
        teamId: undefined,
        sandboxSetupStatus: 'ready',
        isArchived: false,
        onRestoreWorkspace: undefined,
        editorRef,
        chatModeRef: { current: 'agent' },
        isStreamingRef: { current: false },
        imagesRef: { current: [] },
        filesRef: { current: [] },
        textContextsRef: { current: [] },
        diffTextContextsRef: { current: [] },
        codeSelectionContextRef: { current: null },
        activeFileRef: { current: null },
        activeFileExcludedRef: { current: false },
        pastedTextsRef: { current: [] },
        sendMessageRef: { current: sendMessageMock },
        scrollToBottom: vi.fn(),
        clearAll: vi.fn(),
        clearTextContexts: vi.fn(),
        clearDiffTextContexts: vi.fn(),
        clearCodeSelectionContext: vi.fn(),
        clearPastedTexts: vi.fn(),
        addToQueue: vi.fn(),
        isResolvedExecutionAccountReady: false,
      }),
    );

    await result.current();

    // Extract the Connect action callback and invoke it
    const [, options] = toastErrorMock.mock.calls[0] as [
      string,
      { action: { onClick: () => void } },
    ];
    options.action.onClick();

    expect(setPendingAccountAuthMock).toHaveBeenCalledWith({
      mode: 'add',
      accountLabel: '',
      returnToSettings: false,
    });
  });

  it('toast uses Reconnect label and reauth mode when unauthAccount is provided', async () => {
    const editorRef = createRef<AgentsMentionsEditorHandle | null>();
    editorRef.current = {
      getValue: () => 'hello',
      clear: vi.fn(),
    } as unknown as AgentsMentionsEditorHandle;

    const { result } = renderHook(() =>
      useMessageSend({
        subChatId: 'sub-1',
        parentChatId: 'chat-1',
        projectPath: '/tmp/project',
        teamId: undefined,
        sandboxSetupStatus: 'ready',
        isArchived: false,
        onRestoreWorkspace: undefined,
        editorRef,
        chatModeRef: { current: 'agent' },
        isStreamingRef: { current: false },
        imagesRef: { current: [] },
        filesRef: { current: [] },
        textContextsRef: { current: [] },
        diffTextContextsRef: { current: [] },
        codeSelectionContextRef: { current: null },
        activeFileRef: { current: null },
        activeFileExcludedRef: { current: false },
        pastedTextsRef: { current: [] },
        sendMessageRef: { current: sendMessageMock },
        scrollToBottom: vi.fn(),
        clearAll: vi.fn(),
        clearTextContexts: vi.fn(),
        clearDiffTextContexts: vi.fn(),
        clearCodeSelectionContext: vi.fn(),
        clearPastedTexts: vi.fn(),
        addToQueue: vi.fn(),
        isResolvedExecutionAccountReady: false,
        unauthAccount: { label: 'My Claude', type: 'claude-code' },
      }),
    );

    await result.current();

    expect(toastErrorMock).toHaveBeenCalledWith(
      ACCOUNT_NOT_READY_TOAST_MESSAGE_SEND,
      expect.objectContaining({ action: expect.objectContaining({ label: 'Reconnect' }) }),
    );

    const [, options] = toastErrorMock.mock.calls[0] as [
      string,
      { action: { onClick: () => void } },
    ];
    options.action.onClick();

    expect(setPendingAccountAuthMock).toHaveBeenCalledWith({
      mode: 'reauth',
      accountLabel: 'My Claude',
      returnToSettings: false,
    });
  });

  describe('race condition guards', () => {
    const expandSlashCommandMock = vi.mocked(expandSlashCommand);

    afterEach(() => {
      expandSlashCommandMock.mockReset();
      expandSlashCommandMock.mockImplementation(async (text: string) => text);
    });

    it('does not send or run side effects when component unmounts during expandSlashCommand', async () => {
      let resolveExpand!: (value: string) => void;
      expandSlashCommandMock.mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveExpand = resolve;
          }),
      );

      const editorRef = createRef<AgentsMentionsEditorHandle | null>();
      const clearEditor = vi.fn();
      editorRef.current = {
        getValue: () => 'hello race condition',
        clear: clearEditor,
      } as unknown as AgentsMentionsEditorHandle;

      const clearAll = vi.fn();
      const clearTextContexts = vi.fn();
      const sendMessageRef = { current: sendMessageMock };

      const { result, unmount } = renderHook(() =>
        useMessageSend({
          subChatId: 'sub-1',
          parentChatId: 'chat-1',
          projectPath: '/tmp/project',
          teamId: undefined,
          sandboxSetupStatus: 'ready',
          isArchived: false,
          onRestoreWorkspace: undefined,
          editorRef,
          chatModeRef: { current: 'agent' },
          isStreamingRef: { current: false },
          imagesRef: { current: [] },
          filesRef: { current: [] },
          textContextsRef: { current: [] },
          diffTextContextsRef: { current: [] },
          codeSelectionContextRef: { current: null },
          activeFileRef: { current: null },
          activeFileExcludedRef: { current: false },
          pastedTextsRef: { current: [] },
          sendMessageRef,
          scrollToBottom: vi.fn(),
          clearAll,
          clearTextContexts,
          clearDiffTextContexts: vi.fn(),
          clearCodeSelectionContext: vi.fn(),
          clearPastedTexts: vi.fn(),
          addToQueue: vi.fn(),
          isResolvedExecutionAccountReady: true,
        }),
      );

      // Start send — blocks on expandSlashCommand
      const sendPromise = result.current();

      // Simulate pane switch: unmount during the async gap
      unmount();

      // Resolve expandSlashCommand after unmount
      resolveExpand('hello race condition');
      await sendPromise;

      // Message should NOT have been sent to the (now torn-down) chat
      expect(sendMessageMock).not.toHaveBeenCalled();
      // Editor of the (now different) pane should NOT have been cleared
      expect(clearEditor).not.toHaveBeenCalled();
      // Attachment state should NOT have been cleared
      expect(clearAll).not.toHaveBeenCalled();
      expect(clearTextContexts).not.toHaveBeenCalled();
    });

    it('uses snapshotted send function when sendMessageRef mutates during expandSlashCommand', async () => {
      let resolveExpand!: (value: string) => void;
      expandSlashCommandMock.mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveExpand = resolve;
          }),
      );

      const editorRef = createRef<AgentsMentionsEditorHandle | null>();
      editorRef.current = {
        getValue: () => 'hello snapshot',
        clear: vi.fn(),
      } as unknown as AgentsMentionsEditorHandle;

      const originalSend = vi.fn(async () => undefined);
      const replacedSend = vi.fn(async () => undefined);
      const sendMessageRef: { current: typeof sendMessageMock | null } = { current: originalSend };

      const { result } = renderHook(() =>
        useMessageSend({
          subChatId: 'sub-1',
          parentChatId: 'chat-1',
          projectPath: '/tmp/project',
          teamId: undefined,
          sandboxSetupStatus: 'ready',
          isArchived: false,
          onRestoreWorkspace: undefined,
          editorRef,
          chatModeRef: { current: 'agent' },
          isStreamingRef: { current: false },
          imagesRef: { current: [] },
          filesRef: { current: [] },
          textContextsRef: { current: [] },
          diffTextContextsRef: { current: [] },
          codeSelectionContextRef: { current: null },
          activeFileRef: { current: null },
          activeFileExcludedRef: { current: false },
          pastedTextsRef: { current: [] },
          sendMessageRef,
          scrollToBottom: vi.fn(),
          clearAll: vi.fn(),
          clearTextContexts: vi.fn(),
          clearDiffTextContexts: vi.fn(),
          clearCodeSelectionContext: vi.fn(),
          clearPastedTexts: vi.fn(),
          addToQueue: vi.fn(),
          isResolvedExecutionAccountReady: true,
        }),
      );

      // Start send — snapshots originalSend, then blocks on expandSlashCommand
      const sendPromise = result.current();

      // Simulate ref mutation (e.g. re-render with different useChat instance)
      sendMessageRef.current = replacedSend;

      // Resolve expandSlashCommand
      resolveExpand('hello snapshot');
      await sendPromise;

      // The ORIGINAL function should have been called, not the replaced one
      expect(originalSend).toHaveBeenCalledTimes(1);
      expect(replacedSend).not.toHaveBeenCalled();
    });
  });

  describe('routing against a live run', () => {
    afterEach(() => appStore.set(runLiveAtomFamily('sub-1'), false));

    it('queues instead of sending when main still runs the turn but the renderer reads idle', async () => {
      appStore.set(runLiveAtomFamily('sub-1'), true);
      const addToQueue = vi.fn();
      const props = idleComposerProps(addToQueue);
      const { result } = renderHook(() => useMessageSend(props));

      await result.current();

      expect(addToQueue).toHaveBeenCalledTimes(1);
      expect(sendMessageMock).not.toHaveBeenCalled();
    });

    it('still sends after its effects re-run cleanup then setup (hot update, StrictMode)', async () => {
      const props = idleComposerProps();
      const { result } = renderHook(() => useMessageSend(props), { wrapper: StrictMode });

      await result.current();

      expect(sendMessageMock).toHaveBeenCalledTimes(1);
    });
  });
});
