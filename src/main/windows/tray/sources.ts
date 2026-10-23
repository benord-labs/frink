import { inArray } from 'drizzle-orm';
import {
  listPendingQuestionProjections,
  listPendingQuestionSubChatIds,
} from '../../lib/claude/ask-user-question-approval';
import { getDatabase } from '../../lib/db';
import { listAwaitingApprovals } from '../../lib/db/repos/task-queries/work-queue-overview-filter';
import { chats, tasks } from '../../lib/db/schema';
import { respondMobilePermission } from '../../lib/mobile/domain/chat';
import { readWaitingChats } from '../../lib/mobile/live-activity/counts';
import { readWakeHolds } from '../../lib/socket/claude-wake-hold';
import { listActiveExecutionHeaders } from '../../lib/socket/streaming/execution-registry';
import { listLiveStreamActivity } from '../../lib/socket/streaming/live-stream';
import {
  listPendingMoveChatRequests,
  listPendingPermissionRequests,
} from '../../lib/socket/streaming/pending-permission';
import { describeActivity, streamPartSchema } from './activity';
import type { TrayApproval, TrayLive, TraySaved } from './model';

/** `canApprove`: the app window is loaded, so an approved command can carry on. */
export function readTrayLive(canApprove: boolean): TrayLive {
  const working: TrayLive['working'] = listLiveStreamActivity().map(({ lastPart, ...stream }) => ({
    ...stream,
    activity: describeActivity(streamPartSchema.safeParse(lastPart).data),
  }));
  for (const { chatId, subChatId } of listActiveExecutionHeaders()) {
    const entry = working.find((item) => item.subChatId === subChatId);
    if (entry) entry.held = false;
    else if (chatId) working.push({ chatId, subChatId, held: false, activity: 'Working' });
  }
  // A chat can wait on background work after its reply stream has ended: it is still working.
  for (const [subChatId, { chatId, pump }] of readWakeHolds())
    if (!pump.isEnded() && !working.some((item) => item.subChatId === subChatId))
      working.push({ chatId, subChatId, held: true, activity: 'Working' });
  return {
    permissions: [
      ...listPendingPermissionRequests().map(
        ({ chatId, subChatId, requestId, type, prompt, path }) =>
          // A rich prompt has its own review card, so only a plain shell command is answered here.
          type === 'bash' && !prompt?.presentation
            ? { chatId, subChatId, requestId, command: path }
            : { chatId, subChatId, requestId },
      ),
      ...listPendingMoveChatRequests().map(({ chatId, subChatId, requestId }) => ({
        chatId,
        subChatId,
        requestId,
      })),
    ],
    questions: listPendingQuestionSubChatIds().flatMap((subChatId) =>
      listPendingQuestionProjections(subChatId)
        .slice(0, 1)
        .map(({ chatId }) => ({ chatId, subChatId })),
    ),
    working,
    canApprove,
  };
}

export async function readTraySaved(chatIds: string[]): Promise<TraySaved> {
  const db = getDatabase();
  const waits = [...(await readWaitingChats())].flatMap(([key, { kind }]) =>
    kind === 'plan' || kind === 'attention' ? [{ key, kind }] : [],
  );
  const approvals = listAwaitingApprovals(db).map(({ flowRunId, flowName, message }) => ({
    flowRunId,
    flowName,
    message,
  }));
  const taskIds = waits.flatMap(({ key }) => (key.startsWith('task:') ? [key.slice(5)] : []));
  const ids = [...new Set([...chatIds, ...waits.map(({ key }) => key)])].filter(
    (id) => !id.startsWith('task:'),
  );
  const names = new Map<string, string | null>(ids.map((id) => [id, null]));
  if (ids.length) {
    const rows = await db
      .select({ id: chats.id, name: chats.name, archivedAt: chats.archivedAt })
      .from(chats)
      .where(inArray(chats.id, ids));
    for (const row of rows) if (!row.archivedAt) names.set(row.id, row.name || 'Untitled chat');
  }
  // A chat-less Work Queue task is listed under its own title, keyed like its wait.
  if (taskIds.length) {
    const rows = await db
      .select({ id: tasks.id, description: tasks.description })
      .from(tasks)
      .where(inArray(tasks.id, taskIds));
    for (const row of rows) names.set(`task:${row.id}`, row.description);
  }
  return { names, waits, approvals };
}

/** Answers a command request from the menu; one answered in Frink or timed out meanwhile is left be. */
export async function answerTrayRequest(
  { chatId, subChatId, requestId }: TrayApproval,
  approved: boolean,
): Promise<void> {
  const isOpen = () =>
    listPendingPermissionRequests().some((request) => request.requestId === requestId);
  if (!isOpen()) return;
  try {
    await respondMobilePermission({
      type: 'respondPermission',
      chatId,
      subChatId,
      requestId,
      approved,
    });
  } catch (error) {
    if (isOpen()) throw error;
  }
}
