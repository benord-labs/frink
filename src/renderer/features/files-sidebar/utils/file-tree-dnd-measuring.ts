import { getClientRect, type MeasuringConfiguration, MeasuringStrategy } from '@dnd-kit/core';

/** Shared @dnd-kit measuring for file-tree `DndContext` (standalone + split-view container). */
export const fileTreeDndMeasuring = {
  draggable: { measure: getClientRect },
  droppable: { strategy: MeasuringStrategy.BeforeDragging },
} satisfies MeasuringConfiguration;
