import { getClientRect, type MeasuringConfiguration, MeasuringStrategy } from '@dnd-kit/core';

/** Shared @dnd-kit measuring for file-tree `DndContext` (standalone + split-view container). */
export const fileTreeDndMeasuring = {
  draggable: { measure: getClientRect },
  // BeforeDragging keeps measuring every droppable while idle, forcing a full layout whenever
  // the split view re-renders; measure only once a drag has started.
  droppable: { strategy: MeasuringStrategy.WhileDragging },
} satisfies MeasuringConfiguration;
