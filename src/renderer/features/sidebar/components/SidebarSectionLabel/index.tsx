/**
 * SidebarSectionLabel — the group heading shared by every inset left sidepane.
 * Plain heading by default; `count`, `icon` and `rule` cover the chat sidebar's Pinned/Recent rows.
 */

import type { ReactElement, ReactNode } from 'react';
import { cn } from '@/lib/utils';

type SidebarSectionLabelProps = {
  label: string;
  /** Item count rendered after the label. */
  count?: number;
  /** Leading marker (e.g. a pin). */
  icon?: ReactNode;
  /** Trailing hairline that fills the remaining width. */
  rule?: boolean;
  className?: string;
};

export function SidebarSectionLabel({
  label,
  count,
  icon,
  rule = false,
  className,
}: SidebarSectionLabelProps): ReactElement {
  return (
    <div
      role="presentation"
      className={cn('flex select-none items-center gap-1.5 pb-1 pl-2 pr-2 pt-3', className)}
    >
      {icon}
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
        {label}
      </span>
      {count != null && (
        <span className="text-[10px] tabular-nums text-muted-foreground/40">{count}</span>
      )}
      {rule && <span aria-hidden="true" className="ml-1 flex-1 border-t border-border/40" />}
    </div>
  );
}
