import type { Dispatch, SetStateAction } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { SidebarChatListItem } from '../utils';
import {
  applyChatMoveToSidebarMaps,
  applyChatRenameToSidebarMaps,
  applyChatRestoreToSidebarMaps,
  applyForkInsertToSidebarMaps,
  applyPinToggleToSidebarMaps,
  buildChatCountByProjectMap,
  computeChatCountByFolderKey,
  computeFolderSnapshot,
  forkMutationResultToSidebarItem,
  invalidateBatchViews,
  refetchListCountsAndSyncFolderSnapshots,
  removeChatIdsFromSidebarMaps,
  resolveSidebarFolderKeyForProjectId,
  SIDEBAR_GENERAL_COUNT_KEY,
} from './use-sidebar-chat-cache';

const GENERAL = 'General Chats';

function makeChat(partial: Partial<SidebarChatListItem> & { id: string }): SidebarChatListItem {
  return {
    name: null,
    projectId: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-02'),
    archivedAt: null,
    pinnedAt: null,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    prUrl: null,
    prNumber: null,
    taskId: null,
    batchId: null,
    ...partial,
  };
}

describe('computeFolderSnapshot', () => {
  // Invariant under test: the snapshot must never exceed the true count, or the count-drift
  // self-heal disarms and a concurrently-synced chat stays missing until remount.
  it.each([
    // [countAtFetchStart, countAtResolve, expected, why]
    [2, 3, 2, 'count advanced mid-fetch → snapshot stays behind so drift re-arms (the bug case)'],
    [3, 3, 3, 'no advance → snapshot equals count → steady state, no re-arm/loop'],
    [undefined, 3, 0, 'cold start → 0 (never rows.length), re-fires once the real count lands'],
    [2, undefined, 2, 'resolve count unknown → fall back to the pre-fetch count'],
    [3, 2, 2, 'count dropped mid-fetch (archive/delete) → clamp to the freshest, lower count'],
  ] as const)('start=%s resolve=%s → %s (%s)', (start, resolve, expected, _why) => {
    expect(computeFolderSnapshot(start, resolve)).toBe(expected);
  });

  it('never exceeds the resolve count when both are defined', () => {
    for (let start = 0; start <= 5; start++) {
      for (let resolve = 0; resolve <= 5; resolve++) {
        expect(computeFolderSnapshot(start, resolve)).toBeLessThanOrEqual(resolve);
      }
    }
  });
});

describe('resolveSidebarFolderKeyForProjectId', () => {
  const projects = [
    {
      id: 'proj-a',
      name: 'my-name',
      gitRemoteUrl: 'https://github.com/o/r.git',
      gitRepo: 'r',
    },
  ];

  it('uses general folder when projectId is null', () => {
    expect(resolveSidebarFolderKeyForProjectId(null, projects, GENERAL)).toBe(GENERAL);
  });

  it('resolves key from the matching project', () => {
    expect(resolveSidebarFolderKeyForProjectId('proj-a', projects, GENERAL)).toBe(
      'https://github.com/o/r.git',
    );
  });

  it('returns null when project not found', () => {
    expect(resolveSidebarFolderKeyForProjectId('missing', projects, GENERAL)).toBeNull();
  });
});

describe('buildChatCountByProjectMap / computeChatCountByFolderKey', () => {
  it('aggregates folder counts from listCounts rows', () => {
    const raw = [
      { projectId: 'p1', count: 2 },
      { projectId: 'p2', count: 3 },
      { projectId: null, count: 1 },
    ];
    const map = buildChatCountByProjectMap(raw);
    expect(map.get('p1')).toBe(2);
    expect(map.get(SIDEBAR_GENERAL_COUNT_KEY)).toBe(1);

    const folderDescriptors = [
      { key: 'folder-a', projectIds: ['p1', 'p2'] as string[] },
      { key: GENERAL, projectIds: null },
    ];
    const byFolder = computeChatCountByFolderKey(folderDescriptors, map, SIDEBAR_GENERAL_COUNT_KEY);
    expect(byFolder['folder-a']).toBe(5);
    expect(byFolder[GENERAL]).toBe(1);
  });
});

