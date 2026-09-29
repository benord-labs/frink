import { describe, expect, it } from 'vitest';
import type { ChatItem, CodebaseGroup, SidebarProject, UnifiedSidebarProps } from '../types';
import {
  areCodebaseGroupsSidebarEqual,
  chatMapsEqualForCodebase,
  folderActivityEqual,
  selectionTouchesCodebase,
  unifiedSidebarPropsAreEqual,
} from './chat-equality';

const noop = () => {};

function makeProps(overrides: Partial<UnifiedSidebarProps> = {}): UnifiedSidebarProps {
  return {
    onToggleSidebar: noop,
    isMobileFullscreen: false,
    onChatSelect: noop,
    ...overrides,
  };
}

describe('unifiedSidebarPropsAreEqual', () => {
  it('treats identical props as equal', () => {
    expect(unifiedSidebarPropsAreEqual(makeProps(), makeProps())).toBe(true);
  });

  // Each scalar/callback prop must veto on its own: a comparator that skips one silently pins the
  // sidebar to a stale value for that prop only, which is far harder to spot than no memo at all.
  it.each([
    ['onToggleSidebar', { onToggleSidebar: () => {} }],
    ['isMobileFullscreen', { isMobileFullscreen: true }],
    ['onChatSelect', { onChatSelect: () => {} }],
  ])('reports unequal when %s changes', (_label, override) => {
    expect(
      unifiedSidebarPropsAreEqual(makeProps(), makeProps(override as Partial<UnifiedSidebarProps>)),
    ).toBe(false);
  });
});

function makeChat(overrides: Partial<ChatItem> = {}): ChatItem {
  return {
    id: 'chat-1',
    name: 'Chat',
    branch: null,
    updatedAt: new Date('2026-04-08'),
    projectId: 'proj-1',
    hasUnseenChanges: false,
    isLoading: false,
    hasPendingPlan: false,
    hasPendingQuestion: false,
    isHeld: false,
    isWorktree: false,
    taskId: null,
    batchId: null,
    pinnedAt: null,
    ...overrides,
  };
}

function makeProject(overrides: Partial<SidebarProject> = {}): SidebarProject {
  return {
    id: 'p1',
    name: 'repo',
    path: '/tmp/repo',
    gitRemote: null,
    gitOwner: null,
    gitRepo: null,
    ...overrides,
  };
}

function makeCodebase(overrides: Partial<CodebaseGroup> = {}): CodebaseGroup {
  return {
    gitRemote: 'git@github.com:acme/repo.git',
    displayName: 'repo',
    gitOwner: 'acme',
    gitRepo: 'repo',
    projects: [],
    chats: [makeChat()],
    ...overrides,
  };
}

/**
 * This comparator decides whether a whole codebase subtree re-renders, so a field it fails to
 * compare is a row that silently stops updating. The live per-chat flags are the ones that move
 * most often, hence the explicit cases below.
 */
