/**
 * SidebarNavRow — the one row look shared by every inset left sidepane (chat sidebar, Settings).
 * Borderless ghost row: icon + label + optional trailing slot. Owning the row here (rather than a
 * copied class string per pane) is what keeps the panes from drifting apart again.
 */

import { Button, type ButtonProps } from '@benord-labs/frink-primitives';
import { forwardRef, type ReactElement, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Selected-destination fill. Exported for rows whose DOM can't be a Button (draggable chat rows). */
export const SIDEBAR_ROW_ACTIVE_CLASS = 'bg-primary/15 text-foreground font-medium';

type SidebarNavRowProps = Omit<ButtonProps, 'variant' | 'size' | 'children'> & {
  icon: ReactNode;
  label: string;
  /** Right-aligned slot for a status dot, count badge, or Kbd hint. */
  trailing?: ReactNode;
  /** The currently selected destination. */
  active?: boolean;
  /** Promote to the primary action (New Chat) — subtle fill so it isn't a flat ghost peer. */
  emphasized?: boolean;
};

export const SidebarNavRow = forwardRef<HTMLButtonElement, SidebarNavRowProps>(
  (
    { icon, label, trailing, active = false, emphasized = false, className, ...props },
    ref,
  ): ReactElement => (
    <Button
      ref={ref}
      variant="ghost"
      size="auto"
      className={cn(
        'w-full justify-start text-left font-normal',
        'gap-2 px-2 py-1.5 text-muted-foreground hover:text-foreground [&_svg]:size-4',
        emphasized && 'bg-foreground/6 text-foreground hover:bg-foreground/10',
        active && SIDEBAR_ROW_ACTIVE_CLASS,
        className,
      )}
      {...props}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {trailing != null && <span className="shrink-0">{trailing}</span>}
    </Button>
  ),
);
SidebarNavRow.displayName = 'SidebarNavRow';
