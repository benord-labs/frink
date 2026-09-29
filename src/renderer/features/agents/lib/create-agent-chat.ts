/**
 * Shared Chat-instance factory.
 *
 * Builds the `WebSocketChatTransport` + AI-SDK `Chat` and registers it in the
 * module-level `agentChatStore`. This is the SINGLE construction site for a
 * Chat object, used by two callers:
 *   - the visible `ActiveChat` (getOrCreateChat) — passes its React-scoped
 *     execution-account ref + view-only callbacks (OS notification, diff-stats).
 *   - the global task path (use-task-ipc-handler) — creates the Chat HEADLESSLY
 *     when a task is claimed, so a flow/queue chat streams without being the
 *     selected tab. It reads the execution account from the resolved-account
 *     query cache (populated by a prefetch, gated by QueueProcessor's
 *     account-readiness check) instead of the view ref.
 *
 * `onFinish`/`onError` use only store/atom state (all read at runtime), so they
 * behave identically whether or not the owning `ChatViewInner` is mounted.
 */

import { Chat } from '@ai-sdk/react';
import type { UIMessage } from 'ai';
import type { ChatMode } from '../../../../shared/types/chat-mode';
import { soundNotificationsEnabledAtom } from '../../../lib/atoms';
import { playSound } from '../../../lib/audio/play-chime';
import { appStore } from '../../../lib/jotai-store';
import { wakeHeldAtomFamily } from '../../../lib/stores/active-transport-registry';
import { deferUntilWaitOver } from '../../../lib/stores/use-wake-hold-sync';
import { isDesktopApp } from '../../../lib/utils/platform';
import { notifySidebarChatActivity } from '../../sidebar/unified/sidebar-chat-activity';
import {
  agentsSubChatUnseenChangesAtom,
  agentsUnseenChangesAtom,
  clearLoading,
  loadingSubChatsAtom,
  selectedAgentChatIdAtom,
  splitViewAtom,
} from '../atoms';
import { agentChatStore } from '../stores/agent-chat-store';
import {
  executionErrorRollbackSubChatIdAtom,
  flowRunIncompleteAtomFamily,
} from '../stores/message-store';
import { useStreamingStatusStore } from '../stores/streaming-status-store';
import { useAgentSubChatStore } from '../stores/sub-chat-store';
import { resolveCompletionEffects } from './completion-effects';
import type { ExecutionAccountKind } from './resolve-execution-model-cli';
import { WebSocketChatTransport } from './websocket-chat-transport';

export type CreateAgentChatParams = {
  chatId: string;
  subChatId: string;
  /** Routing project id (empty string for general chats — server executes locally). */
  projectId: string;
  mode: ChatMode;
  /** Initial messages to seed the Chat (DB history for continue_chat; [] for a fresh chat). */
  initialMessages: UIMessage[];
  /** Original project path (MCP config lookup); persisted alongside the chat for move detection. */
  projectPath?: string;
  /** Existing stream id at creation time — pins resume behaviour during active streaming. */
  streamId?: string | null;
  /** Execution account resolver, read at SEND time by the transport (never snapshotted). */
  getExecutionAccountType: () => ExecutionAccountKind;
  /** View-only: OS notification on completion when the user isn't viewing. Omit for headless. */
  notifyComplete?: (subChatId: string) => void;
  /** View-only: extra work after a turn finishes (e.g. refresh diff stats). Omit for headless. */
  onFinishExtra?: () => void;
};

/** Chats whose turn fired onError: the SDK always runs onFinish after it, which must not also chime.
 * Per instance, so a replacement Chat on the same sub-chat never inherits a torn-down one's error. */
const erroredChats = new WeakSet<Chat<UIMessage>>();

/**
 * Flow-driven-ness, read LIVE at finish/error time (a creation-time snapshot goes stale: a Chat
 * built before the flow's first dispatch links the chat would chime on every node). Sources:
 * the flow-chat registry (marked on every headless task:chat-ready) OR a live incomplete flow
 * run for this sub-chat (covers a post-reload stream-resume finishing before any new claim).
 */
function isFlowDrivenNow(chatId: string, subChatId: string): boolean {
  return agentChatStore.isFlowChat(chatId) || appStore.get(flowRunIncompleteAtomFamily(subChatId));
}

/** clearLoading expects a jotai-style setter; bridge it to the module-level appStore. */
function clearLoadingViaStore(subChatId: string): void {
  clearLoading(
    (fn) => appStore.set(loadingSubChatsAtom, fn(appStore.get(loadingSubChatsAtom))),
    subChatId,
  );
}

function markTurnUnseen(
  chatId: string,
  subChatId: string,
  effects: ReturnType<typeof resolveCompletionEffects>,
): void {
  if (effects.markSubChatUnseen) {
    appStore.set(agentsSubChatUnseenChangesAtom, (prev: Set<string>) =>
      new Set(prev).add(subChatId),
    );
  }
  if (effects.markChatUnseen) {
    appStore.set(agentsUnseenChangesAtom, (prev: Set<string>) => new Set(prev).add(chatId));
  }
}

