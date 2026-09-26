// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionRequest } from './usePermissionPrompts';
import { usePermissionPrompts } from './usePermissionPrompts';

// Capture listener callbacks registered via window.desktopApi
let onSocketPermissionRequestCb: ((data: Record<string, unknown>) => void) | null = null;
let onPermissionRequestCb: ((data: PermissionRequest) => void) | null = null;
let onAgentRequestMoveChatCb: ((data: Record<string, unknown>) => void) | null = null;
let onPermissionDismissCb: ((data: { requestId: string }) => void) | null = null;
let onSocketPermissionDismissCb: ((data: { requestId: string }) => void) | null = null;

const {
  appStoreGetMock,
  captureExceptionMock,
  listPendingPermissionRequestsQueryMock,
  playSoundMock,
} = vi.hoisted(() => ({
  appStoreGetMock: vi.fn<() => boolean>(() => false),
  captureExceptionMock: vi.fn(),
  listPendingPermissionRequestsQueryMock: vi.fn(),
  playSoundMock: vi.fn(),
}));

vi.mock('@sentry/electron/renderer', () => ({ captureException: captureExceptionMock }));

vi.mock('../lib/utils/platform', () => ({
  isDesktopApp: () => true,
}));

vi.mock('../lib/jotai-store', () => ({
  appStore: { set: vi.fn(), get: appStoreGetMock },
}));

vi.mock('../lib/atoms', () => ({
  soundNotificationsEnabledAtom: { __mock: 'soundNotificationsEnabledAtom' },
}));

vi.mock('../lib/audio/play-chime', () => ({
  playSound: playSoundMock,
}));

vi.mock('../lib/trpc', () => ({
  trpcClient: {
    socket: {
      listPendingPermissionRequests: { query: listPendingPermissionRequestsQueryMock },
    },
  },
}));

const sendSocketPermissionResponse = vi.fn();
const sendPermissionResponse = vi.fn();
const sendAgentMoveChatResponse = vi.fn();