describe('areCodebaseGroupsSidebarEqual', () => {
  it('treats two structurally identical trees built from separate objects as equal', () => {
    expect(areCodebaseGroupsSidebarEqual(makeCodebase(), makeCodebase())).toBe(true);
  });

  it('short-circuits on reference identity', () => {
    const one = makeCodebase();
    expect(areCodebaseGroupsSidebarEqual(one, one)).toBe(true);
  });

  it.each([
    ['gitRemote', { gitRemote: 'git@github.com:acme/other.git' }],
    ['displayName', { displayName: 'other' }],
    ['gitOwner', { gitOwner: 'other' }],
    ['gitRepo', { gitRepo: 'other' }],
  ])('reports unequal when %s differs', (_field, override) => {
    expect(areCodebaseGroupsSidebarEqual(makeCodebase(), makeCodebase(override))).toBe(false);
  });

  it('reports unequal when the project or chat list length changes', () => {
    const withProject = makeCodebase({ projects: [makeProject()] });
    expect(areCodebaseGroupsSidebarEqual(makeCodebase(), withProject)).toBe(false);
    expect(areCodebaseGroupsSidebarEqual(makeCodebase(), makeCodebase({ chats: [] }))).toBe(false);
  });

  it.each([
    ['hasPendingQuestion', { hasPendingQuestion: true }],
    ['isLoading', { isLoading: true }],
    ['hasPendingPlan', { hasPendingPlan: true }],
    ['hasUnseenChanges', { hasUnseenChanges: true }],
    ['isHeld', { isHeld: true }],
    ['taskId', { taskId: 'task-1' }],
    ['batchId', { batchId: 'batch-1' }],
    ['name', { name: 'Renamed' }],
  ])("reports unequal when a chat's %s flips", (_field, override) => {
    const next = makeCodebase({ chats: [makeChat(override)] });
    expect(areCodebaseGroupsSidebarEqual(makeCodebase(), next)).toBe(false);
  });

  it('compares chat timestamps by value, not by Date identity', () => {
    const sameInstant = makeCodebase({
      chats: [makeChat({ updatedAt: new Date('2026-04-08') })],
    });
    expect(areCodebaseGroupsSidebarEqual(makeCodebase(), sameInstant)).toBe(true);

    const later = makeCodebase({
      chats: [makeChat({ updatedAt: new Date('2026-04-09') })],
    });
    expect(areCodebaseGroupsSidebarEqual(makeCodebase(), later)).toBe(false);
  });

  it('treats an absent timestamp as equal to another absent one', () => {
    const a = makeCodebase({ chats: [makeChat({ pinnedAt: null })] });
    const b = makeCodebase({ chats: [makeChat({ pinnedAt: null })] });
    expect(areCodebaseGroupsSidebarEqual(a, b)).toBe(true);
  });

  it('reports unequal when a project field differs', () => {
    const withProject = (name: string) => makeCodebase({ projects: [makeProject({ name })] });
    expect(areCodebaseGroupsSidebarEqual(withProject('a'), withProject('b'))).toBe(false);
    expect(areCodebaseGroupsSidebarEqual(withProject('a'), withProject('a'))).toBe(true);
  });
});

describe('chatMapsEqualForCodebase', () => {
  const local = (ids: string[]) => makeCodebase({ chats: ids.map((id) => makeChat({ id })) });
  const batched = (ids: string[], batchId = 'batch-1') =>
    makeCodebase({
      chats: ids.map((id) => makeChat({ id, batchId })),
    });

  it('ignores entries for chats this codebase does not own', () => {
    expect(chatMapsEqualForCodebase(new Map(), new Map([['elsewhere', 1]]), local(['a']))).toBe(
      true,
    );
  });

  it('reports a change to a chat it does own', () => {
    expect(chatMapsEqualForCodebase(new Map(), new Map([['a', 1]]), local(['a']))).toBe(false);
  });

  /**
   * Widening to the whole map is deliberate: a codebase with a batch re-renders on any chat's
   * change. Narrowing it back silently re-breaks batch rows (stale selection, frozen pill).
   */
  it('widens to a whole-map compare once the codebase has a batch group', () => {
    expect(chatMapsEqualForCodebase(new Map(), new Map([['elsewhere', 1]]), batched(['a']))).toBe(
      false,
    );
  });

  // Same size, different keys: a size-only check would call these equal and freeze both rows.
  it('detects a same-size map whose keys differ', () => {
    expect(chatMapsEqualForCodebase(new Map([['a', 1]]), new Map([['b', 1]]), batched(['a']))).toBe(
      false,
    );
  });

  it('treats two absent maps as equal and an absent-vs-populated pair as different', () => {
    expect(chatMapsEqualForCodebase(undefined, undefined, batched(['a']))).toBe(true);
    expect(chatMapsEqualForCodebase(undefined, new Map([['a', 1]]), batched(['a']))).toBe(false);
    expect(chatMapsEqualForCodebase(new Map(), undefined, batched(['a']))).toBe(true);
  });

  it('uses the supplied comparator instead of identity', () => {
    const byField = (x: { v: number } | undefined, y: { v: number } | undefined) => x?.v === y?.v;
    const prev = new Map([['a', { v: 1 }]]);
    expect(chatMapsEqualForCodebase(prev, new Map([['a', { v: 1 }]]), local(['a']), byField)).toBe(
      true,
    );
    expect(chatMapsEqualForCodebase(prev, new Map([['a', { v: 2 }]]), local(['a']), byField)).toBe(
      false,
    );
  });
});