describe('applyPinToggleToSidebarMaps', () => {
  it('updates pinned section when chat is not present in any folder bucket', () => {
    const chat = makeChat({ id: 'c1', projectId: 'proj-1', pinnedAt: null });
    const setFolder = vi.fn((fn: (p: Record<string, SidebarChatListItem[]>) => unknown) => fn({}));
    const setPinned = vi.fn((fn: (p: Record<string, SidebarChatListItem[]>) => unknown) =>
      fn({ remote: [] }),
    );
    const projects = [
      {
        id: 'proj-1',
        name: 'n',
        gitRemoteUrl: 'remote',
        gitRepo: null,
      },
    ];
    const pinned = new Date('2026-02-01');
    applyPinToggleToSidebarMaps(
      setFolder as Dispatch<SetStateAction<Record<string, SidebarChatListItem[]>>>,
      setPinned as Dispatch<SetStateAction<Record<string, SidebarChatListItem[]>>>,
      { ...chat, pinnedAt: pinned },
      projects,
      GENERAL,
    );
    const folderNext = setFolder.mock.calls[0][0]({}) as Record<string, SidebarChatListItem[]>;
    expect(folderNext).toEqual({});
    const pinnedNext = setPinned.mock.calls[0][0]({ remote: [] }) as Record<
      string,
      SidebarChatListItem[]
    >;
    expect(pinnedNext.remote).toHaveLength(1);
    expect(pinnedNext.remote[0].id).toBe('c1');
  });

  it('removes chat from pinned map when unpinning', () => {
    const pinnedAt = new Date('2026-02-01');
    const chat = makeChat({ id: 'c1', projectId: 'proj-1', pinnedAt });
    const setFolder = vi.fn((fn: (p: Record<string, SidebarChatListItem[]>) => unknown) =>
      fn({ remote: [chat] }),
    );
    const setPinned = vi.fn((fn: (p: Record<string, SidebarChatListItem[]>) => unknown) =>
      fn({ remote: [chat] }),
    );
    const projects = [
      {
        id: 'proj-1',
        name: 'n',
        gitRemoteUrl: 'remote',
        gitRepo: null,
      },
    ];
    applyPinToggleToSidebarMaps(
      setFolder as Dispatch<SetStateAction<Record<string, SidebarChatListItem[]>>>,
      setPinned as Dispatch<SetStateAction<Record<string, SidebarChatListItem[]>>>,
      { ...chat, pinnedAt: null },
      projects,
      GENERAL,
    );
    const folderNext = setFolder.mock.calls[0][0]({ remote: [chat] }) as Record<
      string,
      SidebarChatListItem[]
    >;
    expect(folderNext.remote[0].pinnedAt).toBeNull();
    const pinnedNext = setPinned.mock.calls[0][0]({ remote: [chat] }) as Record<
      string,
      SidebarChatListItem[]
    >;
    expect(pinnedNext.remote).toHaveLength(0);
  });

  it('does not add to pinned map when projectId cannot be resolved (folderKey null)', () => {
    const chat = makeChat({
      id: 'c1',
      projectId: 'orphan-proj',
      pinnedAt: null,
    });
    const setFolder = vi.fn((fn: (p: Record<string, SidebarChatListItem[]>) => unknown) =>
      fn({ someKey: [chat] }),
    );
    const setPinned = vi.fn((fn: (p: Record<string, SidebarChatListItem[]>) => unknown) => fn({}));
    const pinned = new Date('2026-02-01');
    applyPinToggleToSidebarMaps(
      setFolder as Dispatch<SetStateAction<Record<string, SidebarChatListItem[]>>>,
      setPinned as Dispatch<SetStateAction<Record<string, SidebarChatListItem[]>>>,
      { ...chat, pinnedAt: pinned },
      [],
      GENERAL,
    );
    const pinnedNext = setPinned.mock.calls[0][0]({}) as Record<string, SidebarChatListItem[]>;
    expect(Object.keys(pinnedNext)).toHaveLength(0);
  });

  it('updates pinnedAt in folder map and adds to pinned map when pinning', () => {
    const chat = makeChat({ id: 'c1', projectId: 'proj-1', pinnedAt: null });
    const setFolder = vi.fn((fn: (p: Record<string, SidebarChatListItem[]>) => unknown) =>
      fn({ remote: [chat] }),
    );
    const setPinned = vi.fn((fn: (p: Record<string, SidebarChatListItem[]>) => unknown) => fn({}));

    const projects = [
      {
        id: 'proj-1',
        name: 'n',
        gitRemoteUrl: 'remote',
        gitRepo: null,
      },
    ];

    const pinned = new Date('2026-02-01');
    applyPinToggleToSidebarMaps(
      setFolder as Dispatch<SetStateAction<Record<string, SidebarChatListItem[]>>>,
      setPinned as Dispatch<SetStateAction<Record<string, SidebarChatListItem[]>>>,
      { ...chat, pinnedAt: pinned },
      projects,
      GENERAL,
    );

    const folderNext = setFolder.mock.calls[0][0]({ remote: [chat] }) as Record<
      string,
      SidebarChatListItem[]
    >;
    expect(folderNext.remote[0].pinnedAt).toEqual(pinned);

    const pinnedNext = setPinned.mock.calls[0][0]({}) as Record<string, SidebarChatListItem[]>;
    expect(pinnedNext.remote).toHaveLength(1);
    expect(pinnedNext.remote[0].id).toBe('c1');
  });
});

