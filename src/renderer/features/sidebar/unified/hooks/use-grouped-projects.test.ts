// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { getDefaultStore } from 'jotai';
import { afterEach, describe, expect, it } from 'vitest';
import { heldSubChatsAtom } from '../../../../lib/stores/active-transport-registry';
import { useGroupedProjects } from './use-grouped-projects';

const EMPTY_SET = new Set<string>();

afterEach(() => getDefaultStore().set(heldSubChatsAtom, new Map()));

function makeParams(overrides: Partial<Parameters<typeof useGroupedProjects>[0]> = {}) {
  return {
    projects: [],
    chats: [],
    unseenChanges: EMPTY_SET,
    loadingChats: EMPTY_SET,
    pendingPlans: EMPTY_SET,
    pendingQuestions: EMPTY_SET,
    ...overrides,
  };
}

describe('useGroupedProjects', () => {
  it('returns empty array when inputs are empty', () => {
    const { result } = renderHook(() => useGroupedProjects(makeParams()));
    expect(result.current).toEqual([]);
  });

  it('propagates taskId from ChatInput to ChatItem', () => {
    const params = makeParams({
      projects: [
        {
          id: 'proj-1',
          name: 'My Project',
          path: '/home/user/proj',
          gitRemoteUrl: 'https://github.com/user/repo',
          gitOwner: 'user',
          gitRepo: 'repo',
        },
      ],
      chats: [
        {
          id: 'chat-task',
          name: 'Automated fix',
          branch: null,
          updatedAt: new Date('2025-06-01'),
          projectId: 'proj-1',
          worktreePath: null,
          taskId: 'task-123',
          batchId: null,
          pinnedAt: null,
        },
        {
          id: 'chat-manual',
          name: 'Manual session',
          branch: null,
          updatedAt: new Date('2025-06-02'),
          projectId: 'proj-1',
          worktreePath: null,
          taskId: null,
          batchId: null,
          pinnedAt: null,
        },
      ],
    });

    const { result } = renderHook(() => useGroupedProjects(params));
    const chats = result.current[0].chats;

    const taskChat = chats.find((c) => c.id === 'chat-task');
    const manualChat = chats.find((c) => c.id === 'chat-manual');

    expect(taskChat?.taskId).toBe('task-123');
    expect(manualChat?.taskId).toBeNull();
  });

  it('propagates pinnedAt from ChatInput to ChatItem', () => {
    const pinnedDate = new Date('2025-06-15T12:00:00.000Z');
    const params = makeParams({
      projects: [
        {
          id: 'proj-1',
          name: 'My Project',
          path: '/home/user/proj',
          gitRemoteUrl: 'https://github.com/user/repo',
          gitOwner: 'user',
          gitRepo: 'repo',
        },
      ],
      chats: [
        {
          id: 'chat-pinned',
          name: 'Pinned session',
          branch: null,
          updatedAt: new Date('2025-06-01'),
          projectId: 'proj-1',
          worktreePath: null,
          taskId: null,
          batchId: null,
          pinnedAt: pinnedDate,
        },
        {
          id: 'chat-unpinned',
          name: 'Unpinned session',
          branch: null,
          updatedAt: new Date('2025-06-02'),
          projectId: 'proj-1',
          worktreePath: null,
          taskId: null,
          batchId: null,
          pinnedAt: null,
        },
      ],
    });

    const { result } = renderHook(() => useGroupedProjects(params));
    const chats = result.current[0].chats;

    const pinned = chats.find((c) => c.id === 'chat-pinned');
    const unpinned = chats.find((c) => c.id === 'chat-unpinned');

    expect(pinned?.pinnedAt).toEqual(pinnedDate);
    expect(unpinned?.pinnedAt).toBeNull();
  });

  it('sets taskId to null for general chats without a project', () => {
    const params = makeParams({
      chats: [
        {
          id: 'chat-general',
          name: 'General chat',
          branch: null,
          updatedAt: new Date('2025-06-01'),
          projectId: null,
          worktreePath: null,
          taskId: null,
          batchId: null,
          pinnedAt: null,
        },
      ],
    });

    const { result } = renderHook(() => useGroupedProjects(params));
    const generalGroup = result.current.find((g) => g.displayName === 'General Chats');
    expect(generalGroup).toBeDefined();
    expect(generalGroup?.chats[0].taskId).toBeNull();
  });

  it('marks a chat held by any of its sub-chats', () => {
    getDefaultStore().set(heldSubChatsAtom, new Map([['sub-1', 'chat-held']]));
    const general = (id: string) => ({
      id,
      name: null,
      branch: null,
      updatedAt: null,
      projectId: null,
      worktreePath: null,
      taskId: null,
      batchId: null,
      pinnedAt: null,
    });
    const params = makeParams({ chats: [general('chat-held'), general('chat-idle')] });

    const { result } = renderHook(() => useGroupedProjects(params));
    expect(result.current[0].chats.map((c) => c.isHeld)).toEqual([true, false]);
  });

  it('marks isWorktree correctly when worktreePath differs from project path', () => {
    const params = makeParams({
      projects: [
        {
          id: 'proj-1',
          name: 'My Project',
          path: '/home/user/proj',
          gitRemoteUrl: null,
          gitOwner: null,
          gitRepo: null,
        },
      ],
      chats: [
        {
          id: 'chat-wt',
          name: 'Worktree chat',
          branch: 'feat/x',
          updatedAt: new Date('2025-06-01'),
          projectId: 'proj-1',
          worktreePath: '/home/user/proj-wt',
          taskId: null,
          batchId: null,
          pinnedAt: null,
        },
        {
          id: 'chat-main',
          name: 'Main chat',
          branch: null,
          updatedAt: new Date('2025-06-01'),
          projectId: 'proj-1',
          worktreePath: '/home/user/proj',
          taskId: null,
          batchId: null,
          pinnedAt: null,
        },
      ],
    });

    const { result } = renderHook(() => useGroupedProjects(params));
    const chats = result.current[0].chats;
    expect(chats.find((c) => c.id === 'chat-wt')?.isWorktree).toBe(true);
    expect(chats.find((c) => c.id === 'chat-main')?.isWorktree).toBe(false);
  });

  it('groups projects sharing a git remote and sorts codebases alphabetically, General Chats last', () => {
    const project = (id: string, name: string, gitRemoteUrl: string | null) => ({
      id,
      name,
      path: `/src/${id}`,
      gitRemoteUrl,
      gitOwner: null,
      gitRepo: null,
    });
    const chat = (id: string, projectId: string | null) => ({
      id,
      name: id,
      branch: null,
      updatedAt: null,
      pinnedAt: null,
      projectId,
      worktreePath: null,
      taskId: null,
      batchId: null,
    });
    const params = makeParams({
      projects: [
        project('p-zeta', 'zeta', null),
        project('p-alpha-1', 'alpha', 'https://github.com/o/alpha'),
        project('p-alpha-2', 'alpha', 'https://github.com/o/alpha'),
      ],
      chats: [chat('c1', 'p-alpha-1'), chat('c2', 'p-alpha-2'), chat('c3', null)],
    });

    const { result } = renderHook(() => useGroupedProjects(params));
    expect(result.current.map((g) => g.displayName)).toEqual(['alpha', 'zeta', 'General Chats']);
    expect(result.current[0].projects.map((p) => p.id)).toEqual(['p-alpha-1', 'p-alpha-2']);
    expect(result.current[0].chats.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(result.current[2].projects).toEqual([]);
  });
});
