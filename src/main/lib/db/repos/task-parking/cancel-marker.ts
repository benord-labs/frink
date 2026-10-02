/**
 * How a cancel writes its marker onto a flow task's result — the sibling of this folder's park
 * writer, and bound by the same rule it states: the write MERGES, it never replaces.
 */
import { sql as drizzleSql, type SQL } from 'drizzle-orm';
import { RESTART_INTERRUPTION_REASON } from '../../../../../shared/types/flow';
import { tasks } from '../../schema';

/**
 * The cancel marker merged onto a task's existing result. `result.subChatId` (and `startMode`) are
 * the linkage the chat-reply resume path depends on — the same rule `parkFlowTaskForSubChat`
 * states and follows. Replacing the result orphaned a cancelled task from its sub-chat, so
 * `getLatestFlowTaskForSubChat` could no longer find it: the restart-interrupted run it identifies
 * became unrevivable, and the flow chat could not tell that interruption from a live taskless
 * window. `json_patch` merges in ONE statement, so the bulk boot sweep still needs no read pass.
 *
 * `agentSignal: null` DELETES the signal (RFC 7396 null member = remove), mirroring the user-pause
 * park writer. A cancel is the newest fact about the turn, so a `done` recorded mid-stream moments
 * before must not survive to classify the node `completed` and walk the flow past a step the user
 * stopped. `mapTaskToNodeOutput` enforces the same precedence independently; this keeps the row
 * honest as well. `heldQuestions: null` likewise drops a hold marker: a cancelled turn's question
 * must never be promoted to a park by a later boot.
 */
export function cancelResultPatch(interrupted: boolean): SQL {
  const marker = interrupted
    ? {
        cancelled: true,
        agentSignal: null,
        heldQuestions: null,
        error: RESTART_INTERRUPTION_REASON,
      }
    : { cancelled: true, agentSignal: null, heldQuestions: null };
  return drizzleSql`json_patch(coalesce(${tasks.result}, '{}'), ${JSON.stringify(marker)})`;
}