describe('applyForkInsertToSidebarMaps', () => {
  it('does not invoke setFolderChatsByKey when folderKey is null', () => {
    const setFolder = vi.fn();
    applyForkInsertToSidebarMaps(
      setFolder as Dispatch<SetStateAction<Record<string, SidebarChatListItem[]>>>,
      null,
      makeChat({ id: 'new' }),
    );
    expect(setFolder).not.toHaveBeenCalled();
  });

  it('no-ops when folder is not loaded', () => {
    const setFolder = vi.fn((fn: (p: Record<string, SidebarChatListItem[]>) => unknown) => fn({}));
    applyForkInsertToSidebarMaps(
      setFolder as Dispatch<SetStateAction<Record<string, SidebarChatListItem[]>>>,
      'remote',
      makeChat({ id: 'new' }),
    );
    expect(setFolder).toHaveBeenCalled();
    const out = setFolder.mock.calls[0][0]({}) as Record<string, SidebarChatListItem[]>;
    expect(out).toEqual({});
  });

  it('prepends forked chat when folder is loaded', () => {
    const existing = makeChat({ id: 'old' });
    const forked = makeChat({ id: 'new', updatedAt: new Date('2026-03-01') });
    const setFolder = vi.fn();
    applyForkInsertToSidebarMaps(
      setFolder as Dispatch<SetStateAction<Record<string, SidebarChatListItem[]>>>,
      'remote',
      forked,
    );
    const updater = setFolder.mock.calls[0][0] as (
      p: Record<string, SidebarChatListItem[]>,
    ) => Record<string, SidebarChatListItem[]>;
    const next = updater({ remote: [existing] });
    expect(next.remote.map((c) => c.id)).toContain('new');
    expect(next.remote.map((c) => c.id)).toContain('old');
  });
});

describe('removeChatIdsFromSidebarMaps', () => {
  it('strips ids from both folder and pinned maps', () => {
    const setFolder = vi.fn();
    const setPinned = vi.fn();
    removeChatIdsFromSidebarMaps(setFolder, setPinned, ['a']);
    const uf = setFolder.mock.calls[0][0] as (
      p: Record<string, SidebarChatListItem[]>,
    ) => Record<string, SidebarChatListItem[]>;
    const up = setPinned.mock.calls[0][0] as (
      p: Record<string, SidebarChatListItem[]>,
    ) => Record<string, SidebarChatListItem[]>;
    expect(uf({ k: [makeChat({ id: 'a' }), makeChat({ id: 'b' })] }).k).toHaveLength(1);
    expect(up({ k: [makeChat({ id: 'a' })] }).k).toHaveLength(0);
  });
});

