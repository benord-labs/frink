// @vitest-environment happy-dom
/** Row-render isolation through the REAL DndContext (sc-2721): CodebaseItem.test mocks dnd-kit, so it
 * cannot see sensor churn rebuilding the context every useDraggable row reads past memo. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps, ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIdSelectionStore } from '../../../../../lib/tree-navigation';
import type { SidebarTaskStatus } from '../../constants';
import type { ChatItem, CodebaseGroup } from '../../types';
import type { ChatReason } from '../../utils';
import { ChatSelectionContext } from '../ChatSelection';
import { ProjectsTree } from '.';

/** Render tallies. Tooltip/menu doubles are plain components, so they run exactly when a row does. */
const tally = vi.hoisted(() => ({ rows: new Map<string, number>(), rowMenus: 0 }));

// oxlint-disable anti-slop/no-module-mocking -- Radix menu/tooltip and the task hook need app
// providers irrelevant to render isolation; the doubles double as render counters.
vi.mock('../../../../../components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  // The chat-name tooltip is the only one whose content is the bare display name.
  TooltipContent: ({ children }: { children: ReactNode }) => {
    if (typeof children === 'string') tally.rows.set(children, (tally.rows.get(children) ?? 0) + 1);
    return null;
  },
}));
vi.mock('../../../../../components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactElement<{ 'aria-label'?: string }> }) => {
    if (children.props['aria-label'] === 'Chat actions') tally.rowMenus += 1;
    return children;
  },
  DropdownMenuContent: () => null,
  DropdownMenuItem: () => null,
  DropdownMenuSeparator: () => null,
}));
vi.mock('@/hooks/use-mark-task-complete', () => ({ useMarkTaskComplete: () => vi.fn() }));
vi.mock('../../../../../lib/trpc', () => ({
  trpc: {
    useUtils: () => ({}),
    projects: { openFolder: { useMutation: () => ({ mutate: vi.fn() }) } },
  },
}));

const REMOTE = 'git@github.com:acme/repo.git';

function makeChat(id: string, name: string, overrides: Partial<ChatItem> = {}): ChatItem {
  return {
    id,
    name,
    branch: null,
    updatedAt: new Date('2026-09-01T10:00:00Z'),
    pinnedAt: null,
    projectId: 'local-a',
    hasUnseenChanges: false,
    isLoading: false,
    hasPendingPlan: false,
    hasPendingQuestion: false,
    isHeld: false,
    isWorktree: false,
    taskId: null,
    batchId: null,
    ...overrides,
  };
}

/** A poll mints fresh objects for everything, even when nothing changed. */
function makeCodebase(chats: ChatItem[]): CodebaseGroup {
  return {
    gitRemote: REMOTE,
    displayName: 'repo',
    gitOwner: 'acme',
    gitRepo: 'repo',
    projects: [
      {
        id: 'local-a',
        name: 'repo',
        path: '/repo',
        gitRemote: REMOTE,
        gitOwner: 'acme',
        gitRepo: 'repo',
      },
    ],
    chats: chats.map((chat) => ({ ...chat })),
  };
}

// Stable across renders, as UnifiedSidebar's useCallback/useMemo'd handlers are.
const chatActions = {
  onChatSelect: vi.fn(),
  onChatRename: vi.fn(),
  onChatArchive: vi.fn(),
  onChatFork: vi.fn(),
  onChatDelete: vi.fn(),
  onChatPin: vi.fn(),
  onChatOpenInNewPane: vi.fn(),
  canOpenInNewPane: true,
};
const dndHandlers = {
  handleDragStart: vi.fn(),
  handleDragOver: vi.fn(),
  handleDragEnd: vi.fn(),
  handleDragCancel: vi.fn(),
};
const isCodebaseExpanded = () => true;
const toggleCodebase = vi.fn();
const onLoadMoreChats = vi.fn(async () => {});

type TreeProps = ComponentProps<typeof ProjectsTree>;

/** Every derived collection is rebuilt per call, exactly as UnifiedSidebar's useMemos do per poll. */
function pollProps(
  chats: ChatItem[],
  statuses: [string, SidebarTaskStatus][] = [],
  reasons: [string, ChatReason][] = [],
): TreeProps {
  return {
    filteredCodebases: [makeCodebase(chats)],
    searchQuery: '',
    isSearchActive: false,
    isCodebaseExpanded,
    toggleCodebase,
    selectedChatId: null,
    chatActions,
    activeDropTargetId: null,
    activeChat: null,
    dndHandlers,
    folderChatCountByKey: { [REMOTE]: chats.length },
    folderHasMoreByKey: { [REMOTE]: false },
    folderLoadingByKey: { [REMOTE]: false },
    onLoadMoreChats,
    chatPaneMap: new Map(),
    chatTaskStatusByChatId: new Map(statuses),
    chatReasonByChatId: new Map(reasons),
    activeChatsByFolder: new Map(),
    pendingQuestionIds: new Set(),
  };
}

