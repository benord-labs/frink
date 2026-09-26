/**
 * StatusDot - Online/offline indicator
 */

import { cn } from '../../../../lib/utils';

type StatusDotProps = {
  status: 'online' | 'offline';
  size?: 'sm' | 'md';
  className?: string;
};

export function StatusDot({ status, size = 'sm', className }: StatusDotProps) {
  return (
    <span
      className={cn(
        'rounded-full shrink-0',
        status === 'online' ? 'bg-green-500' : 'bg-red-500/60',
        size === 'sm' ? 'h-1.5 w-1.5' : 'h-2 w-2',
        className,
      )}
      title={status === 'online' ? 'Online' : 'Offline'}
    />
  );
}
