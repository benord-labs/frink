// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  buildSplitPaneProjectInfo,
  resolvePaneProjectInfoForChat,
} from './split-pane-project-info';

describe('resolvePaneProjectInfoForChat', () => {
  it('does not use global selectedProject fallback for real chats in 2+ split panes', () => {
    const info = resolvePaneProjectInfoForChat({
      isRealChat: true,
      isNewChat: false,
      chatId: 'chat-left',
      splitPaneCount: 2,
      paneProjectInfo: new Map(),
      selectedProjectFallback: { path: '/global/fallback' },
    });

    expect(info).toBeUndefined();
  });

  it('keeps selectedProject fallback for real chats in single pane', () => {
    const info = resolvePaneProjectInfoForChat({
      isRealChat: true,
      isNewChat: false,
      chatId: 'chat-1',
      splitPaneCount: 1,
      paneProjectInfo: new Map(),
      selectedProjectFallback: { path: '/global/fallback' },
    });

    expect(info).toEqual({ path: '/global/fallback' });
  });

  it('prefers pane-specific project info for real chats', () => {
    const info = resolvePaneProjectInfoForChat({
      isRealChat: true,
      isNewChat: false,
      chatId: 'chat-1',
      splitPaneCount: 2,
      paneProjectInfo: new Map([['chat-1', { path: '/pane/project' }]]),
      selectedProjectFallback: { path: '/global/fallback' },
    });

    expect(info).toEqual({ path: '/pane/project' });
  });

  it('keeps pane isolation in multi-panel mode when only one chat has fresh pane data', () => {
    const paneProjectInfo = new Map([['chat-right', { path: '/projects/hackathon' }]]);

    const leftInfo = resolvePaneProjectInfoForChat({
      isRealChat: true,
      isNewChat: false,
      chatId: 'chat-left',
      splitPaneCount: 2,
      paneProjectInfo,
      selectedProjectFallback: { path: '/global/owners-web' },
    });
    const rightInfo = resolvePaneProjectInfoForChat({
      isRealChat: true,
      isNewChat: false,
      chatId: 'chat-right',
      splitPaneCount: 2,
      paneProjectInfo,
      selectedProjectFallback: { path: '/global/owners-web' },
    });

    // The left pane should not inherit global fallback while right pane is moving.
    expect(leftInfo).toBeUndefined();
    expect(rightInfo).toEqual({ path: '/projects/hackathon' });
  });

  it('does not allow one pane fallback to bleed into another pane during concurrent moves', () => {
    const paneProjectInfo = new Map([
      ['chat-left', { path: '/projects/frink-marketing' }],
      ['chat-right', { path: '/projects/owners-web' }],
    ]);

    const leftInfo = resolvePaneProjectInfoForChat({
      isRealChat: true,
      isNewChat: false,
      chatId: 'chat-left',
      splitPaneCount: 2,
      paneProjectInfo,
      selectedProjectFallback: { path: '/global/stale-project' },
    });
    const rightInfo = resolvePaneProjectInfoForChat({
      isRealChat: true,
      isNewChat: false,
      chatId: 'chat-right',
      splitPaneCount: 2,
      paneProjectInfo,
      selectedProjectFallback: { path: '/global/stale-project' },
    });

    expect(leftInfo?.path).toBe('/projects/frink-marketing');
    expect(rightInfo?.path).toBe('/projects/owners-web');
  });

  it('returns newChatPaneProject when isNewChat is true and pane project exists', () => {
    const info = resolvePaneProjectInfoForChat({
      isRealChat: false,
      isNewChat: true,
      chatId: '__new__',
      splitPaneCount: 2,
      paneProjectInfo: new Map(),
      newChatPaneProject: { path: '/projects/new-chat-target' },
      selectedProjectFallback: { path: '/global/fallback' },
    });

    expect(info).toEqual({ path: '/projects/new-chat-target' });
  });

  it('falls back to selectedProjectFallback when isNewChat and newChatPaneProject is undefined', () => {
    const info = resolvePaneProjectInfoForChat({
      isRealChat: false,
      isNewChat: true,
      chatId: '__new__',
      splitPaneCount: 2,
      paneProjectInfo: new Map(),
      selectedProjectFallback: { path: '/global/fallback-new-chat' },
    });

    expect(info).toEqual({ path: '/global/fallback-new-chat' });
  });

  it('returns undefined when isNewChat and both pane/fallback projects are undefined', () => {
    const info = resolvePaneProjectInfoForChat({
      isRealChat: false,
      isNewChat: true,
      chatId: '__new__',
      splitPaneCount: 2,
      paneProjectInfo: new Map(),
    });

    expect(info).toBeUndefined();
  });
});

