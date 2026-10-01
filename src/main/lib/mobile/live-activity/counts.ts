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

/** What a waiting chat is waiting for, most specific first when a chat waits on several. */
export type WaitingKind = 'question' | 'permission' | 'plan' | 'attention';
export type WaitingChat = { kind: WaitingKind; subChatId?: string };

/** Every chat (or chat-less task, as `task:<id>`) that is waiting on the user, keyed by chat. */
export async function readWaitingChats(): Promise<Map<string, WaitingChat>> {
  const [questions, attention] = await Promise.all([
    chatsBySubChat(listPendingQuestionSubChatIds()),
    // A cap, not a page: the count must not depend on how many rows the phone shows.
    mobileCallers.tasks.listPaginated({
      workQueueSection: 'attention',
      collapseByFlow: true,
      limit: 200,
    }),
  ]);
  const waiting = new Map<string, WaitingChat>();
  for (const task of attention.items)
    if (WAITING_STATUSES.has(task.effectiveStatus))
      waiting.set(task.linkedChatId ?? (text(record(task.result).chatId) || `task:${task.id}`), {
        kind: task.effectiveStatus === 'plan_ready' ? 'plan' : 'attention',
      });
  for (const request of listPendingMoveChatRequests())
    waiting.set(request.chatId, { kind: 'permission' });
  for (const request of listPendingPermissionRequests())
    waiting.set(request.chatId, { kind: 'permission', subChatId: request.subChatId });
  for (const [subChatId, chatId] of questions) waiting.set(chatId, { kind: 'question', subChatId });
  return waiting;
}

/** Counts chats, not sessions or tasks, and never the same chat twice: needing you wins. */
export async function readAgentCounts(): Promise<MobileAgentCounts> {
  const waiting = await readWaitingChats();
  const running = new Set(
    listActiveExecutionHeaders()
      .map((execution) => execution.chatId ?? execution.subChatId)
      .filter((chatId) => !waiting.has(chatId)),
  );
  return { running: running.size, needsYou: waiting.size };
}
