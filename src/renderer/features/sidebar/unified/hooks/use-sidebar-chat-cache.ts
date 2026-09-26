/**
 * In-place patches for unified sidebar folder/pinned chat maps so pin/fork/delete
 * do not wipe pagination state or broadly invalidate listByFolder (sc-690 + sc-701
 * extend the same approach to rename, move, and restore).
 */

import type { inferRouterOutputs } from '@trpc/server';
import type { Dispatch, SetStateAction } from 'react';
import type { AppRouter } from '../../../../../main/lib/trpc/routers';
import type { SidebarChatListItem } from '../utils';
import { mergeChatsById } from '../utils';

export const SIDEBAR_GENERAL_COUNT_KEY = '__general__';

type ListCountsRow = { projectId: string | null; count: number };

type SidebarFolderDescriptor = {
  key: string;
  projectIds: string[] | null;
};

/** Project row shape aligned with UnifiedSidebar `transformedProjects`. */
type SidebarProjectForFolderKey = {
  id: string;
  name: string;
  gitRemoteUrl: string | null;
  gitRepo: string | null;
};

type TrpcUtilsLike = {
  chats: {
    listCounts: {
      invalidate: () => Promise<unknown>;
      fetch: () => Promise<unknown>;
    };
  };
};

type BatchViewUtilsLike = {
  chats: Record<'listByBatch' | 'listBatchGroups', { invalidate: () => Promise<void> }>;
};

/** Batch views are keyed by batch_id and never patched in place, so chat mutations must refetch them. */
export async function invalidateBatchViews(utils: BatchViewUtilsLike): Promise<void> {
  await Promise.all([
    utils.chats.listByBatch.invalidate(),
    utils.chats.listBatchGroups.invalidate(),
  ]);
}

export function resolveSidebarFolderKeyForProjectId(
  projectId: string | null,
  projects: SidebarProjectForFolderKey[],
  generalFolderKey: string,
): string | null {
  if (!projectId) {
    return generalFolderKey;
  }
  for (const p of projects) {
    if (p.id === projectId) {
      return p.gitRemoteUrl ?? p.gitRepo ?? p.name;
    }
  }
  return null;
}

export function buildChatCountByProjectMap(raw: unknown): Map<string, number> {
  const map = new Map<string, number>();
  const counts = Array.isArray(raw) ? raw : [];
  for (const item of counts as ListCountsRow[]) {
    const key = item.projectId ?? SIDEBAR_GENERAL_COUNT_KEY;
    map.set(key, item.count);
  }
  return map;
}

/**
 * Snapshot to record after a `reset` folder page fetch. The folder header count and the
 * folder rows read the same local `chats` table (same filter), so a divergence can only
 * come from a cache that stops refetching. The count-drift self-heal re-fetches page 1
 * whenever `count !== snapshot`; this snapshot is what arms it.
 *
 * Invariant: the snapshot must NEVER exceed the true count. A snapshot pinned *ahead* of
 * reality (e.g. to a count that advanced while the fetch was in flight, while the fetched
 * rows lagged) makes `count === snapshot` and permanently disarms the self-heal — a
 * concurrently-synced chat then stays missing until remount. Pinning to the pre-fetch
 * count (never above the freshest count) leaves the snapshot *behind* any concurrent
 * increment, so drift re-fires on the next poll and the row appears.
 */
export function computeFolderSnapshot(
  countAtFetchStart: number | undefined,
  countAtResolve: number | undefined,
): number {
  if (countAtFetchStart === undefined) return 0; // cold start: re-fire once the real count lands
  if (countAtResolve === undefined) return countAtFetchStart;
  return Math.min(countAtFetchStart, countAtResolve); // never ahead of the freshest count
}

export function computeChatCountByFolderKey(
  folderDescriptors: SidebarFolderDescriptor[],
  chatCountByProject: Map<string, number>,
  generalCountKey: string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const folder of folderDescriptors) {
    if (folder.projectIds === null) {
      counts[folder.key] = chatCountByProject.get(generalCountKey) ?? 0;
      continue;
    }
    counts[folder.key] = folder.projectIds.reduce(
      (sum, projectId) => sum + (chatCountByProject.get(projectId) ?? 0),
      0,
    );
  }
  return counts;
}

