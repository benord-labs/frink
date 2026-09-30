import { and, eq, inArray, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm';
import { FLOW_ADMISSION_LIVE_STATES } from '../../../../../shared/lib/flow-admission';
import { FLOW_DRIVING_STATUSES } from '../../../../../shared/types/flow';
import type { getDatabase } from '../../index';
import { cancelRunRows } from '../../../flows/transitions';
import { chats, flowRunAdmissions, flowRuns, nodeRuns, tasks } from '../../schema';
import { cancelResultPatch } from '../task-parking/cancel-marker';

type Db = ReturnType<typeof getDatabase>;

export type DeleteChatsResult =
  | { deleted: false; unsettledRunIds: string[]; chatIds: string[] }
  | { deleted: true };

const taskChatId = sql<string | null>`CASE
  WHEN ${tasks.result} IS NULL THEN NULL
  WHEN NOT json_valid(${tasks.result}) THEN NULL
  WHEN json_type(${tasks.result}) <> 'object' THEN NULL
  ELSE json_extract(${tasks.result}, '$.chatId')
END`;

function protectedTasksOutsideChats(chatIds: string[]) {
  return and(
    notInArray(tasks.status, ['completed', 'cancelled']),
    isNotNull(taskChatId),
    notInArray(taskChatId, chatIds),
  );
}

function compactFlowRunIds(rows: Array<{ flowRunId: string | null }>): string[] {
  return rows.flatMap(({ flowRunId }) => (flowRunId ? [flowRunId] : []));
}

export function listUnsettledFlowRunIdsForChats(db: Db, chatIds: string[]): string[] {
  if (chatIds.length === 0) return [];
  const linkedActiveRunIds = db
    .selectDistinct({ flowRunId: flowRuns.id })
    .from(flowRuns)
    .leftJoin(nodeRuns, eq(nodeRuns.flowRunId, flowRuns.id))
    .leftJoin(tasks, eq(tasks.flowRunId, flowRuns.id))
    .leftJoin(flowRunAdmissions, eq(flowRunAdmissions.flowRunId, flowRuns.id))
    .where(
      and(
        or(
          inArray(flowRuns.status, ['pending', 'running', 'paused']),
          inArray(flowRunAdmissions.state, [...FLOW_ADMISSION_LIVE_STATES]),
        ),
        or(
          inArray(sql<string>`json_extract(${flowRuns.triggerContext}, '$.chatId')`, chatIds),
          inArray(sql<string>`json_extract(${nodeRuns.nodeOutput}, '$.outputs.chatId')`, chatIds),
          inArray(taskChatId, chatIds),
        ),
      ),
    )
    .all()
    .map((row) => row.flowRunId);
  const ownedDrivingRunIds = compactFlowRunIds(
    db
      .selectDistinct({ flowRunId: tasks.flowRunId })
      .from(tasks)
      .where(
        and(
          isNotNull(tasks.flowRunId),
          inArray(taskChatId, chatIds),
          inArray(tasks.status, [...FLOW_DRIVING_STATUSES]),
        ),
      )
      .all(),
  );
  const siblingProtectedRunIds = new Set(
    compactFlowRunIds(
      db
        .selectDistinct({ flowRunId: tasks.flowRunId })
        .from(tasks)
        .where(and(isNotNull(tasks.flowRunId), protectedTasksOutsideChats(chatIds)))
        .all(),
    ),
  );
  return [
    ...new Set([
      ...ownedDrivingRunIds,
      ...linkedActiveRunIds.filter((flowRunId) => !siblingProtectedRunIds.has(flowRunId)),
    ]),
  ];
}

function cancelDrivingFlowTasksForChats(
  db: Db,
  flowRunId: string,
  chatIds: string[],
  includeUnclaimed: boolean,
  includeParked: boolean,
): number {
  if (chatIds.length === 0) return 0;
  const statuses = includeParked ? FLOW_DRIVING_STATUSES : (['pending', 'running'] as const);
  return db
    .update(tasks)
    .set({ status: 'cancelled', completedAt: new Date(), result: cancelResultPatch(false) })
    .where(
      and(
        eq(tasks.source, 'flow'),
        eq(tasks.flowRunId, flowRunId),
        includeUnclaimed
          ? or(isNull(taskChatId), inArray(taskChatId, chatIds))
          : inArray(taskChatId, chatIds),
        inArray(tasks.status, [...statuses]),
      ),
    )
    .returning({ id: tasks.id })
    .all().length;
}

export type ChatOwnedFlowCancellation = 'preserved' | 'cancelled' | 'settled';

/** Decide and persist chat-scoped cancellation without a sibling-task check/act race. */
function cancelChatOwnedFlowWorkWithScope(
  db: Db,
  flowRunId: string,
  chatIds: string[],
  abortRun: () => void,
  includeParked: boolean,
): ChatOwnedFlowCancellation {
  if (chatIds.length === 0) return 'settled';
  return db.transaction(
    () => {
      const siblingTask = db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.flowRunId, flowRunId), protectedTasksOutsideChats(chatIds)))
        .limit(1)
        .all()[0];
      if (siblingTask) {
        cancelDrivingFlowTasksForChats(db, flowRunId, chatIds, false, includeParked);
        return 'preserved';
      }

      cancelDrivingFlowTasksForChats(db, flowRunId, chatIds, true, includeParked);
      if (!cancelRunRows(db, flowRunId, { includeParked: false })) return 'settled';
      abortRun();
      return 'cancelled';
    },
    { behavior: 'immediate' },
  );
}

