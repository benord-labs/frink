/* eslint-disable max-lines, max-lines-per-function */

import { Button } from '@benord-labs/frink-primitives';
import { useAtomValue } from 'jotai';
import { ListTree, Minimize2, Maximize2 } from 'lucide-react';
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isHtmlArtifactPart } from '../../../../shared/lib/artifacts/html-artifact';
import {
  type CanonicalPlanPartLike,
  extractCanonicalPlanTextForFilter,
  filterCanonicalPlanParts,
} from '../../../../shared/plan-parts-filter';
import { isFrinkPlanMessagePartType } from '../../../../shared/types/plan';
import {
  resolveRenderMarkdown,
  useChatMarkdownToggle,
} from '../../../hooks/use-chat-markdown-toggle';
import { useReadImageFile } from '../../../lib/code-editor/files/use-read-image-file';
import { useCollapseBoundary } from '../../../lib/agent-chat/collapse/use-collapse-boundary';
import { pendingTurnCard } from '../../../lib/agent-chat/planning/planning-status-message';
import { compactingAtomFor } from '../lib/compaction-flag';
import * as FlowPatch from '../../../lib/flows/flow-change-tool';
import { cn } from '../../../lib/utils';
import { chatMarkdownModeAtom, showMessageJsonAtom } from '../atoms';
import { HtmlArtifactCard } from '../HtmlArtifactCard';
import type { Message, MessagePart } from '../stores/message-store';
import { AgentFlowRunTool } from '../ui/AgentFlowRunTool';
import { AgentFlowTool } from '../ui/AgentFlowTool';
import { AgentGenericToolCall } from '../ui/AgentGenericToolCall';
import { AgentImageGenerationTool } from '../ui/AgentImageGenerationTool';
import { AgentAskUserQuestionTool } from '../ui/agent-ask-user-question-tool';
import { AgentBashTool } from '../ui/agent-bash-tool';
import { AgentEditTool } from '../ui/agent-edit-tool';
import { AgentExploringGroup } from '../ui/agent-exploring-group';
import { AgentMcpToolCall } from '../ui/agent-mcp-tool-call';
import { type AgentMessageMetadata, AgentMessageUsage } from '../ui/agent-message-usage';
import { AgentPlanTool } from '../ui/agent-plan-tool';
import { AgentTaskTool } from '../ui/agent-task-tool';
import { AgentTaskToolsGroup } from '../ui/agent-task-tools';
import { AgentThinkingTool, type ThinkingToolPart } from '../ui/agent-thinking-tool';
import { AgentTodoTool } from '../ui/agent-todo-tool';
import { AgentToolCall } from '../ui/agent-tool-call';
import { AgentTurnInterrupted } from '../ui/agent-tool-interrupted';
import {
  AgentToolRegistry,
  getToolStatus,
  isSubagentTaskPart,
  parseMcpToolType,
  resolveRegistryKey,
} from '../ui/agent-tool-registry';
import { AgentWebFetchTool } from '../ui/agent-web-fetch-tool';
import { AgentWebSearchCollapsible } from '../ui/agent-web-search-collapsible';
import {
  CopyButton,
  getMessageTextContent,
  MarkdownToggleButton,
} from '../ui/message-action-buttons';
import { MessageJsonDisplay } from '../ui/message-json-display';
import {
  buildNestedToolsMap,
  groupExploringTools,
  groupTaskTools,
  isExploringGroup,
  isTaskGroup,
} from './active-chat/utils';
import { toAgentPlanToolPartFromFrinkPlan } from './assistant-message-item-plan-part';
import { MemoizedTextPart } from './memoized-text-part';

type CollapsibleStepsProps = {
  stepsCount: number;
  children: React.ReactNode;
  defaultExpanded?: boolean;
};

