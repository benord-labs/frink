import { PencilLine } from 'lucide-react';
import {
  type ComponentProps,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  useId,
} from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../../components/ui/tooltip';
import type { FlowListSectionId } from '../../../../lib/flows/flow-list-sections';
import {
  FLOW_RUN_TONE_CLASSES,
  type FlowRunState,
  type FlowRunTone,
  flowRunState,
  flowTriggerHint,
  formatFlowUpdated,
} from '../../../../lib/flows/flow-run-state';
import { cn } from '../../../../lib/utils';
import { FlowBlockIcon } from '../../FlowEditor/FlowBlockIcon';
import { FlowRowMenu } from '../FlowRowMenu';
import { FlowStatusGlyph } from '../FlowStatusGlyph';

// biome-ignore-start lint/style/useNamingConvention: Flow list DTOs intentionally use API snake_case.
export type FlowListItem = ComponentProps<typeof FlowRowMenu>['flow'] & {
  description: string | null;
  is_enabled?: boolean | null;
  trigger_type: string | null;
  updated_at: string;
  batch_active_count?: number | null;
  batch_run_count?: number | null;
};
// biome-ignore-end lint/style/useNamingConvention: Flow list DTOs intentionally use API snake_case.

/** Glyph, name, status slot, date, menu. Fixed slots keep every rail aligned across sections. */
export const FLOW_ROW_GRID =
  'grid grid-cols-[0.875rem_minmax(0,1fr)_10rem_5rem_1.75rem] gap-x-3 gap-y-1 px-2.5 py-2.5';

const FULL_DATE = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

type TipProps = { tip: string; className?: string; children: ReactNode };

/** A tooltip target painted above the stretched open-button, so it still gets the hover. */
function Tip({ tip, className, children }: TipProps): ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('relative', className)}>{children}</span>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

/** A quiet icon after the name, named by its tooltip and, for screen readers, by `id`. */
function NameHint({ id, tip, children }: TipProps & { id: string }): ReactElement {
  return (
    <Tip tip={tip} className="flex shrink-0 self-center text-muted-foreground">
      {children}
      <span id={id} className="sr-only">
        {tip}
      </span>
    </Tip>
  );
}

/** Tooltip targets sit above the stretched button, so the row opens on their clicks itself. */
function isTipClick(event: MouseEvent<HTMLLIElement>): boolean {
  const { target } = event;
  // Menu clicks bubble here through the React portal; only DOM descendants of the row count.
  return (
    target instanceof Element && event.currentTarget.contains(target) && !target.closest('button')
  );
}

/** ArrowUp / ArrowDown walk the open-buttons across every section, like a single list. */
function moveRowFocus(event: KeyboardEvent<HTMLButtonElement>): void {
  const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
  const list = event.currentTarget.closest('[data-flow-list]');
  if (step === 0 || !list) return;
  event.preventDefault();
  const buttons = Array.from(list.querySelectorAll<HTMLButtonElement>('[data-flow-open]'));
  buttons[buttons.indexOf(event.currentTarget) + step]?.focus();
}

function batchLabel(flow: FlowListItem): string | null {
  const active = flow.batch_active_count ?? 0;
  return active > 0 ? `Batch ${active}/${flow.batch_run_count ?? 0}` : null;
}

type NameCellProps = {
  id: string;
  flow: FlowListItem;
  hasDraft: boolean;
  showDisabled: boolean;
  onOpen: (id: string) => void;
};

/** The open-button (stretched over the row) plus the quiet hints that follow the name. */
function NameCell({ id, flow, hasDraft, showDisabled, onOpen }: NameCellProps): ReactElement {
  const trigger = flowTriggerHint(flow.trigger_type);
  const describedBy = [
    `${id}s`,
    trigger && `${id}t`,
    hasDraft && `${id}u`,
    flow.description && `${id}d`,
    `${id}w`,
  ];
  return (
    <div className="col-start-2 row-start-1 flex min-w-0 items-baseline gap-2">
      <button
        type="button"
        data-flow-open
        onClick={() => onOpen(flow.id)}
        onKeyDown={moveRowFocus}
        aria-describedby={describedBy.filter(Boolean).join(' ')}
        className={cn(
          'min-w-0 cursor-pointer truncate text-left text-sm font-medium leading-5 text-foreground outline-hidden',
          'after:absolute after:inset-0 after:rounded-lg',
          'focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset',
        )}
      >
        {flow.name}
      </button>
      {trigger ? (
        <NameHint id={`${id}t`} tip={trigger}>
          <FlowBlockIcon type={flow.trigger_type ?? ''} className="size-3.5" />
        </NameHint>
      ) : null}
      {hasDraft ? (
        <NameHint id={`${id}u`} tip="Unsaved changes">
          <PencilLine className="size-3.5" aria-hidden />
        </NameHint>
      ) : null}
      {showDisabled ? (
        <span className="shrink-0 text-xs text-muted-foreground">Disabled</span>
      ) : null}
    </div>
  );
}

