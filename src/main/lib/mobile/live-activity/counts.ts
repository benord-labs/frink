import { inArray } from 'drizzle-orm';
import type { MobileAgentCounts, MobilePermission } from '../../../../shared/types/remote/mobile';
import { listPendingQuestionSubChatIds } from '../../claude/ask-user-question-approval';
import { getDatabase } from '../../db';
import { subChats } from '../../db/schema';
import { listActiveExecutionHeaders } from '../../socket/streaming/execution-registry';
import {
  listPendingMoveChatRequests,
  listPendingPermissionRequests,
} from '../../socket/streaming/pending-permission';
import { mobileCallers, record, text } from '../domain/context';
import { mobilePermissions } from '../domain/questions';

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
export type WaitingChat = {
  kind: WaitingKind;
  subChatId?: string;
  /** The chat's only pending permission request, when the phone can answer it. */
  requestId?: string;
};

/** Each chat waiting on exactly one permission request, mapped to it if the phone can answer it. */
function soleAnswerableRequests(): Map<string, string> {
  const only = new Map<string, MobilePermission | null>();
  for (const request of mobilePermissions())
    only.set(request.chatId, only.has(request.chatId) ? null : request);
  const answerable = new Map<string, string>();
  for (const [chatId, request] of only)
    if (request?.supported) answerable.set(chatId, request.requestId);
  return answerable;
}

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
  const answerable = soleAnswerableRequests();
  for (const request of listPendingPermissionRequests()) {
    const chat: WaitingChat = { kind: 'permission', subChatId: request.subChatId };
    const requestId = answerable.get(request.chatId);
    if (requestId) chat.requestId = requestId;
    waiting.set(request.chatId, chat);
  }
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
