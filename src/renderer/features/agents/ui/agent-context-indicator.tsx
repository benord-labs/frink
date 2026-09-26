import { memo } from 'react';
import { z } from 'zod';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip';
import { cn } from '../../../lib/utils';

/** How full the context window is right now; `contextWindow` is null until a turn reports it.
 *  `promptCacheExpiresAt` (epoch ms) is null when the turn's provider reported no cache TTL. */
export type MessageTokenData = {
  contextTokens: number;
  contextWindow: number | null;
  promptCacheExpiresAt: number | null;
};

/** Pure comparison for ChatInputArea memo. */
export function messageTokenDataEqual(a: MessageTokenData, b: MessageTokenData): boolean {
  return (
    a.contextTokens === b.contextTokens &&
    a.contextWindow === b.contextWindow &&
    a.promptCacheExpiresAt === b.promptCacheExpiresAt
  );
}

/** The context fields a finished turn's metadata carries (see AssistantMessageMetadata). */
const contextMetadataSchema = z.object({
  contextTokens: z.number(),
  contextWindow: z.number().optional(),
  promptCacheExpiresAt: z.number().optional(),
});

/** Occupancy is a level, not a sum: the latest turn that reported it is the current value. */
export function contextUsageFromMessages(
  messages: readonly { metadata?: unknown }[],
): MessageTokenData {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parsed = contextMetadataSchema.safeParse(messages[i].metadata);
    if (parsed.success) {
      return {
        contextTokens: parsed.data.contextTokens,
        contextWindow: parsed.data.contextWindow ?? null,
        promptCacheExpiresAt: parsed.data.promptCacheExpiresAt ?? null,
      };
    }
  }
  return { contextTokens: 0, contextWindow: null, promptCacheExpiresAt: null };
}

type AgentContextIndicatorProps = {
  tokenData: MessageTokenData;
  className?: string;
  onCompact?: () => void;
  isCompacting?: boolean;
  disabled?: boolean;
};

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}K`;
  }
  return tokens.toString();
}

// Circular progress component
function CircularProgress({
  percent,
  size = 18,
  strokeWidth = 2,
  className,
}: {
  percent: number;
  size?: number;
  strokeWidth?: number;
  className?: string;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percent / 100) * circumference;

  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      className={cn('transform -rotate-90', className)}
      aria-label={`Context usage: ${percent.toFixed(1)}%`}
    >
      <title>Context usage: {percent.toFixed(1)}%</title>
      {/* Background circle */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        className="text-muted-foreground/20"
      />
      {/* Progress circle */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        className="transition-all duration-300 text-muted-foreground/60"
      />
    </svg>
  );
}

export const AgentContextIndicator = memo(function AgentContextIndicator({
  tokenData,
  className,
  onCompact,
  isCompacting,
  disabled,
}: AgentContextIndicatorProps) {
  const { contextTokens, contextWindow } = tokenData;
  const percentUsed = contextWindow ? Math.min(100, (contextTokens / contextWindow) * 100) : 0;

  const isClickable = onCompact && !disabled && !isCompacting;

  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <div
          {...(isClickable
            ? {
                onClick: onCompact,
                onKeyDown: (e: React.KeyboardEvent) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onCompact?.();
                  }
                },
                role: 'button' as const,
                tabIndex: 0,
                'aria-label': 'Compact context',
              }
            : {
                role: 'presentation' as const,
              })}
          className={cn(
            'h-4 w-4 flex items-center justify-center',
            isClickable
              ? 'cursor-pointer hover:opacity-70 transition-opacity focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring'
              : 'cursor-default',
            disabled && 'opacity-50',
            className,
          )}
        >
          <CircularProgress
            percent={percentUsed}
            size={14}
            strokeWidth={2.5}
            className={isCompacting ? 'animate-pulse' : undefined}
          />
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={8}>
        <p className="text-xs">
          {!contextWindow ? (
            <span className="text-muted-foreground">No context used yet</span>
          ) : (
            <>
              <span className="font-mono font-medium text-foreground">
                {percentUsed.toFixed(1)}%
              </span>
              <span className="text-muted-foreground mx-1">·</span>
              <span className="text-muted-foreground">
                {formatTokens(contextTokens)} / {formatTokens(contextWindow)} context
              </span>
            </>
          )}
        </p>
      </TooltipContent>
    </Tooltip>
  );
});
