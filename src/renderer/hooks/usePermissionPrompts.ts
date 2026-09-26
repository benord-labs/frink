/* eslint-disable max-lines, max-lines-per-function */
/**
 * Hook to manage permission prompts from main process
 * Listens for TWO distinct permission flows:
 *
 * 1. LOCAL IPC flow (`permission:request`) - TODO(6.9-local-execution):
 *    - From proxy.ts → claudeRouter.chat (currently NOT used)
 *    - Will be activated for Phase 6.9 local-only execution mode
 *
 * 2. SOCKET flow (`socket:permission-request`) - CURRENTLY ACTIVE:
 *    - From executor.ts → socket server → renderer
 *    - All current execution uses this path
 *    - User approves/denies in UI, response via socket:permission-response
 */

import * as Sentry from '@sentry/electron/renderer';
import { atom } from 'jotai';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PermissionOperation, PermissionScope } from '../../shared/types/execution';
import type { FlowConsentPromptData } from '../../shared/types/flows/flow-consent';
import type {
  PendingMoveChatProjection,
  PendingPermissionProjection,
  PromptData,
  RuleType,
  SocketPermissionProjection,
} from '../../shared/types/permissions';
import { soundNotificationsEnabledAtom } from '../lib/atoms';
import { shouldAlertOnPermissionRequest } from '../lib/audio/permission-alert-sound';
import { playSound } from '../lib/audio/play-chime';
import { appStore } from '../lib/jotai-store';
import { rememberBounded } from '../lib/utils/bounded-set';
import { isDesktopApp } from '../lib/utils/platform';

const PERMISSION_REHYDRATE_RETRY_MS = 250;

/**
 * Atom holding the chatId of the currently displayed permission request.
 * Written by usePermissionPrompts; read by SplitViewContainer to highlight
 * the pane that owns the active permission request.
 */
export const permissionRequestChatIdAtom = atom<string | null>(null);

// Extended scope type to include bash
type ExtendedScope = PermissionScope | { type: 'bash' };
type ExtendedOperation = PermissionOperation | 'bash';

/** Payload for move-chat approval (navigation after user approves) */
type MoveChatPayload = {
  targetChatId: string;
  targetSubChatId: string;
  projectName: string;
  prompt: string;
  /** Mirrors {@link MoveChatRequest} for downstream navigation / UI. */
  projectPath: string;
  requestedWorktreePath: string | null;
  targetBranch: string | null;
};

/** IPC payload when main sends agent:request-move-chat */
type MoveChatRequest = Omit<PendingMoveChatProjection, 'operation'>;

/** Payload when operation === 'mcp_tool' — display metadata for the four-button MCP prompt. */
type McpToolRequestPayload = {
  toolName: string;
  summary: string;
};

export type PermissionRequest = {
  requestId: string;
  scope: ExtendedScope;
  path: string; // For bash, this is the command string; for move_chat, project name; for mcp_tool, summary; for file ops, trigger path
  operation: ExtendedOperation | 'move_chat' | 'mcp_tool' | 'flow_consent';
  reason?: string;
  taskId?: string;
  projectPath?: string;
  /** Project name for file ops — "Allow read for [projectName]?" */
  projectName?: string;
  /** v2 dispatcher prompt context — drives the four-button view. Undefined for
   *  frink-internal flows (move-chat, frink-internal MCP) which use the 2-button view. */
  prompt?: PromptData;
  // Socket-specific fields for remote permission requests
  isRemote?: boolean;
  chatId?: string;
  subChatId?: string;
  /** Set when operation === 'move_chat' */
  moveChatPayload?: MoveChatPayload;
  /** Set when operation === 'mcp_tool' */
  mcpToolPayload?: McpToolRequestPayload;
  /** Set when operation === 'flow_consent' — drives the per-flow agent-run card. */
  flowConsent?: FlowConsentPromptData;
};

function fromSocketPermissionRequest(data: SocketPermissionProjection): PermissionRequest {
  const scopeForType: ExtendedScope =
    data.type === 'bash' ? { type: 'bash' } : { type: 'folder', folderId: '' };
  const operation = data.type === 'mcp_tool' ? ('mcp_tool' as const) : data.operation;
  return {
    flowConsent: data.flowConsent,
    requestId: data.requestId,
    scope: scopeForType,
    path: data.path,
    operation,
    reason: data.reason,
    isRemote: true,
    chatId: data.chatId,
    subChatId: data.subChatId,
    mcpToolPayload:
      data.type === 'mcp_tool'
        ? { toolName: data.toolName ?? 'MCP tool', summary: data.path }
        : undefined,
    projectName: data.projectName,
    projectPath: data.projectPath,
    prompt: data.prompt,
  };
}

