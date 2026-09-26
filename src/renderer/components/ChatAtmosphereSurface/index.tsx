import type { ComponentPropsWithoutRef, ReactElement } from 'react';
import { cn } from '@/lib/utils';

/**
 * Borderless chat canvas with the shared marketing-aligned atmosphere behind its content.
 * Used by chat and chat-adjacent full-height surfaces such as Settings.
 */
export function ChatAtmosphereSurface({
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<'div'>): ReactElement {
  return (
    <div
      className={cn('relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden', className)}
      {...props}
    >
      <div
        className="chat-canvas-atmosphere pointer-events-none absolute inset-0 z-0 overflow-hidden"
        aria-hidden
      />
      {children}
    </div>
  );
}
