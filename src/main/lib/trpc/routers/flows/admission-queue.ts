import { z } from 'zod';
import { getDatabase } from '../../../db';
import {
  kickStalledFlowAdmissionDrain,
  moveQueuedFlowAdmission,
} from '../../../flows/admission/runtime';
import { queuedAdmissionRun, queuedFlowAdmissions } from '../../../flows/admission/visibility';
import { cancelFlowRun } from '../../../flows/engine';
import { publicProcedureRaw } from '../../index';

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
        ticket: row.ticket,
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
  };
}
