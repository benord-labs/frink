import { useAtomValue } from 'jotai';
import { Timer } from 'lucide-react';
import { memo, useEffect, useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../../components/ui/tooltip';
import { promptCacheTimerEnabledAtom } from '../../../../lib/atoms';
import { cn } from '../../../../lib/utils';

const WARNING_MS = 60_000;

type PromptCacheTimerProps = {
  /** When the prompt cache goes cold at the latest (epoch ms). Null hides the timer: no TTL was
   *  reported, or a turn in flight is refreshing the cache. */
  expiresAt: number | null;
  className?: string;
};

/** `M:SS`, rounding up so the display never reads 0:00 while the cache is still warm. */
export function formatCacheRemaining(remainingMs: number): string {
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const seconds = totalSeconds % 60;
  return `${Math.floor(totalSeconds / 60)}:${seconds.toString().padStart(2, '0')}`;
}

/** Re-renders every second until `expiresAt`, then stops ticking. */
function useRemainingMs(expiresAt: number | null): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (expiresAt === null || expiresAt <= Date.now()) return;
    const interval = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= expiresAt) clearInterval(interval);
    }, 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);
  return expiresAt === null ? 0 : Math.max(0, expiresAt - now);
}

/** Countdown, in the workspace row under the composer, of how long Claude's prompt cache stays
 *  warm after the last turn. */
export const PromptCacheTimer = memo(function PromptCacheTimer({
  expiresAt,
  className,
}: PromptCacheTimerProps) {
  const enabled = useAtomValue(promptCacheTimerEnabledAtom);
  const visible = enabled && expiresAt !== null;
  const remainingMs = useRemainingMs(visible ? expiresAt : null);
  if (!visible) return null;

  const expired = remainingMs === 0;
  const remaining = formatCacheRemaining(remainingMs);
  const label = expired
    ? 'Prompt cache expired: your next message re-sends the full context uncached'
    : `Prompt cache stays warm for up to ${remaining}. After that, your next message re-sends the full context uncached`;

  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={label}
          className={cn(
            'flex shrink-0 select-none items-center gap-1 tabular-nums',
            expired
              ? 'text-muted-foreground/60'
              : remainingMs <= WARNING_MS
                ? 'text-warning'
                : 'text-muted-foreground',
            className,
          )}
        >
          <Timer aria-hidden="true" className="h-3 w-3 shrink-0" />
          {!expired && remaining}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={8}>
        <p className="max-w-64 text-xs">{label}</p>
      </TooltipContent>
    </Tooltip>
  );
});
