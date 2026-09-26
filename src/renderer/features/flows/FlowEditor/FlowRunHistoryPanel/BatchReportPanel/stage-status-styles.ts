/**
 * Shared status pill styles for batch stage visualization.
 * Used by StageStatusTable (table view) and BatchPlanCanvas (graph view).
 */

type StageStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

const STAGE_STATUS_PILL: Record<
  StageStatus,
  { label: string; className: string; dotClassName?: string }
> = {
  pending: {
    label: 'Pending',
    className: 'bg-muted text-muted-foreground',
  },
  running: {
    label: 'Running',
    className: 'bg-primary/15 text-primary',
    dotClassName: 'bg-primary animate-pulse',
  },
  completed: {
    label: 'Done',
    className: 'bg-[hsl(var(--status-online)/0.15)] text-[hsl(var(--status-online-text))]',
  },
  failed: {
    label: 'Failed',
    className: 'bg-destructive/15 text-destructive',
  },
  cancelled: {
    label: 'Cancelled',
    className: 'bg-muted text-muted-foreground',
  },
};

export function getStatusPill(status: string): {
  label: string;
  className: string;
  dotClassName?: string;
} {
  return (
    STAGE_STATUS_PILL[status as StageStatus] ?? {
      label: status,
      className: 'bg-muted text-muted-foreground',
    }
  );
}

/**
 * Run progress formatted as "completed/total", or "—" when no runs are scheduled.
 * Shared between StageStatusTable and BatchStageNode to avoid drift.
 */
export function formatProgress(completed: number, total: number): string {
  if (total === 0) return '—';
  return `${completed}/${total}`;
}

/**
 * Edge stroke color by source stage status using inline style (not className).
 * React Flow's BezierEdge does not forward `className` to the `<path>` element, so
 * Tailwind stroke utilities on `className` are ignored. Inline `style.stroke` is the
 * only reliable way to color RF edges.
 */
export function getEdgeStrokeColor(status: string): string {
  const map: Record<StageStatus, string> = {
    pending: 'hsl(var(--muted-foreground) / 0.3)',
    running: 'hsl(var(--primary) / 0.6)',
    completed: 'hsl(var(--status-online) / 0.6)',
    failed: 'hsl(var(--destructive) / 0.6)',
    cancelled: 'hsl(var(--muted-foreground) / 0.2)',
  };
  return map[status as StageStatus] ?? 'hsl(var(--muted-foreground) / 0.3)';
}
