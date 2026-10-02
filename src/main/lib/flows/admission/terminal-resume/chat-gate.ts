// Deleting a run's start_task chat abandons the run, so a resume into it is refused
// (sc-3509, flow-run-restart-recovery).

import { eq } from 'drizzle-orm';
import type { getDatabase } from '../../../db';
import { resolveUpstreamStartTaskContextSync } from '../../../db/repos/start-task-context';
import { chats, flowVersions, nodeRuns } from '../../../db/schema';
import { findUpstreamNodeIds, parseGraph } from '../../graph';

type Db = ReturnType<typeof getDatabase>;

export const RESUME_CHAT_DELETED_MESSAGE =
  "This run's chat was deleted — start the flow again to re-run it.";

export function chatExists(db: Db, chatId: string): boolean {
  return Boolean(db.select({ id: chats.id }).from(chats).where(eq(chats.id, chatId)).get());
}

/** The anchor's upstream start_task chat (lane-scoped like dispatch) is gone. A start_task anchor
 * or a run with no completed start_task gets a fresh chat; an archived chat still resumes. */
export function resumeChatDeleted(
  db: Db,
  flowRunId: string,
  nodeRunId: string,
  flowVersionId: string,
): boolean {
  const anchor = db
    .select({ nodeId: nodeRuns.nodeId, blockType: nodeRuns.blockType })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, nodeRunId))
    .get();
  if (!anchor || anchor.blockType === 'start_task') return false;
  const version = db
    .select({ graph: flowVersions.graph })
    .from(flowVersions)
    .where(eq(flowVersions.id, flowVersionId))
    .get();
  if (!version) return false;
  let upstreamNodeIds: string[];
  try {
    upstreamNodeIds = findUpstreamNodeIds(parseGraph(version.graph), anchor.nodeId);
  } catch {
    // An unparseable graph is not this gate's call; dispatch reports it.
    return false;
  }
  const context = resolveUpstreamStartTaskContextSync(db, flowRunId, {
    nodeRunId,
    upstreamNodeIds,
  });
  const chatId = context?.chatId;
  return Boolean(chatId) && !chatExists(db, chatId as string);
}
