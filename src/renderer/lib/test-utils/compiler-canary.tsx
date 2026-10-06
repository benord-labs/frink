import { DndContext, PointerSensor, useDraggable, useSensor, useSensors } from '@dnd-kit/core';
import { memo } from 'react';

// Fixtures asserted with and without the React Compiler. Counted components opt out of it, so
// their body runs on every render the compiled parent gives them.

type RenderProbe = (id: string) => void;

/** Counts renders per id. Pass `probe` to a fixture and read `count` after each update. */
export function createRenderTally() {
  const counts = new Map<string, number>();
  const probe: RenderProbe = (id) => counts.set(id, (counts.get(id) ?? 0) + 1);
  return { probe, count: (id: string) => counts.get(id) ?? 0 };
}

type MemoChildProps = {
  options: { distance: number };
  label: string;
  onRender: RenderProbe;
};

const MemoChild = memo(function MemoChild({ options, label, onRender }: MemoChildProps) {
  'use no memo';
  onRender('child');
  return (
    <span>
      {label} {options.distance}
    </span>
  );
});

type InlineLiteralParentProps = {
  /** Changing it re-renders the parent and nothing else. */
  tick: number;
  label: string;
  onRender: RenderProbe;
};

/** Hands a memo child an object literal written inline. */
export function InlineLiteralParent({ tick, label, onRender }: InlineLiteralParentProps) {
  return (
    <div data-tick={tick}>
      <MemoChild options={{ distance: 8 }} label={label} onRender={onRender} />
    </div>
  );
}

export type DragRowItem = {
  id: string;
  label: string;
};

type DragRowProps = {
  onRender: RenderProbe;
} & DragRowItem;

const DragRow = memo(function DragRow({ id, label, onRender }: DragRowProps) {
  'use no memo';
  onRender(id);
  const { setNodeRef, attributes, listeners } = useDraggable({ id });
  return (
    <li ref={setNodeRef} {...attributes} {...listeners}>
      {label}
    </li>
  );
});

type InlineSensorListProps = {
  tick: number;
  rows: DragRowItem[];
  onRender: RenderProbe;
};

/** A real DndContext whose sensor options are an inline literal. dnd-kit keys the sensor on that
 * object, and every useDraggable row reads the resulting context past its memo. */
export function InlineSensorList({ tick, rows, onRender }: InlineSensorListProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  return (
    <DndContext sensors={sensors}>
      <ul data-tick={tick}>
        {rows.map((row) => (
          <DragRow key={row.id} id={row.id} label={row.label} onRender={onRender} />
        ))}
      </ul>
    </DndContext>
  );
}
