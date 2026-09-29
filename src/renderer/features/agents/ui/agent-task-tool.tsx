/* eslint-disable max-lines, max-lines-per-function */

import { Button } from '@benord-labs/frink-primitives';
import { useAtomValue } from 'jotai';
import { ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { NARRATION_PART_TYPES, SUBAGENT_TEXT_PART_TYPE } from '../../../../shared/subagent-parts';
import { TextShimmer } from '../../../components/ui/text-shimmer';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip';
import { isFlowPatchToolType } from '../../../lib/flows/flow-change-tool';
import { runningSubagentToolIdsAtom } from '../../../lib/stores/active-transport-registry';
import { cn } from '../../../lib/utils';
import type { MessagePart } from '../stores/message-store';
import { AgentFlowTool } from './AgentFlowTool';
import { AgentMcpToolCall } from './agent-mcp-tool-call';
import { AgentToolCall } from './agent-tool-call';
import {
  AgentToolRegistry,
  getSubagentLabel,
  getToolStatus,
  parseMcpToolType,
  resolveRegistryKey,
} from './agent-tool-registry';

type AgentTaskToolProps = {
  part: MessagePart;
  nestedTools: MessagePart[];
  chatStatus?: string;
  /** Owning sub-chat — passed to getToolStatus so the subagent override can check transport
   * liveness and stop animating "Running Subagent" once the run is dead (e.g. server restart). */
  subChatId: string;
  /** Whether this card belongs to the active (last) assistant turn. Only the active turn may
   * resurrect the spinner from transport liveness — a frozen, never-finished card in an OLDER turn
   * must stay "interrupted" even when a new run later re-registers the same subChatId. */
  isLastAssistantMessage: boolean;
};

// Constants for rendering
const MAX_VISIBLE_TOOLS = 5;
const TOOL_HEIGHT_PX = 24;

// Format elapsed time in a human-readable format
function formatElapsedTime(ms: number): string {
  if (ms < 1000) return '';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (remainingSeconds === 0) return `${minutes}m`;
  return `${minutes}m ${remainingSeconds}s`;
}

function findCurrentActionPart(
  nestedTools: MessagePart[],
  isPending: boolean,
  nestedChatStatus: string | undefined,
): MessagePart | undefined {
  const actionParts = nestedTools.filter((candidate) => !NARRATION_PART_TYPES.has(candidate.type));
  if (!isPending) return actionParts.at(-1);
  for (let index = actionParts.length - 1; index >= 0; index -= 1) {
    const candidate = actionParts[index];
    if (candidate && getToolStatus(candidate, nestedChatStatus).isPending) return candidate;
  }
  return actionParts.at(-1);
}

function flowPatchActionLabel(part: MessagePart, title: string): string {
  const operationCount = Array.isArray(part.input?.operations) ? part.input.operations.length : 0;
  if (operationCount === 0) return title;
  return `${title}: ${operationCount} ${operationCount === 1 ? 'change' : 'changes'}`;
}

function actionLabel(part: MessagePart): string {
  const resolvedType = resolveRegistryKey(part.type);
  const meta = AgentToolRegistry[resolvedType];
  const mcpInfo = parseMcpToolType(part.type);
  if (isFlowPatchToolType(part.type) && meta) return flowPatchActionLabel(part, meta.title(part));
  if (resolvedType === 'tool-frink_flows_patch' && mcpInfo) return mcpInfo.displayName;
  if (meta) {
    const title = meta.title(part);
    const subtitle = meta.subtitle?.(part);
    return subtitle ? `${title}: ${subtitle}` : title;
  }
  return mcpInfo?.displayName ?? part.type?.replace('tool-', '') ?? 'Tool';
}

export function AgentTaskTool({
  part,
  nestedTools,
  chatStatus,
  subChatId,
  isLastAssistantMessage,
}: AgentTaskToolProps) {
  // Pass subChatId to getToolStatus' transport-liveness override ONLY for the active turn's card.
  // Liveness is keyed per sub-chat, not per run, so a frozen pending card in an older turn would
  // otherwise re-animate when a new run re-registers the same subChatId — gate it to the last
  // assistant message. (Nested getToolStatus calls below act on non-subagent tools, so they omit it.)
  const { isPending: statusPending, isInterrupted } = getToolStatus(
    part,
    chatStatus,
    isLastAssistantMessage ? subChatId : undefined,
  );
  // An ASYNC launch resolves the tool part at launch, so part state reads completed while the
  // task runs — the live truth comes from main's task-frame tracker. Read via the atom so the
  // card follows task liveness independently from the root chat status.
  const taskRunning = useAtomValue(runningSubagentToolIdsAtom).has(part.toolCallId ?? '');
  const isPending = statusPending || taskRunning;
  // Nested tools belong to the subagent transport, which can remain live after the root chat
  // returns to ready. Preserve that liveness so an in-flight nested mutation is not mislabeled
  // as interrupted during the normal async-subagent lifecycle.
  const nestedChatStatus = isPending ? 'streaming' : chatStatus;

  // Default: collapsed
  const [isExpanded, setIsExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Track elapsed time for running tasks
  const [elapsedMs, setElapsedMs] = useState(0);

  // Label for the card subtitle — shared with the registry's subagent entry so the
  // card header and collapsed nested row stay in sync (native `Task` → `description`;
  // `Agent` tool → `subagent_type`/`prompt`).
  const description = getSubagentLabel(part.input);

  // Use startedAt from backend for persistent timing across re-renders
  // startedAt is in input, not directly on part
  const startedAt = typeof part.input?.startedAt === 'number' ? part.input.startedAt : undefined;

  // Track elapsed time while task is running using backend timestamp
  useEffect(() => {
    if (isPending && startedAt) {
      // Set initial elapsed time immediately
      setElapsedMs(Date.now() - startedAt);

      const interval = setInterval(() => {
        setElapsedMs(Date.now() - startedAt);
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [isPending, startedAt]);

  // Use output duration from Claude Code if available, otherwise use our tracked time
  // Safely extract duration with type guards
  const outputDuration =
    typeof part.output?.duration === 'number'
      ? part.output.duration
      : typeof part.output?.duration_ms === 'number'
        ? part.output.duration_ms
        : undefined;
  const displayMs = !isPending && outputDuration ? outputDuration : elapsedMs;
  const elapsedTimeDisplay = formatElapsedTime(displayMs);

  // Auto-scroll to bottom when streaming and new nested tools added
  useEffect(() => {
    if (isPending && isExpanded && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [isPending, isExpanded]);

  const hasNestedTools = nestedTools.length > 0;
  const hasExpandableOutput = !!(part.output?.output ?? part.errorText);
  const hasExpandableContent = hasNestedTools || hasExpandableOutput;

  // Current action for collapsed card: last pending step, else last completed (two-pass per critique)
  const currentAction = useMemo(() => {
    const activePart = findCurrentActionPart(nestedTools, isPending, nestedChatStatus);
    return activePart ? actionLabel(activePart) : null;
  }, [nestedTools, isPending, nestedChatStatus]);

  // Build subtitle - always show description
  const getSubtitle = (): string => {
    if (description) {
      const truncated = description.length > 60 ? `${description.slice(0, 57)}...` : description;
      return truncated;
    }
    return '';
  };

  const subtitle = getSubtitle();

  // Get title text based on status (include interrupted/failed so card always stays)
  const getTitle = () => {
    if (isInterrupted && !part.output) return 'Subagent interrupted';
    if (part.errorText) return 'Task failed';
    return isPending ? 'Running Subagent' : 'Completed Subagent';
  };

  return (
    <div className="rounded-lg border border-border glass-card overflow-hidden p-2">
      {/* Screen reader announcement for status transitions */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {isPending
          ? 'Task running'
          : isInterrupted && !part.output
            ? 'Task interrupted'
            : part.output
              ? 'Task completed'
              : part.errorText
                ? 'Task failed'
                : ''}
      </div>
      {/* Header - clickable to toggle, same style as AgentExploringGroup */}
      <Button
        variant="ghost"
        size="auto"
        onClick={() => setIsExpanded(!isExpanded)}
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} task details`}
        className="w-full justify-start text-left font-normal group flex gap-1.5 w-full min-h-0 py-1 -mx-2 px-2 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card rounded-md"
      >
        <div className="flex-1 min-w-0 flex items-center gap-1">
          <div className="text-xs flex items-center gap-1.5 min-w-0">
            {/* Title with shimmer when running; muted when completed/interrupted/failed */}
            {isPending && !isInterrupted ? (
              <TextShimmer
                as="span"
                duration={1.2}
                className="font-medium whitespace-nowrap shrink-0"
              >
                {getTitle()}
              </TextShimmer>
            ) : (
              <span className="font-medium whitespace-nowrap shrink-0 text-muted-foreground">
                {getTitle()}
              </span>
            )}
            {subtitle && <span className="text-muted-foreground/60 truncate">{subtitle}</span>}
            {/* Show elapsed time while running or final time when done */}
            {elapsedTimeDisplay && (
              <span className="text-muted-foreground/50 tabular-nums shrink-0">
                {elapsedTimeDisplay}
              </span>
            )}
            {/* Chevron - only show when there's content to expand */}
            {hasExpandableContent && (
              <ChevronRight
                aria-hidden
                className={cn(
                  'w-3.5 h-3.5 text-muted-foreground/60 transition-transform duration-200 ease-out shrink-0',
                  isExpanded && 'rotate-90',
                  !isExpanded && 'opacity-0 group-hover:opacity-100',
                )}
              />
            )}
          </div>
        </div>
      </Button>

      {/* Current action line - collapsed card only, no gap from title */}
      {!isExpanded && hasNestedTools && currentAction && (
        <div>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-xs text-muted-foreground/60 truncate block cursor-default">
                {currentAction}
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-sm">
              <span className="text-xs font-mono whitespace-pre-wrap wrap-break-word">
                {currentAction}
              </span>
            </TooltipContent>
          </Tooltip>
        </div>
      )}

      {/* Agent output (subagent cards) - show when expanded, no nested tools */}
      {!hasNestedTools && isExpanded && (part.output?.output ?? part.errorText) && (
        <div className="mt-1">
          <pre className="text-xs text-muted-foreground whitespace-pre-wrap wrap-break-word font-sans max-h-64 overflow-y-auto rounded-md border border-border/50 bg-muted/30 p-2">
            {part.output?.output != null
              ? typeof part.output.output === 'string'
                ? part.output.output
                : JSON.stringify(part.output.output)
              : (part.errorText ?? '')}
          </pre>
        </div>
      )}

      {/* Nested tools - only show when expanded, same card (no inner card) */}
      {hasNestedTools && isExpanded && (
        <div className="mt-1">
          {/* Scrollable container - auto-scrolls to bottom when streaming */}
          {(() => {
            const shouldLimitHeight = isPending && nestedTools.length > MAX_VISIBLE_TOOLS;
            return (
              <div
                ref={scrollRef}
                className={cn(
                  'space-y-1.5',
                  // Top fade as a mask, so it works over a translucent card.
                  shouldLimitHeight &&
                    'overflow-y-auto scrollbar-hide mask-t-from-[calc(100%-2rem)]',
                )}
                style={
                  shouldLimitHeight
                    ? { maxHeight: `${MAX_VISIBLE_TOOLS * TOOL_HEIGHT_PX}px` }
                    : undefined
                }
              >
                {nestedTools.map((nestedPart) => {
                  const nestedResolvedType = resolveRegistryKey(nestedPart.type);
                  const nestedMeta = AgentToolRegistry[nestedResolvedType];
                  const nestedMcpInfo = parseMcpToolType(nestedPart.type);
                  // Safely extract description with type guard
                  const nestedDescription =
                    typeof nestedPart.input?.description === 'string'
                      ? nestedPart.input.description
                      : '';
                  const stableKey =
                    nestedPart.toolCallId ||
                    `${nestedPart.type}-${nestedDescription.slice(0, 20) || 'unknown'}`;
                  if (nestedPart.type === SUBAGENT_TEXT_PART_TYPE) {
                    const prose =
                      typeof nestedPart.input?.text === 'string' ? nestedPart.input.text : '';
                    if (!prose.trim()) return null;
                    return (
                      <div
                        key={stableKey}
                        className={cn(
                          'whitespace-pre-wrap break-words py-0.5 text-xs text-muted-foreground',
                          // The live ticker's window is sized in single rows, so an unclamped
                          // paragraph would fill it and hide the tool calls it exists to show.
                          isPending && 'line-clamp-2',
                        )}
                      >
                        {prose}
                      </div>
                    );
                  }
                  if (isFlowPatchToolType(nestedPart.type)) {
                    return (
                      <AgentFlowTool
                        key={stableKey}
                        part={nestedPart}
                        chatStatus={nestedChatStatus}
                        nested
                      />
                    );
                  }
                  if (nestedResolvedType === 'tool-frink_flows_patch' && nestedMcpInfo) {
                    return (
                      <AgentMcpToolCall
                        key={stableKey}
                        part={nestedPart}
                        mcpInfo={nestedMcpInfo}
                        chatStatus={nestedChatStatus}
                        nested
                      />
                    );
                  }
                  if (nestedMeta) {
                    const { isPending: nestedIsPending, isError: nestedIsError } = getToolStatus(
                      nestedPart,
                      nestedChatStatus,
                    );
                    const subtitle =
                      nestedMeta.subtitleLong?.(nestedPart) ?? nestedMeta.subtitle?.(nestedPart);
                    return (
                      <AgentToolCall
                        key={stableKey}
                        icon={nestedMeta.icon}
                        title={nestedMeta.title(nestedPart)}
                        subtitle={subtitle}
                        tooltipContent={nestedMeta.tooltipContent?.(nestedPart)}
                        isPending={nestedIsPending}
                        isError={nestedIsError}
                        allowWrap
                        titleShimmerVariant={nestedMeta.titleShimmerVariant}
                      />
                    );
                  }
                  if (nestedMcpInfo) {
                    return (
                      <AgentMcpToolCall
                        key={stableKey}
                        part={nestedPart}
                        mcpInfo={nestedMcpInfo}
                        chatStatus={nestedChatStatus}
                        nested
                      />
                    );
                  }
                  return (
                    <div key={stableKey} className="text-xs text-muted-foreground py-0.5">
                      {nestedPart.type?.replace('tool-', '')}
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
