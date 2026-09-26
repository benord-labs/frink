import { and, asc, eq, sql } from 'drizzle-orm';
import type { getDatabase } from '../../db';
import { flowRunAdmissions, flowRuns } from '../../db/schema';
import { flowAdmissionQueueOrderKey } from '../../db/schema/flow-run-admissions';

type Db = ReturnType<typeof getDatabase>;

export type MoveQueuedAdmissionResult = {
  status: 'moved' | 'unchanged' | 'stale' | 'priority_mismatch';
};

const FLOW_ADMISSION_CLASS_ORDER_BY = [
  asc(flowAdmissionQueueOrderKey(flowRunAdmissions)),
  asc(flowRunAdmissions.ticket),
] as const;

export const FLOW_ADMISSION_QUEUE_ORDER_BY = [
  asc(flowRunAdmissions.priorityClass),
  ...FLOW_ADMISSION_CLASS_ORDER_BY,
] as const;

const FLOW_ADMISSION_CLASS_ORDER_SQL = sql`${flowAdmissionQueueOrderKey(
  flowRunAdmissions,
)}, ${flowRunAdmissions.ticket}`;

export const FLOW_ADMISSION_QUEUE_ORDER_SQL = sql`${flowRunAdmissions.priorityClass}, ${FLOW_ADMISSION_CLASS_ORDER_SQL}`;

export function moveQueuedAdmission(
  db: Db,
  ticket: number,
  targetTicket: number,
): MoveQueuedAdmissionResult {
  const queued = db
    .select({
      priorityClass: flowRunAdmissions.priorityClass,
      queueOrder: flowRunAdmissions.queueOrder,
      ticket: flowRunAdmissions.ticket,
    })
    .from(flowRunAdmissions)
    .innerJoin(flowRuns, eq(flowRuns.id, flowRunAdmissions.flowRunId))
    .where(eq(flowRunAdmissions.state, 'queued'))
    .orderBy(...FLOW_ADMISSION_QUEUE_ORDER_BY)
    .all();
  const source = queued.find((row) => row.ticket === ticket);
  const target = queued.find((row) => row.ticket === targetTicket);
  if (!source || !target) {
    return { status: 'stale' };
  }
  if (source.ticket === target.ticket) return { status: 'unchanged' };
  if (source.priorityClass !== target.priorityClass) return { status: 'priority_mismatch' };

  const classRows = queued.filter((row) => row.priorityClass === source.priorityClass);
  const sourceIndex = classRows.findIndex((row) => row.ticket === source.ticket);
  const targetIndex = classRows.findIndex((row) => row.ticket === target.ticket);
  const reordered = classRows.slice();
  const [moved] = reordered.splice(sourceIndex, 1);
  reordered.splice(targetIndex, 0, moved);
  const orderSlots = classRows.map((row) => row.queueOrder ?? row.ticket).sort((a, b) => a - b);

  for (const [index, row] of reordered.entries()) {
    const queueOrder = orderSlots[index];
    if (row.queueOrder === queueOrder) continue;
    const update = db
      .update(flowRunAdmissions)
      .set({ queueOrder })
      .where(and(eq(flowRunAdmissions.ticket, row.ticket), eq(flowRunAdmissions.state, 'queued')))
      .run();
    if (update.changes !== 1) {
      throw new Error(`Queued admission ${row.ticket} changed during reorder`);
    }
  }
  return { status: 'moved' };
}
