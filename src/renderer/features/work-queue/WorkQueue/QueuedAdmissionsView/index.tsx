import { ActivityRow, type ActivityRowProps, Badge, Button } from '@benord-labs/frink-primitives';
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  type Modifier,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowDown, ArrowUp, Eye, GripVertical, Workflow, X } from 'lucide-react';
import { memo, type ReactElement, type Ref, useMemo, useRef, useState } from 'react';
import type { TriggerContext } from '../../../../../shared/types/trigger-context';
import { ConfirmDialog } from '../../../../components/ui/confirm-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../../components/ui/tooltip';
import { TriggerContentDialog } from '../ActionMenu/TriggerContentDialog';

export type QueuedAdmission = {
  flowName: string;
  /** Cancelling this run also fails one member of its batch stage — surfaced before confirming. */
  isBatchMember: boolean;
  priorityClass: 'resume' | 'start';
  projectName: string | null;
  /** What the run is about (story name, batch item label); null when the trigger carries nothing readable. */
  subject: string | null;
  ticket: number;
  /** Validated webhook envelope behind "View original content"; null for every other kind of start. */
  triggerContext: TriggerContext | null;
};

type SortableAdmissionProps = {
  admission: QueuedAdmission;
  index: number;
  isMoving: boolean;
  onMove: (ticket: number, targetTicket: number, targetPosition: number) => Promise<void>;
  onRemoveRequest: (ticket: number) => void;
  onViewContent: (ticket: number) => void;
  rows: QueuedAdmission[];
};

const restrictToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });
// SAFETY: ActivityRow forwards its list-item ref at runtime; the published primitive type omits it.
const SortableActivityRow = ActivityRow as (
  props: ActivityRowProps & { ref?: Ref<HTMLLIElement> },
) => ReactElement;

/** `rowSuffix` reaches the accessible name only — the tooltip keeps the short action wording. */
function ReorderButton({
  children,
  disabled,
  label,
  onClick,
  rowSuffix,
}: {
  children: ReactElement;
  disabled?: boolean;
  label: string;
  onClick: () => void;
  rowSuffix: string;
}): ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`${label}, ${rowSuffix}`}
            className="size-7 text-muted-foreground"
            disabled={disabled}
            onClick={onClick}
          >
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

/** dnd-kit owns these shapes; deriving them keeps the handle's contract exact instead of a bag. */
type SortableDragHandle = Pick<
  ReturnType<typeof useSortable>,
  'attributes' | 'listeners' | 'setActivatorNodeRef'
>;

/**
 * Every control in a queued row. Split out from `SortableAdmission` so the row stays a layout
 * component: the drag/move/remove cluster is where all four accessible names are composed.
 */
function AdmissionRowActions({
  admission,
  dragHandle,
  isMoving,
  isSortable,
  next,
  onMove,
  onRemoveRequest,
  onViewContent,
  previous,
  index,
  rowSuffix,
}: {
  admission: QueuedAdmission;
  dragHandle: SortableDragHandle;
  isMoving: boolean;
  isSortable: boolean;
  next?: QueuedAdmission;
  onMove: SortableAdmissionProps['onMove'];
  onRemoveRequest: (ticket: number) => void;
  onViewContent: (ticket: number) => void;
  previous?: QueuedAdmission;
  index: number;
  rowSuffix: string;
}): ReactElement {
  const label = admission.flowName;
  const preserveFocus = async (operation: () => Promise<void>) => {
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    await operation();
    if (focused?.isConnected) focused.focus();
  };

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {admission.triggerContext && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`View original content for ${label}, ${rowSuffix}`}
              className="size-7 text-muted-foreground"
              data-view-content-ticket={admission.ticket}
              onClick={() => onViewContent(admission.ticket)}
            >
              <Eye className="size-3.5" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">View original content</TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={dragHandle.setActivatorNodeRef}
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Reorder ${label}, ${rowSuffix}`}
            className="size-7 cursor-grab text-muted-foreground active:cursor-grabbing"
            disabled={isMoving || !isSortable}
            {...dragHandle.attributes}
            {...dragHandle.listeners}
          >
            <GripVertical className="size-3.5" aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">Drag to reorder</TooltipContent>
      </Tooltip>
      <ReorderButton
        label={`Move ${label} up`}
        rowSuffix={rowSuffix}
        disabled={isMoving || !previous}
        onClick={() => {
          if (previous)
            void preserveFocus(() => onMove(admission.ticket, previous.ticket, index - 1));
        }}
      >
        <ArrowUp className="size-3.5" aria-hidden />
      </ReorderButton>
      <ReorderButton
        label={`Move ${label} down`}
        rowSuffix={rowSuffix}
        disabled={isMoving || !next}
        onClick={() => {
          if (next) void preserveFocus(() => onMove(admission.ticket, next.ticket, index + 1));
        }}
      >
        <ArrowDown className="size-3.5" aria-hidden />
      </ReorderButton>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove ${label} from queue, ${rowSuffix}`}
              className="size-7 text-muted-foreground hover:text-destructive"
              disabled={isMoving}
              onClick={() => onRemoveRequest(admission.ticket)}
            >
              <X className="size-3.5" aria-hidden />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">Remove from queue</TooltipContent>
      </Tooltip>
    </div>
  );
}

