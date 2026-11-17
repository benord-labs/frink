import type { UIMessage } from 'ai';
import type { ReactElement } from 'react';
import type { ChatMode } from '../../../../../../shared/types/chat-mode';
import type { AgentsMentionsEditorHandle } from '../../../mentions';
import { AutoGenerateManager } from './AutoGenerateManager';
import { KeyboardShortcutsManager } from './KeyboardShortcutsManager';
import { MessageSyncManager } from './MessageSyncManager';
import { PlanApprovalManager } from './PlanApprovalManager';

type Props = {
  isActive: boolean;
  /** True when this pane is focused (single view or active pane in split view). Used for pane-scoped shortcuts. */
  isPaneActive?: boolean;
  isStreaming: boolean;
  subChatId: string;
  parentChatId: string;
  pendingQuestions: unknown;
  hasUnapprovedPlan: boolean;
  chatMode: ChatMode;
  editorRef: React.RefObject<AgentsMentionsEditorHandle | null>;
  stop: () => Promise<void>;
  handleQuestionsSkip: () => Promise<unknown>;
  handleApprovePlan: () => void;
  scrollToBottom: () => void;
  status: string;
  messages: UIMessage[];
  hasUnapprovedPlanRef: React.RefObject<boolean>;
  hasExistingSession: boolean;
  isAccountReady: boolean;
  streamId?: string | null;
  hasTriggeredAutoGenerateRef: React.RefObject<boolean>;
  regenerate: () => void;
  /** Set when a queued item is loaded into the input for editing. Forwarded to KeyboardShortcutsManager so Escape can abandon. */
  editingItemId?: string | null;
  onAbandonEdit?: () => void;
  /** Forwarded to KeyboardShortcutsManager: a flow run drives this chat, raw stop shortcuts off. */
  suppressRawStop?: boolean;
};

/**
 * ManagerComponentsGroup - Renders all manager components for side effects
 * These components handle keyboard shortcuts, scroll, sync, plan approval, and auto-generate
 */
export function ManagerComponentsGroup({
  isActive,
  isPaneActive = true,
  isStreaming,
  subChatId,
  parentChatId,
  pendingQuestions,
  hasUnapprovedPlan,
  chatMode,
  editorRef,
  stop,
  handleQuestionsSkip,
  handleApprovePlan,
  scrollToBottom,
  status,
  messages,
  hasUnapprovedPlanRef,
  hasExistingSession,
  isAccountReady,
  streamId,
  hasTriggeredAutoGenerateRef,
  regenerate,
  editingItemId = null,
  onAbandonEdit,
  suppressRawStop = false,
}: Props): ReactElement {
  return (
    <>
      <KeyboardShortcutsManager
        isActive={isActive}
        isPaneActive={isPaneActive}
        isStreaming={isStreaming}
        pendingQuestions={pendingQuestions}
        hasUnapprovedPlan={hasUnapprovedPlan}
        editorRef={editorRef}
        stop={stop}
        handleQuestionsSkip={handleQuestionsSkip}
        handleApprovePlan={handleApprovePlan}
        scrollToBottom={scrollToBottom}
        editingItemId={editingItemId}
        onAbandonEdit={onAbandonEdit}
        suppressRawStop={suppressRawStop}
      />
      <MessageSyncManager
        isActive={isActive}
        subChatId={subChatId}
        messages={messages}
        status={status}
      />
      <PlanApprovalManager
        messages={messages}
        isPlanMode={chatMode === 'plan'}
        subChatId={subChatId}
        parentChatId={parentChatId}
        isActive={isActive}
        isStreaming={isStreaming}
        hasUnapprovedPlanRef={hasUnapprovedPlanRef}
        handleApprovePlan={handleApprovePlan}
      />
      <AutoGenerateManager
        hasExistingSession={hasExistingSession}
        isAccountReady={isAccountReady}
        messages={messages}
        status={status}
        streamId={streamId}
        hasTriggeredAutoGenerateRef={hasTriggeredAutoGenerateRef}
        regenerate={regenerate}
      />
    </>
  );
}