export function createAgentChat(params: CreateAgentChatParams): Chat<UIMessage> {
  const {
    chatId,
    subChatId,
    projectId,
    mode,
    initialMessages,
    projectPath,
    streamId = null,
    getExecutionAccountType,
    notifyComplete,
    onFinishExtra,
  } = params;

  const transport = new WebSocketChatTransport({
    chatId,
    subChatId,
    projectId,
    mode,
    getExecutionAccountType,
    onExecutionError(errSubChatId: string) {
      appStore.set(executionErrorRollbackSubChatIdAtom, errSubChatId);
    },
    onExecuteComplete() {
      // Invalidation handled by queue-processor's global onSocketExecuteComplete.
    },
  });

  const chat = new Chat<UIMessage>({
    id: subChatId,
    messages: initialMessages,
    transport,
    onError: () => {
      // A torn-down instance's turn belongs to its replacement now: touch no per-sub-chat state.
      if (agentChatStore.wasTornDown(chat)) return;
      erroredChats.add(chat);
      // Sync status to global store on error (allows the queue to continue).
      useStreamingStatusStore.getState().setStatus(subChatId, 'ready');

      // Failure sound under the same away-gating as completion: silent when
      // watching, on manual stop, and for flow turns (the flow's run_failed
      // plays the one failure sound). Read but do NOT clear the abort flag —
      // onFinish owns clearing it.
      const subStore = useAgentSubChatStore.getState();
      const effects = resolveCompletionEffects({
        chatId,
        subChatId,
        subStoreChatId: subStore.chatId,
        subStoreActiveSubChatId: subStore.activeSubChatId,
        splitView: appStore.get(splitViewAtom),
        selectedChatId: appStore.get(selectedAgentChatIdAtom),
        isWindowFocused: document.hasFocus(),
        wasManuallyAborted: agentChatStore.wasManuallyAborted(subChatId),
        isFlowDriven: isFlowDrivenNow(chatId, subChatId),
      });
      if (effects.notifyCompletion && appStore.get(soundNotificationsEnabledAtom)) {
        void playSound('failed');
      }
    },
    onFinish: () => {
      if (agentChatStore.wasTornDown(chat)) return;
      const turnErrored = erroredChats.delete(chat);
      clearLoadingViaStore(subChatId);
      // Sync status to global store for queue processing (even when component unmounted).
      useStreamingStatusStore.getState().setStatus(subChatId, 'ready');

      const wasManuallyAborted = agentChatStore.wasManuallyAborted(subChatId);
      agentChatStore.clearManuallyAborted(subChatId);

      const announce = () => {
        if (agentChatStore.wasTornDown(chat)) return;
        // Read CURRENT view state: the reused Chat's creation-time split/focus snapshots are stale
        // (agent-execution-lifecycle decision); hasFocus() is this renderer window's.
        const subStore = useAgentSubChatStore.getState();
        const effects = resolveCompletionEffects({
          chatId,
          subChatId,
          subStoreChatId: subStore.chatId,
          subStoreActiveSubChatId: subStore.activeSubChatId,
          splitView: appStore.get(splitViewAtom),
          selectedChatId: appStore.get(selectedAgentChatIdAtom),
          isWindowFocused: document.hasFocus(),
          wasManuallyAborted,
          isFlowDriven: isFlowDrivenNow(chatId, subChatId),
        });

        markTurnUnseen(chatId, subChatId, effects);

        // An errored turn already signalled via onError — a success sound or
        // "completed" OS notification here would misreport the outcome.
        if (effects.notifyCompletion && !turnErrored) {
          if (appStore.get(soundNotificationsEnabledAtom)) {
            void playSound('turnComplete');
          }
          notifyComplete?.(subChatId);
        }
      };
      // A turn that leaves background work running is not finished: announce when the wait ends.
      // Never gate on runLive here — it still reads true at onFinish (live-run-observer-lane).
      if (appStore.get(wakeHeldAtomFamily(subChatId))) deferUntilWaitOver(subChatId, announce);
      else announce();

      onFinishExtra?.();

      // Web: bump sidebar order on completion (desktop uses QueueProcessor onSocketExecuteComplete).
      if (!isDesktopApp()) {
        notifySidebarChatActivity(chatId);
      }
    },
  });

  agentChatStore.set(subChatId, chat, chatId, projectPath);
  // Store streamId at creation time to prevent resume during active streaming.
  agentChatStore.setStreamId(subChatId, streamId);
  return chat;
}

// A hot swap of this factory's closure splits live runs across two module instances and freezes
// them; a full reload takes the dev-reload recovery path instead. Vite only sees a literal call.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