type StatusCellProps = { id: string; state: FlowRunState; tone: FlowRunTone; batch: string | null };

/** The fixed status slot: a word only when it matters, batch progress only beside a live run. */
function StatusCell({ id, state, tone, batch }: StatusCellProps): ReactElement {
  return (
    <span
      id={`${id}s`}
      className={cn(
        'col-start-3 row-start-1 truncate pr-3 text-right text-xs',
        FLOW_RUN_TONE_CLASSES[tone],
      )}
    >
      {state.word ?? <span className="sr-only">{state.label}</span>}
      {batch ? (
        <span className={state.glyph === 'live' ? 'text-muted-foreground' : 'sr-only'}>
          {state.word ? ' · ' : ''}
          {batch}
        </span>
      ) : null}
    </span>
  );
}

type FlowListRowProps<T extends FlowListItem> = {
  flow: T;
  sectionId: FlowListSectionId;
  displayStatus: string | null;
  hasDraft: boolean;
  onOpen: (id: string) => void;
  onDelete: (flow: T) => void;
};

export function FlowListRow<T extends FlowListItem>({
  flow,
  sectionId,
  displayStatus,
  hasDraft,
  onOpen,
  onDelete,
}: FlowListRowProps<T>): ReactElement {
  const id = useId();
  const enabled = flow.is_enabled ?? true;
  const state = flowRunState(flow, displayStatus);
  // A switched-off flow cannot be acted on, so only a run still waiting on the user keeps colour.
  const tone = enabled || displayStatus === 'awaiting_input' ? state.tone : 'quiet';
  const batch = batchLabel(flow);
  const updated = `Updated ${FULL_DATE.format(new Date(flow.updated_at))}`;
  const live = state.glyph === 'live';
  // A switched-off flow greys out, unless its run still waits on the user.
  const dimmed = !enabled && displayStatus !== 'awaiting_input';

  return (
    <li
      data-flow-row
      onClick={(event) => isTipClick(event) && onOpen(flow.id)}
      className={cn(
        FLOW_ROW_GRID,
        'group relative cursor-pointer items-baseline rounded-lg transition-colors duration-150 ease-out',
        // 2.5% keeps muted and red text at AA while hovered in light; dark uses the accent step.
        'hover:bg-foreground/[0.025] dark:hover:bg-accent',
        // Hairline starts at the text column; it steps aside for the hovered row's fill.
        'before:absolute before:top-0 before:right-0 before:left-9 before:h-px before:bg-border/70',
        'before:transition-opacity before:duration-150 first:before:hidden hover:before:opacity-0',
        '[&:hover+li]:before:opacity-0',
        // A live run tints its row; the hairlines around it step aside like they do for hover.
        live && 'bg-status-online/[0.06] before:opacity-0 [&+li]:before:opacity-0',
        dimmed && '[&>*:not([data-row-menu])]:opacity-50',
      )}
    >
      <NameCell
        id={id}
        flow={flow}
        hasDraft={hasDraft}
        showDisabled={!enabled && sectionId !== 'disabled'}
        onOpen={onOpen}
      />
      <Tip
        tip={batch ? `${state.label} · ${batch}` : state.label}
        className="col-start-1 row-start-1 flex self-center"
      >
        <FlowStatusGlyph glyph={state.glyph} tone={tone} />
      </Tip>
      <StatusCell id={id} state={state} tone={tone} batch={batch} />
      <Tip
        tip={updated}
        className="col-start-4 row-start-1 justify-self-end text-xs text-muted-foreground tabular-nums"
      >
        <span aria-hidden>{formatFlowUpdated(flow.updated_at)}</span>
        <span id={`${id}w`} className="sr-only">
          {updated}
        </span>
      </Tip>
      <span
        data-row-menu
        className="relative col-start-5 row-start-1 -my-1 flex justify-end self-center"
      >
        <FlowRowMenu
          flow={flow}
          enabled={enabled}
          hasDraft={hasDraft}
          onDelete={() => onDelete(flow)}
        />
      </span>
      {/* Line two is the description alone; an empty one keeps the row height so rhythm holds. */}
      <p
        id={`${id}d`}
        className="col-span-3 col-start-2 row-start-2 min-h-4 truncate text-xs text-muted-foreground"
      >
        {flow.description}
      </p>
    </li>
  );
}