function fromMoveChatRequest(data: PendingMoveChatProjection): PermissionRequest {
  return {
    requestId: data.requestId,
    scope: { type: 'folder', folderId: '' },
    path: data.projectName,
    operation: 'move_chat',
    moveChatPayload: {
      targetChatId: data.targetChatId,
      targetSubChatId: data.targetSubChatId,
      projectName: data.projectName,
      prompt: '',
      projectPath: data.projectPath,
      requestedWorktreePath: data.requestedWorktreePath,
      targetBranch: data.targetBranch,
    },
    chatId: data.chatId,
    subChatId: data.subChatId,
  };
}

function fromPendingPermissionProjection(data: PendingPermissionProjection): PermissionRequest {
  return data.operation === 'move_chat'
    ? fromMoveChatRequest(data)
    : fromSocketPermissionRequest(data);
}

/** v2 approval payload emitted by `FourButtonView` / `SimpleApprovalView`. */
export type ApprovalDecision = {
  /** undefined = "Allow once" (no persistence) or SimpleApprovalView approve */
  scope?: 'project' | 'user';
  ruleString?: string;
  ruleType?: RuleType;
  /**
   * Set by the flow-consent card's "Always allow this flow" button. Kept
   * separate from `scope` because a flow grant writes `flows.agent_invocable`
   * rather than persisting a permission rule.
   */
  flowGrant?: boolean;
};

/** Clamp a queue index to valid bounds for the given array length */
function clampIndex(index: number, length: number): number {
  return length === 0 ? 0 : Math.min(index, length - 1);
}

