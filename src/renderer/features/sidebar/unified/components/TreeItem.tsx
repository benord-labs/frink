/**
 * TreeItem - Base expandable tree item component
 * Used for codebases
 */

import { ChevronRight } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import React from 'react';
import { cn } from '../../../../lib/utils';

/** Height/opacity collapse animation for the expandable children region. */
const COLLAPSE_MOTION = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
  transition: { duration: 0.15, ease: 'easeInOut' },
} as const;

type TreeItemProps = {
  label: React.ReactNode;
  icon?: React.ReactNode;
  rightContent?: React.ReactNode;
  isExpanded: boolean;
  onToggle: () => void;
  depth?: number;
  children?: React.ReactNode;
  className?: string;
  /** Unique ID for keyboard navigation (data-item-id attribute) */
  itemId?: string;
  /** Align expand chevron with `DraggableChat`’s grip column (see BatchGroup). */
  chevronInGripColumn?: boolean;
  /** Hover-revealed control rendered at the row's trailing edge, after the disclosure caret. */
  trailingAction?: React.ReactNode;
};

export function TreeItem({
  label,
  icon,
  rightContent,
  isExpanded,
  onToggle,
  depth = 0,
  children,
  className,
  itemId,
  chevronInGripColumn = false,
  trailingAction,
}: TreeItemProps) {
  const hasChildren = React.Children.count(children) > 0;

  const chevronEl = hasChildren ? (
    <ChevronRight
      className={cn(
        'h-4 w-4 shrink-0 text-muted-foreground/50 transition-transform duration-150',
        isExpanded && 'rotate-90',
      )}
    />
  ) : (
    <span className="w-4 shrink-0" />
  );

  return (
    <div className="select-none">
      <div
        role="treeitem"
        tabIndex={-1}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        id={itemId ? `sidebar-item-${itemId}` : undefined}
        aria-expanded={isExpanded}
        data-sidebar-item=""
        data-item-type="codebase"
        data-item-id={itemId}
        className={cn(
          'group w-full flex items-center py-1.5 rounded-md',
          chevronInGripColumn ? 'gap-0 pr-2 pl-0' : 'gap-2 px-2',
          'text-sm text-muted-foreground hover:text-foreground',
          'hover:bg-foreground/5 transition-colors duration-75',
          'outline-hidden focus-visible:ring-2 focus-visible:ring-ring/50',
          'cursor-pointer text-left',
          className,
        )}
        style={chevronInGripColumn ? undefined : { paddingLeft: `${12 + depth * 12}px` }}
      >
        {/* BatchGroup keeps a leading chevron in the grip column. Project headers do NOT — their
            icon leads so the row lines up with the nav (the disclosure caret moves to the trailing
            edge below), killing the file-tree look. */}
        {chevronInGripColumn && (
          <span className="ml-1 flex h-full shrink-0 items-center px-1 text-muted-foreground/30">
            {chevronEl}
          </span>
        )}
        {icon && <span className="shrink-0">{icon}</span>}
        <span className={cn('flex-1 min-w-0 text-left truncate', chevronInGripColumn && '-ml-1')}>
          {label}
        </span>

        {/* Right content (status, count, etc) */}
        {rightContent && <span className="shrink-0">{rightContent}</span>}

        {/* Trailing disclosure caret (projects). ALWAYS visible, not hover-revealed: NN/g's
            hidden-control studies + WCAG 2.2 SC 3.2.7 (Visible Controls) show hover-only affordances
            hurt discoverability. The row itself is the disclosure control (role=treeitem +
            aria-expanded + Enter/Space), so the caret is decorative (aria-hidden). It lifts on hover. */}
        {!chevronInGripColumn && hasChildren && (
          <ChevronRight
            aria-hidden="true"
            className={cn(
              'ml-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-[transform,color] duration-150 group-hover:text-muted-foreground/90',
              isExpanded && 'rotate-90',
            )}
          />
        )}

        {/* Trailing actions (e.g. a hover-revealed "..." menu) — at the row's far edge, after the
            caret, so the count stays tight to the caret and actions don't pop up mid-row. */}
        {trailingAction && <span className="shrink-0">{trailingAction}</span>}
      </div>

      {/* Children (animated) */}
      <AnimatePresence initial={false}>
        {isExpanded && hasChildren && (
          <motion.div {...COLLAPSE_MOTION} className="overflow-hidden">
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
