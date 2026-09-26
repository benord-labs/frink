/**
 * SidebarNavList — the `<nav>` a sidepane's rows live in, so list padding and row spacing are
 * defined once. `scrollable` when the list itself is the pane's scroll container (Settings).
 */

import type { ReactElement, ReactNode } from 'react';
import { cn } from '@/lib/utils';

type SidebarNavListProps = {
  'aria-label': string;
  scrollable?: boolean;
  className?: string;
  children: ReactNode;
};

export function SidebarNavList({
  scrollable = false,
  className,
  children,
  ...props
}: SidebarNavListProps): ReactElement {
  return (
    <nav
      className={cn(
        'space-y-0.5 px-3 pb-2',
        scrollable && 'min-h-0 flex-1 overflow-y-auto',
        className,
      )}
      {...props}
    >
      {children}
    </nav>
  );
}