describe('buildSplitPaneProjectInfo', () => {
  it('prefers worktreePath when chat has both projectId and worktreePath', () => {
    const info = buildSplitPaneProjectInfo({
      isSplitActive: true,
      chatIds: ['chat-1'],
      newChatPaneId: '__new__',
      agentChatsById: new Map([
        ['chat-1', { projectId: 'proj-1', worktreePath: '/tmp/.frink/worktrees/proj-1/wt-a' }],
      ]),
      resolveLocalProject: () => ({ path: '/repos/proj-1' }),
    });

    expect(info.get('chat-1')).toEqual({
      path: '/tmp/.frink/worktrees/proj-1/wt-a',
      isWorktree: true,
    });
  });

  it('falls back to resolved project path when worktreePath is missing', () => {
    const info = buildSplitPaneProjectInfo({
      isSplitActive: true,
      chatIds: ['chat-2'],
      newChatPaneId: '__new__',
      agentChatsById: new Map([['chat-2', { projectId: 'proj-2' }]]),
      resolveLocalProject: () => ({ path: '/repos/proj-2' }),
    });

    expect(info.get('chat-2')).toEqual({ path: '/repos/proj-2' });
  });

  it('keeps independent worktree paths for multiple panes on initial split load', () => {
    const info = buildSplitPaneProjectInfo({
      isSplitActive: true,
      chatIds: ['chat-left', 'chat-right'],
      newChatPaneId: '__new__',
      agentChatsById: new Map([
        [
          'chat-left',
          { projectId: 'proj-1', worktreePath: '/tmp/.frink/worktrees/proj-1/wt-left' },
        ],
        [
          'chat-right',
          { projectId: 'proj-1', worktreePath: '/tmp/.frink/worktrees/proj-1/wt-right' },
        ],
      ]),
      resolveLocalProject: () => ({ path: '/repos/proj-1' }),
    });

    expect(info.get('chat-left')).toEqual({
      path: '/tmp/.frink/worktrees/proj-1/wt-left',
      isWorktree: true,
    });
    expect(info.get('chat-right')).toEqual({
      path: '/tmp/.frink/worktrees/proj-1/wt-right',
      isWorktree: true,
    });
  });

  it('treats worktreePath equal to resolved project path as non-worktree', () => {
    const info = buildSplitPaneProjectInfo({
      isSplitActive: true,
      chatIds: ['chat-1'],
      newChatPaneId: '__new__',
      agentChatsById: new Map([['chat-1', { projectId: 'proj-1', worktreePath: '/repos/proj-1' }]]),
      resolveLocalProject: () => ({ path: '/repos/proj-1' }),
    });

    expect(info.get('chat-1')).toEqual({ path: '/repos/proj-1' });
  });

  it('normalizes Windows drive-letter casing before worktree equality check', () => {
    const info = buildSplitPaneProjectInfo({
      isSplitActive: true,
      chatIds: ['chat-1'],
      newChatPaneId: '__new__',
      agentChatsById: new Map([
        ['chat-1', { projectId: 'proj-1', worktreePath: 'C:/Repos/Owners-Web' }],
      ]),
      resolveLocalProject: () => ({ path: 'c:/Repos/Owners-Web' }),
    });

    expect(info.get('chat-1')).toEqual({ path: 'c:/Repos/Owners-Web' });
  });
});