/**
 * Refetch list counts and align `folderCountSnapshotByKey` for every folder that
 * already has a snapshot (loaded pagination). Prevents drift refetch from wiping
 * folder pages after fork/delete when counts change.
 */
export async function refetchListCountsAndSyncFolderSnapshots(
  utils: TrpcUtilsLike,
  folderDescriptors: SidebarFolderDescriptor[],
  setFolderCountSnapshotByKey: Dispatch<SetStateAction<Record<string, number>>>,
  generalCountKey: string,
): Promise<void> {
  await utils.chats.listCounts.invalidate();
  const raw = await utils.chats.listCounts.fetch();
  const chatCountByProject = buildChatCountByProjectMap(raw);
  const folderCounts = computeChatCountByFolderKey(
    folderDescriptors,
    chatCountByProject,
    generalCountKey,
  );

  setFolderCountSnapshotByKey((prev) => {
    const next = { ...prev };
    let changed = false;
    for (const folderKey of Object.keys(prev)) {
      const newCount = folderCounts[folderKey] ?? 0;
      if (next[folderKey] !== newCount) {
        next[folderKey] = newCount;
        changed = true;
      }
    }
    return changed ? next : prev;
  });
}

function patchFolderRowsForChat(
  prev: Record<string, SidebarChatListItem[]>,
  patched: SidebarChatListItem,
): Record<string, SidebarChatListItem[]> {
  let changed = false;
  const next: Record<string, SidebarChatListItem[]> = { ...prev };
  for (const key of Object.keys(prev)) {
    const list = prev[key];
    const idx = list.findIndex((c) => c.id === patched.id);
    if (idx === -1) continue;
    changed = true;
    const updated = [...list];
    updated[idx] = { ...updated[idx], ...patched };
    next[key] = mergeChatsById(updated);
  }
  return changed ? next : prev;
}

function patchPinnedRowsForPinToggle(
  prev: Record<string, SidebarChatListItem[]>,
  patched: SidebarChatListItem,
  folderKey: string | null,
  pinnedAt: Date | null,
): Record<string, SidebarChatListItem[]> {
  if (!folderKey) {
    return prev;
  }

  if (pinnedAt) {
    const existingList = prev[folderKey] ?? [];
    const merged = mergeChatsById([patched, ...existingList.filter((c) => c.id !== patched.id)]);
    if (merged.length === existingList.length) {
      let same = true;
      for (let i = 0; i < merged.length; i++) {
        const a = merged[i];
        const b = existingList[i];
        if (a.id !== b.id || (a.pinnedAt?.getTime() ?? null) !== (b.pinnedAt?.getTime() ?? null)) {
          same = false;
          break;
        }
      }
      if (same) return prev;
    }
    return { ...prev, [folderKey]: merged };
  }

  let changed = false;
  const next: Record<string, SidebarChatListItem[]> = { ...prev };
  for (const key of Object.keys(next)) {
    const list = next[key];
    const filtered = list.filter((c) => c.id !== patched.id);
    if (filtered.length !== list.length) {
      changed = true;
      next[key] = filtered;
    }
  }
  return changed ? next : prev;
}

export function applyPinToggleToSidebarMaps(
  setFolderChatsByKey: Dispatch<SetStateAction<Record<string, SidebarChatListItem[]>>>,
  setPinnedChatsByKey: Dispatch<SetStateAction<Record<string, SidebarChatListItem[]>>>,
  patched: SidebarChatListItem,
  projects: SidebarProjectForFolderKey[],
  generalFolderKey: string,
): void {
  const folderKey = resolveSidebarFolderKeyForProjectId(
    patched.projectId,
    projects,
    generalFolderKey,
  );
  setFolderChatsByKey((prev) => patchFolderRowsForChat(prev, patched));
  setPinnedChatsByKey((prev) =>
    patchPinnedRowsForPinToggle(prev, patched, folderKey, patched.pinnedAt),
  );
}

