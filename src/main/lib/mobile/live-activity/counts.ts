import { inArray } from 'drizzle-orm';
import type { MobileAgentCounts } from '../../../../shared/types/remote/mobile';
import { listPendingQuestionSubChatIds } from '../../claude/ask-user-question-approval';
import { getDatabase } from '../../db';
import { subChats } from '../../db/schema';
import { listActiveExecutionHeaders } from '../../socket/streaming/execution-registry';
import {
  listPendingMoveChatRequests,
  listPendingPermissionRequests,
} from '../../socket/streaming/pending-permission';
import { mobileCallers, record, text } from '../domain/context';

/** Task outcomes that wait on the user. Failed and interrupted runs are finished, like done. */
const WAITING_STATUSES = new Set(['needs_attention', 'plan_ready']);

/** Each sub-chat's chat, in one query; sub-chats that no longer exist are left out. */
export async function chatsBySubChat(subChatIds: string[]): Promise<Map<string, string>> {
  if (!subChatIds.length) return new Map();
  const rows = await getDatabase()
    .select({ id: subChats.id, chatId: subChats.chatId })
    .from(subChats)
    .where(inArray(subChats.id, subChatIds));
  return new Map(rows.map((row) => [row.id, row.chatId]));
}

/** Counts chats, not sessions or tasks, and never the same chat twice: needing you wins. */
export async function readAgentCounts(): Promise<MobileAgentCounts> {
  const [questions, attention] = await Promise.all([
    chatsBySubChat(listPendingQuestionSubChatIds()),
    // A cap, not a page: the count must not depend on how many rows the phone shows.
    mobileCallers.tasks.listPaginated({
      workQueueSection: 'attention',
      collapseByFlow: true,
      limit: 200,
    }),
  ]);
  const waiting = new Set([
    ...questions.values(),
    ...listPendingPermissionRequests().map((request) => request.chatId),
    ...listPendingMoveChatRequests().map((request) => request.chatId),
    ...attention.items
      .filter((task) => WAITING_STATUSES.has(task.effectiveStatus))
      .map((task) => task.linkedChatId ?? (text(record(task.result).chatId) || `task:${task.id}`)),
  ]);
  const running = new Set(
    listActiveExecutionHeaders()
      .map((execution) => execution.chatId ?? execution.subChatId)
      .filter((chatId) => !waiting.has(chatId)),
  );
  return { running: running.size, needsYou: waiting.size };
}
