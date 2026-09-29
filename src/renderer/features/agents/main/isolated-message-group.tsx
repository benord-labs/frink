/* eslint-disable max-lines, max-lines-per-function */

import { Button } from '@benord-labs/frink-primitives';
import { useAtomValue } from 'jotai';
import { Code2, GitBranch, MessageSquare, Play, Undo2 } from 'lucide-react';
import { memo, useMemo } from 'react';
import { formatAttachmentSummaryLabel } from '@/lib/agent-chat/format-attachment-summary';
import { pendingTurnCard } from '@/lib/agent-chat/planning/planning-status-message';
import {
  type AnsweredQuestion,
  readAnsweredQuestions,
} from '../../../../shared/lib/agent-questions/answered-questions';
import { TRIGGER_BUBBLE_MARKER } from '../../../../shared/lib/trigger-bubble-marker';
import { isPlanApprovalTriggerText } from '../../../../shared/types/plan';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../../components/ui/dropdown-menu';
import { cn } from '../../../lib/utils';
import { showMessageJsonAtom } from '../atoms';
import { compactingAtomFor } from '../lib/compaction-flag';
import { extractTextMentions, TextMentionBlocks } from '../mentions/render-file-mentions';
import {
  assistantIdsForSubChatMsgAtomFamily,
  chatHasGitContextAtomFamily,
  flowRunIncompleteAtomFamily,
  isFirstUserMessageForSubChatAtomFamily,
  isLastUserMessageForSubChatAtomFamily,
  isRollingBackAtom,
  isStreamingForSubChatAtomFamily,
  messageAtomFamily,
  ORPHAN_ANCHOR_PREFIX,
  rollbackHandlerAtom,
} from '../stores/message-store';
import { ContinueAfterUsageLimit } from '../ui/account-indicator';
import type { IsolatedChatToolRegistry } from '../ui/agent-tool-registry';
import { MessageJsonDisplay } from '../ui/message-json-display';
import { RetryActionButton } from './active-chat/components/RetryActionButton';
import type { IsolatedChatSharedProps } from './active-chat/types';
import { agentsChatUserBubbleShellClass } from './chat-composer-shell-classes';
import { MemoizedAssistantMessages } from './messages-list';

// ============================================================================
// ISOLATED MESSAGE GROUP (LAYER 4)
// ============================================================================
// Renders ONE user message and its associated assistant messages.
// Subscribes to Jotai atoms for:
// - The specific user message
// - Assistant message IDs for this group
// - Whether this is the last user message
// - Streaming status
//
// Only re-renders when:
// - User message content changes (rare)
// - New assistant message is added to this group
// - This becomes/stops being the last group
// - Streaming starts/stops (for planning indicator)
// ============================================================================

export type { IsolatedChatToolRegistry };

/**
 * Reference-compares every shared prop. Each layer's own memo comparator calls this and then
 * adds the props it declares itself.
 */
export function areIsolatedChatSharedPropsEqual(
  prev: IsolatedChatSharedProps,
  next: IsolatedChatSharedProps,
): boolean {
  return (
    prev.subChatId === next.subChatId &&
    prev.chatId === next.chatId &&
    prev.taskId === next.taskId &&
    prev.isMobile === next.isMobile &&
    prev.sandboxSetupStatus === next.sandboxSetupStatus &&
    prev.stickyTopClass === next.stickyTopClass &&
    prev.sandboxSetupError === next.sandboxSetupError &&
    prev.onRetrySetup === next.onRetrySetup &&
    prev.ToolCallComponent === next.ToolCallComponent &&
    prev.MessageGroupWrapper === next.MessageGroupWrapper &&
    prev.toolRegistry === next.toolRegistry &&
    prev.showChatRetryControl === next.showChatRetryControl &&
    prev.retryInFlight === next.retryInFlight &&
    prev.onRetryChat === next.onRetryChat &&
    prev.onCarryOnChat === next.onCarryOnChat &&
    prev.chatRetryTooltipText === next.chatRetryTooltipText
  );
}

type IsolatedMessageGroupProps = IsolatedChatSharedProps & {
  userMsgId: string;
  // biome-ignore lint/style/useNamingConvention: component type prop
  UserBubbleComponent: React.ComponentType<{
    messageId: string;
    textContent: string;
    answeredQuestions?: AnsweredQuestion[];
    imageParts: Array<{ type: string; data?: { url?: string; [key: string]: unknown } }>;
    skipTextMentionBlocks?: boolean;
    endGutter?: boolean;
  }>;
};