export function usePermissionPrompts() {
  const [pendingRequests, setPendingRequests] = useState<PermissionRequest[]>([]);
  // Index of the currently displayed request (supports cycling with "Next")
  const [currentIndex, setCurrentIndex] = useState(0);
  // Use ref to avoid recreating callbacks when pendingRequests changes
  const pendingRequestsRef = useRef<PermissionRequest[]>(pendingRequests);
  pendingRequestsRef.current = pendingRequests;
  // Pulls race with dismiss/response pushes. Once a request has retired in this renderer lifetime,
  // an older list response must never resurrect its card.
  const retiredRequestIdsRef = useRef<Set<string>>(new Set());

  const rememberRetiredRequestId = useCallback((requestId: string) => {
    rememberBounded(retiredRequestIdsRef.current, requestId, 128);
  }, []);

  // Single trigger point for the "agent is blocked waiting on you" alert sound, covering every
  // producer (local IPC, socket, move_chat, mcp_tool) since they all push into pendingRequests.
  // Keyed on the committed state (not inside the setState updaters) so React strict-mode's
  // double-invoked updaters can't double-fire, and seen ids guarantee one sound per request.
  const alertedRequestIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const isWindowFocused = document.hasFocus();
    const soundEnabled = appStore.get(soundNotificationsEnabledAtom);
    for (const request of pendingRequests) {
      const isNew = !alertedRequestIdsRef.current.has(request.requestId);
      if (!isNew) continue;
      alertedRequestIdsRef.current.add(request.requestId);
      if (shouldAlertOnPermissionRequest({ soundEnabled, isWindowFocused, isNew })) {
        void playSound('needsYou');
      }
    }
  }, [pendingRequests]);

  /** Remove a request by id and clamp currentIndex to stay in bounds. Shared by
   *  the user-response path (`respond`) and the timeout-dismiss effects below.
   *  Idempotent — a dismiss for an id already removed is a no-op filter. */
  const removeRequest = useCallback((id: string) => {
    setPendingRequests((prev) => {
      const next = prev.filter((r) => r.requestId !== id);
      setCurrentIndex((idx) => clampIndex(idx, next.length));
      return next;
    });
  }, []);

  const retireRequest = useCallback(
    (id: string) => {
      rememberRetiredRequestId(id);
      removeRequest(id);
    },
    [rememberRetiredRequestId, removeRequest],
  );

  const enqueueRequest = useCallback((request: PermissionRequest) => {
    if (retiredRequestIdsRef.current.has(request.requestId)) return;
    setPendingRequests((prev) => {
      if (prev.some((item) => item.requestId === request.requestId)) return prev;
      return [...prev, request];
    });
  }, []);

  // Listen for local IPC permission requests (same-machine execution)
  useEffect(() => {
    if (!isDesktopApp()) return;

    const unsubscribe = window.desktopApi.onPermissionRequest((data) => {
      enqueueRequest({ ...data, isRemote: false });
    });

    return unsubscribe;
  }, [enqueueRequest]);

  // Listen for socket-based permission requests
  useEffect(() => {
    if (!isDesktopApp()) return;

    // Check if the handler exists (it may not if the preload was updated)
    if (!window.desktopApi.onSocketPermissionRequest) return;

    let disposed = false;
    let retried = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const accept = (data: SocketPermissionProjection) =>
      enqueueRequest(fromSocketPermissionRequest(data));
    // Subscribe before pulling: any request created while the query is in flight reaches this
    // listener, while request-id de-duplication collapses the overlapping snapshot row.
    const unsubscribe = window.desktopApi.onSocketPermissionRequest(accept);
    // Pull once; on rejection, wait and retry exactly once more; then give up. Local IPC never
    // partitions, so a rejection here means main itself failed to answer twice in a row — the
    // listener subscribed above still carries any request created afterward.
    const pullPendingRequests = async (): Promise<void> => {
      try {
        // Keep the Electron-only client out of the component barrel's eager module graph. The
        // PermissionPrompt component re-exports this hook, and purely visual consumers (including
        // browser/test renderers) do not install the preload global that trpc-electron requires.
        const { trpcClient } = await import('../lib/trpc');
        const requests = await trpcClient.socket.listPendingPermissionRequests.query();
        if (disposed) return;
        for (const request of requests) enqueueRequest(fromPendingPermissionProjection(request));
      } catch (error) {
        if (disposed) return;
        if (!retried) {
          Sentry.captureException(error, { tags: { surface: 'permission-prompt-rehydrate' } });
          retried = true;
          retryTimer = setTimeout(() => void pullPendingRequests(), PERMISSION_REHYDRATE_RETRY_MS);
        }
      }
    };
    void pullPendingRequests();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      unsubscribe();
    };
  }, [enqueueRequest]);

  // Listen for move-chat requests (blocking; same queue as permissions)
  useEffect(() => {
    if (!isDesktopApp()) return;
    const api = window.desktopApi as unknown as {
      onAgentRequestMoveChat?: (cb: (data: MoveChatRequest) => void) => () => void;
    };
    if (!api?.onAgentRequestMoveChat) return;

    const unsubscribe = api.onAgentRequestMoveChat((data: MoveChatRequest) => {
      enqueueRequest(fromMoveChatRequest({ ...data, operation: 'move_chat' }));
    });

    return unsubscribe;
  }, [enqueueRequest]);

  // Pop a prompt when the main process times it out (local-IPC producers:
  // proxy bash, MCP-tool, move-chat). Without this the card lingers and a
  // re-request — which gets a fresh requestId — stacks a second card.
  useEffect(() => {
    if (!isDesktopApp()) return;
    if (!window.desktopApi.onPermissionDismiss) return;
    return window.desktopApi.onPermissionDismiss((data) => retireRequest(data.requestId));
  }, [retireRequest]);

  // Pop a prompt when the main process times it out (socket producer: executor.ts).
  useEffect(() => {
    if (!isDesktopApp()) return;
    if (!window.desktopApi.onSocketPermissionDismiss) return;
    return window.desktopApi.onSocketPermissionDismiss((data) => retireRequest(data.requestId));
  }, [retireRequest]);

  // Clamp currentIndex when requests are added/removed and sync the shared atom
  useEffect(() => {
    const clamped = clampIndex(currentIndex, pendingRequests.length);
    if (clamped !== currentIndex) {
      setCurrentIndex(clamped);
    }
    const chatId = pendingRequests[clamped]?.chatId ?? null;
    appStore.set(permissionRequestChatIdAtom, chatId);
  }, [pendingRequests, currentIndex]);

  // Clear atom on true unmount only (not on every dep change)
  useEffect(() => {
    return () => {
      appStore.set(permissionRequestChatIdAtom, null);
    };
  }, []);

  /** Cycle to the next pending request (wraps around).
   *  Reads pendingRequests length via a paired setState to avoid stale ref. */
  const next = useCallback(() => {
    setPendingRequests((current) => {
      const len = current.length;
      setCurrentIndex((prev) => (len <= 1 ? 0 : (prev + 1) % len));
      return current;
    });
  }, []);

  /** Cycle to the previous pending request (wraps around). */
  const previous = useCallback(() => {
    setPendingRequests((current) => {
      const len = current.length;
      setCurrentIndex((prev) => (len <= 1 ? 0 : (prev - 1 + len) % len));
      return current;
    });
  }, []);

  // Stable callback - uses ref to access current requests without dependency
  const respond = useCallback(
    (
      requestId: string,
      approved: boolean,
      options?: ApprovalDecision & {
        /**
         * System-driven cancellation (pane close while prompt pending, etc.).
         * Persistence paths must NOT treat this as an explicit user Deny —
         * skips writing a phantom project-wide deny row.
         */
        timedOut?: boolean;
      },
    ) => {
      const { scope, ruleString, ruleType, flowGrant, timedOut } = options ?? {};

      // Use ref to avoid dependency on pendingRequests state
      const request = pendingRequestsRef.current.find((r) => r.requestId === requestId);

      if (!request) {
        // Already removed (race condition or React strict mode double-fire) — skip IPC
        return;
      }

      rememberRetiredRequestId(requestId);

      if (request?.operation === 'move_chat') {
        (
          window.desktopApi as {
            sendAgentMoveChatResponse: (id: string, approved: boolean) => void;
          }
        ).sendAgentMoveChatResponse(requestId, approved);
        removeRequest(requestId);
        return;
      }

      // Claude-style: remote (socket) vs local (proxy) — same for file, bash, and mcp_tool
      if (request?.isRemote && request.chatId && request.subChatId) {
        window.desktopApi.sendSocketPermissionResponse({
          chatId: request.chatId,
          subChatId: request.subChatId,
          requestId,
          approved,
          scope,
          ruleString,
          ruleType,
          flowGrant,
          timedOut,
        });
      } else {
        // Send response via local IPC for same-machine requests.
        // Note: `timedOut` is intentionally not forwarded — the local proxy path
        // ([src/main/lib/permissions/proxy.ts]) does not persist denials today, so
        // there is no phantom-block trap to guard against. If persistence is added
        // to that path, mirror the executor's `timedOut` guard here too.
        window.desktopApi.sendPermissionResponse({
          requestId,
          approved,
          scope,
          ruleString,
          ruleType,
        });
      }

      // Remove from pending and clamp index
      removeRequest(requestId);
    },
    [rememberRetiredRequestId, removeRequest],
  );

  // Stable callbacks - no dependencies since respond is stable
  const approve = useCallback(
    (requestId: string, decision?: ApprovalDecision) => {
      respond(requestId, true, decision);
    },
    [respond],
  );

  const deny = useCallback(
    (requestId: string) => {
      respond(requestId, false);
    },
    [respond],
  );

  /** Remove queued requests whose chatIds are no longer in any open pane.
   *  Only treats as orphan when a chat was *removed* from the list (pane closed), not when
   *  the request arrived before the list included it (avoids race; no fixed timeout). */
  const removeOrphanedRequests = useCallback(
    (activeChatIds: string[], previousActiveChatIds: string[] = []) => {
      const removedChatIds = previousActiveChatIds.filter((id) => !activeChatIds.includes(id));
      if (removedChatIds.length === 0) return;

      const current = pendingRequestsRef.current;
      const orphaned = current.filter(
        (r) => r.chatId && removedChatIds.includes(r.chatId) && r.operation !== 'move_chat',
      );
      if (orphaned.length === 0) return;

      for (const r of orphaned) {
        // Pane closed while prompt pending — flag as system-driven so the executor
        // does not persist a phantom project-wide deny.
        respond(r.requestId, false, { timedOut: true });
      }

      setPendingRequests((prev) => {
        const filtered = prev.filter(
          (r) => r.operation === 'move_chat' || !r.chatId || !removedChatIds.includes(r.chatId),
        );
        if (filtered.length === prev.length) return prev;
        setCurrentIndex((idx) => clampIndex(idx, filtered.length));
        return filtered;
      });
    },
    [respond],
  );

  // Clamped index for safety (effect may not have fired yet)
  const safeIndex = clampIndex(currentIndex, pendingRequests.length);

  return {
    pendingRequests,
    currentRequest: pendingRequests[safeIndex] ?? null,
    /** 1-indexed position of the currently shown request in the queue */
    currentPosition: pendingRequests.length === 0 ? 0 : safeIndex + 1,
    /** Total number of pending permission requests */
    queueTotal: pendingRequests.length,
    hasRequests: pendingRequests.length > 0,
    approve,
    deny,
    /** Cycle to the next pending request (wraps around) */
    next,
    /** Cycle to the previous pending request (wraps around) */
    previous,
    /** Remove queued requests whose chatIds are no longer active */
    removeOrphanedRequests,
  };
}
