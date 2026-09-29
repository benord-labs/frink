import type {
  MobileOverview,
  MobileQueueItem,
  MobileQueueSection,
} from '@frink/shared/types/remote/mobile';
import { taskStatus, type Status } from '../../lib/status';

export type QueueSectionKey = 'needsYou' | 'running' | 'review' | 'upNext';
export type QueueTarget =
  | {
      screen: 'Chat';
      id: string;
      subChatId?: string;
      decisionTarget?: { type: 'question' | 'permission'; id: string };
    }
  | { screen: 'Run'; id: string };
export type QueueRow = {
  /** Needs-you rows are the thing to read, so their titles get two lines. */
  emphasis: boolean;
  key: string;
  kind: 'chat' | 'flow' | 'inbox';
  title: string;
  /** Line two: kind · project · what it needs or how far it got. */
  detail: string;
  status: Status;
  activityAt: string | null;
  target: QueueTarget | null;
};
export type QueueSection = {
  key: QueueSectionKey;
  title: string;
  rows: QueueRow[];
  /** The header count: the badge's number for Needs you, the computer's total elsewhere. */
  total: number;
  /** More rows than the collapsed section shows, here or still on the computer. */
  hasMore: boolean;
};

/** Rows per section until the user asks for all of them. */
export const COLLAPSED_ROWS = 5;
/** The largest page the computer serves per list. */
const MAX_LIMIT = 200;
// Needs you and Ready for review both page through the computer's attention list.
const SOURCE: Record<QueueSectionKey, MobileQueueSection> = {
  needsYou: 'attention',
  running: 'running',
  review: 'attention',
  upNext: 'inbox',
};

const KIND_WORD = { chat: 'Chat', flow: 'Flow', inbox: '' } as const;
const QUESTION: Status = { word: 'Question', tone: 'attention', glyph: 'awaiting' };
const PERMISSION: Status = { word: 'Approval', tone: 'attention', glyph: 'awaiting' };
// Finished work is calm: the section already says "Ready for review".
const READY: Status = { word: 'Ready', tone: 'quiet', glyph: 'done' };
// Not "Up next" again under the Up next header.
const QUEUED: Status = { ...taskStatus('pending'), word: 'Queued' };

/** In the Queue amber means "needs you"; only a failure keeps its red. */
function needsYouStatus(status: string): Status {
  const base = taskStatus(status);
  return base.tone === 'danger' ? base : { ...base, tone: 'attention' };
}

function line(kind: QueueRow['kind'], ...parts: Array<string | null | undefined>) {
  return [KIND_WORD[kind], ...parts].filter(Boolean).join(' · ');
}

function itemKind(item: MobileQueueItem): QueueRow['kind'] {
  if (item.flowRunId) return 'flow';
  return item.chatId ? 'chat' : 'inbox';
}

// A Flow item opens its run (the whole picture); a plain task opens its chat.
function itemTarget(item: MobileQueueItem): QueueTarget | null {
  if (item.flowRunId) return { screen: 'Run', id: item.flowRunId };
  if (item.chatId) return { screen: 'Chat', id: item.chatId, subChatId: item.subChatId ?? undefined };
  return null;
}

function itemRow(
  item: MobileQueueItem,
  status: Status,
  detail: string | null,
  emphasis = false,
): QueueRow {
  const kind = itemKind(item);
  return {
    key: item.id,
    emphasis,
    kind,
    title: item.title,
    detail: line(kind, item.projectName, detail),
    status,
    activityAt: item.activityAt,
    target: itemTarget(item),
  };
}

type Decision = {
  key: string;
  type: 'question' | 'permission';
  id: string;
  chatId: string;
  subChatId: string;
  /** The chat title the computer files the matching task under. */
  sourceTitle: string;
  title: string;
};

/** Questions and permissions, deduplicated against the attention tasks that carry them. */
function collectDecisions(data: MobileOverview) {
  const decisions: Decision[] = [
    ...data.questions.map((item) => ({
      key: `question:${item.id}`,
      type: 'question' as const,
      id: item.id,
      chatId: item.chatId,
      subChatId: item.subChatId,
      sourceTitle: item.title,
      title: item.questions[0]?.question ?? item.title,
    })),
    ...data.permissions.map((item) => ({
      key: `permission:${item.requestId}`,
      type: 'permission' as const,
      id: item.requestId,
      chatId: item.chatId,
      subChatId: item.subChatId,
      sourceTitle: item.title,
      title: item.title,
    })),
  ];
  const attention = data.queue.filter((item) => item.section === 'attention');
  const duplicates = new Set(
    attention
      .filter((item) =>
        decisions.some(
          (decision) =>
            item.chatId === decision.chatId &&
            item.subChatId === decision.subChatId &&
            (item.title === decision.sourceTitle || item.title === decision.title),
        ),
      )
      .map((item) => item.id),
  );
  const tasks = attention.filter((item) => !duplicates.has(item.id));
  return { decisions, tasks };
}

