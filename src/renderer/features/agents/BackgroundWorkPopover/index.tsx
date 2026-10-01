/** The held row's label, opening the list of what the wait is on. Main owns the list and re-publishes
 * it on every change; the last item has no row Stop because a per-item stop never ends a wait. */

import { Button } from '@benord-labs/frink-primitives';
import {
  Activity,
  Bot,
  ChevronDown,
  Clock,
  type LucideIcon,
  Radar,
  Square,
  SquareTerminal,
  Workflow,
} from 'lucide-react';
import { toast } from 'sonner';
import type { WakeHoldItem } from '../../../../shared/types/wake-hold';
import { Popover, PopoverContent, PopoverTrigger } from '../../../components/ui/popover';
import { trpc } from '../../../lib/trpc';

const KIND_ICONS = new Map<string, LucideIcon>([
  ['Command', SquareTerminal],
  ['Agent', Bot],
  ['Workflow', Workflow],
  ['Monitor', Radar],
  ['Scheduled wake', Clock],
]);

type BackgroundWorkPopoverProps = {
  subChatId: string;
  /** The trigger's text, e.g. "Working in the background — 1 Workflow". */
  label: string;
  /** Non-empty, as published by main. */
  waitingOn: WakeHoldItem[];
  /** Whether the held row offers its session Stop; a Flow chat's stop lives on the flow instead. */
  hasSessionStop: boolean;
};

export function BackgroundWorkPopover({
  subChatId,
  label,
  waitingOn,
  hasSessionStop,
}: BackgroundWorkPopoverProps) {
  const rowsCanStop = waitingOn.length > 1;
  const someRowCannotStop = waitingOn.some((item) => !(rowsCanStop && item.stoppable));
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-start gap-1 rounded-sm text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {label}
          <ChevronDown className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-md p-0">
        <div className="flex items-baseline justify-between gap-2 border-b border-border px-3 py-2">
          <span className="text-xs font-medium">Background work</span>
          <span className="text-[11px] text-muted-foreground">
            Updates when the agent checks in
          </span>
        </div>
        <ul className="py-1">
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
          <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
            {hasSessionStop
              ? 'Stop on the banner ends everything still running.'
              : 'The flow’s Stop ends everything still running.'}
          </p>
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
    <li className="flex items-start gap-2 px-3 py-1.5">
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium">{item.label}</div>
        <div className="line-clamp-2 text-xs text-muted-foreground" title={item.description}>
          {item.description}
        </div>
        {item.command ? (
          <div
            className="truncate font-mono text-[11px] text-muted-foreground"
            title={item.command}
          >
            {item.command}
          </div>
        ) : null}
      </div>
      {canStop ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1 rounded-md px-2 text-xs text-muted-foreground hover:text-foreground"
          disabled={stopTask.isPending}
          onClick={() => stopTask.mutate({ subChatId, taskId: item.id })}
          aria-label={`Stop ${item.label}: ${item.description}`}
          aria-busy={stopTask.isPending || undefined}
        >
          <Square className="h-3 w-3" aria-hidden />
          <span>{stopTask.isPending ? 'Stopping…' : 'Stop'}</span>
        </Button>
      ) : null}
    </li>
  );
}