export function cancelChatOwnedFlowWork(
  db: Db,
  flowRunId: string,
  chatIds: string[],
  abortRun: () => void,
): ChatOwnedFlowCancellation {
  return cancelChatOwnedFlowWorkWithScope(db, flowRunId, chatIds, abortRun, true);
}

export function cancelChatOwnedFlowWorkForArchive(
  db: Db,
  flowRunId: string,
  chatIds: string[],
  abortRun: () => void,
): ChatOwnedFlowCancellation {
  return cancelChatOwnedFlowWorkWithScope(db, flowRunId, chatIds, abortRun, false);
}

/** Archive stops executing work but leaves parked review tasks available for restore. */
export function cancelExecutingFlowTasksForChats(db: Db, chatIds: string[]): number {
  if (chatIds.length === 0) return 0;
  return db
    .update(tasks)
    .set({ status: 'cancelled', completedAt: new Date(), result: cancelResultPatch(false) })
    .where(
      and(
        eq(tasks.source, 'flow'),
        inArray(taskChatId, chatIds),
        inArray(tasks.status, ['pending', 'running']),
      ),
    )
    .returning({ id: tasks.id })
    .all().length;
}

/** Delete queue rows owned by chats being permanently deleted. Must run in the caller's transaction. */
export function deleteFlowQueueTasksForChats(db: Db, chatIds: string[]): number {
  if (chatIds.length === 0) return 0;
  const linkedRunIds = db
    .selectDistinct({ flowRunId: flowRuns.id })
    .from(flowRuns)
    .leftJoin(nodeRuns, eq(nodeRuns.flowRunId, flowRuns.id))
    .leftJoin(tasks, eq(tasks.flowRunId, flowRuns.id))
    .where(
      or(
        inArray(sql<string>`json_extract(${flowRuns.triggerContext}, '$.chatId')`, chatIds),
        inArray(sql<string>`json_extract(${nodeRuns.nodeOutput}, '$.outputs.chatId')`, chatIds),
        inArray(taskChatId, chatIds),
      ),
    )
    .all()
    .map((row) => row.flowRunId);
  const sharedRunIds = new Set(
    compactFlowRunIds(
      linkedRunIds.length === 0
        ? []
        : db
            .selectDistinct({ flowRunId: tasks.flowRunId })
            .from(tasks)
            .where(and(inArray(tasks.flowRunId, linkedRunIds), protectedTasksOutsideChats(chatIds)))
            .all(),
    ),
  );
  const exclusivelyOwnedRunIds = linkedRunIds.filter((id) => !sharedRunIds.has(id));
  const deletableClaimedTask = and(
    inArray(taskChatId, chatIds),
    or(isNull(tasks.flowRunId), notInArray(tasks.status, [...FLOW_DRIVING_STATUSES])),
  );
  const chatOwnership =
    exclusivelyOwnedRunIds.length === 0
      ? deletableClaimedTask
      : or(
          deletableClaimedTask,
          and(isNull(taskChatId), inArray(tasks.flowRunId, exclusivelyOwnedRunIds)),
        );
  const removed = db
    .delete(tasks)
    .where(and(eq(tasks.source, 'flow'), chatOwnership))
    .returning({ id: tasks.id })
    .all();
  return removed.length;
}

export function deleteChatWithFlowQueueTasks(db: Db, chatId: string): DeleteChatsResult {
  return db.transaction(
    () => {
      const unsettledRunIds = listUnsettledFlowRunIdsForChats(db, [chatId]);
      if (unsettledRunIds.length > 0) {
        return { deleted: false, unsettledRunIds, chatIds: [chatId] };
      }
      deleteFlowQueueTasksForChats(db, [chatId]);
      db.delete(chats).where(eq(chats.id, chatId)).run();
      return { deleted: true };
    },
    { behavior: 'immediate' },
  );
}
