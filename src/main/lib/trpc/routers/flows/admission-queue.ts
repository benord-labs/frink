import { z } from 'zod';
import { MAX_HELD_RUNS_LISTED } from '../../../../../shared/lib/flow-admission/constants';
import { getDatabase } from '../../../db';
import {
  kickStalledFlowAdmissionDrain,
  moveQueuedFlowAdmission,
} from '../../../flows/admission/runtime';
import {
  queuedAdmissionRun,
  queuedFlowAdmissions,
  workQueueHeldRuns,
} from '../../../flows/admission/visibility';
import { cancelFlowRun, dismissHeldFlowRun, startHeldFlowRun } from '../../../flows/engine';
import { publicProcedureRaw } from '../../index';

const heldRunInput = z.object({ run_id: z.string().min(1) });

export function flowAdmissionQueueProcedures() {
  return {
    workQueueAdmissions: publicProcedureRaw.query(() => {
      // The Work Queue polls this while open: a queue whose drain retries ran out recovers on the
      // next tick instead of waiting for a restart. Never awaited, so the read stays fast.
      kickStalledFlowAdmissionDrain();
      return queuedFlowAdmissions(getDatabase()).map((row) => ({
        flow_name: row.flowName,
        is_batch_member: row.batchId !== null,
        priority_class: row.priorityClass,
        project_name: row.projectName,
        requested_at: row.requestedAt,
        run_first: row.runFirst,
        ticket: row.ticket,
        trigger_context: row.triggerContext,
      }));
    }),
    moveWorkQueueAdmission: publicProcedureRaw
      .input(
        z.object({
          ticket: z.number().int().positive(),
          target_ticket: z.number().int().positive(),
        }),
      )
      .mutation(({ input }) => moveQueuedFlowAdmission(input.ticket, input.target_ticket)),
    // Removal is a dequeue, not a stop: `queuedOnly` keeps `cancelFlowRun` from touching a run
    // whose admission the scheduler claimed between the caller's read and this mutation.
    cancelWorkQueueAdmission: publicProcedureRaw
      .input(z.object({ ticket: z.number().int().positive() }))
      .mutation(async ({ input }) => {
        const target = queuedAdmissionRun(getDatabase(), input.ticket);
        if (!target) return { status: 'stale' as const };
        const cancelled = await cancelFlowRun(target.flowRunId, {
          queuedOnly: { ticket: input.ticket },
        });
        return { status: cancelled ? ('removed' as const) : ('stale' as const) };
      }),
    workQueueHeldRuns: publicProcedureRaw
      .input(z.object({ limit: z.number().int().positive().max(MAX_HELD_RUNS_LISTED) }))
      .query(({ input }) => workQueueHeldRuns(getDatabase(), input.limit)),
    // Both answer 'stale' when the run was started, dismissed or stopped somewhere else first.
    startHeldRun: publicProcedureRaw
      .input(heldRunInput)
      .mutation(async ({ input }): Promise<{ status: 'started' | 'stale' }> => ({
        status: (await startHeldFlowRun(input.run_id)) ? 'started' : 'stale',
      })),
    dismissHeldRun: publicProcedureRaw
      .input(heldRunInput)
      .mutation(async ({ input }): Promise<{ status: 'dismissed' | 'stale' }> => ({
        status: (await dismissHeldFlowRun(input.run_id)) ? 'dismissed' : 'stale',
      })),
  };
}
