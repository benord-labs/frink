import { cn } from '../../../../../lib/utils';

const STATUS_LABEL_MAP: Record<string, string> = {
  completed: 'Completed',
  failed: 'Failed',
  running: 'Running',
  queued: 'Queued',
  // biome-ignore lint/style/useNamingConvention: snake_case domain status (node-run vocabulary)
  awaiting_input: 'Awaiting input',
  paused: 'Paused',
  cancelled: 'Cancelled',
  pending: 'Pending',
};

export function RunStatusLabel({ status, suffix = '' }: { status: string; suffix?: string }) {
  return (
    <span
      className={cn(
        'text-xs font-medium',
        status === 'completed' && 'text-[hsl(var(--status-online-text))]',
        status === 'failed' && 'text-destructive',
        status === 'running' && 'text-blue-500',
        status === 'queued' && 'text-blue-700 dark:text-blue-300',
        (status === 'paused' || status === 'awaiting_input') && 'text-warning',
        (status === 'cancelled' || status === 'pending') && 'text-muted-foreground/60',
      )}
    >
      {STATUS_LABEL_MAP[status] ?? status}
      {suffix}
    </span>
  );
}
