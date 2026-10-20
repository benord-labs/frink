import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { getDatabase } from '../../db';
import { flowRunAdmissions, flowRuns } from '../../db/schema';
import {
  flowAdmissionQueueOrderKey,
  flowAdmissionResumeKey,
} from '../../db/schema/flow-run-admissions';

type Db = ReturnType<typeof getDatabase>;

export type MoveQueuedAdmissionResult = {
  status: 'moved' | 'unchanged' | 'stale' | 'priority_mismatch';
};

const FLOW_ADMISSION_CLASS_ORDER_BY = [
  asc(flowAdmissionQueueOrderKey(flowRunAdmissions)),
  asc(flowRunAdmissions.ticket),
] as const;

// Resumes, then run-first starts, then other starts; user order, then arrival, inside each group.
export const FLOW_ADMISSION_QUEUE_ORDER_BY = [
  desc(flowAdmissionResumeKey(flowRunAdmissions)),
  desc(flowRunAdmissions.runFirst),
  ...FLOW_ADMISSION_CLASS_ORDER_BY,
] as const;

const FLOW_ADMISSION_CLASS_ORDER_SQL = sql`${flowAdmissionQueueOrderKey(
  flowRunAdmissions,
)}, ${flowRunAdmissions.ticket}`;

export const FLOW_ADMISSION_QUEUE_ORDER_SQL = sql`${flowAdmissionResumeKey(flowRunAdmissions)} desc, ${flowRunAdmissions.runFirst} desc, ${FLOW_ADMISSION_CLASS_ORDER_SQL}`;

export function moveQueuedAdmission(
  db: Db,
  ticket: number,
  targetTicket: number,
): MoveQueuedAdmissionResult {
  const queued = db
    .select({
      priorityClass: flowRunAdmissions.priorityClass,
      runFirst: flowRunAdmissions.runFirst,
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
  const sameGroup = (row: (typeof queued)[number]) =>
    row.priorityClass === source.priorityClass && row.runFirst === source.runFirst;
  if (!sameGroup(target)) return { status: 'priority_mismatch' };

  const groupRows = queued.filter(sameGroup);
  const sourceIndex = groupRows.findIndex((row) => row.ticket === source.ticket);
  const targetIndex = groupRows.findIndex((row) => row.ticket === target.ticket);
  const reordered = groupRows.slice();
  const [moved] = reordered.splice(sourceIndex, 1);
  reordered.splice(targetIndex, 0, moved);
  const orderSlots = groupRows.map((row) => row.queueOrder ?? row.ticket).sort((a, b) => a - b);

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
