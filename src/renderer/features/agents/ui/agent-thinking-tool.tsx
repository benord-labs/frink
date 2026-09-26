import { Button } from '@benord-labs/frink-primitives';
import { ChevronRight } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import { ChatMarkdownRenderer } from '../../../components/chat-markdown-renderer';
import { cn } from '../../../lib/utils';
import { AgentToolInterrupted } from './agent-tool-interrupted';
import { getToolStatus } from './agent-tool-registry';
import { areToolPropsEqual } from './agent-tool-utils';

const NEWLINE_TO_SPACE_REGEX = /\n/g;

export type ThinkingToolPart = {
  type: string;
  state?: string;
  toolCallId?: string;
  input?: {
    text?: string;
  };
  output?: {
    completed?: boolean;
  };
};

type AgentThinkingToolProps = {
  part: ThinkingToolPart;
  chatStatus?: string;
};

// Constants for thinking preview and scrolling
const PREVIEW_LENGTH = 60;
const SCROLL_THRESHOLD = 500;

export const AgentThinkingTool = memo(function AgentThinkingTool({
  part,
  chatStatus,
}: AgentThinkingToolProps) {
  // Always via getToolStatus, never re-derived locally — it is the single judge of terminal-ness.
  const { isPending: isStreaming, isInterrupted } = getToolStatus(part, chatStatus);
  // Get thinking text
  const thinkingText = part.input?.text || '';

  // Default: expanded while streaming, collapsed when done
  const [isExpanded, setIsExpanded] = useState(isStreaming);
  const wasStreamingRef = useRef(isStreaming);
  const scrollRef = useRef<HTMLDivElement>(null);
  const thinkingLengthRef = useRef(thinkingText.length);
  thinkingLengthRef.current = thinkingText.length;

  // Auto-collapse when streaming ends (transition from true -> false)
  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming && thinkingLengthRef.current > PREVIEW_LENGTH) {
      setIsExpanded(false);
    }
    wasStreamingRef.current = isStreaming;
  }, [isStreaming]);

  // Auto-scroll to bottom when streaming; re-run as streamed thinking grows (max-h box).
  // biome-ignore lint/correctness/useExhaustiveDependencies: thinkingText.length is an intentional scroll trigger (DOM height follows content after commit)
  useEffect(() => {
    if (!isStreaming || !isExpanded || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [isStreaming, isExpanded, thinkingText.length]);

  // Build preview for collapsed state
  const previewText = thinkingText.slice(0, PREVIEW_LENGTH).replace(NEWLINE_TO_SPACE_REGEX, ' ');
  const isPreviewTruncated = thinkingText.length > PREVIEW_LENGTH;

  // Show interrupted state if thinking was interrupted without completing
  if (isInterrupted && !thinkingText) {
    return <AgentToolInterrupted toolName="Thinking" />;
  }

  return (
    <div>
      {/* Header - clickable to toggle, same as Exploring */}
      <Button
        variant="ghost"
        size="auto"
        onClick={() => setIsExpanded(!isExpanded)}
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} thinking content`}
        className="w-full justify-start text-left font-normal group flex items-start gap-1.5 py-0.5 px-2 hover:bg-transparent"
      >
        <div className="flex-1 min-w-0 flex items-center gap-1">
          <div className="text-xs flex items-center gap-1.5 min-w-0">
            <span className="font-medium whitespace-nowrap shrink-0 text-muted-foreground">
              {isStreaming ? 'Thinking' : 'Thought'}
            </span>
            {/* Preview text when collapsed */}
            {!isExpanded && previewText.trim() && (
              <span className="text-muted-foreground/60 truncate">
                {isPreviewTruncated ? `${previewText}...` : previewText}
              </span>
            )}
            {/* Chevron - rotates when expanded, visible on hover when collapsed */}
            <ChevronRight
              className={cn(
                'w-3.5 h-3.5 text-muted-foreground/60 transition-transform duration-200 ease-out shrink-0',
                isExpanded && 'rotate-90',
                !isExpanded && 'opacity-0 group-hover:opacity-100',
              )}
            />
          </div>
        </div>
      </Button>

      {/* Thinking content - only show when expanded */}
      {isExpanded && thinkingText && (
        <div className="opacity-85">
          {/* Single opacity layer: ChatMarkdownRenderer uses text-foreground on children */}
          <div
            ref={scrollRef}
            className={cn(
              'px-2',
              // Top fade as a mask, so it works over translucent panes.
              isStreaming &&
                thinkingText.length > SCROLL_THRESHOLD &&
                'overflow-y-auto scrollbar-none max-h-24 mask-t-from-[calc(100%-1.25rem)]',
            )}
          >
            <ChatMarkdownRenderer content={thinkingText} size="sm" />
            {/* Blinking cursor when streaming */}
            {isStreaming && (
              <span className="inline-block w-1 h-3 bg-muted-foreground/50 ml-0.5 animate-pulse" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}, areToolPropsEqual);
