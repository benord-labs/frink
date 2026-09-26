/**
 * Paginated run list for a single batch stage.
 * Uses listBatchStageRuns (queries batch_stage_runs directly) so pending/queued
 * runs appear before they have a flow_run. Fallback label: label → ticketId → title → "Run N".
 */

import { Button } from '@benord-labs/frink-primitives';
import { ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react';
import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import type { BatchStageRunRow } from '../../../../../../shared/types/flow';
import { useDirtyNavGuard } from '../../../../../hooks/use-dirty-nav-guard';
import { trpc } from '../../../../../lib/trpc';
import { cn } from '../../../../../lib/utils';
import { formatRelativeTime } from '../../../../../lib/utils/format-time';
import { DirtyNavAlertDialog } from '../../FlowRunHistoryPanel/BatchReportPanel/DirtyNavAlertDialog';
import { formatDuration } from '../../FlowRunHistoryPanel/format-duration';
import { FlowRunStatusIcon } from '../../FlowRunStatusIcon';
import { deriveRunLabel, runDisplayStatus } from './utils';

const PAGE_SIZE = 50;

type StageRunListProps = {
  flowId: string;
  batchId: string;
  stageId: string;
  selectedRunId?: string | null;
  onRunSelect?: (run: BatchStageRunRow, index: number) => void;
};

type RunRowProps = {
  run: BatchStageRunRow;
  index: number;
  isSelected: boolean;
  onSelect: () => void;
};

function RunRow({ run, index, isSelected, onSelect }: RunRowProps): ReactElement {
  const { showDialog, requestNav, confirmNav, cancelNav } = useDirtyNavGuard();
  const label = deriveRunLabel(run.trigger_context, index);
  const status = runDisplayStatus(run);
  const durationMs =
    run.started_at && run.completed_at
      ? new Date(run.completed_at).getTime() - new Date(run.started_at).getTime()
      : null;

  return (
    <li
      className={cn(
        'flex items-center gap-2.5 px-4 py-2.5 border-b border-border/20 last:border-0 cursor-pointer transition-colors',
        isSelected ? 'bg-primary/6' : 'hover:bg-muted/30',
      )}
    >
      <Button
        variant="ghost"
        className="flex h-auto flex-1 justify-start gap-2.5 min-w-0 p-0 text-left font-normal hover:bg-transparent"
        onClick={onSelect}
        aria-pressed={isSelected}
        aria-label={`Run: ${label}`}
      >
        <FlowRunStatusIcon status={status.icon} size="md" labelled={false} />
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-medium text-foreground/90 truncate" title={label}>
            {label}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span
              className={cn(
                'text-[10px] capitalize',
                status.warn ? 'text-warning' : 'text-muted-foreground/60',
              )}
            >
              {status.label}
            </span>
            {run.started_at && (
              <span className="text-[10px] text-muted-foreground/40">
                · {formatRelativeTime(run.started_at)}
                {durationMs != null && ` · ${formatDuration(durationMs)}`}
              </span>
            )}
          </div>
        </div>
      </Button>
      {run.chat_id && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="px-1.5 gap-0.5 text-[10px] shrink-0"
          onClick={() => requestNav(run.chat_id as string)}
          title="Open agent chat"
        >
          <ExternalLink className="h-2.5 w-2.5" aria-hidden />
          Chat
        </Button>
      )}
      <DirtyNavAlertDialog showDialog={showDialog} onConfirm={confirmNav} onCancel={cancelNav} />
    </li>
  );
}

export function StageRunList({
  flowId,
  batchId,
  stageId,
  selectedRunId,
  onRunSelect,
}: StageRunListProps): ReactElement {
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    setOffset(0);
  }, [flowId, batchId, stageId]);

  const { data, isLoading, isError } = trpc.flows.listBatchStageRuns.useQuery(
    { flowId, stageId, limit: PAGE_SIZE, offset },
    { staleTime: 30_000 },
  );

  const runs = data?.runs ?? [];
  const total = data?.total ?? 0;
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + PAGE_SIZE, total);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
        Loading…
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex items-center justify-center py-8 text-destructive/70 text-sm">
        Could not load runs.
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
        No runs yet.
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <ul className="flex-1 overflow-y-auto min-h-0">
        {runs.map((run, i) => (
          <RunRow
            key={run.id}
            run={run}
            index={offset + i}
            isSelected={run.id === selectedRunId}
            onSelect={() => onRunSelect?.(run, offset + i)}
          />
        ))}
      </ul>
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between border-t border-border/30 px-4 py-2 shrink-0">
          <span className="text-[11px] text-muted-foreground/70">
            {pageStart}–{pageEnd} of {total}
          </span>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="w-6 p-0"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="w-6 p-0"
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
              aria-label="Next page"
            >
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
