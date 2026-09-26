import type { ReactElement } from 'react';
import type { DbNodeRun } from '../../../../../../shared/types/flow-run';
import { cn } from '../../../../../lib/utils';
import { formatDuration, formatElapsedSinceStartLive } from '../format-duration';
import { usePeriodicNow } from '../use-periodic-now';
import type { ParseNodeOutputResult } from './parse-node-output';
import { TruncatedJsonBlock } from './TruncatedJsonBlock';

type NodeRunDetailEarlyProps = {
  nodeRun: DbNodeRun;
  parsed: ParseNodeOutputResult;
  wallDurationMs: number | null;
};

/**
 * Renders expanded detail for non-terminal / unknown-parse states.
 * Returns null when the caller should render the main success body.
 */
export function NodeRunDetailEarly({
  nodeRun,
  parsed,
  wallDurationMs,
}: NodeRunDetailEarlyProps): ReactElement | null {
  const { status, started_at } = nodeRun;
  const isRunning = status === 'running';
  const now = usePeriodicNow(isRunning);

  const isFailed = status === 'failed';
  const shell = isFailed
    ? 'border-destructive/25 bg-destructive/6'
    : 'border-border/40 bg-muted/20';

  if (status === 'running') {
    const elapsed = formatElapsedSinceStartLive(started_at, now);
    return (
      <div className={cn('mt-1 rounded-md border px-2 py-1.5 text-[10px]', shell)}>
        {elapsed !== '' ? (
          <p className="text-muted-foreground">Running for {elapsed}…</p>
        ) : (
          <p className="text-muted-foreground">Running…</p>
        )}
      </div>
    );
  }

  if (status === 'pending') {
    return (
      <div className={cn('mt-1 rounded-md border px-2 py-1.5 text-[10px]', shell)}>
        <p className="text-muted-foreground">This step has not started yet.</p>
      </div>
    );
  }

  if (status === 'cancelled') {
    return (
      <div className={cn('mt-1 rounded-md border px-2 py-1.5 text-[10px]', shell)}>
        <p className="text-muted-foreground">Cancelled (run stopped or branch aborted).</p>
      </div>
    );
  }

  if (status === 'skipped') {
    return (
      <div className={cn('mt-1 rounded-md border px-2 py-1.5 text-[10px]', shell)}>
        <p className="text-muted-foreground">
          Skipped — upstream condition or flow routing did not execute this branch.
        </p>
      </div>
    );
  }

  if (status === 'awaiting_input' || status === 'blocked') {
    return (
      <div className={cn('mt-1 rounded-md border px-2 py-1.5 text-[10px]', shell)}>
        <p className="text-muted-foreground capitalize">{status.replace(/_/g, ' ')}</p>
        {parsed.success && parsed.output.error?.message ? (
          <p className="mt-1 font-mono text-[10px] text-foreground/90">
            {parsed.output.error.message}
          </p>
        ) : null}
      </div>
    );
  }

  if (!parsed.success) {
    const rawStr =
      parsed.raw != null
        ? (() => {
            try {
              return JSON.stringify(parsed.raw, null, 2);
            } catch {
              return String(parsed.raw);
            }
          })()
        : null;
    return (
      <div className={cn('mt-1 space-y-2 rounded-md border px-2 py-1.5 text-[10px]', shell)}>
        <p className="text-warning">Unknown output format</p>
        {wallDurationMs != null && wallDurationMs >= 0 && (
          <p className="text-muted-foreground">Wall time: {formatDuration(wallDurationMs)}</p>
        )}
        {rawStr ? <TruncatedJsonBlock label="Raw" value={rawStr} /> : null}
      </div>
    );
  }

  return null;
}
