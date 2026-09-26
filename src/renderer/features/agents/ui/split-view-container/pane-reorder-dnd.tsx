import { GripVertical } from 'lucide-react';
import { Button } from '@benord-labs/frink-primitives';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { composeRefs } from '@radix-ui/react-compose-refs';
import type { HTMLAttributes, ReactElement, ReactNode } from 'react';
import { forwardRef, memo, useCallback, useMemo } from 'react';
import { cn } from '../../../../lib/utils';
import type { PaneReorderDragData } from './types';

/**
 * Wrappers that isolate the pane-reorder dnd-kit context subscriptions. Putting `useDroppable`
 * and `useDraggable` in the body of SplitPane caused them to re-execute on every
 * dnd-kit state update (any drag, anywhere), which cascaded fresh callback/prop references into
 * every child — defeating `React.memo` on TreeNode and causing thousands of renders during a
 * single file drag. With these wrappers, only the tiny wrapper components re-render; their
 * `children` references stay stable and React skips the expensive subtree.
 */

type PaneDropSectionProps = HTMLAttributes<HTMLElement> & {
  paneIndex: number;
  /** className merged in when something is actively hovered over this pane as a drop target */
  overClassName?: string;
  /** className merged in when nothing is being hovered over this pane */
  idleClassName?: string;
  children: ReactNode;
};

export const PaneDropSection = memo(
  forwardRef<HTMLElement, PaneDropSectionProps>(function PaneDropSection(
    { paneIndex, overClassName, idleClassName, className, children, ...rest },
    forwardedRef,
  ) {
    const dropData: PaneReorderDragData = useMemo(
      () => ({ type: 'pane-reorder', paneIndex }),
      [paneIndex],
    );
    const { setNodeRef, isOver } = useDroppable({
      id: `pane-drop-${paneIndex}`,
      data: dropData,
    });
    const refCallback = useCallback(
      (el: HTMLElement | null) => {
        composeRefs(setNodeRef, forwardedRef)(el);
      },
      [setNodeRef, forwardedRef],
    );
    return (
      <section
        ref={refCallback}
        className={cn(className, isOver ? overClassName : idleClassName)}
        {...rest}
      >
        {children}
      </section>
    );
  }),
);
PaneDropSection.displayName = 'PaneDropSection';

type PaneReorderHandleButtonProps = {
  paneIndex: number;
  className?: string;
  iconClassName?: string;
};

export const PaneReorderHandleButton = memo(function PaneReorderHandleButton({
  paneIndex,
  className,
  iconClassName,
}: PaneReorderHandleButtonProps): ReactElement {
  const dragData: PaneReorderDragData = useMemo(
    () => ({ type: 'pane-reorder', paneIndex }),
    [paneIndex],
  );
  const { attributes, listeners, setNodeRef } = useDraggable({
    id: `pane-drag-${paneIndex}`,
    data: dragData,
  });
  return (
    <Button
      ref={setNodeRef}
      variant="ghost"
      size="sm"
      {...attributes}
      {...listeners}
      className={cn(
        'cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground flex p-0 h-auto w-auto border-0 bg-transparent hover:bg-transparent',
        className,
      )}
      aria-label="Drag to reorder pane"
      iconOnly
    >
      <GripVertical className={cn('size-3.5', iconClassName)} />
    </Button>
  );
});
