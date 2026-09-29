import { describe, expect, it } from 'vitest';
import { SIDEBAR_TASK_PRESENTATION, type SidebarTaskStatus } from './constants';
import type { CodebaseGroup } from './types';
import type { ActiveFolderChat } from './utils';
import {
  buildChatTaskStatusMap,
  buildSidebarActivityMaps,
  getFolderActiveChats,
  getFolderActiveState,
  groupActiveChatsByFolder,
} from './utils';

const active = (chatId: string, extra: Partial<ActiveFolderChat> = {}): ActiveFolderChat => ({
  chatId,
  projectId: null,
  batchId: null,
  hasLiveFlowRun: false,
  ...extra,
});

describe('getFolderActiveState', () => {
  type ChatFlags = {
    batchId?: string;
    isLoading?: boolean;
    hasPendingQuestion?: boolean;
    hasPendingPlan?: boolean;
    hasUnseenChanges?: boolean;
  };
  const chat = (id: string, flags: ChatFlags = {}) => ({
    id,
    batchId: null,
    isLoading: false,
    hasPendingQuestion: false,
    hasPendingPlan: false,
    hasUnseenChanges: false,
    ...flags,
  });
  const tasks = (entries: Record<string, SidebarTaskStatus>) => new Map(Object.entries(entries));

  it('returns null when no chat is active', () => {
    expect(getFolderActiveState([chat('a'), chat('b')])).toBeNull();
  });

  it('rolls a live stream up as running with the pulsing primary dot', () => {
    const state = getFolderActiveState([chat('a', { isLoading: true }), chat('b')]);
    expect(state).toMatchObject({ label: 'Running', count: 1 });
    expect(state?.dotClassName).toContain('animate-pulse');
  });

  it('counts a polled running task as running', () => {
    const state = getFolderActiveState([chat('a')], tasks({ a: 'running' }));
    expect(state).toMatchObject({ label: 'Running', count: 1 });
  });

  it('prefers needs-you over running, and counts only chats at the winning level', () => {
    const state = getFolderActiveState([
      chat('a', { isLoading: true }),
      chat('b', { hasPendingQuestion: true }),
      chat('c', { isLoading: true }),
    ]);
    expect(state).toMatchObject({ label: 'Needs attention', count: 1 });
  });

  it('treats a question held while its task is still running as needs-you', () => {
    const state = getFolderActiveState(
      [chat('a', { hasPendingQuestion: true })],
      tasks({ a: 'running' }),
    );
    expect(state).toMatchObject({ label: 'Needs attention', count: 1 });
  });

  it('lets a terminal task status beat stale question and plan flags, as the chat row does', () => {
    const state = getFolderActiveState(
      [chat('a', { hasPendingQuestion: true }), chat('b', { hasPendingPlan: true })],
      tasks({ a: 'done', b: 'done' }),
    );
    expect(state).toMatchObject({ label: 'Ready for review', count: 2 });
  });

  it('keeps a failed or needs-attention task above a live stream in the same chat', () => {
    const streaming = [chat('a', { isLoading: true }), chat('b', { isLoading: true })];
    expect(getFolderActiveState(streaming, tasks({ a: 'needs_attention' }))).toMatchObject({
      label: 'Needs attention',
      count: 1,
    });
    expect(getFolderActiveState(streaming, tasks({ a: 'failed' }))).toMatchObject({
      label: 'Failed',
      count: 1,
    });
  });

  it('counts task chats beyond the loaded page once, using their polled task status', () => {
    const state = getFolderActiveState(
      [chat('loaded')],
      tasks({ loaded: 'needs_attention', old: 'needs_attention' }),
      undefined,
      [active('loaded'), active('old'), active('old')],
    );
    expect(state).toMatchObject({ label: 'Needs attention', count: 2 });
  });

  it('rolls up the status a multi-task chat row shows, without reordering the row priority', () => {
    const rowStatuses = buildChatTaskStatusMap([
      { linkedChatId: 'a', status: 'failed' },
      { linkedChatId: 'a', status: 'needs_attention' },
    ]);
    expect(getFolderActiveState([chat('a')], rowStatuses)).toMatchObject({
      label: SIDEBAR_TASK_PRESENTATION[rowStatuses.get('a') ?? 'failed'].label,
      count: 1,
    });
  });

  it('shows a follow-up stream on a done or cancelled task as running, as the row icon pulses', () => {
    const streaming = [chat('a', { isLoading: true }), chat('b', { isLoading: true })];
    expect(getFolderActiveState(streaming, tasks({ a: 'done', b: 'cancelled' }))).toMatchObject({
      label: 'Running',
      count: 2,
    });
  });

  it('treats a held question on an unloaded chat as needs-you', () => {
    const state = getFolderActiveState(
      [],
      tasks({ old: 'running' }),
      undefined,
      [active('old')],
      new Set(['old']),
    );
    expect(state).toMatchObject({ label: 'Needs attention', count: 1 });
  });

  it('counts an unloaded batch run once, through its batch summary', () => {
    const batches = new Map([['batch-1', { running_count: 2, failed_count: 0 }]]);
    const state = getFolderActiveState(
      [chat('a', { batchId: 'batch-1', isLoading: true })],
      tasks({ old: 'running' }),
      batches,
      [active('old', { batchId: 'batch-1' })],
    );
    expect(state).toMatchObject({ label: 'Running', count: 2 });
  });

  it('does not surface queued or cancelled tasks', () => {
    expect(
      getFolderActiveState([chat('a'), chat('b')], tasks({ a: 'pending', b: 'cancelled' })),
    ).toBeNull();
  });

  it('ranks failed above everything', () => {
    const state = getFolderActiveState(
      [chat('a'), chat('b', { hasPendingQuestion: true })],
      tasks({ a: 'failed' }),
    );
    expect(state).toMatchObject({ label: 'Failed', count: 1 });
  });

  it('falls through to the quiet review level for unseen changes', () => {
    expect(getFolderActiveState([chat('a', { hasUnseenChanges: true })])).toMatchObject({
      label: 'Ready for review',
      count: 1,
    });
  });

  it('counts a batch from its summary when most of its runs are not in the local list', () => {
    const batches = new Map([['batch-1', { running_count: 3, failed_count: 0 }]]);
    const state = getFolderActiveState(
      [chat('a', { batchId: 'batch-1' }), chat('b', { isLoading: true })],
      undefined,
      batches,
    );
    expect(state).toMatchObject({ label: 'Running', count: 4 });
  });

  it('rolls failed batch runs up from the summary, as the batch header shows them', () => {
    const batches = new Map([['batch-1', { running_count: 1, failed_count: 2 }]]);
    const state = getFolderActiveState(
      [chat('a', { batchId: 'batch-1' }), chat('b', { isLoading: true })],
      tasks({ a: 'failed' }),
      batches,
    );
    expect(state).toMatchObject({ label: 'Failed', count: 2 });
  });

  it('keeps a locally running batch chat visible before its summary catches up', () => {
    const batches = new Map([['batch-1', { running_count: 0, failed_count: 0 }]]);
    const state = getFolderActiveState(
      [chat('a', { batchId: 'batch-1', isLoading: true })],
      undefined,
      batches,
    );
    expect(state).toMatchObject({ label: 'Running', count: 1 });
  });
});

