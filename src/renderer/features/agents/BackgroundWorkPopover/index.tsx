/** The held row, whose label opens the list of what the wait is on — anchored to the whole row and
 * as wide as it. Main owns the list; the last item has no row Stop since that never ends a wait. */

import { Button } from '@benord-labs/frink-primitives';
import {
  Activity,
  Bot,
  ChevronUp,
  Clock,
  type LucideIcon,
  Radar,
  Square,
  SquareTerminal,
  Workflow,
} from 'lucide-react';
import { type ReactNode, useRef } from 'react';
import { toast } from 'sonner';
import type { WakeHoldItem } from '../../../../shared/types/wake-hold';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from '../../../components/ui/popover';
import {
  overlayItemBase,
  overlayItemHover,
  overlayLabel,
  overlaySeparator,
} from '../../../lib/overlay-styles';
import { trpc } from '../../../lib/trpc';
import { cn } from '../../../lib/utils';
import { RunStatusRow } from '../RunStatusRow';
import { WorkflowProgress } from './WorkflowProgress';

const KIND_ICONS = new Map<string, LucideIcon>([
  ['Command', SquareTerminal],
  ['Agent', Bot],
  ['Workflow', Workflow],
  ['Monitor', Radar],
  ['Scheduled wake', Clock],
]);

type BackgroundWorkPopoverProps = {
  subChatId: string;
  /** The row's text, e.g. "Working in the background — 1 Workflow". */
  label: string;
  /** Non-empty, as published by main. */
  waitingOn: WakeHoldItem[];
  /** Whether the row offers its session Stop; a Flow chat's stop lives on the flow instead. */
  hasSessionStop: boolean;
  /** The row's own actions (its session Stop). */
  children: ReactNode;
};

export function BackgroundWorkPopover({
  subChatId,
  label,
  waitingOn,
  hasSessionStop,
  children,
}: BackgroundWorkPopoverProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const rowsCanStop = waitingOn.length > 1;
  const someRowCannotStop = waitingOn.some((item) => !(rowsCanStop && item.stoppable));
  return (
    <Popover>
      <PopoverAnchor virtualRef={cardRef} />
      <RunStatusRow
        cardRef={cardRef}
        dotClassName="bg-primary motion-safe:animate-pulse"
        label={
          <PopoverTrigger asChild>
            <button
              type="button"
              className="group inline-flex items-start gap-1 rounded-sm text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {label}
              <ChevronUp
                className="mt-0.5 h-3 w-3 shrink-0 transition-transform group-data-[state=open]:rotate-180"
                aria-hidden
              />
            </button>
          </PopoverTrigger>
        }
      >
        {children}
      </RunStatusRow>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        // Focus the panel, not its first Stop: that would pop the Stop's tooltip unasked.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
        tabIndex={-1}
        // As wide as the row, but never so narrow that the titles stop being readable: below
        // 32rem the kind label and Stop text give their room to the title.
        className="@container/bg-work max-h-(--radix-popover-content-available-height) w-(--radix-popover-trigger-width) min-w-[min(22rem,var(--radix-popover-content-available-width))] overflow-y-auto p-1"
      >
        <div className={cn(overlayLabel, 'flex flex-wrap items-baseline justify-between gap-x-2')}>
          <span>Background work</span>
          <span className="font-normal">Updates when the agent checks in</span>
        </div>
        <ul>
          {waitingOn.map((item) => (
            <BackgroundWorkRow
              key={item.id}
              subChatId={subChatId}
              item={item}
              canStop={rowsCanStop && item.stoppable}
            />
          ))}
        </ul>
        {someRowCannotStop ? (
          <>
            <div className={overlaySeparator} />
            <p className={cn(overlayLabel, 'font-normal')}>
              {!hasSessionStop
                ? 'The flow’s Stop ends everything still running.'
                : rowsCanStop
                  ? 'Stop all ends everything still running.'
                  : 'Stop on the banner ends it.'}
            </p>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function BackgroundWorkRow({
  subChatId,
  item,
  canStop,
}: {
  subChatId: string;
  item: WakeHoldItem;
  canStop: boolean;
}) {
  const Icon = KIND_ICONS.get(item.label) ?? Activity;
  const stopTask = trpc.socket.stopBackgroundTask.useMutation({
    onSuccess: (result) => {
      if (result.ok) return;
      if (result.reason === 'failed')
        toast.error('Couldn’t stop it', { description: result.message });
      if (result.reason === 'timeout') {
        toast.info('Still stopping', { description: 'The agent hasn’t confirmed yet.' });
      }
      // 'ended' and 'last': the wait already moved on, and its next publish corrects this list.
    },
    onError: (error) => toast.error('Couldn’t stop it', { description: error.message }),
  });

  return (
    <li className={cn(overlayItemBase, overlayItemHover, 'items-start gap-2 py-1')}>
      <Icon className="mt-[3px] h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          {/* Wraps rather than truncates: rows often differ only at the end of the title. */}
          <span className="min-w-0 line-clamp-2 wrap-break-word" title={item.description}>
            {item.description || item.label}
          </span>
          {/* The icon already shows the kind, so narrow rows keep the label for screen readers only. */}
          <span className="shrink-0 text-xs text-muted-foreground @max-[32rem]/bg-work:sr-only">
            {item.label}
          </span>
        </div>
        {item.command ? (
          <div className="truncate font-mono text-xs text-muted-foreground" title={item.command}>
            {item.command}
          </div>
        ) : null}
        {item.label === 'Workflow' ? (
          <WorkflowProgress subChatId={subChatId} taskId={item.id} />
        ) : null}
      </div>
      {canStop ? (
        // The banner's own Stop, so the two read as one control.
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1 rounded-md px-2 text-xs text-muted-foreground hover:text-foreground @max-[32rem]/bg-work:w-7 @max-[32rem]/bg-work:px-0 @max-[32rem]/bg-work:[&>span]:sr-only"
          title="Stop"
          disabled={stopTask.isPending}
          onClick={() => stopTask.mutate({ subChatId, taskId: item.id })}
          aria-label={`Stop ${item.label}: ${item.description}`}
          aria-busy={stopTask.isPending || undefined}
        >
          <Square className="h-3.5 w-3.5" aria-hidden />
          <span>{stopTask.isPending ? 'Stopping…' : 'Stop'}</span>
        </Button>
      ) : null}
    </li>
  );
}