describe('refetchListCountsAndSyncFolderSnapshots', () => {
  it('refetches counts and aligns snapshots for loaded folders only', async () => {
    const invalidate = vi.fn(async () => undefined);
    const fetch = vi.fn(async () => [
      { projectId: 'p1', count: 10 },
      { projectId: null, count: 0 },
    ]);
    const setSnapshot = vi.fn((fn: (p: Record<string, number>) => Record<string, number>) =>
      fn({ folderA: 5 }),
    );

    await refetchListCountsAndSyncFolderSnapshots(
      { chats: { listCounts: { invalidate, fetch } } },
      [
        { key: 'folderA', projectIds: ['p1'] },
        { key: GENERAL, projectIds: null },
      ],
      setSnapshot as Dispatch<SetStateAction<Record<string, number>>>,
      SIDEBAR_GENERAL_COUNT_KEY,
    );

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const updater = setSnapshot.mock.calls[0][0] as (
      p: Record<string, number>,
    ) => Record<string, number>;
    const next = updater({ folderA: 5 });
    expect(next.folderA).toBe(10);
  });
});

describe('applyChatRenameToSidebarMaps', () => {
  it('patches name in folder and pinned maps', () => {
    const chat = makeChat({ id: 'c1', name: 'old' });
    const setFolder = vi.fn();
    const setPinned = vi.fn();
    applyChatRenameToSidebarMaps(setFolder, setPinned, 'c1', 'new');
    const folderUpdater = setFolder.mock.calls[0][0] as (
      p: Record<string, SidebarChatListItem[]>,
    ) => Record<string, SidebarChatListItem[]>;
    const pinnedUpdater = setPinned.mock.calls[0][0] as (
      p: Record<string, SidebarChatListItem[]>,
    ) => Record<string, SidebarChatListItem[]>;
    const folderNext = folderUpdater({ remote: [chat] });
    expect(folderNext.remote[0].name).toBe('new');
    const pinnedNext = pinnedUpdater({ remote: [chat] });
    expect(pinnedNext.remote[0].name).toBe('new');
  });

  it('returns the same reference when chat is missing in a map', () => {
    const setFolder = vi.fn();
    const setPinned = vi.fn();
    applyChatRenameToSidebarMaps(setFolder, setPinned, 'missing', 'whatever');
    const folderUpdater = setFolder.mock.calls[0][0] as (
      p: Record<string, SidebarChatListItem[]>,
    ) => Record<string, SidebarChatListItem[]>;
    const input = { remote: [makeChat({ id: 'c1', name: 'keep' })] };
    expect(folderUpdater(input)).toBe(input);
  });

  it('returns the same reference when name is unchanged', () => {
    const chat = makeChat({ id: 'c1', name: 'same' });
    const setFolder = vi.fn();
    const setPinned = vi.fn();
    applyChatRenameToSidebarMaps(setFolder, setPinned, 'c1', 'same');
    const folderUpdater = setFolder.mock.calls[0][0] as (
      p: Record<string, SidebarChatListItem[]>,
    ) => Record<string, SidebarChatListItem[]>;
    const input = { remote: [chat] };
    expect(folderUpdater(input)).toBe(input);
  });
});