const SortableAdmission = memo(function SortableAdmission({
  admission,
  index,
  isMoving,
  onMove,
  onRemoveRequest,
  onViewContent,
  rows,
}: SortableAdmissionProps): ReactElement {
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform, isDragging } =
    useSortable({ id: admission.ticket, disabled: isMoving || rows.length < 2 });
  const projectName = admission.projectName?.trim();
  const previous = rows[index - 1];
  const next = rows[index + 1];
  const label = admission.flowName;
  // Two rows routinely name the SAME flow — one flow queued twice, or two members of one batch — so
  // the flow name alone gives every control in this row an accessible name identical to another
  // row's. Every control appends the position the row already displays, plus the group that makes
  // that position unique across the two lists.
  const rowSuffix = `${admission.priorityClass === 'resume' ? 'Resuming' : 'Starting'} ${index + 1} of ${rows.length}`;
  const preserveFocus = async (operation: () => Promise<void>) => {
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    await operation();
    if (focused?.isConnected) focused.focus();
  };

  return (
    <SortableActivityRow
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        opacity: isDragging ? 0.65 : 1,
      }}
      actions={
        <AdmissionRowActions
          admission={admission}
          dragHandle={{ attributes, listeners, setActivatorNodeRef }}
          index={index}
          isMoving={isMoving}
          isSortable={rows.length > 1}
          next={next}
          onMove={onMove}
          onRemoveRequest={onRemoveRequest}
          onViewContent={onViewContent}
          previous={previous}
          rowSuffix={rowSuffix}
        />
      }
      className="group"
      state="neutral"
      statusLabel={admission.priorityClass === 'resume' ? 'Queued to resume' : 'Queued to start'}
      leading={<Workflow />}
      title={label}
      // The subject replaces the waiting line; the section and group headings still carry the state.
      description={
        admission.subject ??
        (admission.priorityClass === 'resume' ? 'Waiting to resume' : 'Waiting to start')
      }
      meta={
        projectName ? (
          <Badge noDot className="bg-surface/70 px-1.5 py-0.5 text-xs text-muted-foreground">
            {projectName}
          </Badge>
        ) : undefined
      }
      trailing={`${index + 1} of ${rows.length}`}
      trailingWidth="wide"
    />
  );
});

