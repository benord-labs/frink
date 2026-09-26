// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appStore } from '../../../../../lib/jotai-store';
import { pendingChatRetryAtomFamily, taskExecutionErrorAtomFamily } from '../../../atoms';
import { detectExternalSideEffects } from '../../../lib/detect-external-side-effects';
import type { AgentsMentionsEditorHandle } from '../../../mentions/agents-mentions-editor';
import {
  perSubChatMainMessageIdsAtomFamily,
  setRollbackFilter,
} from '../../../stores/message-store';
import { useRollback } from './useRollback';

const SIDE_EFFECTS = [
  { tool: 'tool-mcp__shortcut__stories-update', label: 'shortcut: Stories Update' },
];

const mutateMock = vi.fn().mockResolvedValue({ success: false, error: 'noop' });

vi.mock('../../../../../lib/trpc', () => ({
  trpcClient: {
    chats: {
      rollbackToMessage: {
        mutate: (...args: unknown[]) => mutateMock(...args),
      },
    },
  },
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), warning: vi.fn() },
}));

vi.mock('../../../stores/message-store', () => ({
  clearPrependedForSubChat: vi.fn(),
  setRollbackFilter: vi.fn(),
  syncMessagesWithStatusAtom: Symbol('syncMessagesWithStatusAtom'),
  perSubChatMainMessageIdsAtomFamily: vi.fn(() => Symbol('perSubChatMainMessageIds')),
  perSubChatMessageIdsAtomFamily: vi.fn(() => Symbol('perSubChatMessageIds')),
}));

vi.mock('../../../lib/detect-external-side-effects', () => ({
  detectExternalSideEffects: vi.fn(() => []),
}));

vi.mock('../../../atoms', () => ({
  pendingChatRetryAtomFamily: vi.fn((sub: string) => Symbol(`pendingChatRetry:${sub}`)),
  taskExecutionErrorAtomFamily: vi.fn((sub: string) => Symbol(`taskExecutionError:${sub}`)),
}));

vi.mock('../../../../../lib/jotai-store', () => ({
  appStore: {
    get: vi.fn(() => [] as string[]),
    set: vi.fn(),
  },
}));

function makeEditorRef(setValue = vi.fn(), focus = vi.fn()) {
  const ref = createRef<AgentsMentionsEditorHandle>();
  (ref as { current: Partial<AgentsMentionsEditorHandle> }).current = {
    setValue,
    focus,
  } as unknown as AgentsMentionsEditorHandle;
  return { ref, setValue, focus };
}

