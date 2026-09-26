import { Button } from '@benord-labs/frink-primitives';
import { ChevronRight } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import { cn } from '../../../lib/utils';
import type { MessagePart } from '../stores/message-store';
import { AgentMcpToolCall } from './agent-mcp-tool-call';
import { AgentToolCall } from './agent-tool-call';
import {
  AgentToolRegistry,
  getToolStatus,
  parseMcpToolType,
  resolveRegistryKey,
} from './agent-tool-registry';
import { areExploringGroupPropsEqual } from './agent-tool-utils';

type AgentExploringGroupProps = {
  parts: MessagePart[];
  chatStatus?: string;
  isStreaming: boolean;
};

// Constants for rendering
const MAX_VISIBLE_TOOLS = 5;
const TOOL_HEIGHT_PX = 24;

export const AgentExploringGroup = memo(function AgentExploringGroup({
  parts,
  chatStatus,
  isStreaming,
}: AgentExploringGroupProps) {
  // Default: expanded while streaming, collapsed when done
  const [isExpanded, setIsExpanded] = useState(isStreaming);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasStreamingRef = useRef(isStreaming);

  // Auto-collapse when streaming ends (transition from true -> false)
  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming) {
      setIsExpanded(false);
    }
    wasStreamingRef.current = isStreaming;
  }, [isStreaming]);

  // Auto-scroll to bottom when streaming and new parts added
  useEffect(() => {
    if (isStreaming && isExpanded && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [isStreaming, isExpanded]);

  // Count files (Read, Grep, Glob) and searches (WebSearch, WebFetch)
  const fileCount = parts.filter((p) =>
    ['tool-Read', 'tool-Grep', 'tool-Glob'].includes(p.type),
  ).length;
  const searchCount = parts.filter((p) =>
    ['tool-WebSearch', 'tool-WebFetch'].includes(p.type),
  ).length;

  // Build subtitle parts
  const subtitleParts: string[] = [];
  if (fileCount > 0) {
    subtitleParts.push(`${fileCount} ${fileCount === 1 ? 'file' : 'files'}`);
  }
  if (searchCount > 0) {
    subtitleParts.push(`${searchCount} ${searchCount === 1 ? 'search' : 'searches'}`);
  }
  const subtitle = subtitleParts.join(' ');

  const handleToggle = () => {
    setIsExpanded(!isExpanded);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleToggle();
    }
  };

  return (
    <div>
      {/* Header - clickable to toggle */}
      <Button
        variant="ghost"
        size="auto"
        onClick={handleToggle}
        onKeyDown={handleKeyDown}
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} explored content`}
        className="w-full justify-start text-left font-normal group flex items-start gap-1.5 py-0.5 px-2 focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2 hover:bg-transparent"
      >
        <div className="flex-1 min-w-0 flex items-center gap-1">
          <div className="text-xs flex items-center gap-1.5 min-w-0">
            <span className="font-medium whitespace-nowrap shrink-0 text-muted-foreground">
              {isStreaming ? 'Exploring' : 'Explored'}
            </span>
            <span className="text-muted-foreground/60 whitespace-nowrap shrink-0">{subtitle}</span>
            {/* Chevron right after text - rotates when expanded */}
            <ChevronRight
              className={cn(
                'w-3.5 h-3.5 text-muted-foreground/60 transition-transform duration-200 ease-out',
                isExpanded && 'rotate-90',
                !isExpanded && 'opacity-0 group-hover:opacity-100',
              )}
            />
          </div>
        </div>
      </Button>

      {/* Tools list - only show when expanded */}
      {isExpanded && (
        <div className="mt-1">
          {/* Scrollable container - auto-scrolls to bottom when streaming */}
          {(() => {
            const shouldLimitHeight = parts.length > MAX_VISIBLE_TOOLS;
            return (
              <div
                ref={scrollRef}
                className={cn(
                  'space-y-1.5',
                  shouldLimitHeight && 'overflow-y-auto scrollbar-hide',
                  // Top fade while streaming: a mask, so it works over translucent panes.
                  shouldLimitHeight && isStreaming && 'mask-t-from-[calc(100%-2rem)]',
                )}
                style={
                  shouldLimitHeight
                    ? { maxHeight: `${MAX_VISIBLE_TOOLS * TOOL_HEIGHT_PX}px` }
                    : undefined
                }
              >
                {parts.map((part) => {
                  const meta = AgentToolRegistry[resolveRegistryKey(part.type)];
                  // Use toolCallId as unique key, fallback to type if missing
                  const partKey = part.toolCallId || part.type || 'unknown';
                  if (meta) {
                    const { isPending, isError } = getToolStatus(part, chatStatus);
                    return (
                      <AgentToolCall
                        key={partKey}
                        icon={meta.icon}
                        title={meta.title(part)}
                        subtitle={meta.subtitle?.(part)}
                        tooltipContent={meta.tooltipContent?.(part)}
                        isPending={isPending}
                        isError={isError}
                        titleShimmerVariant={meta.titleShimmerVariant}
                      />
                    );
                  }
                  const mcpInfo = parseMcpToolType(part.type);
                  if (mcpInfo) {
                    return (
                      <AgentMcpToolCall
                        key={partKey}
                        part={part}
                        mcpInfo={mcpInfo}
                        chatStatus={chatStatus}
                      />
                    );
                  }
                  return (
                    <div key={partKey} className="text-xs text-muted-foreground py-0.5 px-2">
                      {part.type?.replace('tool-', '')}
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
}, areExploringGroupPropsEqual);