const store = createIdSelectionStore();
function renderTree(props: TreeProps) {
  const ui = (p: TreeProps) => (
    <ChatSelectionContext.Provider value={store}>
      <div role="tree">
        <ProjectsTree {...p} />
      </div>
    </ChatSelectionContext.Provider>
  );
  const result = render(ui(props));
  return { ...result, rerenderTree: (next: TreeProps) => result.rerender(ui(next)) };
}

const A = makeChat('chat-a', 'Chat A');
const B = makeChat('chat-b', 'Chat B', { updatedAt: new Date('2026-09-01T09:00:00Z') });

beforeEach(() => {
  tally.rows.clear();
  tally.rowMenus = 0;
});
afterEach(cleanup);

describe('ProjectsTree row-render isolation (real DndContext)', () => {
  it('renders both rows once on mount', () => {
    renderTree(pollProps([A, B]));
    expect(tally.rows.get('Chat A')).toBe(1);
    expect(tally.rows.get('Chat B')).toBe(1);
  });

  it('re-renders no row when a poll re-derives every collection with unchanged contents', () => {
    const { rerenderTree } = renderTree(pollProps([A, B]));
    const menusBefore = tally.rowMenus;

    for (let tick = 0; tick < 5; tick++) rerenderTree(pollProps([A, B]));

    expect(tally.rows.get('Chat A')).toBe(1);
    expect(tally.rows.get('Chat B')).toBe(1);
    expect(tally.rowMenus).toBe(menusBefore);
  });

  it('re-renders only the streaming row, and not its actions menu, on a stream tick', () => {
    const { rerenderTree } = renderTree(pollProps([A, B]));
    const menusBefore = tally.rowMenus;

    const streamingA = { ...A, isLoading: true, updatedAt: new Date('2026-09-01T10:00:05Z') };
    rerenderTree(pollProps([streamingA, B]));

    expect(tally.rows.get('Chat A')).toBe(2);
    expect(tally.rows.get('Chat B')).toBe(1);
    expect(tally.rowMenus).toBe(menusBefore);
  });

  it('re-renders both rows exactly once when two chats stream in the same tick', () => {
    const { rerenderTree } = renderTree(pollProps([A, B]));

    rerenderTree(
      pollProps([
        { ...A, isLoading: true },
        { ...B, isLoading: true },
      ]),
    );

    expect(tally.rows.get('Chat A')).toBe(2);
    expect(tally.rows.get('Chat B')).toBe(2);
  });

  it('routes a task-status change to its row only, and re-renders that row menu (Mark complete)', () => {
    const taskA = { ...A, taskId: 'task-a' };
    const { rerenderTree } = renderTree(pollProps([taskA, B], [['chat-a', 'running']]));
    const menusBefore = tally.rowMenus;

    rerenderTree(pollProps([taskA, B], [['chat-a', 'done']]));

    expect(tally.rows.get('Chat A')).toBe(2);
    expect(tally.rows.get('Chat B')).toBe(1);
    expect(tally.rowMenus).toBe(menusBefore + 1);
  });

  it('ignores a re-minted reason with the same text, but forwards changed text', () => {
    const reason = (summary: string): [string, ChatReason][] => [['chat-a', { summary }]];
    const { rerenderTree } = renderTree(
      pollProps([A, B], [['chat-a', 'needs_attention']], reason('x')),
    );

    rerenderTree(pollProps([A, B], [['chat-a', 'needs_attention']], reason('x')));
    expect(tally.rows.get('Chat A')).toBe(1);

    rerenderTree(pollProps([A, B], [['chat-a', 'needs_attention']], reason('y')));
    expect(tally.rows.get('Chat A')).toBe(2);
    expect(tally.rows.get('Chat B')).toBe(1);
  });

  it('still starts a keyboard drag through the shared sensors after polls', () => {
    const { rerenderTree } = renderTree(pollProps([A, B]));
    rerenderTree(pollProps([A, B]));

    const grip = screen.getAllByRole('button', { name: 'Drag to reorder' })[0];
    grip.focus();
    fireEvent.keyDown(grip, { code: 'Space', key: ' ' });

    expect(dndHandlers.handleDragStart).toHaveBeenCalledTimes(1);
    expect(dndHandlers.handleDragStart.mock.calls[0][0].active.id).toBe('chat-a');
  });
});