function SortableAdmissionGroup({
  label,
  onMove,
  onRemoveRequest,
  onViewContent,
  rows,
  isMoving,
}: {
  label: string;
  onMove: SortableAdmissionProps['onMove'];
  onRemoveRequest: SortableAdmissionProps['onRemoveRequest'];
  onViewContent: SortableAdmissionProps['onViewContent'];
  rows: QueuedAdmission[];
  isMoving: boolean;
}): ReactElement | null {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const tickets = useMemo(() => rows.map((row) => row.ticket), [rows]);
  const handleDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id) return;
    const sourceIndex = tickets.indexOf(Number(event.active.id));
    const targetIndex = tickets.indexOf(Number(event.over.id));
    if (sourceIndex < 0 || targetIndex < 0) return;
    void onMove(tickets[sourceIndex], tickets[targetIndex], targetIndex);
  };
  if (rows.length === 0) return null;

  return (
    <div>
      <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</h4>
      <DndContext sensors={sensors} modifiers={[restrictToVerticalAxis]} onDragEnd={handleDragEnd}>
        <SortableContext items={tickets} strategy={verticalListSortingStrategy}>
          <ol className="overflow-hidden">
            {rows.map((admission, index) => (
              <SortableAdmission
                key={admission.ticket}
                admission={admission}
                index={index}
                isMoving={isMoving}
                onMove={onMove}
                onRemoveRequest={onRemoveRequest}
                onViewContent={onViewContent}
                rows={rows}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
    </div>
  );
}

/** Spells out what confirming actually destroys — the two priority classes differ sharply. */
function removalDescription(admission: QueuedAdmission): string {
  if (admission.priorityClass === 'resume') {
    return 'The finished run stays as it is. It returns to your attention list, where you can retry it.';
  }
  const base =
    "The queued run is cancelled. Its trigger details can't be replayed, so you'll need to run the flow again.";
  return admission.isBatchMember
    ? `${base} It also counts as one failed member of its batch stage, which can fail that stage and cancel the stages waiting on it.`
    : base;
}

export type QueuedAdmissionsViewProps = {
  announcement: string;
  error: boolean;
  loading: boolean;
  moving: boolean;
  onMove: SortableAdmissionProps['onMove'];
  /** Resolves true when the row is really gone, which is the only case that moves focus. */
  onRemove: (admission: QueuedAdmission) => Promise<boolean>;
  onRetry: () => void;
  rows: QueuedAdmission[];
};

export const QueuedAdmissionsView = memo(function QueuedAdmissionsView({
  announcement,
  error,
  loading,
  moving,
  onMove,
  onRemove,
  onRetry,
  rows,
}: QueuedAdmissionsViewProps): ReactElement {
  const [resumptions, starts] = useMemo(
    () => [
      rows.filter((row) => row.priorityClass === 'resume'),
      rows.filter((row) => row.priorityClass === 'start'),
    ],
    [rows],
  );

  const rootRef = useRef<HTMLDivElement>(null);
  const [pendingRemoval, setPendingRemoval] = useState<QueuedAdmission | null>(null);
  const [viewing, setViewing] = useState<QueuedAdmission | null>(null);
  const requestView = (ticket: number) =>
    setViewing(rows.find((row) => row.ticket === ticket) ?? null);
  const closeView = () => {
    setViewing(null);
    // The 5s poll can unmount the row while its dialog is open; Radix would then drop focus to
    // <body>. Return to the eye button that opened it if it still exists, else the panel wrapper.
    const opener = rootRef.current?.querySelector<HTMLElement>(
      `[data-view-content-ticket="${viewing?.ticket}"]`,
    );
    requestAnimationFrame(() => (opener ?? rootRef.current)?.focus());
  };
  const requestRemoval = (ticket: number) =>
    setPendingRemoval(rows.find((row) => row.ticket === ticket) ?? null);
  const confirmRemoval = async (admission: QueuedAdmission) => {
    // Focus moves only once the row is really gone. Radix has already restored the Remove button by
    // now, and that button lives inside the row about to unmount — leaving focus there would drop it
    // to <body>. Every other outcome keeps the row, so it keeps its focus too.
    if (await onRemove(admission)) rootRef.current?.focus();
  };

  const body = (() => {
    if (loading) {
      return (
        <div className="py-6 text-center text-xs text-muted-foreground" role="status">
          Loading queued flows…
        </div>
      );
    }
    if (error) {
      return (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-border/50 px-3 py-2.5">
          <p className="text-xs text-muted-foreground">Queued flows could not be loaded.</p>
          <Button type="button" variant="ghost" size="xs" onClick={onRetry}>
            Try again
          </Button>
        </div>
      );
    }
    if (rows.length === 0) return null;

    return (
      <section aria-labelledby="queued-flows-heading">
        <div className="mb-3">
          <h3 id="queued-flows-heading" className="text-sm font-medium text-foreground">
            Queued to run
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Resumes run first. Reorder work within either group.
          </p>
        </div>
        <div className="space-y-4">
          <SortableAdmissionGroup
            label="Resuming"
            rows={resumptions}
            isMoving={moving}
            onMove={onMove}
            onRemoveRequest={requestRemoval}
            onViewContent={requestView}
          />
          <SortableAdmissionGroup
            label="Starting"
            rows={starts}
            isMoving={moving}
            onMove={onMove}
            onRemoveRequest={requestRemoval}
            onViewContent={requestView}
          />
        </div>
      </section>
    );
  })();

  // The wrapper, live region and dialog sit OUTSIDE `body`: it renders nothing once the queue
  // empties, which is exactly when the last removal must still be announced and focus must land
  // somewhere. Spacing follows the same rule, so an empty queue leaves no gap behind.
  return (
    <div ref={rootRef} tabIndex={-1} className={body ? 'mb-4 outline-none' : 'outline-none'}>
      {body}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      <ConfirmDialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemoval(null);
        }}
        onConfirm={() => {
          if (pendingRemoval) void confirmRemoval(pendingRemoval);
        }}
        title={`Remove "${pendingRemoval?.flowName ?? ''}" from the queue?`}
        description={pendingRemoval ? removalDescription(pendingRemoval) : ''}
        confirmLabel="Remove"
      />
      {viewing?.triggerContext && (
        <TriggerContentDialog
          open
          onOpenChange={(open) => {
            if (!open) closeView();
          }}
          triggerContext={viewing.triggerContext}
        />
      )}
    </div>
  );
});
