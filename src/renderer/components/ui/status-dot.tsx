/**
 * Shared status indicator for resources/servers (MCP, agents, sidebar widgets).
 * Uses design tokens (--status-online, --status-warning, destructive).
 */
import { memo, type ReactElement } from 'react';
import { cn } from '@/lib/utils';
import { Spinner } from './spinner';

export type ResourceStatus =
  | 'connected'
  | 'disconnected'
  | 'error'
  | 'needs_auth'
  | 'pending'
  | 'starting'
  | 'reconnecting';

type Props = {
  status: ResourceStatus | string;
  className?: string;
  /** Accessible label for the status (defaults to status string) */
  'aria-label'?: string;
};

function getStatusColor(status: string): string {
  switch (status) {
    case 'connected':
      return 'bg-[hsl(var(--status-online))]';
    case 'needs_auth':
      return 'bg-[hsl(var(--status-warning))]';
    case 'error':
    case 'disconnected':
      return 'bg-destructive';
    case 'pending':
    case 'starting':
      return 'bg-muted-foreground/60 motion-safe:animate-pulse';
    default:
      return 'bg-muted-foreground/60';
  }
}

export const StatusDot = memo(function StatusDot({
  status,
  className,
  'aria-label': ariaLabel,
}: Props): ReactElement {
  if (status === 'reconnecting') {
    return <Spinner className={cn('w-3.5 h-3.5 text-primary', className)} />;
  }

  const colorClass = getStatusColor(status);
  const label = ariaLabel ?? `Status: ${status}`;

  return (
    <span
      className={cn('w-2 h-2 rounded-full shrink-0', colorClass, className)}
      role="img"
      aria-label={label}
      title={label}
    />
  );
});
