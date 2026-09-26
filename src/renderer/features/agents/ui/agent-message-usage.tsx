import { Button } from '@benord-labs/frink-primitives';
import { memo } from 'react';
import type { AssistantMessageMetadata } from '../../../../shared/types/assistant-message';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../../components/ui/hover-card';
import { cn } from '../../../lib/utils';

/** Re-exported under the local name its consumers already use; the shape is process-shared. */
export type AgentMessageMetadata = AssistantMessageMetadata;

type AgentMessageUsageProps = {
  metadata?: AgentMessageMetadata;
  isStreaming?: boolean;
  isMobile?: boolean;
};

function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return tokens.toString();
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

export const AgentMessageUsage = memo(function AgentMessageUsage({
  metadata,
  isStreaming = false,
  isMobile: _isMobile = false,
}: AgentMessageUsageProps) {
  if (!metadata || isStreaming) return null;

  const {
    inputTokens = 0,
    outputTokens = 0,
    totalTokens = 0,
    durationMs,
    resultSubtype,
  } = metadata;

  const hasUsage = inputTokens > 0 || outputTokens > 0;

  if (!hasUsage) return null;

  const displayTokens = totalTokens || inputTokens + outputTokens;

  return (
    <HoverCard openDelay={400} closeDelay={100}>
      <HoverCardTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          tabIndex={-1}
          className={cn(
            'h-5 px-1.5 text-[10px]',
            'text-muted-foreground/60 hover:text-muted-foreground',
            'transition-[background-color,transform] duration-150 ease-out',
          )}
        >
          <span className="font-mono">{formatTokens(displayTokens)}</span>
        </Button>
      </HoverCardTrigger>
      <HoverCardContent
        sideOffset={4}
        align="end"
        className="w-auto pt-2 px-2 pb-0 shadow-xs rounded-lg border-border/50 overflow-hidden"
      >
        <div className="space-y-1.5 pb-2">
          {/* Status & Duration group */}
          {(resultSubtype || (durationMs !== undefined && durationMs > 0)) && (
            <div className="space-y-1">
              {resultSubtype && (
                <div className="flex justify-between text-xs gap-4">
                  <span className="text-muted-foreground">Status:</span>
                  <span className="font-mono text-foreground">
                    {resultSubtype === 'success' ? 'Success' : 'Failed'}
                  </span>
                </div>
              )}

              {durationMs !== undefined && durationMs > 0 && (
                <div className="flex justify-between text-xs gap-4">
                  <span className="text-muted-foreground">Duration:</span>
                  <span className="font-mono text-foreground">{formatDuration(durationMs)}</span>
                </div>
              )}
            </div>
          )}

          {/* Tokens group */}
          {displayTokens > 0 && (
            <div className="flex justify-between text-xs gap-4 pt-1.5 mt-1 border-t border-border/50">
              <span className="text-muted-foreground">Tokens:</span>
              <span className="font-mono font-medium text-foreground">
                {displayTokens.toLocaleString()}
              </span>
            </div>
          )}
        </div>
      </HoverCardContent>
    </HoverCard>
  );
});
