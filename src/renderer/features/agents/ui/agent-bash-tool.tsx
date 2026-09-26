/* eslint-disable max-lines, max-lines-per-function */

import { Button } from '@benord-labs/frink-primitives';
import { Check, ShieldAlert, X, Minimize2, Maximize2, Loader2 } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { TextShimmer } from '../../../components/ui/text-shimmer';
import { cn } from '../../../lib/utils';
import type { MessagePart } from '../stores/message-store';
import { getBashToolDenialState } from './agent-bash-permission';
import { AgentToolInterrupted } from './agent-tool-interrupted';
import { getToolStatus } from './agent-tool-registry';
import { areToolPropsEqual, getOutputNumber, getOutputString } from './agent-tool-utils';

type AgentBashToolProps = {
  part: MessagePart;
  messageId?: string;
  partIndex?: number;
  chatStatus?: string;
};

// Regex patterns - hoisted to module level for performance
const LINE_CONTINUATION_REGEX = /\\\s*\n\s*/g;
const COMMAND_SEPARATOR_REGEX = /\s*(?:&&|\|\||;|\|)\s*/;
const WHITESPACE_SPLIT_REGEX = /\s+/;

// Extract command summary - first word of each command in a pipeline
function extractCommandSummary(command: string): string {
  // First, normalize line continuations (backslash + newline) into single line
  const normalizedCommand = command.replace(LINE_CONTINUATION_REGEX, ' ');
  const parts = normalizedCommand.split(COMMAND_SEPARATOR_REGEX);
  const firstWords = parts.map((p) => p.trim().split(WHITESPACE_SPLIT_REGEX)[0]).filter(Boolean);
  // Limit to first 4 commands to keep it concise
  const limited = firstWords.slice(0, 4);
  if (firstWords.length > 4) {
    return `${limited.join(', ')}...`;
  }
  return limited.join(', ');
}

// Limit output to first N lines
function limitLines(text: string, maxLines: number): { text: string; truncated: boolean } {
  if (!text) return { text: '', truncated: false };
  const lines = text.split('\n');
  if (lines.length <= maxLines) {
    return { text, truncated: false };
  }
  return { text: lines.slice(0, maxLines).join('\n'), truncated: true };
}

