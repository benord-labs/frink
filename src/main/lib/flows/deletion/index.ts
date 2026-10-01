import { getDatabase } from '../../db';
import { hardDeleteFlow, listUnsettledFlowRunIdsForFlow } from '../../db/repos/flow-deletion';
import { getFlowById, updateFlow } from '../../db/repos/flows';
import type { DeleteChatsResult } from '../../db/repos/task-queries/chat-flow-cleanup';
import { clearActiveFlowTaskForChatIfMatches } from '../../task-executor';
import { abortFlowRun } from '../cancel-registry';
import { cancelFlowRunForChatDeletion, cancelFlowRunForDeletion } from '../engine';

const DELETE_ATTEMPTS = 100;
const DELETE_RETRY_MS = 50;
type Db = ReturnType<typeof getDatabase>;
type CancelRun = (flowRunId: string) => Promise<void>;

const waitForDeletionRetry = () =>
  new Promise<void>((resolve) => setTimeout(resolve, DELETE_RETRY_MS));

export async function settleChatOwnedFlowDeletion(
  attemptDelete: () => DeleteChatsResult | Promise<DeleteChatsResult>,
  cancelRun = cancelFlowRunForChatDeletion,
): Promise<void> {
  for (let attempt = 0; attempt < DELETE_ATTEMPTS; attempt += 1) {
    const result = await attemptDelete();
    if (result.deleted) return;
    for (const flowRunId of result.unsettledRunIds) {
      await cancelRun(flowRunId, result.chatIds);
    }
    if (attempt + 1 < DELETE_ATTEMPTS) await waitForDeletionRetry();
  }
  throw new Error(
    'Deletion could not finish while Flow work was still stopping. Please try again.',
  );
}

async function deleteSettledFlow(
  db: Db,
  flowId: string,
  cancelRun: CancelRun,
): Promise<Array<{ chatId: string; taskId: string }>> {
  const { transitionFlowRun } = await import('../admission/runtime');
  let unsettledRunIds = await listUnsettledFlowRunIdsForFlow(db, flowId);
  for (let attempt = 0; attempt < DELETE_ATTEMPTS; attempt += 1) {
    for (const flowRunId of unsettledRunIds) await cancelRun(flowRunId);

    const result = await transitionFlowRun(
      () => hardDeleteFlow(db, flowId),
      (deleted) => {
        if (deleted.deleted) for (const flowRunId of deleted.flowRunIds) abortFlowRun(flowRunId);
      },
    );
    if (result.deleted) return result.taskLinks;

    unsettledRunIds = result.unsettledRunIds;
    if (attempt + 1 < DELETE_ATTEMPTS) await waitForDeletionRetry();
  }
  throw new Error(
    'Flow deletion could not finish while work was still stopping. Please try again.',
  );
}

/** Stop every execution, then permanently remove the Flow and all of its queue rows. */
export async function deleteFlow(
  flowId: string,
  cancelRun = cancelFlowRunForDeletion,
): Promise<boolean> {
  const db = getDatabase();
  const flow = await getFlowById(db, flowId);
  if (!flow) return false;
  if (flow.isEnabled && !(await updateFlow(db, flowId, { isEnabled: false }))) return false;

  try {
    for (const { chatId, taskId } of await deleteSettledFlow(db, flowId, cancelRun)) {
      clearActiveFlowTaskForChatIfMatches(chatId, taskId);
    }
    return true;
  } catch (error) {
    if (flow.isEnabled) await updateFlow(db, flowId, { isEnabled: true });
    throw error;
  }
}