describe('groupActiveChatsByFolder', () => {
  it('groups active chats by local project, with null as the general bucket', () => {
    const grouped = groupActiveChatsByFolder([
      active('c1', { projectId: 'p1' }),
      active('c2'),
      active('flow-1', { projectId: 'p1', hasLiveFlowRun: true }),
    ]);
    expect(grouped.get('p1')?.map((chat) => chat.chatId)).toEqual(['c1', 'flow-1']);
    expect(grouped.get(null)?.map((chat) => chat.chatId)).toEqual(['c2']);
  });

  it('fills only chats with a live flow run as running in the row status map', () => {
    const [statuses] = buildSidebarActivityMaps(
      [],
      [active('flow-1', { hasLiveFlowRun: true }), active('task-chat')],
    );
    expect(statuses.get('flow-1')).toBe('running');
    expect(statuses.has('task-chat')).toBe(false);
  });
});

describe('getFolderActiveChats', () => {
  const folder = (projectIds: string[]): CodebaseGroup => ({
    gitRemote: null,
    displayName: 'repo',
    gitOwner: null,
    gitRepo: null,
    projects: projectIds.map((id) => ({
      id,
      name: 'repo',
      path: '/repo',
      gitRemote: null,
      gitOwner: null,
      gitRepo: null,
    })),
    chats: [],
  });
  const byFolder = new Map([
    ['local-a', [active('a1', { projectId: 'local-a' })]],
    [null, [active('g1')]],
  ]);

  it('reads a project folder by the ids of its projects, never the general bucket', () => {
    const chats = getFolderActiveChats(byFolder, folder(['local-a', 'local-b']));
    expect(chats.map((chat) => chat.chatId)).toEqual(['a1']);
  });

  it('reads the general folder from the null bucket', () => {
    expect(getFolderActiveChats(byFolder, folder([])).map((chat) => chat.chatId)).toEqual(['g1']);
  });
});