describe('applyChatMoveToSidebarMaps', () => {
  it('patches projectId + worktreePath in place when chat is already in destination key', () => {
    const chat = makeChat({ id: 'c1', projectId: 'old', worktreePath: '/old/path' });
    const setFolder = vi.fn();
    const setPinned = vi.fn();
    applyChatMoveToSidebarMaps(setFolder, setPinned, 'c1', 'remote', 'new', '/new/path');
    const updater = setFolder.mock.calls[0][0] as (
      p: Record<string, SidebarChatListItem[]>,
    ) => Record<string, SidebarChatListItem[]>;
    const next = updater({ remote: [chat] });
    expect(next.remote[0].projectId).toBe('new');
    // worktreePath re-synced so derived isWorktree (BatchGroup) doesn't show a stale GitFork icon.
    expect(next.remote[0].worktreePath).toBe('/new/path');
    expect(next.remote[0].id).toBe('c1');
  });

  it('moves chat across folders when destination is loaded', () => {
    const chat = makeChat({ id: 'c1', projectId: 'src-proj', worktreePath: '/src/path' });
    const setFolder = vi.fn();
    const setPinned = vi.fn();
    applyChatMoveToSidebarMaps(setFolder, setPinned, 'c1', 'dest', 'dest-proj', '/dest/path');
    const updater = setFolder.mock.calls[0][0] as (
      p: Record<string, SidebarChatListItem[]>,
    ) => Record<string, SidebarChatListItem[]>;
    const next = updater({ src: [chat], dest: [] });
    expect(next.src.find((c) => c.id === 'c1')).toBeUndefined();
    expect(next.dest).toHaveLength(1);
    expect(next.dest[0].projectId).toBe('dest-proj');
    expect(next.dest[0].worktreePath).toBe('/dest/path');
  });

  it('removes from source even when destination folder is not loaded', () => {
    const chat = makeChat({ id: 'c1', projectId: 'src-proj' });
    const setFolder = vi.fn();
    const setPinned = vi.fn();
    applyChatMoveToSidebarMaps(setFolder, setPinned, 'c1', 'dest', 'dest-proj', '/dest/path');
    const updater = setFolder.mock.calls[0][0] as (
      p: Record<string, SidebarChatListItem[]>,
    ) => Record<string, SidebarChatListItem[]>;
    const next = updater({ src: [chat] });
    expect(next.src.find((c) => c.id === 'c1')).toBeUndefined();
    expect('dest' in next).toBe(false);
  });

  it('returns same reference when chat is already in dest with the right projectId', () => {
    const chatInDest = makeChat({ id: 'c1', projectId: 'dest-proj' });
    const setFolder = vi.fn();
    const setPinned = vi.fn();
    applyChatMoveToSidebarMaps(setFolder, setPinned, 'c1', 'dest', 'dest-proj', '/dest/path');
    const updater = setFolder.mock.calls[0][0] as (
      p: Record<string, SidebarChatListItem[]>,
    ) => Record<string, SidebarChatListItem[]>;
    const input = { dest: [chatInDest] };
    expect(updater(input)).toBe(input);
  });

  it('moves pinned row across pinned-by-key buckets when chat is pinned', () => {
    const pinnedAt = new Date('2026-02-01');
    const chat = makeChat({ id: 'c1', projectId: 'src-proj', pinnedAt });
    const setFolder = vi.fn();
    const setPinned = vi.fn();
    applyChatMoveToSidebarMaps(setFolder, setPinned, 'c1', 'dest', 'dest-proj', '/dest/path');
    const updater = setPinned.mock.calls[0][0] as (
      p: Record<string, SidebarChatListItem[]>,
    ) => Record<string, SidebarChatListItem[]>;
    const next = updater({ src: [chat], dest: [] });
    expect(next.src.find((c) => c.id === 'c1')).toBeUndefined();
    expect(next.dest).toHaveLength(1);
    expect(next.dest[0].projectId).toBe('dest-proj');
    expect(next.dest[0].pinnedAt).toEqual(pinnedAt);
  });

  it('moves a pinned-only chat (not present in folder map) — discovers source per-map (sc-701)', () => {
    // Regression: pinned chats are excluded from chats.listByFolder by the backend
    // (`AND c.pinned_at IS NULL` in /api/v1/chats/page), so they never appear in
    // folderChatsByKey. The helper must discover `fromKey` independently inside each map,
    // not require the caller to pre-compute it from one specific map.
    const pinnedAt = new Date('2026-02-01');
    const chat = makeChat({ id: 'c1', projectId: 'src-proj', pinnedAt });
    const setFolder = vi.fn();
    const setPinned = vi.fn();
    applyChatMoveToSidebarMaps(setFolder, setPinned, 'c1', 'dest', 'dest-proj', '/dest/path');

    // Folder map: chat is absent — folder updater should be a no-op (empty buckets in/out).
    const folderUpdater = setFolder.mock.calls[0][0] as (
      p: Record<string, SidebarChatListItem[]>,
    ) => Record<string, SidebarChatListItem[]>;
    const folderInput = { src: [], dest: [] };
    expect(folderUpdater(folderInput)).toBe(folderInput);

    // Pinned map: chat lives in src; updater must move it to dest with patched projectId.
    const pinnedUpdater = setPinned.mock.calls[0][0] as (
      p: Record<string, SidebarChatListItem[]>,
    ) => Record<string, SidebarChatListItem[]>;
    const pinnedNext = pinnedUpdater({ src: [chat], dest: [] });
    expect(pinnedNext.src.find((c) => c.id === 'c1')).toBeUndefined();
    expect(pinnedNext.dest).toHaveLength(1);
    expect(pinnedNext.dest[0].projectId).toBe('dest-proj');
    expect(pinnedNext.dest[0].pinnedAt).toEqual(pinnedAt);
  });
});