/**
 * Recovery pair for a failed interactive turn — mirrors TaskControls' ordering: Retry (re-run the
 * failed turn from scratch) on the left, Carry on (resume the session and continue from where it
 * stopped — the default choice, e.g. after a usage limit resets) as the terminal action.
 *
 * Carry on needs a session to resume; with none, `onCarryOnChat` is null and only Retry renders.
 */
function ChatRetryAfterGroupRow({
  chatId,
  subChatId,
  retryInFlight,
  onRetryChat,
  onCarryOnChat,
  chatRetryTooltipText,
}: {
  chatId: string;
  subChatId: string;
  retryInFlight: boolean;
  onRetryChat: () => void;
  onCarryOnChat: (() => void) | null;
  chatRetryTooltipText: string | null;
}) {
  return (
    <div className="px-2 mt-1 flex justify-end gap-1">
      <ContinueAfterUsageLimit chatId={chatId} subChatId={subChatId} onRetry={onRetryChat} />
      <RetryActionButton
        onClick={onRetryChat}
        disabled={retryInFlight}
        ariaLabel={retryInFlight ? 'Retrying chat send' : 'Retry chat send'}
        ariaBusy={retryInFlight}
        label={retryInFlight ? 'Retrying...' : 'Retry'}
        tooltipText={chatRetryTooltipText ?? undefined}
      />
      {onCarryOnChat && (
        <RetryActionButton
          icon={Play}
          onClick={onCarryOnChat}
          disabled={retryInFlight}
          ariaLabel="Carry on from where the chat stopped"
          label="Carry on"
          tooltipText="Resume the session and continue from where it stopped — nothing is redone."
        />
      )}
    </div>
  );
}

function areGroupPropsEqual(
  prev: IsolatedMessageGroupProps,
  next: IsolatedMessageGroupProps,
): boolean {
  return (
    prev.userMsgId === next.userMsgId &&
    prev.UserBubbleComponent === next.UserBubbleComponent &&
    areIsolatedChatSharedPropsEqual(prev, next)
  );
}