export function applyForkInsertToSidebarMaps(
  setFolderChatsByKey: Dispatch<SetStateAction<Record<string, SidebarChatListItem[]>>>,
  folderKey: string | null,
  item: SidebarChatListItem,
): void {
  if (!folderKey) return;
  setFolderChatsByKey((prev) => {
    if (!(folderKey in prev)) return prev;
    const existing = prev[folderKey] ?? [];
    if (existing.some((c) => c.id === item.id)) return prev;
    return {
      ...prev,
      [folderKey]: mergeChatsById([item, ...existing]),
    };
  });
}

type ForkOutput = inferRouterOutputs<AppRouter>['chats']['fork'];

export function forkMutationResultToSidebarItem(forked: ForkOutput): SidebarChatListItem {
  const now = new Date();
  return {
    id: forked.id,
    name: forked.name ?? null,
    projectId: forked.projectId ?? null,
    createdAt: forked.createdAt ?? now,
    updatedAt: forked.updatedAt ?? now,
    archivedAt: forked.archivedAt ?? null,
    pinnedAt: null,
    worktreePath: forked.worktreePath ?? null,
    branch: forked.branch ?? null,
    baseBranch: forked.baseBranch ?? null,
    prUrl: forked.prUrl ?? null,
    prNumber: forked.prNumber ?? null,
    taskId: forked.taskId ?? null,
    batchId: null,
  };
}

/**
 * Patch the `name` field of a chat in any loaded folder/pinned map.
 * No-op if the chat is not currently present.
 */
export function applyChatRenameToSidebarMaps(
  setFolderChatsByKey: Dispatch<SetStateAction<Record<string, SidebarChatListItem[]>>>,
  setPinnedChatsByKey: Dispatch<SetStateAction<Record<string, SidebarChatListItem[]>>>,
  chatId: string,
  name: string,
): void {
  const patch = (
    prev: Record<string, SidebarChatListItem[]>,
  ): Record<string, SidebarChatListItem[]> => {
    let changed = false;
    const next: Record<string, SidebarChatListItem[]> = { ...prev };
    for (const key of Object.keys(prev)) {
      const list = prev[key];
      const idx = list.findIndex((c) => c.id === chatId);
      if (idx === -1) continue;
      if (list[idx].name === name) continue;
      changed = true;
      const updated = [...list];
      updated[idx] = { ...updated[idx], name };
      next[key] = updated;
    }
    return changed ? next : prev;
  };
  setFolderChatsByKey(patch);
  setPinnedChatsByKey(patch);
}

/**
 * Move a chat to `toKey` across folder + pinned maps.
 * Source key is discovered per-map by inspecting the current state. This matters because:
 * - Pinned chats are excluded from `chats.listByFolder` by the backend
 *   (`AND c.pinned_at IS NULL` in /api/v1/chats/page), so they live only in pinnedChatsByKey.
 * - Regular chats live only in folderChatsByKey.
 * The same updater therefore correctly relocates the chat in whichever map holds it.
 *
 * Same-key (no cross-folder transition): patches projectId + worktreePath in place.
 * Cross-folder: removes from source bucket; inserts into `toKey` only if that bucket is loaded
 * (so we preserve pagination state for unloaded folders).
 *
 * `newWorktreePath` is the moved chat's destination workspace (project root, or null for General).
 * Patching it keeps the row's worktreePath in sync so derived `isWorktree` (BatchGroup, etc.) does
 * not show a stale GitFork icon — the move path deliberately skips `listByFolder` refetch.
 */
