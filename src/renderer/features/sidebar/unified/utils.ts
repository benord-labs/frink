import { getChatActiveState, SIDEBAR_TASK_PRESENTATION, type SidebarTaskStatus } from './constants';
import type { ChatItem, CodebaseGroup } from './types';

export type SidebarChatListItem = {
  id: string;
  name: string | null;
  projectId: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  pinnedAt: Date | null;
  worktreePath: string | null;
  branch: string | null;
  baseBranch: string | null;
  prUrl: string | null;
  prNumber: number | null;
  taskId: string | null;
  batchId: string | null;
};

export type FolderCursor = {
  updatedAt: string;
  id: string;
};

export function normalizeCursor(cursor: FolderCursor | null): FolderCursor | null {
  if (!cursor) return null;
  const rawUpdatedAt = (cursor as unknown as { updatedAt: unknown }).updatedAt;
  const updatedAt =
    rawUpdatedAt instanceof Date
      ? rawUpdatedAt.toISOString()
      : typeof rawUpdatedAt === 'string'
        ? rawUpdatedAt
        : null;
  const id = (cursor as unknown as { id: unknown }).id;
  if (!updatedAt || typeof id !== 'string') return null;
  return { updatedAt, id };
}

export function extractErrorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return null;
}

export function mergeChatsById(chats: SidebarChatListItem[]): SidebarChatListItem[] {
  const map = new Map<string, SidebarChatListItem>();
  for (const chat of chats) {
    map.set(chat.id, chat);
  }
  return Array.from(map.values()).sort((a, b) => {
    const byTime = b.updatedAt.getTime() - a.updatedAt.getTime();
    if (byTime !== 0) return byTime;
    return b.id.localeCompare(a.id);
  });
}

/**
 * Updates `updatedAt` for `chatId` in any loaded folder list and re-sorts each touched list.
 * Returns `folderChatsByKey` unchanged (same reference) if the chat is not present in any folder.
 */
export function bumpChatUpdatedAtInFolderMap(
  folderChatsByKey: Record<string, SidebarChatListItem[]>,
  chatId: string,
  updatedAt: Date,
): Record<string, SidebarChatListItem[]> {
  let changed = false;
  const next: Record<string, SidebarChatListItem[]> = { ...folderChatsByKey };
  for (const key of Object.keys(folderChatsByKey)) {
    const list = folderChatsByKey[key];
    const idx = list.findIndex((c) => c.id === chatId);
    if (idx === -1) continue;
    changed = true;
    const updatedList = [...list];
    updatedList[idx] = { ...updatedList[idx], updatedAt };
    next[key] = mergeChatsById(updatedList);
  }
  if (!changed) return folderChatsByKey;
  return next;
}

const STATUS_PRIORITY = new Map<SidebarTaskStatus, number>([
  ['needs_attention', 5],
  ['failed', 4],
  ['done', 3],
  ['plan_ready', 3],
  ['cancelled', 3],
  ['running', 2],
  ['pending', 1],
]);

/** A flow chat's pinned task carries a terminal outcome that the flow_run is authoritative over. */
const RUN_AUTHORITATIVE_TASK_STATUS = new Set(['done', 'failed']);

/** Flow chat pill: a terminal run's outcome overrides a node's done/failed. Under a live run a done
 * node and an attempt the server superseded (`effectiveStatus`) read `running`; `pending` stays. */
function flowAwareStatus(task: ActiveTaskLite): SidebarTaskStatus {
  const status = task.status as SidebarTaskStatus;
  if (!task.flowRunStatus) return status;
  if (RUN_AUTHORITATIVE_TASK_STATUS.has(status)) {
    if (task.flowRunStatus === 'completed') return 'done';
    if (task.flowRunStatus === 'cancelled') return 'cancelled';
    if (task.flowRunStatus === 'failed') return 'failed';
    if (status === 'done') return 'running';
  }
  return status !== 'pending' && task.effectiveStatus === 'running' ? 'running' : status;
}

type ActiveTaskLite = {
  status?: string | null;
  linkedChatId?: string | null;
  flowRunStatus?: string | null;
  effectiveStatus?: string | null;
  // Already on the tasks.listPaginated payload (the SELECT spreads the full task row); the sidebar
  // just narrows it away. Read here for the park reason — no query change. See sc-848.
  result?: { agentSignal?: { summary?: string; details?: string } } | null;
};

/**
 * The shape the sidebar polls, declared once so the change check and the maps built from it cannot
 * drift apart when a field is added.
 */
export type SidebarPolledTask = ActiveTaskLite & {
  id: string;
};

/** Every field below is a nullable string; an absent key and an explicit null both mean "unset". */
type TaskFieldValue = string | null | undefined;

