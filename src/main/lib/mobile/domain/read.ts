import { hostname } from 'node:os';
import { desc, inArray, isNull } from 'drizzle-orm';
import type { MobileOverview, MobileQueueItem } from '../../../../shared/types/remote/mobile';
import { listPendingQuestionSubChatIds } from '../../claude/ask-user-question-approval';
import { getDatabase } from '../../db';
import { listProjects } from '../../db/repos/projects';
import { chats, subChats } from '../../db/schema';
import { executionReady, mobileCallers, record, text } from './context';
import { mobilePermissions, mobileQuestions, parkedQuestion } from './questions';

const sections = ['attention', 'inbox', 'running'] as const;
export async function readMobileOverview(): Promise<MobileOverview> {
  const pages = await Promise.all(
    sections.map((workQueueSection) =>
      mobileCallers.tasks.listPaginated({
        workQueueSection,
        collapseByFlow: true,
        limit: 50,
      }),
    ),
  );
  const queue = pages.flatMap((page, index) =>
    page.items.map((task): MobileQueueItem => {
      const result = record(task.result);
      const signal = record(result.agentSignal);
      return {
        id: task.id,
        title: task.description,
        summary: text(signal.summary),
        status: task.effectiveStatus,
        section: sections[index],
        chatId: task.linkedChatId ?? (text(result.chatId) || null),
        subChatId: text(result.subChatId) || null,
        flowRunId: task.flowRunId,
      };
    }),
  );
  const pendingIds = listPendingQuestionSubChatIds();
  const pendingChats = pendingIds.length
    ? await getDatabase()
        .select({ id: subChats.id, chatId: subChats.chatId })
        .from(subChats)
        .where(inArray(subChats.id, pendingIds))
    : [];
  const chatBySubChat = new Map(pendingChats.map((subChat) => [subChat.id, subChat.chatId]));
  const liveQuestions = (
    await Promise.all(
      pendingIds.map((subChatId) => {
        const chatId = chatBySubChat.get(subChatId);
        return chatId ? mobileQuestions(chatId, subChatId, null) : [];
      }),
    )
  ).flat();
  const questions = [...liveQuestions];
  for (const page of pages)
    for (const task of page.items) {
      const item = queue.find((row) => row.id === task.id);
      if (
        !item?.chatId ||
        !item.subChatId ||
        liveQuestions.some((q) => q.subChatId === item.subChatId)
      )
        continue;
      const question = parkedQuestion(task, item.chatId, item.subChatId);
      if (question) questions.push(question);
    }
  return {
    machineName: hostname(),
    executionReady: executionReady(),
    queue,
    questions,
    permissions: mobilePermissions(),
  };
}

export async function readMobileChats() {
  const rows = await getDatabase()
    .select({ id: chats.id, name: chats.name, projectId: chats.projectId })
    .from(chats)
    .where(isNull(chats.archivedAt))
    .orderBy(desc(chats.updatedAt), desc(chats.id))
    .limit(100);
  return rows.map((chat) => ({
    id: chat.id,
    name: chat.name ?? 'Untitled chat',
    projectId: chat.projectId,
  }));
}

export async function readMobileProjects() {
  return (await listProjects(getDatabase())).map(({ id, name }) => ({
    id,
    name,
  }));
}