beforeEach(() => {
  onSocketPermissionRequestCb = null;
  onPermissionRequestCb = null;
  onAgentRequestMoveChatCb = null;
  onPermissionDismissCb = null;
  onSocketPermissionDismissCb = null;
  listPendingPermissionRequestsQueryMock.mockReset();
  listPendingPermissionRequestsQueryMock.mockResolvedValue([]);

  // Defaults: sound off + window unfocused so the alert effect is silent for the
  // existing suites; the dedicated alert tests opt in by overriding these.
  appStoreGetMock.mockReturnValue(false);
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);

  Object.defineProperty(window, 'desktopApi', {
    writable: true,
    configurable: true,
    value: {
      onPermissionRequest: (cb: (data: PermissionRequest) => void) => {
        onPermissionRequestCb = cb;
        return () => {
          onPermissionRequestCb = null;
        };
      },
      onSocketPermissionRequest: (cb: (data: Record<string, unknown>) => void) => {
        onSocketPermissionRequestCb = cb;
        return () => {
          onSocketPermissionRequestCb = null;
        };
      },
      onAgentRequestMoveChat: (cb: (data: Record<string, unknown>) => void) => {
        onAgentRequestMoveChatCb = cb;
        return () => {
          onAgentRequestMoveChatCb = null;
        };
      },
      onPermissionDismiss: (cb: (data: { requestId: string }) => void) => {
        onPermissionDismissCb = cb;
        return () => {
          onPermissionDismissCb = null;
        };
      },
      onSocketPermissionDismiss: (cb: (data: { requestId: string }) => void) => {
        onSocketPermissionDismissCb = cb;
        return () => {
          onSocketPermissionDismissCb = null;
        };
      },
      sendSocketPermissionResponse,
      sendPermissionResponse,
      sendAgentMoveChatResponse,
    },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

function makeSocketRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: `req-${Math.random().toString(36).slice(2, 8)}`,
    type: 'bash',
    path: 'echo hello',
    operation: 'bash',
    chatId: 'chat-1',
    subChatId: 'sub-1',
    ...overrides,
  };
}

function injectSocketRequest(overrides: Record<string, unknown> = {}) {
  const data = makeSocketRequest(overrides);
  act(() => {
    onSocketPermissionRequestCb?.(data);
  });
  return data;
}

function injectMoveChatRequest(overrides: Record<string, unknown> = {}) {
  const data = {
    requestId: `move-${Math.random().toString(36).slice(2, 8)}`,
    chatId: 'chat-move-1',
    subChatId: 'sub-move-1',
    projectId: 'project-2',
    projectName: 'Project Two',
    targetChatId: 'chat-target-1',
    targetSubChatId: 'sub-target-1',
    projectPath: '/tmp/project-two',
    requestedWorktreePath: null,
    targetBranch: null,
    ...overrides,
  };
  act(() => {
    onAgentRequestMoveChatCb?.(data);
  });
  return data;
}

/** Socket-borne MCP ask — the only MCP producer post-unification; always carries `prompt`. */
function injectSocketMcpRequest(overrides: Record<string, unknown> = {}) {
  return injectSocketRequest({
    type: 'mcp_tool',
    operation: 'mcp_tool',
    path: '',
    toolName: 'mcp__shortcut-frink__stories-list',
    prompt: {
      tool: 'mcp__shortcut-frink__stories-list',
      input: {},
      reason: 'no-matching-rule',
      suggestedRules: ['mcp__shortcut-frink__stories-list', 'mcp__shortcut-frink__*'],
    },
    ...overrides,
  });
}

describe('usePermissionPrompts', () => {
  describe('renderer reload recovery', () => {
    it('subscribes first and recovers the main-process pending projection', async () => {
      listPendingPermissionRequestsQueryMock.mockResolvedValue([
        makeSocketRequest({ requestId: 'recovered-1' }),
      ]);

      const { result } = renderHook(() => usePermissionPrompts());

      expect(onSocketPermissionRequestCb).not.toBeNull();
      await waitFor(() => expect(result.current.pendingRequests).toHaveLength(1));
      expect(result.current.currentRequest).toMatchObject({
        requestId: 'recovered-1',
        isRemote: true,
      });
    });

    it('recovers a blocking move-chat prompt from the main-process projection', async () => {
      listPendingPermissionRequestsQueryMock.mockResolvedValue([
        {
          requestId: 'recovered-move-1',
          chatId: 'chat-1',
          subChatId: 'sub-1',
          operation: 'move_chat',
          projectId: 'project-2',
          projectName: 'Project two',
          targetChatId: 'chat-1',
          targetSubChatId: 'sub-1',
          projectPath: '/project-two',
          requestedWorktreePath: null,
          targetBranch: 'main',
        },
      ]);

      const { result } = renderHook(() => usePermissionPrompts());

      await waitFor(() => expect(result.current.pendingRequests).toHaveLength(1));
      expect(result.current.currentRequest).toMatchObject({
        requestId: 'recovered-move-1',
        operation: 'move_chat',
        chatId: 'chat-1',
        subChatId: 'sub-1',
        moveChatPayload: {
          projectName: 'Project two',
          projectPath: '/project-two',
          targetBranch: 'main',
        },
      });
    });

    it('deduplicates a push that overlaps the pull snapshot', async () => {
      let resolvePull: (rows: Record<string, unknown>[]) => void = () => {};
      listPendingPermissionRequestsQueryMock.mockReturnValue(
        new Promise<Record<string, unknown>[]>((resolve) => {
          resolvePull = resolve;
        }),
      );
      const row = makeSocketRequest({ requestId: 'overlap-1' });
      const { result } = renderHook(() => usePermissionPrompts());

      act(() => onSocketPermissionRequestCb?.(row));
      await act(async () => resolvePull([row]));

      expect(result.current.pendingRequests.map((request) => request.requestId)).toEqual([
        'overlap-1',
      ]);
    });

    it('does not resurrect a request dismissed while the pull is in flight', async () => {
      let resolvePull: (rows: Record<string, unknown>[]) => void = () => {};
      listPendingPermissionRequestsQueryMock.mockReturnValue(
        new Promise<Record<string, unknown>[]>((resolve) => {
          resolvePull = resolve;
        }),
      );
      const row = makeSocketRequest({ requestId: 'retired-during-pull' });
      const { result } = renderHook(() => usePermissionPrompts());

      act(() => onSocketPermissionDismissCb?.({ requestId: 'retired-during-pull' }));
      await act(async () => resolvePull([row]));

      expect(result.current.pendingRequests).toEqual([]);
    });

    it('retries a transient projection failure exactly once', async () => {
      vi.useFakeTimers();
      try {
        listPendingPermissionRequestsQueryMock
          .mockRejectedValueOnce(new Error('main temporarily unavailable'))
          .mockResolvedValueOnce([makeSocketRequest({ requestId: 'recovered-after-retry' })]);

        const { result, unmount } = renderHook(() => usePermissionPrompts());
        await act(async () => Promise.resolve());
        expect(listPendingPermissionRequestsQueryMock).toHaveBeenCalledTimes(1);
        expect(captureExceptionMock).toHaveBeenCalledTimes(1);

        await act(async () => vi.advanceTimersByTimeAsync(249));
        expect(listPendingPermissionRequestsQueryMock).toHaveBeenCalledTimes(1);
        await act(async () => vi.advanceTimersByTimeAsync(1));

        expect(listPendingPermissionRequestsQueryMock).toHaveBeenCalledTimes(2);
        expect(result.current.pendingRequests).toEqual([
          expect.objectContaining({ requestId: 'recovered-after-retry' }),
        ]);
        unmount();
      } finally {
        vi.useRealTimers();
      }
    });

    it('gives up silently after the single retry also fails', async () => {
      vi.useFakeTimers();
      try {
        listPendingPermissionRequestsQueryMock.mockRejectedValue(
          new Error('main still unavailable'),
        );

        const { unmount } = renderHook(() => usePermissionPrompts());
        await act(async () => Promise.resolve());
        await act(async () => vi.advanceTimersByTimeAsync(250));

        expect(listPendingPermissionRequestsQueryMock).toHaveBeenCalledTimes(2);
        expect(captureExceptionMock).toHaveBeenCalledTimes(1);

        await act(async () => vi.advanceTimersByTimeAsync(10_000));
        expect(listPendingPermissionRequestsQueryMock).toHaveBeenCalledTimes(2);
        unmount();
      } finally {
        vi.useRealTimers();
      }
    });

    it('cancels the projection retry when the listener is disposed', async () => {
      vi.useFakeTimers();
      try {
        listPendingPermissionRequestsQueryMock.mockRejectedValue(new Error('main unavailable'));
        const { unmount } = renderHook(() => usePermissionPrompts());
        await act(async () => Promise.resolve());
        expect(listPendingPermissionRequestsQueryMock).toHaveBeenCalledTimes(1);

        unmount();
        await vi.advanceTimersByTimeAsync(1_000);

        expect(listPendingPermissionRequestsQueryMock).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('removeOrphanedRequests', () => {
    it('does nothing when no chats were removed', () => {
      const { result } = renderHook(() => usePermissionPrompts());

      injectSocketRequest({ chatId: 'chat-1' });
      expect(result.current.pendingRequests).toHaveLength(1);

      act(() => {
        result.current.removeOrphanedRequests(['chat-1', 'chat-2'], ['chat-1', 'chat-2']);
      });

      expect(result.current.pendingRequests).toHaveLength(1);
    });

    it('removes requests whose chatId was in the previous list but not in current (pane closed)', () => {
      const { result } = renderHook(() => usePermissionPrompts());

      injectSocketRequest({ chatId: 'chat-1' });
      injectSocketRequest({ chatId: 'chat-2' });
      expect(result.current.pendingRequests).toHaveLength(2);

      act(() => {
        result.current.removeOrphanedRequests(
          ['chat-2'], // current — chat-1 removed
          ['chat-1', 'chat-2'], // previous
        );
      });

      expect(result.current.pendingRequests).toHaveLength(1);
      expect(result.current.pendingRequests[0].chatId).toBe('chat-2');
    });

    it('does NOT remove a request when its chatId was never in the previous list (race-safe)', () => {
      const { result } = renderHook(() => usePermissionPrompts());

      injectSocketRequest({ chatId: 'chat-new' });
      expect(result.current.pendingRequests).toHaveLength(1);

      // chat-new was never in previous → not a "removed" chat → keep the request
      act(() => {
        result.current.removeOrphanedRequests(['chat-1'], ['chat-1']);
      });

      expect(result.current.pendingRequests).toHaveLength(1);
      expect(result.current.pendingRequests[0].chatId).toBe('chat-new');
    });

    it('auto-denies removed requests via sendSocketPermissionResponse with timedOut flag', () => {
      const { result } = renderHook(() => usePermissionPrompts());

      const req = injectSocketRequest({ chatId: 'chat-1' });

      act(() => {
        result.current.removeOrphanedRequests(
          [], // current — all removed
          ['chat-1'], // previous
        );
      });

      // Pane-close auto-deny must flag timedOut: true so the executor's persistence
      // guard skips writing a phantom project-wide deny row to Neon. Without this,
      // closing a pane mid-prompt creates a permanent block — same class as the
      // 5-min-timeout bug fixed in executor.ts.
      expect(sendSocketPermissionResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: req.requestId,
          approved: false,
          timedOut: true,
        }),
      );
      expect(result.current.pendingRequests).toHaveLength(0);
    });

    it('keeps requests with no chatId (local IPC requests are never orphaned)', () => {
      const { result } = renderHook(() => usePermissionPrompts());

      // Inject a local request (no chatId) via the local IPC listener
      act(() => {
        onPermissionRequestCb?.({
          requestId: 'local-1',
          scope: { type: 'folder', folderId: '' },
          path: '/tmp/foo',
          operation: 'read',
        });
      });

      expect(result.current.pendingRequests).toHaveLength(1);

      act(() => {
        result.current.removeOrphanedRequests([], ['chat-1']);
      });

      // Local request (no chatId) should survive
      expect(result.current.pendingRequests).toHaveLength(1);
      expect(result.current.pendingRequests[0].requestId).toBe('local-1');
    });
  });

  describe('queue navigation', () => {
    it('cycles forward and wraps around', () => {
      const { result } = renderHook(() => usePermissionPrompts());

      injectSocketRequest({ requestId: 'r1', chatId: 'c1' });
      injectSocketRequest({ requestId: 'r2', chatId: 'c2' });
      injectSocketRequest({ requestId: 'r3', chatId: 'c3' });

      expect(result.current.currentRequest?.requestId).toBe('r1');

      act(() => result.current.next());
      expect(result.current.currentRequest?.requestId).toBe('r2');

      act(() => result.current.next());
      expect(result.current.currentRequest?.requestId).toBe('r3');

      act(() => result.current.next());
      expect(result.current.currentRequest?.requestId).toBe('r1');
    });

    it('cycles backward and wraps around', () => {
      const { result } = renderHook(() => usePermissionPrompts());

      injectSocketRequest({ requestId: 'r1', chatId: 'c1' });
      injectSocketRequest({ requestId: 'r2', chatId: 'c2' });

      expect(result.current.currentRequest?.requestId).toBe('r1');

      act(() => result.current.previous());
      expect(result.current.currentRequest?.requestId).toBe('r2');

      act(() => result.current.previous());
      expect(result.current.currentRequest?.requestId).toBe('r1');
    });
  });

  describe('deduplication', () => {
    it('ignores duplicate requestIds', () => {
      const { result } = renderHook(() => usePermissionPrompts());

      injectSocketRequest({ requestId: 'dup-1', chatId: 'c1' });
      injectSocketRequest({ requestId: 'dup-1', chatId: 'c1' });

      expect(result.current.pendingRequests).toHaveLength(1);
    });

    it('ignores duplicate move-chat requestIds', () => {
      const { result } = renderHook(() => usePermissionPrompts());

      injectMoveChatRequest({ requestId: 'move-dup', chatId: 'c1' });
      injectMoveChatRequest({ requestId: 'move-dup', chatId: 'c1' });

      expect(result.current.pendingRequests).toHaveLength(1);
    });

    it('dedupes duplicate request ids even when coming from different channels', () => {
      const { result } = renderHook(() => usePermissionPrompts());

      injectMoveChatRequest({ requestId: 'shared-1' });
      injectSocketRequest({ requestId: 'shared-1', type: 'bash', operation: 'bash' });

      expect(result.current.pendingRequests).toHaveLength(1);
    });
  });

  describe('move-chat responses', () => {
    it('keeps permission request anchored to source chat pane', () => {
      const { result } = renderHook(() => usePermissionPrompts());
      const move = injectMoveChatRequest({
        requestId: 'move-source-pane',
        chatId: 'source-chat-1',
        targetChatId: 'target-chat-2',
      });

      const request = result.current.pendingRequests.find((r) => r.requestId === move.requestId);
      expect(request).toBeTruthy();
      // TDD expectation: prompt should remain attached to source pane owner, not target chat.
      expect(request?.chatId).toBe('source-chat-1');
      expect(request?.moveChatPayload?.targetChatId).toBe('target-chat-2');
      expect(request?.moveChatPayload?.projectPath).toBe('/tmp/project-two');
      expect(request?.moveChatPayload?.requestedWorktreePath).toBeNull();
      expect(request?.moveChatPayload?.targetBranch).toBeNull();
    });

    it('preserves destination path metadata on moveChatPayload', () => {
      const { result } = renderHook(() => usePermissionPrompts());
      const move = injectMoveChatRequest({
        requestId: 'move-meta-1',
        projectPath: '/abs/proj',
        requestedWorktreePath: '/abs/proj/wt-a',
        targetBranch: 'feature/x',
      });
      const request = result.current.pendingRequests.find((r) => r.requestId === move.requestId);
      expect(request?.moveChatPayload?.projectPath).toBe('/abs/proj');
      expect(request?.moveChatPayload?.requestedWorktreePath).toBe('/abs/proj/wt-a');
      expect(request?.moveChatPayload?.targetBranch).toBe('feature/x');
    });

    it('approves move-chat request and removes it from queue', () => {
      const { result } = renderHook(() => usePermissionPrompts());
      const move = injectMoveChatRequest({ requestId: 'move-approve-1' });

      expect(result.current.pendingRequests).toHaveLength(1);
      act(() => {
        result.current.approve(move.requestId);
      });

      expect(sendAgentMoveChatResponse).toHaveBeenCalledWith('move-approve-1', true);
      expect(result.current.pendingRequests).toHaveLength(0);
    });

    it('denies move-chat request and removes it from queue', () => {
      const { result } = renderHook(() => usePermissionPrompts());
      const move = injectMoveChatRequest({ requestId: 'move-deny-1' });

      act(() => {
        result.current.deny(move.requestId);
      });

      expect(sendAgentMoveChatResponse).toHaveBeenCalledWith('move-deny-1', false);
      expect(result.current.pendingRequests).toHaveLength(0);
    });

    it('preserves request ordering between move-chat and socket permissions', () => {
      const { result } = renderHook(() => usePermissionPrompts());

      injectMoveChatRequest({ requestId: 'move-first' });
      injectSocketRequest({ requestId: 'socket-second', chatId: 'chat-2' });

      expect(result.current.currentRequest?.requestId).toBe('move-first');
      act(() => {
        result.current.next();
      });
      expect(result.current.currentRequest?.requestId).toBe('socket-second');
    });

    it('does not orphan-clean move-chat requests (no chatId attached to queue entry)', () => {
      const { result } = renderHook(() => usePermissionPrompts());
      const move = injectMoveChatRequest({ requestId: 'move-orphan', chatId: 'chat-x' });

      act(() => {
        result.current.removeOrphanedRequests([], ['chat-x']);
      });

      expect(sendAgentMoveChatResponse).not.toHaveBeenCalledWith(move.requestId, false);
      expect(result.current.pendingRequests).toHaveLength(1);
    });
  });

  describe('per-flow agent-run consent', () => {
    function injectFlowConsentRequest(overrides: Record<string, unknown> = {}) {
      return injectSocketRequest({
        requestId: 'flow-consent-1',
        chatId: 'chat-1',
        subChatId: 'sub-1',
        type: 'flow_consent',
        operation: 'flow_consent',
        path: 'flow-abc',
        flowConsent: {
          flowId: 'flow-abc',
          flowName: 'Nightly digest',
          summary: { nodeCount: 2, blockTypes: ['agent'], unsandboxedBlockTypes: [] },
          allowOnce: true,
        },
        ...overrides,
      });
    }

    it('threads the flow-consent payload through to the queued request', () => {
      const { result } = renderHook(() => usePermissionPrompts());
      injectFlowConsentRequest();

      const queued = result.current.pendingRequests[0];
      expect(queued.operation).toBe('flow_consent');
      expect(queued.flowConsent?.flowName).toBe('Nightly digest');
    });

    it('forwards flowGrant on the socket response', () => {
      // This field crosses hops that type the payload without it and survive
      // only because the object is forwarded whole. Losing it would silently
      // downgrade "Always allow this Flow" to a one-call approval.
      const { result } = renderHook(() => usePermissionPrompts());
      const request = injectFlowConsentRequest();

      act(() => {
        result.current.approve(request.requestId as string, { flowGrant: true });
      });

      expect(sendSocketPermissionResponse).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 'flow-consent-1', approved: true, flowGrant: true }),
      );
    });

    it('sends no flowGrant for a one-call approval', () => {
      const { result } = renderHook(() => usePermissionPrompts());
      const request = injectFlowConsentRequest();

      act(() => {
        result.current.approve(request.requestId as string);
      });

      expect(sendSocketPermissionResponse).toHaveBeenCalledWith(
        expect.objectContaining({ approved: true, flowGrant: undefined }),
      );
    });

    it('sends a denial with no grant attached', () => {
      const { result } = renderHook(() => usePermissionPrompts());
      const request = injectFlowConsentRequest();

      act(() => {
        result.current.deny(request.requestId as string);
      });

      expect(sendSocketPermissionResponse).toHaveBeenCalledWith(
        expect.objectContaining({ approved: false, flowGrant: undefined }),
      );
    });
  });

  describe('response channels and interleaving', () => {
    it('routes an MCP ask approval to the socket channel like any other v2 prompt', () => {
      const { result } = renderHook(() => usePermissionPrompts());
      const request = injectSocketMcpRequest({ requestId: 'mcp-socket-1' });

      act(() => {
        result.current.approve(request.requestId as string);
      });

      expect(sendSocketPermissionResponse).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 'mcp-socket-1', approved: true }),
      );
      expect(sendPermissionResponse).not.toHaveBeenCalled();
    });

    it('routes remote socket permission to sendSocketPermissionResponse', () => {
      const { result } = renderHook(() => usePermissionPrompts());
      const request = injectSocketRequest({
        requestId: 'socket-approve-1',
        chatId: 'chat-1',
        subChatId: 'sub-1',
        type: 'bash',
        operation: 'bash',
      });

      act(() => {
        result.current.approve(request.requestId as string);
      });

      expect(sendSocketPermissionResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'socket-approve-1',
          approved: true,
          chatId: 'chat-1',
          subChatId: 'sub-1',
        }),
      );
    });

    it('routes local file permission responses to sendPermissionResponse', () => {
      const { result } = renderHook(() => usePermissionPrompts());
      act(() => {
        onPermissionRequestCb?.({
          requestId: 'local-read-1',
          scope: { type: 'folder', folderId: 'f1' },
          path: '/tmp/foo.ts',
          operation: 'read',
        });
      });

      act(() => {
        result.current.approve('local-read-1', {
          scope: 'project',
          ruleString: 'Read(/tmp/foo.ts)',
          ruleType: 'allow',
        });
      });

      // Local IPC path forwards the v2 response fields directly. No
      // duration/time-bound translation — v2 has no rule expiry.
      expect(sendPermissionResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'local-read-1',
          approved: true,
          scope: 'project',
          ruleString: 'Read(/tmp/foo.ts)',
          ruleType: 'allow',
        }),
      );
    });

    it('preserves queue order when move + mcp + socket requests are interleaved', () => {
      const { result } = renderHook(() => usePermissionPrompts());
      injectMoveChatRequest({ requestId: 'move-1' });
      injectSocketMcpRequest({ requestId: 'mcp-2' });
      injectSocketRequest({ requestId: 'socket-3', type: 'bash', operation: 'bash' });

      expect(result.current.currentRequest?.requestId).toBe('move-1');
      act(() => result.current.next());
      expect(result.current.currentRequest?.requestId).toBe('mcp-2');
      act(() => result.current.next());
      expect(result.current.currentRequest?.requestId).toBe('socket-3');
    });
  });

  describe('socket payload → prompt threading', () => {
    it('threads PromptData through for Bash socket payloads (regression for latent SimpleApprovalView fallthrough)', () => {
      const { result } = renderHook(() => usePermissionPrompts());

      const promptData = {
        tool: 'Bash',
        input: { command: 'npm install' },
        reason: 'no-matching-rule' as const,
        suggestedRules: ['Bash(npm install:*)', 'Bash(npm:*)'],
      };
      injectSocketRequest({
        requestId: 'bash-with-prompt',
        type: 'bash',
        operation: 'bash',
        path: 'npm install',
        prompt: promptData,
      });

      const request = result.current.pendingRequests[0];
      expect(request?.prompt).toEqual(promptData);
    });

    it('threads PromptData through for MCP socket payloads', () => {
      const { result } = renderHook(() => usePermissionPrompts());

      const promptData = {
        tool: 'mcp__shortcut-frink__stories-list',
        input: {},
        reason: 'no-matching-rule' as const,
        suggestedRules: ['mcp__shortcut-frink__stories-list', 'mcp__shortcut-frink__*'],
      };
      injectSocketRequest({
        requestId: 'mcp-with-prompt',
        type: 'mcp_tool',
        operation: 'mcp_tool',
        path: '',
        toolName: 'mcp__shortcut-frink__stories-list',
        prompt: promptData,
      });

      const request = result.current.pendingRequests[0];
      expect(request?.prompt).toEqual(promptData);
      expect(request?.mcpToolPayload?.toolName).toBe('mcp__shortcut-frink__stories-list');
    });

    it('leaves prompt undefined when the socket payload omits it (frink-internal flows)', () => {
      const { result } = renderHook(() => usePermissionPrompts());
      injectSocketRequest({ requestId: 'no-prompt', type: 'bash', operation: 'bash' });
      expect(result.current.pendingRequests[0]?.prompt).toBeUndefined();
    });
  });

  // When the main process times a request out it pops the card from the renderer
  // queue. Without this, a re-request (which gets a fresh requestId) stacks a
  // second card and they pile up.
  describe('dismiss on timeout', () => {
    it('pops a socket prompt when the socket dismiss fires (executor timeout)', () => {
      const { result } = renderHook(() => usePermissionPrompts());
      const req = injectSocketRequest({ requestId: 'socket-timeout-1' });
      expect(result.current.pendingRequests).toHaveLength(1);

      act(() => onSocketPermissionDismissCb?.({ requestId: req.requestId as string }));

      expect(result.current.pendingRequests).toHaveLength(0);
    });

    it('pops a local-IPC prompt when the local dismiss fires (move-chat/proxy timeout)', () => {
      const { result } = renderHook(() => usePermissionPrompts());
      const req = injectMoveChatRequest({ requestId: 'move-timeout-1' });
      expect(result.current.pendingRequests).toHaveLength(1);

      act(() => onPermissionDismissCb?.({ requestId: req.requestId as string }));

      expect(result.current.pendingRequests).toHaveLength(0);
    });

    it('re-clamps currentIndex when the displayed card is dismissed mid-queue', () => {
      const { result } = renderHook(() => usePermissionPrompts());
      injectSocketRequest({ requestId: 'r1', chatId: 'c1' });
      injectSocketRequest({ requestId: 'r2', chatId: 'c2' });
      injectSocketRequest({ requestId: 'r3', chatId: 'c3' });

      // Move to the last card, then dismiss it — index must clamp back into range.
      act(() => result.current.next());
      act(() => result.current.next());
      expect(result.current.currentRequest?.requestId).toBe('r3');

      act(() => onSocketPermissionDismissCb?.({ requestId: 'r3' }));

      expect(result.current.pendingRequests).toHaveLength(2);
      expect(result.current.currentRequest).not.toBeNull();
      expect(['r1', 'r2']).toContain(result.current.currentRequest?.requestId);
    });

    it('is a no-op when dismissing an unknown / already-removed requestId', () => {
      const { result } = renderHook(() => usePermissionPrompts());
      injectSocketRequest({ requestId: 'still-here', chatId: 'c1' });

      act(() => onSocketPermissionDismissCb?.({ requestId: 'never-existed' }));

      expect(result.current.pendingRequests).toHaveLength(1);
      expect(result.current.pendingRequests[0].requestId).toBe('still-here');
    });
  });

  // A backgrounded permission prompt is silent today; this plays a distinct alert so an
  // away user knows the agent has stalled waiting on them.
  describe('permission alert sound', () => {
    it('plays the alert for a new socket request while away with sound enabled', () => {
      appStoreGetMock.mockReturnValue(true);
      renderHook(() => usePermissionPrompts());

      injectSocketRequest({ requestId: 'alert-1' });

      expect(playSoundMock).toHaveBeenCalledTimes(1);
      expect(playSoundMock).toHaveBeenCalledWith('needsYou');
    });

    it('plays the alert for a new local-IPC request while away (acceptance criterion)', () => {
      appStoreGetMock.mockReturnValue(true);
      renderHook(() => usePermissionPrompts());

      act(() => {
        onPermissionRequestCb?.({
          requestId: 'local-alert-1',
          scope: { type: 'folder', folderId: '' },
          path: '/tmp/x.ts',
          operation: 'read',
        });
      });

      expect(playSoundMock).toHaveBeenCalledTimes(1);
    });

    it('alerts for any blocking prompt the agent raises (e.g. mcp_tool), not only file/bash', () => {
      // Deliberate scope decision: every queue entry is "agent stalled waiting on you", so the
      // single trigger fires for all producers rather than gating by operation.
      appStoreGetMock.mockReturnValue(true);
      renderHook(() => usePermissionPrompts());

      injectSocketMcpRequest({ requestId: 'mcp-alert-1' });

      expect(playSoundMock).toHaveBeenCalledTimes(1);
    });

    it('stays silent when the window is focused', () => {
      appStoreGetMock.mockReturnValue(true);
      vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      renderHook(() => usePermissionPrompts());

      injectSocketRequest({ requestId: 'focused-1' });

      expect(playSoundMock).not.toHaveBeenCalled();
    });

    it('stays silent when sound notifications are disabled', () => {
      appStoreGetMock.mockReturnValue(false);
      renderHook(() => usePermissionPrompts());

      injectSocketRequest({ requestId: 'muted-1' });

      expect(playSoundMock).not.toHaveBeenCalled();
    });

    it('fires once per request, not again while cycling the existing queue', () => {
      appStoreGetMock.mockReturnValue(true);
      const { result } = renderHook(() => usePermissionPrompts());

      injectSocketRequest({ requestId: 'once-1', chatId: 'c1' });
      injectSocketRequest({ requestId: 'once-2', chatId: 'c2' });
      expect(playSoundMock).toHaveBeenCalledTimes(2);

      // Cycling re-renders the hook but adds no new request id → no extra sound.
      act(() => result.current.next());
      act(() => result.current.previous());
      expect(playSoundMock).toHaveBeenCalledTimes(2);
    });

    it('does not re-alert a duplicate requestId', () => {
      appStoreGetMock.mockReturnValue(true);
      renderHook(() => usePermissionPrompts());

      injectSocketRequest({ requestId: 'dup-alert', chatId: 'c1' });
      injectSocketRequest({ requestId: 'dup-alert', chatId: 'c1' });

      expect(playSoundMock).toHaveBeenCalledTimes(1);
    });
  });
});
