/**
 * Last-run status indicator for the FlowEditor header.
 * Shows status icon, relative time, and outcome summary for the most recent run.
 * Refreshes on new flow execution socket events.
 */

import { useEffect } from 'react';
import type { FlowExecutionEvent } from '../../../../../shared/types/flow';
import { trpc } from '../../../../lib/trpc';
import { formatRelativeTime } from '../../../../lib/utils/format-time';
import { isDesktopApp } from '../../../../lib/utils/platform';
import {
  FlowRunStatusIcon,
  flowRunDisplayStatus,
  shouldPollFlowAdmission,
} from '../FlowRunStatusIcon';

type FlowLastRunBadgeProps = {
  flowId: string;
};

export function FlowLastRunBadge({ flowId }: FlowLastRunBadgeProps) {
  const utils = trpc.useUtils();
  const { data: runs } = trpc.flows.listRuns.useQuery(
    // Match Run History's query key so queued polling shares one backend request.
    { flowId, limit: 20 },
    {
      enabled: true,
      staleTime: 30_000,
      refetchInterval: (query) =>
        shouldPollFlowAdmission(
          query.state.data?.[0]?.status,
          query.state.data?.[0]?.admission_state,
        )
          ? 5_000
          : false,
      refetchIntervalInBackground: false,
    },
  );

  // Re-fetch when a run event for this flow arrives
  useEffect(() => {
    if (!isDesktopApp()) return;
    if (!window.desktopApi?.onSocketFlowExecutionEvent) return;

    const unsubscribe = window.desktopApi.onSocketFlowExecutionEvent(
      (event: FlowExecutionEvent) => {
        if (event.flowId !== flowId) return;
        void utils.flows.listRuns.invalidate({ flowId });
      },
    );

    return unsubscribe;
  }, [flowId, utils]);

  const lastRun = runs?.[0];
  if (!lastRun) return null;

  const { status, completed_at, started_at, active_task_status, admission_state } = lastRun;
  const displayStatus = flowRunDisplayStatus(status, active_task_status, admission_state);
  const timestamp =
    displayStatus === 'queued' ? lastRun.admission_requested_at : (completed_at ?? started_at);
  const position = displayStatus === 'queued' ? lastRun.queue_position : null;

  return (
    <div
      className="flex items-center gap-1 min-w-0 ml-1.5"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <FlowRunStatusIcon status={displayStatus} size="sm" labelled={displayStatus !== 'queued'} />
      <span className="text-[11px] text-muted-foreground truncate">
        {displayStatus === 'queued' ? 'Queued · ' : ''}
        {position != null ? `#${position} · ` : ''}
        {timestamp ? formatRelativeTime(timestamp) : displayStatus}
      </span>
    </div>
  );
}