function CollapsibleSteps({
  stepsCount,
  children,
  defaultExpanded = false,
}: CollapsibleStepsProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  const handleToggle = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleToggle();
      }
    },
    [handleToggle],
  );

  if (stepsCount === 0) return null;

  return (
    <div className="mb-2" data-collapsible-steps="true">
      <Button
        variant="ghost"
        size="auto"
        className="w-full justify-start text-left font-normal flex justify-between rounded-md py-0.5 px-2 focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2"
        onClick={handleToggle}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${stepsCount} ${stepsCount === 1 ? 'step' : 'steps'}`}
      >
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ListTree className="w-3.5 h-3.5 shrink-0" />
          <span className="font-medium whitespace-nowrap">
            {stepsCount} {stepsCount === 1 ? 'step' : 'steps'}
          </span>
        </div>
        <span className="p-1 rounded-md" aria-hidden="true">
          <div className="relative w-4 h-4">
            <Maximize2
              className={cn(
                'absolute inset-0 w-4 h-4 text-muted-foreground transition-[opacity,transform] duration-200 ease-out',
                isExpanded ? 'opacity-0 scale-75' : 'opacity-100 scale-100',
              )}
            />
            <Minimize2
              className={cn(
                'absolute inset-0 w-4 h-4 text-muted-foreground transition-[opacity,transform] duration-200 ease-out',
                isExpanded ? 'opacity-100 scale-100' : 'opacity-0 scale-75',
              )}
            />
          </div>
        </span>
      </Button>
      {isExpanded && <div className="mt-1 space-y-1.5">{children}</div>}
    </div>
  );
}

// Assistant message item — memoized by message id + parts length.

type AssistantMessageItemProps = {
  message: Message;
  isLastMessage: boolean;
  isLastAssistantMessage: boolean;
  isStreaming: boolean;
  status: string;
  isMobile: boolean;
  subChatId: string;
  /** Unused — kept for plumbing parity with messages-list/isolated-message-group. */
  chatId: string;
  sandboxSetupStatus?: 'cloning' | 'ready' | 'error';
};
const isHoistedFromCollapse = (part: MessagePart): boolean =>
  isFrinkPlanMessagePartType(part.type) ||
  part.type === 'tool-AskUserQuestion' ||
  part.type === 'tool-ImageGeneration' ||
  FlowPatch.isRootFlowPatchToolPart(part);

// Cache for tracking previous message state per message (to detect AI SDK in-place mutations)
// Stores both text lengths and tool states for complete change detection
type MessageStateSnapshot = {
  textLengths: number[];
  partStates: (string | undefined)[];
  lastPartInputJson: string | undefined;
  /** Metadata-only change: an involuntary teardown can stamp the reason without adding a part. */
  interruptedBy: string | undefined;
};
const messageStateCache = new Map<string, MessageStateSnapshot>();

/** Every prop that is cheap to compare by identity. `message` is excluded — the AI SDK mutates it
 * in place, so it needs the snapshot comparison below. */
const SCALAR_PROPS = [
  'status',
  'isStreaming',
  'isLastMessage',
  'isLastAssistantMessage',
  'isMobile',
  'subChatId',
  'chatId',
  'sandboxSetupStatus',
] as const satisfies readonly (keyof AssistantMessageItemProps)[];

// Custom comparison - check if message content actually changed
// CRITICAL: AI SDK mutates objects in-place! So prev.message.parts[i].text === next.message.parts[i].text
// even when text HAS changed (they're the same mutated object).
// Solution: Cache state externally and compare those.
function areMessagePropsEqual(
  prev: AssistantMessageItemProps,
  next: AssistantMessageItemProps,
): boolean {
  if (prev.message?.id !== next.message?.id) return false;
  if (SCALAR_PROPS.some((key) => prev[key] !== next[key])) return false;

  const msgId = next.message?.id;
  const current = snapshotMessageState(next);
  const cached = msgId ? messageStateCache.get(msgId) : undefined;
  if (cached && sameMessageState(cached, current)) return true;

  if (msgId) messageStateCache.set(msgId, current);
  return false;
}

function snapshotMessageState(props: AssistantMessageItemProps): MessageStateSnapshot {
  const parts = props.message?.parts || [];
  const lastPart = parts[parts.length - 1];
  return {
    textLengths: parts.map((p: MessagePart) => (p.type === 'text' ? p.text?.length || 0 : -1)),
    // ALL part states — critical for detecting Edit plan file streaming.
    partStates: parts.map((p: MessagePart) => p.state),
    // Tool input changes — critical for tool streaming.
    lastPartInputJson: lastPart?.input ? JSON.stringify(lastPart.input) : undefined,
    interruptedBy: (props.message?.metadata as AgentMessageMetadata | undefined)?.interruptedBy,
  };
}

function sameMessageState(a: MessageStateSnapshot, b: MessageStateSnapshot): boolean {
  return (
    // Metadata-only: a teardown stamps its reason without touching any part, so nothing below sees it.
    a.interruptedBy === b.interruptedBy &&
    a.lastPartInputJson === b.lastPartInputJson &&
    a.textLengths.length === b.textLengths.length &&
    a.textLengths.every((len, i) => len === b.textLengths[i]) &&
    a.partStates.every((state, i) => state === b.partStates[i])
  );
}

/**
 * Dev-only: isolates showMessageJson subscription from the main message body.
 * The toggle atom is global — all mounted assistant rows subscribe; intended for local debugging, not per-pane UX.
 */
const AssistantMessageJsonDebug = memo(function AssistantMessageJsonDebug({
  message,
}: {
  message: Message;
}) {
  const showMessageJson = useAtomValue(showMessageJsonAtom);
  if (!showMessageJson) return null;
  return (
    <div className="px-2 mt-2">
      <MessageJsonDisplay message={message} label="Assistant" />
    </div>
  );
});

/** Copy / usage row for assistant messages. */
const AssistantMessageFooterRow = memo(function AssistantMessageFooterRow({
  message,
  isStreaming,
  isMobile,
}: {
  message: Message;
  isStreaming: boolean;
  isMobile: boolean;
}) {
  const msgMetadata = message?.metadata as AgentMessageMetadata;
  const text = getMessageTextContent(message);
  // One toggle governs every text part of the message (getMessageTextContent joins them).
  const { renderMarkdown, showToggle, toggle } = useChatMarkdownToggle('assistant', text);
  return (
    <div className="flex justify-between items-center h-6 px-2 mt-1">
      <div className="flex items-center gap-0.5">
        <CopyButton text={text} isMobile={isMobile} />
        {showToggle && <MarkdownToggleButton rendered={renderMarkdown} onToggle={toggle} />}
      </div>
      <AgentMessageUsage metadata={msgMetadata} isStreaming={isStreaming} isMobile={isMobile} />
    </div>
  );
});

export const AssistantMessageItem = memo(function AssistantMessageItem({
  message,
  isLastMessage,
  isLastAssistantMessage,
  isStreaming,
  status,
  isMobile,
  subChatId,
  sandboxSetupStatus = 'ready',
}: AssistantMessageItemProps) {
  const messageParts = message?.parts || [];
  const interruptedBy = (message?.metadata as AgentMessageMetadata | undefined)?.interruptedBy;

  // One atom subscription per message (not per text part) — resolve the markdown
  // render mode for assistant bubbles (default rendered) and thread it down.
  const markdownMode = useAtomValue(chatMarkdownModeAtom);
  const renderMarkdown = resolveRenderMarkdown(markdownMode, 'assistant');

  /** Dedupe duplicate plan markdown in message parts when a frink-plan card already carries the same planText (matches executor `buildFinalPartsForPersist`). */
  const messagePartsForRender = useMemo(() => {
    const hasFrink = messageParts.some((p) => isFrinkPlanMessagePartType(p.type));
    if (!hasFrink) {
      return messageParts;
    }
    const partsLike = messageParts as CanonicalPlanPartLike[];
    const planText = extractCanonicalPlanTextForFilter(partsLike);
    const filtered = filterCanonicalPlanParts(partsLike, planText ?? undefined) as MessagePart[];
    return filtered;
  }, [messageParts]);

  // Debounce isStreaming→false to prevent steps from collapsing during brief
  // streaming gaps (e.g. chat move transitions). True propagates immediately.
  const [stableIsStreaming, setStableIsStreaming] = useState(isStreaming);
  const streamingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (isStreaming) {
      if (streamingTimerRef.current) {
        clearTimeout(streamingTimerRef.current);
        streamingTimerRef.current = null;
      }
      setStableIsStreaming(true);
    } else {
      streamingTimerRef.current = setTimeout(() => {
        setStableIsStreaming(false);
        streamingTimerRef.current = null;
      }, 600);
    }
    return () => {
      if (streamingTimerRef.current) clearTimeout(streamingTimerRef.current);
    };
  }, [isStreaming]);

  const contentParts = useMemo(
    () => messagePartsForRender.filter((p: MessagePart) => p.type !== 'step-start'),
    [messagePartsForRender],
  );

  const isSandboxReady = sandboxSetupStatus === 'ready';
  const hasNoContent = contentParts.length === 0;
  const shouldShowPlanning = isSandboxReady && isStreaming && isLastMessage && hasNoContent;
  const isCompacting = useAtomValue(compactingAtomFor(subChatId, shouldShowPlanning));
  const planningMeta = AgentToolRegistry['tool-planning'];
  const planningId = `ui-streaming-planning:${subChatId}:msg:${message.id}`;

  const { nestedToolsMap, nestedToolIds } = useMemo(
    () => buildNestedToolsMap(messagePartsForRender),
    [messagePartsForRender],
  );

  const {
    shouldCollapse,
    collapseBeforeIndex,
    hoistedEntries: hoistedCollapsedEntries,
    collapsedStepParts,
  } = useCollapseBoundary({
    messageId: message?.id,
    parts: messagePartsForRender,
    stableIsStreaming,
    isLastMessage,
    isHoisted: isHoistedFromCollapse,
  });

  const visibleStepsCount = useMemo(() => {
    return collapsedStepParts.filter((p: MessagePart) => {
      if (p.type === 'step-start') return false;
      if (p.type === 'tool-TaskOutput') return false;
      if (p.toolCallId && nestedToolIds.has(p.toolCallId)) return false;
      if (p.type === 'text' && !p.text?.trim()) return false;
      return true;
    }).length;
  }, [collapsedStepParts, nestedToolIds]);

  const finalParts = useMemo(() => {
    if (!shouldCollapse || collapseBeforeIndex === -1) return messagePartsForRender;
    return messagePartsForRender.slice(collapseBeforeIndex);
  }, [messagePartsForRender, shouldCollapse, collapseBeforeIndex]);

  const hasTextContent = useMemo(
    () => messagePartsForRender.some((p: MessagePart) => p.type === 'text' && p.text?.trim()),
    [messagePartsForRender],
  );

  const renderPart = useCallback(
    (part: MessagePart, idx: number, isFinal = false) => {
      if (part.type === 'step-start') return null;
      if (part.type === 'tool-TaskOutput') return null;
      // Plan mode: Claude emits this tool; IPC may suppress streaming — hide stray part so we don't print "ExitPlanMode" as text.
      if (part.type === 'tool-ExitPlanMode') return null;

      if (part.toolCallId && nestedToolIds.has(part.toolCallId)) return null;
      if (part.type === 'exploring-group') return null;

      if (isHtmlArtifactPart(part)) {
        return <HtmlArtifactCard key={idx} artifact={part.data} />;
      }

      if (part.type === 'text') {
        if (!part.text?.trim()) return null;
        // One response per turn: every wake burst ends in text, but only the last is the answer.
        const isFinalText = isFinal && isLastAssistantMessage && idx === collapseBeforeIndex;
        const isTextStreaming = isLastMessage && isStreaming;
        return (
          <MemoizedTextPart
            key={idx}
            text={part.text}
            messageId={message.id}
            partIndex={idx}
            isFinalText={isFinalText}
            visibleStepsCount={visibleStepsCount}
            isStreaming={isTextStreaming}
            renderMarkdown={renderMarkdown}
          />
        );
      }

      if (isSubagentTaskPart(part)) {
        const nestedTools = part.toolCallId ? nestedToolsMap.get(part.toolCallId) || [] : [];
        return (
          <AgentTaskTool
            key={idx}
            part={part}
            nestedTools={nestedTools}
            chatStatus={status}
            subChatId={subChatId}
            isLastAssistantMessage={isLastAssistantMessage}
          />
        );
      }

      if (part.type === 'tool-Bash')
        return (
          <AgentBashTool
            key={idx}
            part={part}
            messageId={message.id}
            partIndex={idx}
            chatStatus={status}
          />
        );
      if (part.type === 'tool-Thinking') {
        // Ensure part matches ThinkingToolPart shape
        const thinkingPart: ThinkingToolPart = {
          type: part.type,
          state: part.state,
          toolCallId: typeof part.toolCallId === 'string' ? part.toolCallId : undefined,
          input:
            part.input && typeof part.input === 'object' && 'text' in part.input
              ? { text: typeof part.input.text === 'string' ? part.input.text : undefined }
              : undefined,
          output:
            part.output && typeof part.output === 'object' && 'completed' in part.output
              ? {
                  completed:
                    typeof part.output.completed === 'boolean' ? part.output.completed : undefined,
                }
              : undefined,
        };
        return <AgentThinkingTool key={idx} part={thinkingPart} chatStatus={status} />;
      }

      if (part.type === 'tool-Edit' || part.type === 'tool-Write')
        return (
          <AgentEditTool
            key={idx}
            part={part}
            messageId={message.id}
            partIndex={idx}
            chatStatus={status}
          />
        );
      if (part.type === 'tool-WebSearch')
        return <AgentWebSearchCollapsible key={idx} part={part} chatStatus={status} />;
      if (part.type === 'tool-WebFetch')
        return <AgentWebFetchTool key={idx} part={part} chatStatus={status} />;
      if (part.type === 'tool-ImageGeneration')
        return (
          <AgentImageGenerationTool
            key={idx}
            part={part}
            chatStatus={status}
            useReadImage={useReadImageFile}
          />
        );
      // Canonical frink-plan: render as structured plan card with todos.
      if (isFrinkPlanMessagePartType(part.type)) {
        const adaptedPart = toAgentPlanToolPartFromFrinkPlan(part);
        if (!adaptedPart) return null;
        return (
          <AgentPlanTool
            key={idx}
            part={adaptedPart}
            chatStatus={status}
            subChatId={subChatId}
            isStreaming={isStreaming}
          />
        );
      }

      if (part.type === 'tool-TodoWrite') {
        // Ensure part matches TodoTool type requirements
        if (!part.toolCallId) return null;
        const todoPart = {
          type: part.type,
          toolCallId: part.toolCallId,
          state: part.state,
          input:
            part.input && typeof part.input === 'object' && 'todos' in part.input
              ? (part.input as {
                  todos?: Array<{
                    content: string;
                    status: 'pending' | 'in_progress' | 'completed';
                    activeForm?: string;
                  }>;
                })
              : undefined,
          output:
            part.output &&
            typeof part.output === 'object' &&
            ('oldTodos' in part.output || 'newTodos' in part.output)
              ? (part.output as {
                  oldTodos?: Array<{
                    content: string;
                    status: 'pending' | 'in_progress' | 'completed';
                    activeForm?: string;
                  }>;
                  newTodos?: Array<{
                    content: string;
                    status: 'pending' | 'in_progress' | 'completed';
                    activeForm?: string;
                  }>;
                })
              : undefined,
        };
        return (
          <AgentTodoTool key={idx} part={todoPart} chatStatus={status} subChatId={subChatId} />
        );
      }

      if (part.type === 'tool-AskUserQuestion') {
        const { isPending, isError } = getToolStatus(part, status);
        // Type narrow input to match expected shape
        const input =
          part.input && typeof part.input === 'object' && 'questions' in part.input
            ? (part.input as {
                questions?: Array<{
                  question: string;
                  header: string;
                  options: Array<{ label: string; description: string }>;
                  multiSelect: boolean;
                }>;
              })
            : { questions: undefined };
        // A LIVE part carries only `output` (the SDK's own field); persistence mirrors it into
        // `result` as well. Reading `result` alone left an answered question rendering "Waiting for
        // response..." for the rest of the turn, and correct only after a reload.
        const answered = part.output ?? part.result;
        const result =
          answered &&
          typeof answered === 'object' &&
          ('questions' in answered || 'answers' in answered)
            ? (answered as { questions?: unknown; answers?: Record<string, string> })
            : typeof answered === 'string'
              ? answered
              : undefined;
        return (
          <AgentAskUserQuestionTool
            key={idx}
            input={input}
            result={result}
            errorText={part.errorText || (typeof part.error === 'string' ? part.error : undefined)}
            state={isPending ? 'call' : 'result'}
            isError={isError}
            isStreaming={isStreaming && isLastMessage}
            toolCallId={part.toolCallId}
          />
        );
      }

      const resolvedType = resolveRegistryKey(part.type);
      const mcpInfo = parseMcpToolType(part.type);
      const isGenericFlowPatch =
        mcpInfo !== null && FlowPatch.isGenericFlowPatchTool(part.type, resolvedType);

      if (FlowPatch.isFlowPatchToolType(part.type)) {
        return <AgentFlowTool key={idx} part={part} chatStatus={status} />;
      }

      if (resolvedType === 'tool-frink_flows_run') {
        return <AgentFlowRunTool key={idx} part={part} chatStatus={status} />;
      }

      if (resolvedType in AgentToolRegistry && !isGenericFlowPatch) {
        const meta = AgentToolRegistry[resolvedType];
        const { isPending, isError } = getToolStatus(part, status);
        return (
          <AgentToolCall
            key={idx}
            icon={meta.icon}
            title={meta.title(part)}
            subtitle={meta.subtitle?.(part)}
            isPending={isPending}
            isError={isError}
            titleShimmerVariant={meta.titleShimmerVariant}
          />
        );
      }

      // MCP tool calls (pattern: tool-mcp__<server>__<tool>). Pass raw part.type,
      // not resolvedType — resolveRegistryKey strips the MCP prefix for registry
      // lookup, which would defeat parseMcpToolType.
      if (mcpInfo) {
        return <AgentMcpToolCall key={idx} part={part} mcpInfo={mcpInfo} chatStatus={status} />;
      }

      if (part.type?.startsWith('tool-')) {
        return <AgentGenericToolCall key={idx} part={part} chatStatus={status} />;
      }

      return null;
    },
    [
      nestedToolsMap,
      nestedToolIds,
      collapseBeforeIndex,
      visibleStepsCount,
      status,
      isLastMessage,
      isLastAssistantMessage,
      isStreaming,
      subChatId,
      message.id,
      renderMarkdown,
    ],
  );

  if (!message) return null;

  return (
    <div data-assistant-message-id={message.id} className="group/message w-full mb-4">
      <div className="flex flex-col gap-1.5">
        {shouldCollapse && visibleStepsCount > 0 && (
          <CollapsibleSteps stepsCount={visibleStepsCount}>
            {(() => {
              const taskGrouped = groupTaskTools(collapsedStepParts, nestedToolIds);
              const grouped = groupExploringTools(taskGrouped, nestedToolIds);
              return grouped.map(
                (
                  part:
                    | MessagePart
                    | { type: 'exploring-group'; parts: MessagePart[] }
                    | { type: 'task-group'; parts: MessagePart[] },
                  idx: number,
                ) => {
                  if (isExploringGroup(part)) {
                    const isLast = idx === grouped.length - 1;
                    const isGroupStreaming = isStreaming && isLastMessage && isLast;
                    // Use first part's toolCallId as unique key, or fallback to composite key
                    const groupKey =
                      part.parts[0]?.toolCallId ||
                      `group-${part.parts.map((p: MessagePart) => p.toolCallId || '').join('-')}`;
                    return (
                      <AgentExploringGroup
                        key={groupKey}
                        parts={part.parts}
                        chatStatus={status}
                        isStreaming={isGroupStreaming}
                      />
                    );
                  }
                  if (isTaskGroup(part)) {
                    const isLast = idx === grouped.length - 1;
                    const isGroupStreaming = isStreaming && isLastMessage && isLast;
                    const groupKey =
                      part.parts[0]?.toolCallId ||
                      `task-group-${part.parts.map((p: MessagePart) => p.toolCallId || '').join('-')}`;
                    return (
                      <AgentTaskToolsGroup
                        key={groupKey}
                        parts={part.parts}
                        chatStatus={status}
                        isStreaming={isGroupStreaming}
                        subChatId={subChatId}
                      />
                    );
                  }
                  return renderPart(part, idx, false);
                },
              );
            })()}
          </CollapsibleSteps>
        )}

        {/* Durable artifacts remain visible after the turn's generic execution steps collapse. */}
        {hoistedCollapsedEntries.map(({ index, part }) => (
          <Fragment key={`hoisted-artifact-${message.id}-${index}`}>
            {renderPart(part, index, false)}
          </Fragment>
        ))}

        {(() => {
          const taskGrouped = groupTaskTools(finalParts, nestedToolIds);
          const grouped = groupExploringTools(taskGrouped, nestedToolIds);
          return grouped.map(
            (
              part:
                | MessagePart
                | { type: 'exploring-group'; parts: MessagePart[] }
                | { type: 'task-group'; parts: MessagePart[] },
              idx: number,
            ) => {
              if (isExploringGroup(part)) {
                const isLast = idx === grouped.length - 1;
                const isGroupStreaming = isStreaming && isLastMessage && isLast;
                // Use first part's toolCallId as unique key, or fallback to composite key
                const groupKey =
                  part.parts[0]?.toolCallId ||
                  `group-${part.parts.map((p: MessagePart) => p.toolCallId || '').join('-')}`;
                return (
                  <AgentExploringGroup
                    key={groupKey}
                    parts={part.parts}
                    chatStatus={status}
                    isStreaming={isGroupStreaming}
                  />
                );
              }
              if (isTaskGroup(part)) {
                const isLast = idx === grouped.length - 1;
                const isGroupStreaming = isStreaming && isLastMessage && isLast;
                const groupKey =
                  part.parts[0]?.toolCallId ||
                  `task-group-${part.parts.map((p: MessagePart) => p.toolCallId || '').join('-')}`;
                return (
                  <AgentTaskToolsGroup
                    key={groupKey}
                    parts={part.parts}
                    chatStatus={status}
                    isStreaming={isGroupStreaming}
                    subChatId={subChatId}
                  />
                );
              }
              return renderPart(
                part,
                shouldCollapse ? collapseBeforeIndex + idx : idx,
                shouldCollapse,
              );
            },
          );
        })()}

        {shouldShowPlanning && (
          <AgentToolCall {...pendingTurnCard(isCompacting, planningMeta, planningId)} />
        )}
      </div>

      {/* Survives the reload that caused it — the matching error IPC does not. */}
      {interruptedBy && <AgentTurnInterrupted reason={interruptedBy} />}

      {/* One action row per TURN: isLastAssistantMessage is per-group, not chat-wide. */}
      {hasTextContent && isLastAssistantMessage && (!isStreaming || !isLastMessage) && (
        <AssistantMessageFooterRow
          message={message}
          isStreaming={isStreaming}
          isMobile={isMobile}
        />
      )}

      {import.meta.env.DEV && <AssistantMessageJsonDebug message={message} />}
    </div>
  );
}, areMessagePropsEqual);