export const IsolatedMessageGroup = memo(function IsolatedMessageGroup({
  userMsgId,
  subChatId,
  chatId,
  taskId,
  isMobile,
  sandboxSetupStatus,
  stickyTopClass,
  sandboxSetupError,
  onRetrySetup,
  UserBubbleComponent,
  ToolCallComponent,
  MessageGroupWrapper,
  toolRegistry,
  showChatRetryControl,
  retryInFlight,
  onRetryChat,
  onCarryOnChat,
  chatRetryTooltipText,
}: IsolatedMessageGroupProps) {
  const isOrphanAnchor = userMsgId.startsWith(ORPHAN_ANCHOR_PREFIX);

  // Subscribe to per-subChat atoms for split view support.
  // Each pane reads from its own isolated atoms (keyed by subChatId).
  // For orphan anchors, messageAtomFamily returns undefined (no real message) — that's expected.
  const userMsg = useAtomValue(messageAtomFamily(userMsgId));
  const assistantIds = useAtomValue(
    assistantIdsForSubChatMsgAtomFamily(`${subChatId}:${userMsgId}`),
  );
  const isLastGroup = useAtomValue(
    isLastUserMessageForSubChatAtomFamily(`${subChatId}:${userMsgId}`),
  );
  const isFirstGroup = useAtomValue(
    isFirstUserMessageForSubChatAtomFamily(`${subChatId}:${userMsgId}`),
  );
  const isStreaming = useAtomValue(isStreamingForSubChatAtomFamily(subChatId));
  const showMessageJson = useAtomValue(showMessageJsonAtom);
  const onRollback = useAtomValue(rollbackHandlerAtom);
  const isRollingBack = useAtomValue(isRollingBackAtom);
  const isFlowRunIncomplete = useAtomValue(flowRunIncompleteAtomFamily(subChatId));
  const hasGitContext = useAtomValue(chatHasGitContextAtomFamily(subChatId));
  const isCompacting = useAtomValue(compactingAtomFor(subChatId, isLastGroup));

  // Extract user message content
  const rawTextContent =
    userMsg?.parts
      ?.filter((p: { type: string }) => p.type === 'text')
      .map((p: { text?: string }) => p.text)
      .join('\n') || '';

  const imageParts = userMsg?.parts?.filter((p: { type: string }) => p.type === 'data-image') || [];

  // Display-only provenance: this message answered these questions, so it renders as a card rather
  // than a bare bubble. Read off metadata, never parsed out of the text — the model never sees it.
  const answeredQuestions = readAnsweredQuestions(
    (userMsg?.metadata as { answeredQuestions?: unknown } | undefined)?.answeredQuestions,
  );

  // Trigger-spawned chats carry the trigger card as their first user message. It is an immutable
  // origin (an external event that happened) — suppress rollback so it can't be rewritten/emptied.
  const isTriggerOrigin = rawTextContent.startsWith(TRIGGER_BUBBLE_MARKER);

  // Extract text mentions (quote/diff) to render separately above sticky block
  // NOTE: useMemo must be called before any early returns to follow Rules of Hooks
  const { textMentions, cleanedText: textContent } = useMemo(
    () => extractTextMentions(rawTextContent),
    [rawTextContent],
  );

  // Orphan anchor group: assistant-only (no user bubble). Same retry / planning rules as the main
  // path when this group is last — omitting them here hid controls for leading-assistant threads.
  const showStreamingPlanning =
    isStreaming && isLastGroup && assistantIds.length === 0 && sandboxSetupStatus === 'ready';
  const showRetryAfterGroup = showChatRetryControl && isLastGroup && !taskId && !isStreaming;

  const planningMeta = toolRegistry['tool-planning'];
  if (showStreamingPlanning && !planningMeta) {
    throw new Error('tool-planning entry is required in toolRegistry when streaming');
  }

  const planningCard = showStreamingPlanning && (
    <div className="mt-4">
      <ToolCallComponent
        {...pendingTurnCard(
          isCompacting,
          planningMeta,
          `ui-streaming-planning:${subChatId}:user:${userMsgId}`,
        )}
      />
    </div>
  );

  if (isOrphanAnchor) {
    const hasContent = assistantIds.length > 0 || showStreamingPlanning || showRetryAfterGroup;
    if (!hasContent) return null;
    return (
      <MessageGroupWrapper isLastGroup={isLastGroup}>
        {assistantIds.length > 0 && (
          <MemoizedAssistantMessages
            assistantMsgIds={assistantIds}
            subChatId={subChatId}
            chatId={chatId}
            isMobile={isMobile}
            sandboxSetupStatus={sandboxSetupStatus}
          />
        )}
        {showRetryAfterGroup && (
          <ChatRetryAfterGroupRow
            chatId={chatId}
            subChatId={subChatId}
            retryInFlight={retryInFlight}
            onRetryChat={onRetryChat}
            onCarryOnChat={onCarryOnChat}
            chatRetryTooltipText={chatRetryTooltipText}
          />
        )}
        {planningCard}
      </MessageGroupWrapper>
    );
  }

  if (!userMsg) return null;

  // Show cloning when sandbox is being set up
  const isCloning = sandboxSetupStatus === 'cloning';
  const hasNoAssistants = assistantIds.length === 0;
  const shouldShowCloning = isCloning && isLastGroup && hasNoAssistants;

  // Show setup error if sandbox setup failed
  const hasSetupError = sandboxSetupStatus === 'error';
  const shouldShowSetupError = hasSetupError && isLastGroup && hasNoAssistants;

  // Check if this is an image-only message (no text content and no text mentions)
  const isImageOnlyMessage =
    imageParts.length > 0 && !textContent.trim() && textMentions.length === 0;
  const isAttachmentOnlyMessage =
    !textContent.trim() && (imageParts.length > 0 || textMentions.length > 0);
  const shouldRenderPlanAcceptedCard = isPlanApprovalTriggerText(textContent);
  const showRollback =
    !!onRollback &&
    !isOrphanAnchor &&
    !isTriggerOrigin &&
    !isFlowRunIncomplete &&
    !isStreaming &&
    !isRollingBack;

  return (
    <MessageGroupWrapper isLastGroup={isLastGroup}>
      {/* Attachments - NOT sticky (only when there's also text) */}
      {imageParts.length > 0 && !isImageOnlyMessage && (
        <div className="mb-2 pointer-events-auto">
          <UserBubbleComponent
            messageId={userMsgId}
            textContent=""
            imageParts={imageParts}
            skipTextMentionBlocks
          />
        </div>
      )}

      {/* Text mentions (quote/diff/pasted) - NOT sticky */}
      {textMentions.length > 0 && (
        <div className="mb-2 pointer-events-auto">
          <TextMentionBlocks mentions={textMentions} />
        </div>
      )}

      {/* User message text - sticky (or attachment-only summary bubble) */}
      <div
        data-user-message-id={userMsgId}
        className={cn('[&>div]:mb-4! pointer-events-auto sticky z-10', stickyTopClass)}
      >
        <div className="relative">
          {isAttachmentOnlyMessage && !isImageOnlyMessage ? (
            <div className="flex justify-start" data-user-bubble>
              <div className="space-y-2 w-full">
                <div
                  className={cn(
                    agentsChatUserBubbleShellClass(),
                    'text-muted-foreground italic whitespace-normal',
                    showRollback && 'pr-10',
                  )}
                >
                  {formatAttachmentSummaryLabel(imageParts.length, textMentions)}
                </div>
              </div>
            </div>
          ) : shouldRenderPlanAcceptedCard ? (
            <div className="flex justify-start" data-user-bubble>
              <div
                className={cn(
                  agentsChatUserBubbleShellClass(),
                  'text-muted-foreground whitespace-normal',
                  showRollback && 'pr-10',
                )}
              >
                Plan accepted
              </div>
            </div>
          ) : (
            <UserBubbleComponent
              messageId={userMsgId}
              textContent={textContent}
              answeredQuestions={answeredQuestions ?? undefined}
              imageParts={isImageOnlyMessage ? imageParts : []}
              skipTextMentionBlocks={!isImageOnlyMessage}
              endGutter={showRollback}
            />
          )}

          {/* Rollback — inside the bubble, right side */}
          {showRollback && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2 z-20">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Revert to this message"
                    tabIndex={-1}
                    className="p-1 rounded-md transition-[background-color,transform] duration-150 ease-out active:scale-[0.97]"
                  >
                    <Undo2 className="w-3.5 h-3.5 text-muted-foreground" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" side="bottom" className="min-w-[180px]">
                  <DropdownMenuItem onClick={() => onRollback(userMsgId, rawTextContent, 'chat')}>
                    <MessageSquare className="w-3.5 h-3.5" />
                    Revert chat
                  </DropdownMenuItem>
                  {hasGitContext && !isFirstGroup && (
                    <DropdownMenuItem
                      onClick={() => onRollback(userMsgId, rawTextContent, 'chat-and-code')}
                    >
                      <Code2 className="w-3.5 h-3.5" />
                      Revert chat & code
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>

        {/* Cloning indicator */}
        {shouldShowCloning && (
          <div className="mt-4">
            <ToolCallComponent
              icon={toolRegistry['tool-cloning']?.icon ?? GitBranch}
              title={toolRegistry['tool-cloning']?.title({ type: 'cloning' }) || 'Cloning...'}
              isPending={true}
              isError={false}
            />
          </div>
        )}

        {/* Setup error with retry */}
        {shouldShowSetupError && (
          <div className="mt-4 p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
            <div className="flex items-center gap-2 text-destructive text-sm">
              <span>
                Failed to set up sandbox
                {sandboxSetupError ? `: ${sandboxSetupError}` : ''}
              </span>
              {onRetrySetup && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="px-2 py-1 text-sm hover:bg-destructive/20 rounded"
                  onClick={onRetrySetup}
                >
                  Retry
                </Button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* User message JSON display (dev only) */}
      {import.meta.env.DEV && showMessageJson && (
        <div className="pointer-events-auto mt-1 mb-2">
          <MessageJsonDisplay message={userMsg} label="User" />
        </div>
      )}

      {/* Assistant messages - memoized, only re-renders when IDs change */}
      {assistantIds.length > 0 && (
        <MemoizedAssistantMessages
          assistantMsgIds={assistantIds}
          subChatId={subChatId}
          chatId={chatId}
          isMobile={isMobile}
          sandboxSetupStatus={sandboxSetupStatus}
        />
      )}

      {showRetryAfterGroup && (
        <ChatRetryAfterGroupRow
          chatId={chatId}
          subChatId={subChatId}
          retryInFlight={retryInFlight}
          onRetryChat={onRetryChat}
          onCarryOnChat={onCarryOnChat}
          chatRetryTooltipText={chatRetryTooltipText}
        />
      )}

      {planningCard}
    </MessageGroupWrapper>
  );
}, areGroupPropsEqual);