/** An absent key and an explicit null both mean "unset" on this payload — never a real difference. */
const sameOptional = (a: TaskFieldValue, b: TaskFieldValue): boolean => (a ?? null) === (b ?? null);

/**
 * Every field the sidebar reads. `agentSignal` is here deliberately: a re-parked task can change
 * only its reason, and that reason drives the pill tooltip.
 */
const TASK_FIELDS: ReadonlyArray<(task: SidebarPolledTask) => TaskFieldValue> = [
  (task) => task.id,
  (task) => task.status,
  (task) => task.linkedChatId,
  (task) => task.flowRunStatus,
  (task) => task.effectiveStatus,
  (task) => task.result?.agentSignal?.summary,
  (task) => task.result?.agentSignal?.details,
];

/**
 * Compared by value, never by reference: pages past the first bypass the query cache, so unchanged
 * content still arrives as fresh objects and would churn every map and callback built from it.
 */
export function sameSidebarTasks(
  a: readonly SidebarPolledTask[],
  b: readonly SidebarPolledTask[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((task, index) =>
    TASK_FIELDS.every((read) => sameOptional(read(task), read(b[index]))),
  );
}

/** The reason an agent task parked (its frink_task_signal summary/details), shown on the pill tooltip. */
export type ChatReason = { summary?: string; details?: string };

/**
 * Chat ids with a live held question, keyed by each atom entry's `parentChatId` (the sidebar row).
 * Shared by UnifiedSidebar and BatchGroup so both derive `hasPendingQuestion` identically.
 */
export function buildPendingQuestionChatIds(
  pendingQuestions: ReadonlyMap<string, { parentChatId: string }>,
): Set<string> {
  const ids = new Set<string>();
  for (const q of pendingQuestions.values()) ids.add(q.parentChatId);
  return ids;
}

/**
 * Build chatId → highest-priority sidebar status. Flow-run authority: a terminal `done` whose
 * flow_run is still non-terminal is substituted to `running`, so a multi-agent flow chat never
 * shows a premature green "Done" between nodes — including the inter-node gap where the next
 * agent's task doesn't exist yet (covered because the run stays non-terminal). A genuinely live
 * sibling (running/plan_ready/needs_attention) is already in `tasks` and still wins via priority.
 * `done` survives only when its run is terminal/absent (flow finished) or it's a non-flow task,
 * so a legitimately-done chat keeps its green pill (no regression).
 *
 * `activeFlowChatIds` are chats with a non-terminal flow_run (from flows.activeRunChatIds). They
 * FILL BLANKS only — a chat with no tracked task but a live flow_run shows `running` (covers the
 * taskless windows: pre-first-agent, non-agent nodes). Never overrides a real task status.
 */
export function buildChatTaskStatusMap(
  tasks: ActiveTaskLite[],
  activeFlowChatIds?: Iterable<string>,
): Map<string, SidebarTaskStatus> {
  const map = new Map<string, SidebarTaskStatus>();
  for (const task of tasks) {
    if (!task.linkedChatId || !task.status) continue;
    const status = flowAwareStatus(task);
    const nextPriority = STATUS_PRIORITY.get(status);
    if (nextPriority === undefined) continue;
    const current = map.get(task.linkedChatId);
    const currentPriority = current ? (STATUS_PRIORITY.get(current) ?? 0) : 0;
    if (!current || nextPriority > currentPriority) {
      map.set(task.linkedChatId, status);
    }
  }
  if (activeFlowChatIds) {
    for (const chatId of activeFlowChatIds) {
      if (!map.has(chatId)) map.set(chatId, 'running');
    }
  }
  return map;
}

/**
 * Build chatId → the agent reason ({summary, details}) of the SAME task that wins the pill in
 * {@link buildChatTaskStatusMap} (highest STATUS_PRIORITY, with the same done→running flow-run
 * substitution), so the pill tooltip shows the reason for the status it displays. Additive: read
 * alongside the status map, never mutating it. Only parked tasks (awaiting_input/blocked/partial)
 * carry a summary; for any other winner the reason is empty and the pill keeps its static label.
 */
export function buildChatReasonMap(tasks: ActiveTaskLite[]): Map<string, ChatReason> {
  const winnerPriority = new Map<string, number>();
  const reasons = new Map<string, ChatReason>();
  for (const task of tasks) {
    if (!task.linkedChatId || !task.status) continue;
    const status = flowAwareStatus(task);
    const priority = STATUS_PRIORITY.get(status);
    if (priority === undefined) continue;
    const current = winnerPriority.get(task.linkedChatId);
    if (current !== undefined && priority <= current) continue;
    winnerPriority.set(task.linkedChatId, priority);
    const signal = task.result?.agentSignal;
    reasons.set(task.linkedChatId, { summary: signal?.summary, details: signal?.details });
  }
  return reasons;
}

type ActiveChat = Pick<
  ChatItem,
  'id' | 'batchId' | 'isLoading' | 'hasPendingQuestion' | 'hasPendingPlan' | 'hasUnseenChanges'
>;

type FolderLevel = 'failed' | 'needs' | 'plan' | 'running' | 'review';

/** Most human-actionable first: a collapsed folder shows the first level any of its chats reaches. */
const FOLDER_LEVEL_ORDER: readonly FolderLevel[] = ['failed', 'needs', 'plan', 'running', 'review'];

const FOLDER_LEVEL_PRESENTATION = {
  failed: SIDEBAR_TASK_PRESENTATION.failed,
  needs: SIDEBAR_TASK_PRESENTATION.needs_attention,
  plan: SIDEBAR_TASK_PRESENTATION.plan_ready,
  running: SIDEBAR_TASK_PRESENTATION.running,
  review: SIDEBAR_TASK_PRESENTATION.done,
} satisfies Record<FolderLevel, { label: string; dotClassName: string }>;

type ChatActiveState = NonNullable<ReturnType<typeof getChatActiveState>>;
type TaskChatMoment = 'resting' | 'question' | 'stream';

const UNTASKED_FOLDER_LEVEL = {
  pendingQuestion: 'needs',
  pendingPlan: 'plan',
  loading: 'running',
  unseenChanges: 'review',
} satisfies Record<ChatActiveState, FolderLevel>;

const TASK_CHAT_MOMENT = {
  pendingQuestion: 'question',
  pendingPlan: 'resting',
  loading: 'stream',
  unseenChanges: 'resting',
} satisfies Record<ChatActiveState, TaskChatMoment>;

/** Per task status, the level of a chat that is resting, holding a question, or streaming. Mirrors
 * ChatListItem: urgent statuses always win, and a stream reads as running over done or cancelled. */
const TASK_FOLDER_LEVELS = {
  pending: { resting: null, question: 'needs', stream: 'running' },
  running: { resting: 'running', question: 'needs', stream: 'running' },
  plan_ready: { resting: 'plan', question: 'plan', stream: 'plan' },
  needs_attention: { resting: 'needs', question: 'needs', stream: 'needs' },
  failed: { resting: 'failed', question: 'failed', stream: 'failed' },
  done: { resting: 'review', question: 'review', stream: 'running' },
  cancelled: { resting: null, question: null, stream: 'running' },
} satisfies Record<SidebarTaskStatus, Record<TaskChatMoment, FolderLevel | null>>;

function getChatFolderLevel(
  chat: ActiveChat,
  taskStatus: SidebarTaskStatus | undefined,
): FolderLevel | null {
  const state = getChatActiveState(chat);
  if (!taskStatus) return state ? UNTASKED_FOLDER_LEVEL[state] : null;
  return TASK_FOLDER_LEVELS[taskStatus][state ? TASK_CHAT_MOMENT[state] : 'resting'];
}

export type FolderActiveState = { label: string; dotClassName: string; count: number };

const IDLE_CHAT = {
  batchId: null,
  isLoading: false,
  hasPendingQuestion: false,
  hasPendingPlan: false,
  hasUnseenChanges: false,
};

/** A chat the main process reports as active, with its folder and batch; mirrors SidebarActiveChat. */
export type ActiveFolderChat = {
  chatId: string;
  projectId: string | null;
  batchId: string | null;
  hasLiveFlowRun: boolean;
};

/** Folder key: a local project id, or null for general chats. */
type FolderKey = string | null;

/** Folder key → the active chats it owns, loaded in the sidebar or not. */
export function groupActiveChatsByFolder(
  activeChats: readonly ActiveFolderChat[],
): Map<FolderKey, ActiveFolderChat[]> {
  const byFolder = new Map<FolderKey, ActiveFolderChat[]>();
  for (const chat of activeChats) {
    const folderChats = byFolder.get(chat.projectId);
    if (folderChats) folderChats.push(chat);
    else byFolder.set(chat.projectId, [chat]);
  }
  return byFolder;
}

/** The sidebar's two activity maps from its polls: row statuses and active chats per folder. */
export function buildSidebarActivityMaps(
  tasks: SidebarPolledTask[],
  activeChats: readonly ActiveFolderChat[],
): [Map<string, SidebarTaskStatus>, Map<FolderKey, ActiveFolderChat[]>] {
  const liveFlowChatIds = activeChats.flatMap((chat) => (chat.hasLiveFlowRun ? [chat.chatId] : []));
  return [buildChatTaskStatusMap(tasks, liveFlowChatIds), groupActiveChatsByFolder(activeChats)];
}

/** Active chats for one sidebar folder: its project ids, or the general bucket. */
export function getFolderActiveChats(
  activeChatsByFolder: ReadonlyMap<FolderKey, readonly ActiveFolderChat[]> | undefined,
  codebase: CodebaseGroup,
): ActiveFolderChat[] {
  const keys = codebase.projects.length === 0 ? [null] : codebase.projects.map((p) => p.id);
  return keys.flatMap((key) => activeChatsByFolder?.get(key) ?? []);
}

type BatchSummaries = ReadonlyMap<string, { running_count: number; failed_count: number }>;

// Batch runs at these levels come from the batch summary, as the BatchGroup header shows them.
const BATCH_SUMMARY_COUNT = { running: 'running_count', failed: 'failed_count' } as const;
type BatchLevel = keyof typeof BATCH_SUMMARY_COUNT;

function isBatchLevel(level: FolderLevel | null): level is BatchLevel {
  return level === 'running' || level === 'failed';
}
type LeveledChat = { chat: ActiveChat; level: FolderLevel | null };

function withUnloadedActiveChats(
  loadedChats: readonly ActiveChat[],
  activeChats: readonly ActiveFolderChat[],
  pendingQuestionIds?: ReadonlySet<string>,
): ActiveChat[] {
  const seenIds = new Set(loadedChats.map((chat) => chat.id));
  const unloaded: ActiveChat[] = [];
  for (const { chatId, batchId } of activeChats) {
    if (seenIds.has(chatId)) continue;
    seenIds.add(chatId);
    const hasPendingQuestion = pendingQuestionIds?.has(chatId) ?? false;
    unloaded.push({ ...IDLE_CHAT, id: chatId, batchId, hasPendingQuestion });
  }
  return [...loadedChats, ...unloaded];
}

function isInBatch(chat: ActiveChat, batchGroups?: BatchSummaries): boolean {
  return Boolean(chat.batchId && batchGroups?.has(chat.batchId));
}

/** Runs per batch at `level`: the larger of the summary count and the matching local batch chats. */
function countBatchRuns(
  chats: readonly LeveledChat[],
  level: BatchLevel,
  batchGroups?: BatchSummaries,
): number {
  const localCount = new Map<string, number>();
  for (const { chat, level: chatLevel } of chats) {
    if (!chat.batchId || !isInBatch(chat, batchGroups)) continue;
    const matches = chatLevel === level ? 1 : 0;
    localCount.set(chat.batchId, (localCount.get(chat.batchId) ?? 0) + matches);
  }
  let total = 0;
  for (const [batchId, local] of localCount) {
    const summaryCount = batchGroups?.get(batchId)?.[BATCH_SUMMARY_COUNT[level]] ?? 0;
    total += Math.max(local, summaryCount);
  }
  return total;
}

function addCount(counts: Map<FolderLevel, number>, level: FolderLevel, amount: number): void {
  if (amount > 0) counts.set(level, (counts.get(level) ?? 0) + amount);
}

/** Highest-precedence state across a folder's chats, with how many sit at that level. Batch runs come
 * from the batch summary; `activeChats` adds this folder's active chats beyond the loaded page. */
export function getFolderActiveState(
  loadedChats: readonly ActiveChat[],
  taskStatusByChatId?: ReadonlyMap<string, SidebarTaskStatus>,
  batchGroups?: BatchSummaries,
  activeChats: readonly ActiveFolderChat[] = [],
  pendingQuestionIds?: ReadonlySet<string>,
): FolderActiveState | null {
  const withUnloaded = withUnloadedActiveChats(loadedChats, activeChats, pendingQuestionIds);
  const chats = withUnloaded.map((chat) => ({
    chat,
    level: getChatFolderLevel(chat, taskStatusByChatId?.get(chat.id)),
  }));
  const counts = new Map<FolderLevel, number>();
  for (const { chat, level } of chats) {
    const countedByBatch = isBatchLevel(level) && isInBatch(chat, batchGroups);
    if (level && !countedByBatch) addCount(counts, level, 1);
  }
  addCount(counts, 'failed', countBatchRuns(chats, 'failed', batchGroups));
  addCount(counts, 'running', countBatchRuns(chats, 'running', batchGroups));
  const top = FOLDER_LEVEL_ORDER.find((level) => counts.has(level));
  if (!top) return null;
  const { label, dotClassName } = FOLDER_LEVEL_PRESENTATION[top];
  return { label, dotClassName, count: counts.get(top) ?? 0 };
}
