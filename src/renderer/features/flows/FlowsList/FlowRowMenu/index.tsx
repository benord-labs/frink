import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@benord-labs/frink-primitives';
import * as Sentry from '@sentry/electron/renderer';
import { TRPCClientError } from '@trpc/client';
import { Copy, MoreHorizontal, Power, PowerOff, Square, Trash2 } from 'lucide-react';
import { type MutableRefObject, type ReactElement, useRef } from 'react';
import { toast } from 'sonner';
import type { FlowRunAdmissionSummary } from '../../../../../shared/types';
import { trpc } from '../../../../lib/trpc';
import { cn } from '../../../../lib/utils';

type FlowRowMenuProps = {
  // biome-ignore-start lint/style/useNamingConvention: Flow list DTOs intentionally use API snake_case.
  flow: FlowRunAdmissionSummary & {
    id: string;
    name: string;
    node_count: number | null;
    latest_run_id?: string | null;
  };
  // biome-ignore-end lint/style/useNamingConvention: Flow list DTOs intentionally use API snake_case.
  enabled: boolean;
  hasDraft: boolean;
  onDelete: () => void;
};

const SAVED_ONLY_COPY_MESSAGE =
  'Copied the latest saved version; unsaved changes were not included.';

type CopyFlowArgs = {
  flow: { id: string; name: string };
  hasDraft: boolean;
  inFlight: MutableRefObject<boolean>;
  copy: (input: { id: string }) => Promise<{ id: string }>;
  refresh: () => Promise<void>;
};

/** One copy at a time per row; the guard lives on the row, so closing the menu cannot reset it. */
async function copyFlow({ flow, hasDraft, inFlight, copy, refresh }: CopyFlowArgs): Promise<void> {
  if (inFlight.current) return;
  inFlight.current = true;
  try {
    await copy({ id: flow.id });
  } catch (error) {
    Sentry.captureException(error, { tags: { source: 'FlowRowMenu', action: 'duplicate' } });
    toast.error(error instanceof Error && error.message ? error.message : 'Could not copy flow');
    return;
  } finally {
    inFlight.current = false;
  }
  // The copy is committed; a failed list refresh must not read as a failed copy and invite a retry.
  toast.success(hasDraft ? SAVED_ONLY_COPY_MESSAGE : `Copied “${flow.name}”`);
  void refresh();
}

/** Disabling only blocks new runs (start refuses a disabled flow), so a live run gets a caveat. */
function ToggleLabel({ enabled, liveRun }: { enabled: boolean; liveRun: boolean }): ReactElement {
  if (!enabled) {
    return (
      <>
        <Power className="h-3 w-3" aria-hidden />
        Enable flow
      </>
    );
  }
  return (
    <>
      <PowerOff className="mt-px h-3 w-3" aria-hidden />
      {liveRun ? (
        <span className="flex flex-col">
          Disable flow
          <span className="text-xs text-muted-foreground">
            The run in progress still finishes. New runs won't start.
          </span>
        </span>
      ) : (
        'Disable flow'
      )}
    </>
  );
}

export function FlowRowMenu({ flow, enabled, hasDraft, onDelete }: FlowRowMenuProps): ReactElement {
  const utils = trpc.useUtils();
  const copyInFlight = useRef(false);
  const copyMutation = trpc.flows.copy.useMutation();
  const unsaved = flow.node_count == null;
  const queued = flow.latest_run_admission_state === 'queued';
  const latestRunId = flow.latest_run_id ?? null;
  const canStopRun =
    latestRunId != null &&
    (queued || ['pending', 'running', 'paused'].includes(flow.latest_run_status ?? ''));

  const refreshAfterCancel = (runId: string) => {
    void utils.flows.listRuns.invalidate({ flowId: flow.id });
    void utils.flows.listBatches.invalidate({ flowId: flow.id });
    void utils.flows.listBatchRuns.invalidate({ flowId: flow.id });
    void utils.flows.listBatchStages.invalidate({ flowId: flow.id });
    void utils.flows.get.invalidate({ id: flow.id });
    void utils.flows.list.invalidate();
    void utils.flows.getRun.invalidate({ runId });
  };
  const updateMutation = trpc.flows.update.useMutation({
    onMutate: async (variables) => {
      await utils.flows.list.cancel();
      const prev = utils.flows.list.getData();
      utils.flows.list.setData(undefined, (old) =>
        old?.map((f) => (f.id === variables.id ? { ...f, ...variables } : f)),
      );
      return { prev };
    },
    onError: (err, _, context) => {
      if (context?.prev) utils.flows.list.setData(undefined, context.prev);
      toast.error(err.message || 'Could not update flow');
    },
    onSettled: () => void utils.flows.list.invalidate(),
  });
  const cancelRunMutation = trpc.flows.cancelRun.useMutation({
    onSuccess: (_data, { runId }) => {
      toast.success(queued ? 'Queued run cancelled' : 'Run stopped');
      refreshAfterCancel(runId);
    },
    onError: (err, { runId }) => {
      if (err instanceof TRPCClientError && err.data?.code === 'CONFLICT') {
        toast.info('Run already finished');
        refreshAfterCancel(runId);
        return;
      }
      toast.error(err.message || 'Could not stop run');
    },
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          iconOnly
          aria-label={`More actions for ${flow.name}`}
          className="size-7 text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontal className="size-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="w-56">
        {canStopRun ? (
          <DropdownMenuItem
            className="cursor-pointer text-xs"
            disabled={cancelRunMutation.isPending}
            onSelect={() => cancelRunMutation.mutate({ runId: latestRunId })}
          >
            <Square className="h-3 w-3" aria-hidden />
            {queued ? 'Cancel queued run' : 'Stop run'}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          className="cursor-pointer text-xs"
          disabled={unsaved || copyMutation.isPending}
          onSelect={() =>
            void copyFlow({
              flow,
              hasDraft,
              inFlight: copyInFlight,
              copy: copyMutation.mutateAsync,
              refresh: () => utils.flows.list.invalidate(),
            })
          }
        >
          <Copy className="h-3 w-3" aria-hidden />
          {unsaved ? 'Save the flow to duplicate it' : 'Duplicate'}
        </DropdownMenuItem>
        <DropdownMenuItem
          className={cn('cursor-pointer text-xs', enabled && canStopRun && 'items-start')}
          disabled={updateMutation.isPending}
          // biome-ignore lint/style/useNamingConvention: DB field name
          onSelect={() => updateMutation.mutate({ id: flow.id, is_enabled: !enabled })}
        >
          <ToggleLabel enabled={enabled} liveRun={canStopRun} />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="cursor-pointer text-xs" tone="danger" onSelect={onDelete}>
          <Trash2 className="h-3 w-3" aria-hidden />
          Delete flow
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
