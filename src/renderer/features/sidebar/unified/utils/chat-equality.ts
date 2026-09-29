import type { ChatItem, CodebaseGroup, SidebarProject, UnifiedSidebarProps } from '../types';
import type { SidebarTaskStatus } from '../constants';
import { type ActiveFolderChat, type ChatReason, getFolderActiveChats } from '../utils';

/**
 * Field-list equality. One loop instead of a long `&&`/`||` chain: same semantics at a fraction of
 * the branch count, and the field set becomes a readable list rather than an expression to parse.
 */
function fieldsEqual<T>(a: T, b: T, keys: readonly (keyof T)[]): boolean {
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/** Dates compare by epoch; a null/absent timestamp is 0 so it never differs from another absent one. */
function timestampsEqual(a: Date | null | undefined, b: Date | null | undefined): boolean {
  return (a?.getTime() ?? 0) === (b?.getTime() ?? 0);
}

type ChatRowMemoProps = {
  chat: ChatItem;
  reason?: { summary?: string; details?: string };
};

/**
 * Shallow memo comparison for a sidebar chat row: the given reference-identity `refKeys`, then the
 * `reason` text, then the chat fields. Shared by DraggableChat (CodebaseItem) and BatchChatRow
 * (BatchGroup) so the two comparators stay one parameterised helper, not copies.
 */
export function areChatRowMemoEqual<T extends ChatRowMemoProps>(
  prev: Readonly<T>,
  next: Readonly<T>,
  refKeys: readonly (keyof T)[],
): boolean {
  for (const key of refKeys) {
    if (prev[key] !== next[key]) return false;
  }
  if (prev.reason?.summary !== next.reason?.summary) return false;
  if (prev.reason?.details !== next.reason?.details) return false;
  return areChatItemsSidebarEqual(prev.chat, next.chat);
}

/** Memo comparison for UnifiedSidebar itself: identity on the scalar/callback props. */
export function unifiedSidebarPropsAreEqual(
  prev: UnifiedSidebarProps,
  next: UnifiedSidebarProps,
): boolean {
  if (prev.onToggleSidebar !== next.onToggleSidebar) return false;
  if (prev.isMobileFullscreen !== next.isMobileFullscreen) return false;
  return prev.onChatSelect === next.onChatSelect;
}

/** Chat row fields that affect sidebar rendering (DraggableChat, BatchChatRow, CodebaseItem memo). */
const CHAT_ITEM_SIDEBAR_KEYS = [
  'id',
  'name',
  'projectId',
  'branch',
  'isWorktree',
  'hasUnseenChanges',
  'isLoading',
  'hasPendingPlan',
  'hasPendingQuestion',
  'taskId',
  'batchId',
] as const satisfies readonly (keyof ChatItem)[];

function areChatItemsSidebarEqual(a: ChatItem, b: ChatItem): boolean {
  if (!fieldsEqual(a, b, CHAT_ITEM_SIDEBAR_KEYS)) return false;
  return timestampsEqual(a.updatedAt, b.updatedAt) && timestampsEqual(a.pinnedAt, b.pinnedAt);
}

const PROJECT_SIDEBAR_KEYS = [
  'id',
  'path',
  'name',
  'gitRemote',
  'gitOwner',
  'gitRepo',
] as const satisfies readonly (keyof SidebarProject)[];

const CODEBASE_GROUP_KEYS = [
  'gitRemote',
  'displayName',
  'gitOwner',
  'gitRepo',
] as const satisfies readonly (keyof CodebaseGroup)[];

/** Structural equality — parent often passes new `codebase` object refs when grouped data is recomputed. */
export function areCodebaseGroupsSidebarEqual(a: CodebaseGroup, b: CodebaseGroup): boolean {
  if (a === b) return true;
  if (!fieldsEqual(a, b, CODEBASE_GROUP_KEYS)) return false;
  if (a.projects.length !== b.projects.length || a.chats.length !== b.chats.length) return false;
  if (!a.projects.every((p, i) => fieldsEqual(p, b.projects[i], PROJECT_SIDEBAR_KEYS)))
    return false;
  return a.chats.every((chat, i) => areChatItemsSidebarEqual(chat, b.chats[i]));
}

/**
 * True when this codebase renders a BatchGroup, whose expanded rows are fetched from the server and
 * so are absent from `codebase.chats` — every per-chat scan below is blind to them.
 */
function hasBatchedChats(codebase: CodebaseGroup): boolean {
  return codebase.chats.some((c) => c.batchId);
}

/** True when a selection change could affect rows under this codebase (chat or batch child). */
export function selectionTouchesCodebase(
  codebase: CodebaseGroup,
  prevSel: string | null,
  nextSel: string | null,
): boolean {
  if (prevSel === nextSel) return false;
  if (hasBatchedChats(codebase)) return true;
  return codebase.chats.some((c) => c.id === prevSel || c.id === nextSel);
}

const EMPTY_CHAT_MAP: ReadonlyMap<string, never> = new Map<string, never>();

/** Whole-map compare, for the case where the codebase's own chat list is not the full row set. */
function wholeMapsEqual<T>(
  prevMap: Map<string, T> | undefined,
  nextMap: Map<string, T> | undefined,
  eq: (a: T | undefined, b: T | undefined) => boolean,
): boolean {
  const prev: ReadonlyMap<string, T> = prevMap ?? EMPTY_CHAT_MAP;
  const next: ReadonlyMap<string, T> = nextMap ?? EMPTY_CHAT_MAP;
  if (prev.size !== next.size) return false;
  for (const [chatId, value] of prev) {
    if (!eq(value, next.get(chatId))) return false;
  }
  return true;
}

/**
 * Per-chat map compare scoped to this codebase's rows. `eq` exists so the park reason compares by
 * field: the poll mints new reason objects every tick, so identity would never hold there.
 */
export function chatMapsEqualForCodebase<T>(
  prevMap: Map<string, T> | undefined,
  nextMap: Map<string, T> | undefined,
  codebase: CodebaseGroup,
  eq: (a: T | undefined, b: T | undefined) => boolean = Object.is,
): boolean {
  if (prevMap === nextMap) return true;
  if (hasBatchedChats(codebase)) return wholeMapsEqual(prevMap, nextMap, eq);
  return codebase.chats.every((c) => eq(prevMap?.get(c.id), nextMap?.get(c.id)));
}

/** The park reason is re-derived per poll, so it is compared by field, never by reference. */
export const reasonsEqual = (a: ChatReason | undefined, b: ChatReason | undefined): boolean =>
  a?.summary === b?.summary && a?.details === b?.details;

export function batchGroupsEqualForCodebase<T>(
  prev: Map<string, T> | undefined,
  next: Map<string, T> | undefined,
  codebase: CodebaseGroup,
): boolean {
  if (prev === next) return true;
  const batchIds = new Set<string>();
  for (const c of codebase.chats) {
    if (c.batchId) batchIds.add(c.batchId);
  }
  if (batchIds.size === 0) return true;
  for (const bid of batchIds) {
    if (prev?.get(bid) !== next?.get(bid)) return false;
  }
  return true;
}

// Compared by reference identity — any change busts the memo. The non-reference props (codebase,
// selection, the per-codebase maps) need the structural checks below.

type FolderActivityProps = {
  activeChatsByFolder?: ReadonlyMap<string | null, readonly ActiveFolderChat[]>;
  chatTaskStatusByChatId?: ReadonlyMap<string, SidebarTaskStatus>;
  batchGroups?: ReadonlyMap<string, unknown>;
};

/** True when this folder's active chats, their task statuses and their batch summaries are unchanged,
 * so an update that belongs to another folder does not re-render it. */
export function folderActivityEqual(
  prev: FolderActivityProps,
  next: FolderActivityProps,
  codebase: CodebaseGroup,
): boolean {
  const prevChats = getFolderActiveChats(prev.activeChatsByFolder, codebase);
  const nextChats = getFolderActiveChats(next.activeChatsByFolder, codebase);
  if (prevChats.length !== nextChats.length) return false;
  return nextChats.every((chat, index) => {
    const { chatId, batchId } = chat;
    if (chatId !== prevChats[index]?.chatId || batchId !== prevChats[index]?.batchId) return false;
    if (prev.chatTaskStatusByChatId?.get(chatId) !== next.chatTaskStatusByChatId?.get(chatId)) {
      return false;
    }
    return !batchId || prev.batchGroups?.get(batchId) === next.batchGroups?.get(batchId);
  });
}