function decisionRow(decision: Decision, queue: MobileQueueItem[]): QueueRow {
  // The overview names no project for a decision; its chat's queue item does, when one was sent.
  const task = queue.find((item) => item.chatId === decision.chatId);
  const kind = task?.flowRunId ? 'flow' : 'chat';
  const ask = decision.type === 'question' ? 'Wants your answer' : 'Wants your approval';
  return {
    key: decision.key,
    emphasis: true,
    kind,
    title: decision.title,
    detail: line(kind, task?.projectName, ask),
    status: decision.type === 'question' ? QUESTION : PERMISSION,
    activityAt: task?.activityAt ?? null,
    target: {
      screen: 'Chat',
      id: decision.chatId,
      subChatId: decision.subChatId,
      decisionTarget: { type: decision.type, id: decision.id },
    },
  };
}

function newestFirst(a: QueueRow, b: QueueRow) {
  return (b.activityAt ?? '').localeCompare(a.activityAt ?? '');
}

/** "Step 2 of 4" out of a Flow's summary; the rest of the summary is step detail. */
function progress(summary: string) {
  return /step \d+ of \d+/i.exec(summary)?.[0] ?? null;
}

/**
 * Everything that needs the user: questions, approvals and attention tasks, but not finished
 * work waiting for review. The same set the Queue tab badge counts.
 */
export function needsYouCount(data: MobileOverview | undefined): number {
  if (!data) return 0;
  const { decisions, tasks } = collectDecisions(data);
  return decisions.length + tasks.filter((item) => item.status !== 'done').length;
}

/** Server page sizes for the expanded sections: each list's full count, capped. */
export function expandedLimits(
  expanded: ReadonlySet<QueueSectionKey>,
  counts: MobileOverview['counts'],
): Partial<Record<MobileQueueSection, number>> {
  const limits: Partial<Record<MobileQueueSection, number>> = {};
  for (const key of expanded) limits[SOURCE[key]] = Math.min(MAX_LIMIT, counts[SOURCE[key]]);
  return limits;
}

/** The Queue's sections, in order, without empty ones. Rows are newest first within a section. */
export function queueSections(data: MobileOverview): QueueSection[] {
  const { decisions, tasks } = collectDecisions(data);
  const needsYou = [
    ...decisions.map((decision) => decisionRow(decision, data.queue)).sort(newestFirst),
    ...tasks
      .filter((item) => item.status !== 'done')
      // Only a failure keeps its reason (as Ready for review drops its summary): the right slot
      // already names every other state.
      .map((item) =>
        itemRow(
          item,
          needsYouStatus(item.status),
          item.status === 'failed' ? item.summary : progress(item.summary),
          true,
        ),
      )
      .sort(newestFirst),
  ];
  const review = tasks
    .filter((item) => item.status === 'done')
    .map((item) => itemRow(item, READY, null))
    .sort(newestFirst);
  const bySection = (section: MobileQueueSection) =>
    data.queue.filter((item) => item.section === section);
  const running = bySection('running')
    .map((item) => itemRow(item, taskStatus('running'), progress(item.summary)))
    .sort(newestFirst);
  const upNext = bySection('inbox')
    .map((item) => itemRow(item, QUEUED, item.chatId ? null : item.summary))
    .sort(newestFirst);
  // Unsent attention rows can't be told apart, so both attention sections count what was sent;
  // expanding pages in the whole attention list, which makes both exact.
  const totals: Record<QueueSectionKey, number> = {
    needsYou: needsYou.length,
    running: data.counts.running,
    review: review.length,
    upNext: data.counts.inbox,
  };
  const titles = { needsYou: 'Needs you', running: 'Running', review: 'Ready for review', upNext: 'Up next' };
  const rows = { needsYou, running, review, upNext };
  return (Object.keys(titles) as QueueSectionKey[])
    .filter((key) => rows[key].length > 0)
    .map((key) => ({
      key,
      title: titles[key],
      rows: rows[key],
      total: Math.max(totals[key], rows[key].length),
      hasMore: rows[key].length > COLLAPSED_ROWS || data.more[SOURCE[key]],
    }));
}
