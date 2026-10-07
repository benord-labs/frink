import { and, eq, inArray, not, notExists, type SQL, sql } from 'drizzle-orm';
import { FLOW_DRIVING_STATUSES, SIGNAL_DEAD_RUN_STATUSES } from '../../../../../shared/types/flow';
import type { getDatabase } from '../../index';
import { flowRuns, tasks } from '../../schema';
import { isSupersededAttempt } from './flow-collapse';

export function pausedFlowRun(flowRunId?: string): SQL | undefined {
  return flowRunId
    ? sql`exists (select 1 from ${flowRuns} where ${flowRuns.id} = ${flowRunId} and ${flowRuns.status} = 'paused')`
    : undefined;
}

/** What a retry's write requires of the task row: its run still paused (when the caller names one)
 * and its attempt still the node's current one, so a retry landing mid-flight cannot revive history. */
export function retryableAttempt(requirePausedFlowRunId?: string): SQL | undefined {
  return and(pausedFlowRun(requirePausedFlowRunId), not(isSupersededAttempt(tasks.nodeRunId)));
}

/**
 * A flow task drives its sub-chat only while its RUN is still live — a parked (`needs_attention`)
 * task outlives its run being cancelled, so task status alone reports a finished flow as live.
 * Only `completed`/`cancelled` count as dead; `failed`/`paused` runs still drive, because both are
 * chat-reply resume surfaces. `notExists` rather than a join: `tasks.flow_run_id` is
 * `onDelete: 'set null'`, so a task whose run row was deleted keeps driving on its own status.
 */
export function drivingFlowTaskOnSubChat(
  db: ReturnType<typeof getDatabase>,
  subChatId: string,
): SQL | undefined {
  return and(
    eq(tasks.source, 'flow'),
    inArray(tasks.status, [...FLOW_DRIVING_STATUSES]),
    sql`json_extract(${tasks.result}, '$.subChatId') = ${subChatId}`,
    notExists(
      db
        .select({ id: flowRuns.id })
        .from(flowRuns)
        .where(
          and(
            eq(flowRuns.id, tasks.flowRunId),
            inArray(flowRuns.status, [...SIGNAL_DEAD_RUN_STATUSES]),
          ),
        ),
    ),
  );
}