export const AgentBashTool = memo(function AgentBashTool({
  part,
  messageId,
  partIndex,
  chatStatus,
}: AgentBashToolProps) {
  const [isOutputExpanded, setIsOutputExpanded] = useState(false);
  const { isPending } = getToolStatus(part, chatStatus);

  const command = typeof part.input?.command === 'string' ? part.input.command : '';
  const stdout =
    getOutputString(part.output, 'stdout') || getOutputString(part.output, 'output') || '';
  const stderr = getOutputString(part.output, 'stderr');
  const exitCode = getOutputNumber(part.output, 'exitCode', 'exit_code');

  // Do not memoize on object identity: tool parts are mutated in-place while streaming.
  const { permissionDenied, denialReason } = getBashToolDenialState(part);

  // For bash tools, success/error: exitCode 0 = success; non-zero or generic tool-output-error = Failed
  const isSuccess = !permissionDenied && exitCode === 0;
  const isError =
    !permissionDenied &&
    ((exitCode !== undefined && exitCode !== 0) ||
      (part.state === 'output-error' && !!part.errorText));

  // Determine if we have any output (including permission denial message)
  const hasOutput = stdout || stderr || part.errorText || denialReason;

  // Limit output to 3 lines when collapsed
  const maxOutputLines = 3;
  const stdoutLimited = useMemo(() => limitLines(stdout, maxOutputLines), [stdout]);
  const stderrLimited = useMemo(() => limitLines(stderr, maxOutputLines), [stderr]);
  const hasMoreOutput = stdoutLimited.truncated || stderrLimited.truncated;

  // Memoize command summary to avoid recalculation on every render
  const commandSummary = useMemo(() => extractCommandSummary(command), [command]);

  // Shared status label for header (announced to assistive tech when it changes)
  const statusLabel = isPending
    ? 'Running command'
    : permissionDenied
      ? 'Blocked command'
      : isError
        ? 'Command failed'
        : 'Ran command';

  const renderStatusBadge = () => (
    <div className="flex items-center gap-1 text-xs text-muted-foreground min-w-[60px] justify-end">
      {isPending ? (
        <>
          <Loader2 className="w-3 h-3 animate-spin" aria-hidden />
          <span className="sr-only">Running command</span>
        </>
      ) : permissionDenied ? (
        <>
          <ShieldAlert className="w-3 h-3 text-amber-700 dark:text-amber-600" />
          <span>Command blocked</span>
        </>
      ) : isSuccess ? (
        <>
          <Check className="w-3 h-3" />
          <span>Success</span>
        </>
      ) : isError ? (
        <>
          <X className="w-3 h-3" />
          <span>Failed</span>
        </>
      ) : null}
    </div>
  );

  const renderPermissionDeniedReason = () =>
    permissionDenied && denialReason ? (
      <div className="mt-1.5 text-xs text-amber-700 dark:text-amber-600 whitespace-pre-wrap break-all">
        {denialReason}
      </div>
    ) : null;

  // Check if command input is still being streamed
  // Only consider streaming if chat is actively streaming (prevents hang on stop)
  // Include "submitted" status - this is when request was sent but streaming hasn't started yet
  const isActivelyStreaming = chatStatus === 'streaming' || chatStatus === 'submitted';
  const isInputStreaming = part.state === 'input-streaming' && isActivelyStreaming;

  // Determine if header/content is clickable
  const isHeaderClickable = hasMoreOutput && !isPending;
  const isContentClickable = !isOutputExpanded && hasMoreOutput && !isPending;

  // Handlers for header toggle
  const handleHeaderToggle = useCallback(() => {
    if (isHeaderClickable) {
      setIsOutputExpanded(!isOutputExpanded);
    }
  }, [isHeaderClickable, isOutputExpanded]);

  const handleHeaderKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isHeaderClickable && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        handleHeaderToggle();
      }
    },
    [isHeaderClickable, handleHeaderToggle],
  );

  // Handlers for content click (to expand when collapsed)
  const handleContentClick = useCallback(() => {
    if (isContentClickable) {
      setIsOutputExpanded(true);
    }
  }, [isContentClickable]);

  const handleContentKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isContentClickable && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        handleContentClick();
      }
    },
    [isContentClickable, handleContentClick],
  );

  // If command is still being generated (input-streaming state), show loading state
  if (isInputStreaming) {
    return (
      <div className="flex items-start gap-1.5 rounded-md py-0.5 px-2">
        <div className="flex-1 min-w-0 flex items-center gap-1.5">
          <div className="text-xs text-muted-foreground flex items-center gap-1.5 min-w-0">
            <span className="font-medium whitespace-nowrap shrink-0">
              <TextShimmer
                as="span"
                duration={1.2}
                className="inline-flex items-center text-xs leading-none h-4 m-0"
              >
                Generating command
              </TextShimmer>
            </span>
          </div>
        </div>
      </div>
    );
  }

  // If no command and not streaming, tool was interrupted
  if (!command) {
    return <AgentToolInterrupted toolName="Command" />;
  }

  const headerInner = (
    <>
      <span className="text-xs text-muted-foreground truncate flex-1 min-w-0">
        {statusLabel}: {commandSummary}
      </span>
      <div className="flex items-center gap-2 shrink-0 ml-2">
        <output aria-live="polite" className="contents">
          {renderStatusBadge()}
        </output>
        {!isPending && hasOutput && hasMoreOutput && (
          <span
            aria-hidden="true"
            className="p-1 rounded-md transition-[background-color,transform] duration-150 ease-out"
          >
            {isOutputExpanded ? (
              <Minimize2 className="w-4 h-4 text-muted-foreground" />
            ) : (
              <Maximize2 className="w-4 h-4 text-muted-foreground" />
            )}
          </span>
        )}
      </div>
    </>
  );

  const bodyInner = (
    <>
      <div className="font-mono text-xs">
        <span className="text-warning">$ </span>
        <span className="text-foreground whitespace-pre-wrap break-all">{command}</span>
      </div>
      {renderPermissionDeniedReason()}
      {stdout && (
        <div className="mt-1.5 font-mono text-xs text-muted-foreground whitespace-pre-wrap break-all">
          {isOutputExpanded ? stdout : stdoutLimited.text}
        </div>
      )}
      {stderr && (
        <div
          className={cn(
            'mt-1.5 font-mono text-xs whitespace-pre-wrap break-all',
            exitCode === 0 || exitCode === undefined
              ? 'text-warning'
              : 'text-rose-500 dark:text-rose-400',
          )}
        >
          {isOutputExpanded ? stderr : stderrLimited.text}
        </div>
      )}
    </>
  );

  return (
    <div
      data-message-id={messageId}
      data-part-index={partIndex}
      data-part-type="tool-Bash"
      className="rounded-lg border border-border glass-card overflow-hidden mx-2"
    >
      {/* Header - clickable to expand, fixed height to prevent layout shift */}
      {isHeaderClickable ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={handleHeaderToggle}
          onKeyDown={handleHeaderKeyDown}
          aria-expanded={isOutputExpanded}
          aria-label={`${isOutputExpanded ? 'Collapse' : 'Expand'} command output`}
          className={cn(
            'flex justify-between pl-2.5 pr-0.5 h-7 w-full rounded-none',
            'duration-150 focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2',
          )}
        >
          {headerInner}
        </Button>
      ) : (
        <div className="flex items-center justify-between pl-2.5 pr-0.5 h-7">{headerInner}</div>
      )}

      {/* Content - always visible, clickable to expand (only when collapsed and has more output) */}
      {isContentClickable ? (
        <Button
          variant="ghost"
          size="auto"
          onClick={handleContentClick}
          onKeyDown={handleContentKeyDown}
          aria-label="Click to expand full output"
          className={cn(
            'w-full justify-start text-left font-normal',
            'border-t border-border px-2.5 py-1.5 duration-150 rounded-none flex flex-col items-stretch',
            'focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2',
          )}
        >
          {bodyInner}
        </Button>
      ) : (
        <div className="border-t border-border px-2.5 py-1.5">{bodyInner}</div>
      )}
    </div>
  );
}, areToolPropsEqual);