export function applyChatMoveToSidebarMaps(
  setFolderChatsByKey: Dispatch<SetStateAction<Record<string, SidebarChatListItem[]>>>,
  setPinnedChatsByKey: Dispatch<SetStateAction<Record<string, SidebarChatListItem[]>>>,
  chatId: string,
  toKey: string,
  newProjectId: string | null,
  newWorktreePath: string | null,
): void {
  const moveAcrossKeys = (
    prev: Record<string, SidebarChatListItem[]>,
  ): Record<string, SidebarChatListItem[]> => {
    let sourceKey: string | null = null;
    let sourceList: SidebarChatListItem[] = [];
    let sourceIdx = -1;
    for (const [key, list] of Object.entries(prev)) {
      const idx = list.findIndex((c) => c.id === chatId);
      if (idx !== -1) {
        sourceKey = key;
        sourceList = list;
        sourceIdx = idx;
        break;
      }
    }
    const sourceRow = sourceIdx === -1 ? null : sourceList[sourceIdx];

    if (sourceKey === toKey) {
      if (sourceIdx === -1 || !sourceRow) return prev;
      if (sourceRow.projectId === newProjectId) return prev;
      const updatedList = [...sourceList];
      updatedList[sourceIdx] = {
        ...sourceRow,
        projectId: newProjectId,
        worktreePath: newWorktreePath,
      };
      return { ...prev, [sourceKey]: updatedList };
    }

    let next: Record<string, SidebarChatListItem[]> = prev;
    if (sourceKey && sourceIdx !== -1) {
      next = { ...next, [sourceKey]: sourceList.filter((c) => c.id !== chatId) };
    }

    const destKnown = toKey in next;
    if (destKnown) {
      const existing = next[toKey] ?? [];
      const existingDest = existing.find((c) => c.id === chatId) ?? null;
      const baseRow: SidebarChatListItem | null = sourceRow ?? existingDest;
      if (baseRow) {
        const needsProjectIdPatch = baseRow.projectId !== newProjectId;
        // Skip insertion when chat is already in dest with the right projectId and we have no
        // fresher source row to merge in. Avoids an unnecessary array reference change.
        if (!existingDest || needsProjectIdPatch || sourceRow) {
          const inserted = needsProjectIdPatch
            ? { ...baseRow, projectId: newProjectId, worktreePath: newWorktreePath }
            : baseRow;
          next = {
            ...next,
            [toKey]: mergeChatsById([inserted, ...existing.filter((c) => c.id !== chatId)]),
          };
        }
      }
    }

    return next === prev ? prev : next;
  };

  setFolderChatsByKey(moveAcrossKeys);
  setPinnedChatsByKey(moveAcrossKeys);
}

/**
 * Insert a restored (unarchived) chat row back into its folder map and, if
 * `pinnedAt` is set, into the pinned map. Skips folders that are not loaded
 * (the destination folder will fetch fresh when expanded).
 */
export function applyChatRestoreToSidebarMaps(
  setFolderChatsByKey: Dispatch<SetStateAction<Record<string, SidebarChatListItem[]>>>,
  setPinnedChatsByKey: Dispatch<SetStateAction<Record<string, SidebarChatListItem[]>>>,
  folderKey: string | null,
  restored: SidebarChatListItem,
): void {
  if (!folderKey) return;

  setFolderChatsByKey((prev) => {
    if (!(folderKey in prev)) return prev;
    const existing = prev[folderKey] ?? [];
    if (existing.some((c) => c.id === restored.id)) return prev;
    return {
      ...prev,
      [folderKey]: mergeChatsById([restored, ...existing]),
    };
  });

  if (!restored.pinnedAt) return;
  setPinnedChatsByKey((prev) => {
    const existing = prev[folderKey] ?? [];
    if (existing.some((c) => c.id === restored.id)) return prev;
    return {
      ...prev,
      [folderKey]: mergeChatsById([restored, ...existing]),
    };
  });
}

export function removeChatIdsFromSidebarMaps(
  setFolderChatsByKey: Dispatch<SetStateAction<Record<string, SidebarChatListItem[]>>>,
  setPinnedChatsByKey: Dispatch<SetStateAction<Record<string, SidebarChatListItem[]>>>,
  chatIds: Iterable<string>,
): void {
  const ids = new Set(chatIds);
  if (ids.size === 0) return;

  const strip = (
    prev: Record<string, SidebarChatListItem[]>,
  ): Record<string, SidebarChatListItem[]> => {
    let changed = false;
    const next: Record<string, SidebarChatListItem[]> = {};

    for (const [folderKey, chatsInFolder] of Object.entries(prev)) {
      const filtered = chatsInFolder.filter((chat) => !ids.has(chat.id));
      next[folderKey] = filtered;
      if (filtered.length !== chatsInFolder.length) {
        changed = true;
      }
    }

    return changed ? next : prev;
  };

  setFolderChatsByKey(strip);
  setPinnedChatsByKey(strip);
}