describe('selectionTouchesCodebase', () => {
  const local = (ids: string[]) => makeCodebase({ chats: ids.map((id) => makeChat({ id })) });

  it('is false when the selection did not move', () => {
    expect(selectionTouchesCodebase(local(['a']), 'a', 'a')).toBe(false);
  });

  it('is false when neither end of the move is one of its chats', () => {
    expect(selectionTouchesCodebase(local(['a']), 'x', 'y')).toBe(false);
  });

  it('is true when either end of the move is one of its chats', () => {
    expect(selectionTouchesCodebase(local(['a']), 'a', 'y')).toBe(true);
    expect(selectionTouchesCodebase(local(['a']), 'x', 'a')).toBe(true);
  });

  // Selecting a server-fetched batch row must repaint the old and new rows; the scan cannot see it.
  it('is true for any move once the codebase has a batch group', () => {
    const withBatch = makeCodebase({
      chats: [makeChat({ id: 'a', batchId: 'batch-1' })],
    });
    expect(selectionTouchesCodebase(withBatch, 'x', 'y')).toBe(true);
  });
});

describe('folderActivityEqual', () => {
  const codebase = makeCodebase({
    projects: [makeProject({ id: 'local-a' })],
  });
  const active = (chatId: string, batchId: string | null = null) => ({
    chatId,
    projectId: 'local-a',
    batchId,
    hasLiveFlowRun: false,
  });
  const byFolder = (entries: Array<[string | null, ReturnType<typeof active>[]]>) =>
    new Map(entries);

  it('ignores active chats and status changes that belong to another folder', () => {
    const prev = { activeChatsByFolder: byFolder([['local-a', [active('a1')]]]) };
    const next = {
      activeChatsByFolder: byFolder([
        ['local-a', [active('a1')]],
        ['local-b', [active('b1')]],
      ]),
      chatTaskStatusByChatId: new Map([['b1', 'failed' as const]]),
    };
    expect(folderActivityEqual(prev, next, codebase)).toBe(true);
  });

  it('re-renders when an unloaded chat of this folder changes status', () => {
    const prev = {
      activeChatsByFolder: byFolder([['local-a', [active('a1')]]]),
      chatTaskStatusByChatId: new Map([['a1', 'running' as const]]),
    };
    const next = {
      activeChatsByFolder: byFolder([['local-a', [active('a1')]]]),
      chatTaskStatusByChatId: new Map([['a1', 'needs_attention' as const]]),
    };
    expect(folderActivityEqual(prev, next, codebase)).toBe(false);
  });

  it('re-renders when this folder gains an active chat', () => {
    const prev = { activeChatsByFolder: byFolder([['local-a', [active('a1')]]]) };
    const next = { activeChatsByFolder: byFolder([['local-a', [active('a1'), active('a2')]]]) };
    expect(folderActivityEqual(prev, next, codebase)).toBe(false);
  });

  it('re-renders when the summary of a batch one of its unloaded chats belongs to changes', () => {
    const activeChatsByFolder = byFolder([['local-a', [active('a1', 'batch-1')]]]);
    const prev = { activeChatsByFolder, batchGroups: new Map([['batch-1', { running_count: 1 }]]) };
    const next = { activeChatsByFolder, batchGroups: new Map([['batch-1', { running_count: 2 }]]) };
    expect(folderActivityEqual(prev, next, codebase)).toBe(false);
  });
});