describe('useRollback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no external writes in range → rollback proceeds without a confirm.
    // (clearAllMocks keeps any prior mockReturnValue, so reset it explicitly here.)
    vi.mocked(detectExternalSideEffects).mockReturnValue([]);
    mutateMock.mockResolvedValue({ success: false, error: 'noop' });
  });

  it('keeps handleRollback identity when setMessages and recomputeChangedFiles are replaced each render', () => {
    const setMessagesA = vi.fn();
    const recomputeA = vi.fn();
    const setMessagesB = vi.fn();
    const recomputeB = vi.fn();
    const editorRef = createRef<AgentsMentionsEditorHandle>();

    const { result, rerender } = renderHook(
      ({
        setMessages,
        recomputeChangedFiles,
      }: {
        setMessages: (m: unknown[]) => void;
        recomputeChangedFiles: (m: unknown[]) => void;
      }) =>
        useRollback({
          subChatId: 'sub-1',
          isStreaming: false,
          setMessages,
          recomputeChangedFiles,
          editorRef,
        }),
      {
        initialProps: {
          setMessages: setMessagesA,
          recomputeChangedFiles: recomputeA,
        },
      },
    );

    const first = result.current.handleRollback;
    expect(typeof first).toBe('function');

    rerender({
      setMessages: setMessagesB,
      recomputeChangedFiles: recomputeB,
    });

    expect(result.current.handleRollback).toBe(first);
  });

  it('sends userMessageId (not sdkMessageUuid) to the backend mutation', async () => {
    mutateMock.mockResolvedValue({ success: true, messages: [], gitReverted: false });
    const { ref } = makeEditorRef();

    const { result } = renderHook(() =>
      useRollback({
        subChatId: 'sub-1',
        isStreaming: false,
        setMessages: vi.fn(),
        recomputeChangedFiles: vi.fn(),
        editorRef: ref,
      }),
    );

    await act(() => result.current.handleRollback('user-msg-42', 'hello world', 'chat'));

    expect(mutateMock).toHaveBeenCalledWith({
      subChatId: 'sub-1',
      userMessageId: 'user-msg-42',
      mode: 'chat',
    });
    expect(mutateMock.mock.calls[0][0]).not.toHaveProperty('sdkMessageUuid');
  });

  it('populates editor with user text content after successful rollback', async () => {
    mutateMock.mockResolvedValue({ success: true, messages: [], gitReverted: false });
    const { ref, setValue, focus } = makeEditorRef();

    const { result } = renderHook(() =>
      useRollback({
        subChatId: 'sub-1',
        isStreaming: false,
        setMessages: vi.fn(),
        recomputeChangedFiles: vi.fn(),
        editorRef: ref,
      }),
    );

    await act(() => result.current.handleRollback('user-1', 'my original message', 'chat'));

    expect(setValue).toHaveBeenCalledWith('my original message');
    expect(focus).toHaveBeenCalled();
  });

  it('does not populate editor when user text content is empty (image-only message)', async () => {
    mutateMock.mockResolvedValue({ success: true, messages: [], gitReverted: false });
    const { ref, setValue, focus } = makeEditorRef();

    const { result } = renderHook(() =>
      useRollback({
        subChatId: 'sub-1',
        isStreaming: false,
        setMessages: vi.fn(),
        recomputeChangedFiles: vi.fn(),
        editorRef: ref,
      }),
    );

    await act(() => result.current.handleRollback('user-1', '', 'chat'));

    expect(setValue).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });

  it('sets rollback filter with the ids that disappear from the main id list', async () => {
    // Before rollback, main has [u1, a1, u2, a2]. Backend returns [u1, a1].
    // The filter must be populated with the dropped ids so future stale syncs
    // (from useChat's internal cache) cannot re-introduce u2/a2 into the UI
    // or the agent's history payload.
    const sub = 'sub-set-filter';
    vi.mocked(appStore.get).mockReturnValue(['u1', 'a1', 'u2', 'a2']);
    mutateMock.mockResolvedValue({
      success: true,
      messages: [
        { id: 'u1', role: 'user' },
        { id: 'a1', role: 'assistant' },
      ],
      gitReverted: false,
    });

    const { ref } = makeEditorRef();

    const { result } = renderHook(() =>
      useRollback({
        subChatId: sub,
        isStreaming: false,
        setMessages: vi.fn(),
        recomputeChangedFiles: vi.fn(),
        editorRef: ref,
      }),
    );

    await act(() => result.current.handleRollback('u2', 'edit me', 'chat'));

    expect(perSubChatMainMessageIdsAtomFamily).toHaveBeenCalledWith(sub);
    expect(setRollbackFilter).toHaveBeenCalledTimes(1);
    expect(setRollbackFilter).toHaveBeenCalledWith(sub, ['u2', 'a2']);
  });

  it('writes the synced messages directly to Jotai BEFORE calling setMessages (so the filter is in place before MSM stale re-syncs)', async () => {
    // Order matters: setRollbackFilter -> appStore.set(syncMessagesWithStatusAtom) -> setMessages.
    // If setMessages fires first, useChat triggers MessageSyncManager with stale messages
    // before the filter exists, and rolled-back ids leak back into the UI.
    const sub = 'sub-order';
    vi.mocked(appStore.get).mockReturnValue(['u1', 'u2']);
    const result = [{ id: 'u1', role: 'user' }];
    mutateMock.mockResolvedValue({ success: true, messages: result, gitReverted: false });

    const setMessages = vi.fn();
    const { ref } = makeEditorRef();
    const { result: hookResult } = renderHook(() =>
      useRollback({
        subChatId: sub,
        isStreaming: false,
        setMessages,
        recomputeChangedFiles: vi.fn(),
        editorRef: ref,
      }),
    );

    await act(() => hookResult.current.handleRollback('u2', 'edit me', 'chat'));

    const setOrder = vi.mocked(appStore.set).mock.invocationCallOrder.map((order, i) => ({
      order,
      atom: vi.mocked(appStore.set).mock.calls[i]?.[0],
    }));
    const syncCallOrder = setOrder.find((e) =>
      String(e.atom).includes('syncMessagesWithStatusAtom'),
    )?.order;
    const setMessagesOrder = setMessages.mock.invocationCallOrder[0];
    const filterCallOrder = vi.mocked(setRollbackFilter).mock.invocationCallOrder[0];

    expect(filterCallOrder).toBeLessThan(syncCallOrder ?? Infinity);
    expect(syncCallOrder ?? Infinity).toBeLessThan(setMessagesOrder ?? Infinity);

    const syncCallArgs = vi
      .mocked(appStore.set)
      .mock.calls.find(([atom]) => String(atom).includes('syncMessagesWithStatusAtom'))?.[1];
    expect(syncCallArgs).toMatchObject({
      messages: result,
      status: 'ready',
      subChatId: sub,
      isActive: true,
    });
  });

  it('clears stale taskExecutionError and pendingChatRetry on successful rollback', async () => {
    const sub = 'sub-clear-stale';
    vi.mocked(appStore.get).mockReturnValue(['u1']);
    mutateMock.mockResolvedValue({ success: true, messages: [], gitReverted: false });

    const { ref } = makeEditorRef();
    const { result } = renderHook(() =>
      useRollback({
        subChatId: sub,
        isStreaming: false,
        setMessages: vi.fn(),
        recomputeChangedFiles: vi.fn(),
        editorRef: ref,
      }),
    );

    await act(() => result.current.handleRollback('u1', 'text', 'chat'));

    expect(taskExecutionErrorAtomFamily).toHaveBeenCalledWith(sub);
    expect(pendingChatRetryAtomFamily).toHaveBeenCalledWith(sub);

    const setCalls = vi.mocked(appStore.set).mock.calls.map(([atom, value]) => ({
      atomKey: String(atom),
      value,
    }));
    expect(
      setCalls.some((c) => c.atomKey.includes('taskExecutionError:') && c.value === null),
    ).toBe(true);
    expect(setCalls.some((c) => c.atomKey.includes('pendingChatRetry:') && c.value === null)).toBe(
      true,
    );
  });

  it('does NOT clear taskExecutionError or pendingChatRetry on failed rollback', async () => {
    const sub = 'sub-no-clear-on-fail';
    vi.mocked(appStore.get).mockReturnValue(['u1']);
    mutateMock.mockResolvedValue({ success: false, error: 'Sub-chat not found' });

    const { ref } = makeEditorRef();
    const { result } = renderHook(() =>
      useRollback({
        subChatId: sub,
        isStreaming: false,
        setMessages: vi.fn(),
        recomputeChangedFiles: vi.fn(),
        editorRef: ref,
      }),
    );

    await act(() => result.current.handleRollback('u1', 'text', 'chat'));

    const setCalls = vi.mocked(appStore.set).mock.calls.map(([atom, value]) => ({
      atomKey: String(atom),
      value,
    }));
    expect(
      setCalls.some((c) => c.atomKey.includes('taskExecutionError:') && c.value === null),
    ).toBe(false);
    expect(setCalls.some((c) => c.atomKey.includes('pendingChatRetry:') && c.value === null)).toBe(
      false,
    );
  });

  it('does not populate editor on failed rollback', async () => {
    mutateMock.mockResolvedValue({ success: false, error: 'Sub-chat not found' });
    const { ref, setValue } = makeEditorRef();

    const { result } = renderHook(() =>
      useRollback({
        subChatId: 'sub-1',
        isStreaming: false,
        setMessages: vi.fn(),
        recomputeChangedFiles: vi.fn(),
        editorRef: ref,
      }),
    );

    await act(() => result.current.handleRollback('user-1', 'my text', 'chat'));

    expect(setValue).not.toHaveBeenCalled();
  });

  it('defers the rollback behind a confirm when external side effects are detected', async () => {
    vi.mocked(detectExternalSideEffects).mockReturnValue(SIDE_EFFECTS);
    mutateMock.mockResolvedValue({ success: true, messages: [], gitReverted: false });
    const { ref } = makeEditorRef();

    const { result } = renderHook(() =>
      useRollback({
        subChatId: 'sub-1',
        isStreaming: false,
        setMessages: vi.fn(),
        recomputeChangedFiles: vi.fn(),
        editorRef: ref,
      }),
    );

    await act(() => result.current.handleRollback('u1', 'edit me', 'chat'));

    // Mutation must NOT fire until the user confirms.
    expect(mutateMock).not.toHaveBeenCalled();
    expect(result.current.rollbackConfirm?.effects).toEqual(SIDE_EFFECTS);
  });

  it('runs the rollback when the confirm is accepted', async () => {
    vi.mocked(detectExternalSideEffects).mockReturnValue(SIDE_EFFECTS);
    mutateMock.mockResolvedValue({ success: true, messages: [], gitReverted: false });
    const { ref } = makeEditorRef();

    const { result } = renderHook(() =>
      useRollback({
        subChatId: 'sub-1',
        isStreaming: false,
        setMessages: vi.fn(),
        recomputeChangedFiles: vi.fn(),
        editorRef: ref,
      }),
    );

    await act(() => result.current.handleRollback('u1', 'edit me', 'chat'));
    const confirm = result.current.rollbackConfirm;

    await act(async () => {
      confirm?.onConfirm();
    });

    expect(mutateMock).toHaveBeenCalledWith({
      subChatId: 'sub-1',
      userMessageId: 'u1',
      mode: 'chat',
    });
    expect(result.current.rollbackConfirm).toBeNull();
  });

  it('aborts a deferred rollback if streaming started while the confirm was open', async () => {
    // Regression guard: handleRollback checks isStreaming at entry, but the confirm dialog
    // defers execution. A flow continuation can begin streaming meanwhile — proceed() must
    // re-check and refuse, or it would truncate history + revert git mid-stream.
    vi.mocked(detectExternalSideEffects).mockReturnValue(SIDE_EFFECTS);
    const { ref } = makeEditorRef();

    const { result, rerender } = renderHook(
      ({ isStreaming }: { isStreaming: boolean }) =>
        useRollback({
          subChatId: 'sub-1',
          isStreaming,
          setMessages: vi.fn(),
          recomputeChangedFiles: vi.fn(),
          editorRef: ref,
        }),
      { initialProps: { isStreaming: false } },
    );

    await act(() => result.current.handleRollback('u1', 'edit me', 'chat'));
    const confirm = result.current.rollbackConfirm;
    expect(confirm).not.toBeNull();

    // Streaming begins while the confirm dialog is open.
    rerender({ isStreaming: true });

    await act(async () => {
      confirm?.onConfirm();
    });

    expect(mutateMock).not.toHaveBeenCalled();
  });

  it('dismissRollbackConfirm clears the pending confirm without rolling back', async () => {
    vi.mocked(detectExternalSideEffects).mockReturnValue(SIDE_EFFECTS);
    const { ref } = makeEditorRef();

    const { result } = renderHook(() =>
      useRollback({
        subChatId: 'sub-1',
        isStreaming: false,
        setMessages: vi.fn(),
        recomputeChangedFiles: vi.fn(),
        editorRef: ref,
      }),
    );

    await act(() => result.current.handleRollback('u1', 'edit me', 'chat'));
    expect(result.current.rollbackConfirm).not.toBeNull();

    act(() => {
      result.current.dismissRollbackConfirm();
    });

    expect(result.current.rollbackConfirm).toBeNull();
    expect(mutateMock).not.toHaveBeenCalled();
  });
});
