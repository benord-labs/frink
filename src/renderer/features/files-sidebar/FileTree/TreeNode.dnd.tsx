import { useDraggable, useDroppable } from '@dnd-kit/core';
import { composeRefs } from '@radix-ui/react-compose-refs';
import type {
  ButtonHTMLAttributes,
  CSSProperties,
  KeyboardEvent,
  PointerEvent,
  ReactNode,
} from 'react';
import { forwardRef, memo, useCallback } from 'react';
import { cn } from '@/lib/utils';
import type { TreeNodeDragData, TreeNodeDropData } from './TreeNode';

const emptyStyle: CSSProperties = {};

/**
 * Wrappers that isolate dnd-kit context subscriptions to tiny components so TreeNode's heavy
 * body (ContextMenu, icons, recursive children) doesn't re-execute on every DndContext update.
 *
 * dnd-kit re-renders every useDroppable/useDraggable consumer on any context change (drag
 * position, active item, etc.). With many tree nodes × panes, that causes thousands of renders
 * per drag. By putting the hooks in memoed leaf components and passing the real content via
 * `children`, only these small wrappers re-render; their children's element references stay
 * stable and React skips reconciling the subtree.
 */

type DropRootProps = {
  id: string;
  data: TreeNodeDropData;
  disabled: boolean;
  className?: string;
  overClassName?: string;
  style?: CSSProperties;
  children: ReactNode;
};

export const DropRoot = memo(function DropRoot({
  id,
  data,
  disabled,
  className,
  overClassName,
  style,
  children,
}: DropRootProps) {
  const { setNodeRef, isOver } = useDroppable({ id, data, disabled });
  return (
    <div
      ref={disabled ? undefined : setNodeRef}
      className={cn(className, isOver && !disabled && overClassName)}
      style={style}
    >
      {children}
    </div>
  );
});

type DragButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'id'> & {
  draggableId: string;
  draggableData: TreeNodeDragData;
  children: ReactNode;
};

/**
 * forwardRef + composeRefs so Radix's `asChild` Slot (e.g. ContextMenuTrigger) can attach its ref
 * alongside dnd-kit's setNodeRef. Event handlers that both libs touch (onPointerDown, onKeyDown)
 * are chained: the outer handler (Radix / consumer) runs first; dnd-kit's runs unless
 * preventDefault was called — matches Radix's `composeEventHandlers` contract.
 */
export const DragButton = memo(
  forwardRef<HTMLButtonElement, DragButtonProps>(function DragButton(
    {
      draggableId,
      draggableData,
      children,
      className,
      style,
      onPointerDown: outerPointerDown,
      onKeyDown: outerKeyDown,
      ...rest
    },
    forwardedRef,
  ) {
    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
      id: draggableId,
      data: draggableData,
    });

    const refCallback = useCallback(
      (el: HTMLButtonElement | null) => {
        composeRefs(setNodeRef, forwardedRef)(el);
      },
      [setNodeRef, forwardedRef],
    );

    const mergedStyle: CSSProperties = isDragging
      ? { ...style, opacity: 0.3 }
      : (style ?? emptyStyle);

    const dndPointerDown = listeners?.onPointerDown as
      | ((e: PointerEvent<HTMLButtonElement>) => void)
      | undefined;
    const dndKeyDown = listeners?.onKeyDown as
      | ((e: KeyboardEvent<HTMLButtonElement>) => void)
      | undefined;

    const composedPointerDown = useCallback(
      (e: PointerEvent<HTMLButtonElement>) => {
        outerPointerDown?.(e);
        if (!e.defaultPrevented) dndPointerDown?.(e);
      },
      [outerPointerDown, dndPointerDown],
    );

    const composedKeyDown = useCallback(
      (e: KeyboardEvent<HTMLButtonElement>) => {
        outerKeyDown?.(e);
        if (!e.defaultPrevented) dndKeyDown?.(e);
      },
      [outerKeyDown, dndKeyDown],
    );

    // Spread dnd-kit `listeners` first (so composed handlers below replace the conflicting ones),
    // then `rest` for the remaining consumer/Radix props, then attributes and composed handlers.
    return (
      // eslint-disable-next-line no-restricted-syntax -- dnd-kit draggable: spreads listeners/attributes + ref callback; DS Button can't forward these
      <button
        ref={refCallback}
        className={className}
        style={mergedStyle}
        {...listeners}
        {...rest}
        {...attributes}
        onPointerDown={composedPointerDown}
        onKeyDown={composedKeyDown}
      >
        {children}
      </button>
    );
  }),
);
DragButton.displayName = 'DragButton';
