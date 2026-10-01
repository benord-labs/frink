import { hostname } from 'node:os';
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import { app } from 'electron';
import type {
  MobileActivity,
  MobileChatSummary,
  MobileOverview,
  MobilePage,
  MobileProject,
  MobileQueueItem,
  MobileRequest,
} from '../../../../shared/types/remote/mobile';
import { listPendingQuestionSubChatIds } from '../../claude/ask-user-question-approval';
import { getDatabase } from '../../db';
import { listProjectsByRecentActivity } from '../../db/repos/projects';
import { chats, projects, subChats, tasks } from '../../db/schema';
import { chatsBySubChat, readAgentCounts } from '../live-activity/counts';
import { subChatActivity } from './chat';
import { executionReady, mobileCallers, record, text } from './context';
import { mobilePermissions, mobileQuestions, parkedQuestion } from './questions';
import { mobileTaskActions } from './tasks';

const sections = ['attention', 'inbox', 'running'] as const;
export async function readMobileOverview({
  limits = {},
}: Omit<Extract<MobileRequest, { type: 'overview' }>, 'type'> = {}): Promise<MobileOverview> {
  const [counts, pages, agents] = await Promise.all([
    mobileCallers.tasks.workQueueOverviewCounts(),
    Promise.all(
      sections.map((workQueueSection) =>
        mobileCallers.tasks.listPaginated({
          workQueueSection,
          collapseByFlow: true,
          limit: limits[workQueueSection] ?? 20,
        }),
      ),
    ),
    readAgentCounts(),
  ]);
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
        projectName: task.projectName,
        activityAt: (task.completedAt ?? task.startedAt ?? task.createdAt).toISOString(),
        actions: mobileTaskActions(task, task.effectiveStatus),
      };
    }),
  );
  const pendingIds = listPendingQuestionSubChatIds();
  const chatBySubChat = await chatsBySubChat(pendingIds);
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
    appVersion: app.getVersion(),
    queue,
    // The same section filter as the rows, so each total matches what "Show all" reveals.
    counts: { attention: counts.review, inbox: counts.inbox, running: counts.running },
    more: {
      attention: pages[0].hasMore,
      inbox: pages[1].hasMore,
      running: pages[2].hasMore,
    },
    questions,
    permissions: mobilePermissions(),
    agents,
  };
}

function containsText(column: SQLiteColumn, query: string): SQL {
  return sql`${column} like ${`%${query.replace(/[\\%_]/g, '\\$&')}%`} escape '\\'`;
}

/** Newest conversation activity first (sub_chats.updated_at: messages, mode and session changes);
 *  renaming or pinning a chat (chats.updated_at) does not move it. */
export async function readMobileChats({
  limit = 30,
  query,
}: Omit<Extract<MobileRequest, { type: 'chats' }>, 'type'> = {}): Promise<
  MobilePage<MobileChatSummary>
> {
  const rows = await getDatabase()
    .select({
      id: chats.id,
      name: chats.name,
      projectId: chats.projectId,
      projectName: projects.name,
      flowRunId: tasks.flowRunId,
      lastActiveAt:
        sql<Date>`coalesce((select max(${subChats.updatedAt}) from ${subChats} where ${subChats.chatId} = ${chats.id}), ${chats.createdAt})`
          .mapWith(chats.createdAt)
          .as('last_active_at'),
    })
    .from(chats)
    .leftJoin(projects, eq(projects.id, chats.projectId))
    .leftJoin(tasks, eq(tasks.id, chats.taskId))
    .where(
      and(
        isNull(chats.archivedAt),
        query ? or(containsText(chats.name, query), containsText(projects.name, query)) : undefined,
      ),
    )
    .orderBy(({ lastActiveAt }) => [desc(lastActiveAt), desc(chats.id)])
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const activity = await chatActivity(page.map((chat) => chat.id));
  return {
    items: page.map((chat) => ({
      id: chat.id,
      name: chat.name ?? 'Untitled chat',
      projectId: chat.projectId,
      projectName: chat.projectName,
      lastActiveAt: chat.lastActiveAt.toISOString(),
      activity: activity.get(chat.id) ?? 'idle',
      kind: chat.flowRunId ? 'flow' : 'chat',
    })),
    hasMore: rows.length > limit,
  };
}

const activityRank: Record<MobileActivity, number> = { idle: 0, background: 1, running: 2 };

/** Each chat's busiest conversation, from the in-memory execution and stream registries. */
async function chatActivity(chatIds: string[]): Promise<Map<string, MobileActivity>> {
  const result = new Map<string, MobileActivity>();
  if (!chatIds.length) return result;
  const rows = await getDatabase()
    .select({ id: subChats.id, chatId: subChats.chatId })
    .from(subChats)
    .where(inArray(subChats.chatId, chatIds));
  for (const row of rows) {
    const activity = subChatActivity(row.id);
    if (activityRank[activity] > activityRank[result.get(row.chatId) ?? 'idle'])
      result.set(row.chatId, activity);
  }
  return result;
}

export async function readMobileProjects(): Promise<MobileProject[]> {
  return (await listProjectsByRecentActivity(getDatabase())).map(({ id, name, lastActiveAt }) => ({
    id,
    name,
    lastActiveAt: lastActiveAt?.toISOString() ?? null,
  }));
}