describe('applyChatRestoreToSidebarMaps', () => {
  it('returns the same reference when folderKey is null', () => {
    const setFolder = vi.fn();
    const setPinned = vi.fn();
    applyChatRestoreToSidebarMaps(setFolder, setPinned, null, makeChat({ id: 'r1' }));
    expect(setFolder).not.toHaveBeenCalled();
    expect(setPinned).not.toHaveBeenCalled();
  });

  it('inserts into folder map when folder is loaded', () => {
    const restored = makeChat({ id: 'r1', updatedAt: new Date('2026-03-01') });
    const setFolder = vi.fn();
    const setPinned = vi.fn();
    applyChatRestoreToSidebarMaps(setFolder, setPinned, 'remote', restored);
    const updater = setFolder.mock.calls[0][0] as (
      p: Record<string, SidebarChatListItem[]>,
    ) => Record<string, SidebarChatListItem[]>;
    const next = updater({ remote: [makeChat({ id: 'old' })] });
    expect(next.remote.map((c) => c.id)).toContain('r1');
  });

  it('returns same reference when destination folder is not loaded', () => {
    const restored = makeChat({ id: 'r1' });
    const setFolder = vi.fn();
    const setPinned = vi.fn();
    applyChatRestoreToSidebarMaps(setFolder, setPinned, 'remote', restored);
    const updater = setFolder.mock.calls[0][0] as (
      p: Record<string, SidebarChatListItem[]>,
    ) => Record<string, SidebarChatListItem[]>;
    const input = {};
    expect(updater(input)).toBe(input);
  });

  it('inserts into pinned map when restored chat has pinnedAt', () => {
    const pinnedAt = new Date('2026-02-01');
    const restored = makeChat({ id: 'r1', pinnedAt });
    const setFolder = vi.fn();
    const setPinned = vi.fn();
    applyChatRestoreToSidebarMaps(setFolder, setPinned, 'remote', restored);
    const updater = setPinned.mock.calls[0][0] as (
      p: Record<string, SidebarChatListItem[]>,
    ) => Record<string, SidebarChatListItem[]>;
    const next = updater({ remote: [] });
    expect(next.remote).toHaveLength(1);
    expect(next.remote[0].id).toBe('r1');
  });

  it('skips pinned-map update when restored chat is not pinned', () => {
    const restored = makeChat({ id: 'r1', pinnedAt: null });
    const setFolder = vi.fn();
    const setPinned = vi.fn();
    applyChatRestoreToSidebarMaps(setFolder, setPinned, 'remote', restored);
    expect(setPinned).not.toHaveBeenCalled();
  });
});

describe('forkMutationResultToSidebarItem', () => {
  it('fills sidebar list fields from fork output', () => {
    const row = forkMutationResultToSidebarItem({
      id: 'f1',
      name: 'Fork',
      projectId: 'p1',
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-01-02'),
      archivedAt: null,
      pinnedAt: null,
      worktreePath: '/w',
      branch: 'b',
      baseBranch: 'main',
      prUrl: null,
      prNumber: null,
      taskId: null,
      batchId: null,
      worktreeHistory: null,
      subChats: [],
    });
    expect(row.batchId).toBeNull();
    expect(row.pinnedAt).toBeNull();
    expect(row.projectId).toBe('p1');
  });
});

describe('invalidateBatchViews', () => {
  it('invalidates listByBatch and listBatchGroups together', async () => {
    const utils = {
      chats: {
        listByBatch: { invalidate: vi.fn(async () => undefined) },
        listBatchGroups: { invalidate: vi.fn(async () => undefined) },
      },
    };

    await invalidateBatchViews(utils);

    expect(utils.chats.listByBatch.invalidate).toHaveBeenCalledTimes(1);
    expect(utils.chats.listBatchGroups.invalidate).toHaveBeenCalledTimes(1);
  });
});
