// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SidebarBatchGroup } from '../../../../../shared/types/flows/sidebar-batch-group';
import type { ChatItem, CodebaseGroup } from '../types';
import { CodebaseItem } from './CodebaseItem';

/** Captures useDraggable args so tests can assert per-chat `disabled` (task-owned lock). */
const dndMock = vi.hoisted(() => ({ calls: [] as Array<{ id: string; disabled?: boolean }> }));
/** Render tallies. These mocks run only when the memo above them lets a render through, so the
 *  counts below are the row/batch render counts the sidebar's re-render storm is measured in. */
const renderTally = vi.hoisted(() => ({ rows: new Map<string, number>(), batches: 0 }));

vi.mock('@dnd-kit/core', () => ({
  useDraggable: (opts: { id: string; disabled?: boolean }) => {
    dndMock.calls.push({ id: opts.id, disabled: opts.disabled });
    return {
      attributes: {},
      listeners: {},
      setNodeRef: vi.fn(),
      transform: null,
      isDragging: false,
    };
  },
  useDroppable: () => ({
    setNodeRef: vi.fn(),
    isOver: false,
  }),
}));

vi.mock('@dnd-kit/utilities', () => ({
  CSS: {
    Translate: {
      toString: () => '',
    },
  },
}));

vi.mock('../../../../components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock('../../../../components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../../../lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      projects: {
        list: { invalidate: vi.fn() },
      },
      chats: {
        get: { invalidate: vi.fn() },
      },
    }),
    projects: {
      openFolder: {
        useMutation: () => ({ mutate: vi.fn() }),
      },
    },
  },
}));

vi.mock('./ChatListItem', () => ({
  ChatListItem: ({ chat }: { chat: { id: string; name: string | null } }) => {
    renderTally.rows.set(chat.id, (renderTally.rows.get(chat.id) ?? 0) + 1);
    return <div>{chat.name ?? 'Untitled chat'}</div>;
  },
}));

vi.mock('./TreeItem', () => ({
  TreeItem: ({
    label,
    rightContent,
    trailingAction,
    children,
    isExpanded,
  }: {
    label: React.ReactNode;
    rightContent?: React.ReactNode;
    trailingAction?: React.ReactNode;
    children?: React.ReactNode;
    isExpanded: boolean;
  }) => (
    <div>
      <div>{label}</div>
      {rightContent}
      {trailingAction}
      {isExpanded ? <div>{children}</div> : null}
    </div>
  ),
}));

/** Minimal mock — real BatchGroup pulls tRPC; we only assert grouping decisions in CodebaseItem. */
vi.mock('./BatchGroup', () => ({
  BatchGroup: ({
    summary,
    localChats,
    pendingQuestionIds,
  }: {
    summary: SidebarBatchGroup;
    localChats: { id: string; name: string | null }[];
    pendingQuestionIds?: Set<string>;
  }) => {
    renderTally.batches += 1;
    return (
      <div
        data-testid="batch-group"
        data-batch-id={summary.batch_id}
        data-pending-questions={[...(pendingQuestionIds ?? [])].sort().join(',')}
      >
        {localChats.map((c) => (
          <div key={c.id}>{c.name}</div>
        ))}
      </div>
    );
  },
}));

const BATCH_IN_MAP = 'a1b2c3d4-e5f6-4781-a012-345678901234';
const BATCH_NOT_IN_MAP = 'b2b3c4d5-e6f7-4892-b234-567890123456';

function makeBatchSummary(batchId: string, flowName = 'Flow'): SidebarBatchGroup {
  return {
    batch_id: batchId,
    flow_name: flowName,
    run_count: 2,
    completed_count: 1,
    failed_count: 0,
    running_count: 0,
    first_run_at: null,
    last_activity_at: '2026-04-08T12:00:00.000Z',
  };
}

function makeChat(overrides: Partial<ChatItem> & { id: string }): ChatItem {
  return {
    name: 'Chat',
    branch: null,
    updatedAt: new Date('2026-04-08'),
    projectId: 'local-a',
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

function buildCodebase(overrides: Partial<CodebaseGroup> = {}): CodebaseGroup {
  return {
    gitRemote: 'git@github.com:acme/repo.git',
    displayName: 'repo',
    gitOwner: 'acme',
    gitRepo: 'repo',
    projects: [
      {
        id: 'local-a',
        name: 'repo',
        path: '/repo',
        gitRemote: 'git@github.com:acme/repo.git',
        gitOwner: 'acme',
        gitRepo: 'repo',
      },
      {
        id: 'local-b',
        name: 'repo',
        path: '/repo-b',
        gitRemote: 'git@github.com:acme/repo.git',
        gitOwner: 'acme',
        gitRepo: 'repo',
      },
    ],
    chats: [
      {
        id: 'chat-a',
        name: 'Chat A',
        branch: null,
        updatedAt: new Date('2026-01-01'),
        projectId: 'local-a',
        hasUnseenChanges: false,
        isLoading: false,
        hasPendingPlan: false,
        hasPendingQuestion: false,
        isHeld: false,
        isWorktree: false,
        taskId: null,
        batchId: null,
        pinnedAt: null,
      },
      {
        id: 'chat-b',
        name: 'Chat B',
        branch: null,
        updatedAt: new Date('2026-01-02'),
        projectId: 'local-b',
        hasUnseenChanges: false,
        isLoading: false,
        hasPendingPlan: false,
        hasPendingQuestion: false,
        isHeld: false,
        isWorktree: false,
        taskId: null,
        batchId: null,
        pinnedAt: null,
      },
    ],
    ...overrides,
  };
}

/** Single-project codebase so batch grouping tests stay deterministic. */
function buildSingleProjectCodebase(
  chats: ChatItem[],
  overrides: Partial<CodebaseGroup> = {},
): CodebaseGroup {
  const base = buildCodebase();
  return { ...base, projects: base.projects.slice(0, 1), chats, ...overrides };
}

afterEach(cleanup);

describe('CodebaseItem', () => {
  describe('collapsed folder activity dot', () => {
    const renderFolder = (isExpanded: boolean, taskStatus?: Map<string, 'running'>) =>
      render(
        <CodebaseItem
          codebaseKey="git@github.com:acme/repo.git"
          codebase={buildCodebase({
            chats: [makeChat({ id: 'chat-a', isLoading: true }), makeChat({ id: 'chat-b' })],
          })}
          isExpanded={isExpanded}
          toggleCodebase={vi.fn()}
          selectedChatId={null}
          onChatSelect={vi.fn()}
          totalChatsCount={2}
          chatTaskStatusByChatId={taskStatus}
        />,
      );

    it('rolls a running chat up to the collapsed row with a labelled pulsing dot', () => {
      renderFolder(false);
      const dot = screen.getByRole('img', { name: 'Running: 1' });
      expect(dot.className).toContain('animate-pulse');
    });

    it('hides the rollup once the folder is expanded, where rows carry the state', () => {
      renderFolder(true);
      expect(screen.queryByRole('img', { name: /Running/ })).toBeNull();
    });

    it('surfaces a needs-attention task chat that is not in the loaded page', () => {
      render(
        <CodebaseItem
          codebaseKey="git@github.com:acme/repo.git"
          codebase={buildCodebase()}
          isExpanded={false}
          toggleCodebase={vi.fn()}
          selectedChatId={null}
          onChatSelect={vi.fn()}
          totalChatsCount={40}
          chatTaskStatusByChatId={new Map([['old-chat', 'needs_attention']])}
          activeChatsByFolder={
            new Map([
              [
                'local-a',
                [
                  {
                    chatId: 'old-chat',
                    projectId: 'local-a',
                    batchId: null,
                    hasLiveFlowRun: false,
                  },
                ],
              ],
            ])
          }
        />,
      );
      expect(screen.getByRole('img', { name: 'Needs attention: 1' })).toBeTruthy();
    });

    it('shows no dot for an idle folder', () => {
      render(
        <CodebaseItem
          codebaseKey="git@github.com:acme/repo.git"
          codebase={buildCodebase()}
          isExpanded={false}
          toggleCodebase={vi.fn()}
          selectedChatId={null}
          onChatSelect={vi.fn()}
          totalChatsCount={2}
        />,
      );
      expect(screen.queryByRole('img')).toBeNull();
    });
  });

  it('passes folder key to delete-all handler for multi-project folders', () => {
    const onDeleteAllChatsInFolder = vi.fn();
    render(
      <CodebaseItem
        codebaseKey="git@github.com:acme/repo.git"
        codebase={buildCodebase()}
        isExpanded
        toggleCodebase={vi.fn()}
        selectedChatId={null}
        onChatSelect={vi.fn()}
        totalChatsCount={2}
        onDeleteAllChatsInFolder={onDeleteAllChatsInFolder}
      />,
    );

    fireEvent.click(screen.getByText('Delete all chats in this folder'));
    expect(onDeleteAllChatsInFolder).toHaveBeenCalledWith('git@github.com:acme/repo.git');
  });

  it('shows Rename only for build projects and renames via the display name', () => {
    const onRenameProject = vi.fn();
    const base = buildSingleProjectCodebase([makeChat({ id: 'c1' })]);
    const buildCb: CodebaseGroup = {
      ...base,
      displayName: 'My Build',
      projects: [
        { ...base.projects[0], path: '/Users/x/.frink/builds/my-build', name: 'My Build' },
      ],
    };

    render(
      <CodebaseItem
        codebaseKey="build"
        codebase={buildCb}
        isExpanded
        toggleCodebase={vi.fn()}
        selectedChatId={null}
        onChatSelect={vi.fn()}
        totalChatsCount={1}
        onProjectDelete={vi.fn()}
        onRenameProject={onRenameProject}
      />,
    );

    fireEvent.click(screen.getByText('Rename'));
    expect(onRenameProject).toHaveBeenCalledWith('local-a', 'My Build');
  });

  it('hides Rename for a real (non-build) project', () => {
    render(
      <CodebaseItem
        codebaseKey="git@github.com:acme/repo.git"
        codebase={buildCodebase()} // project path '/repo' → not a build
        isExpanded
        toggleCodebase={vi.fn()}
        selectedChatId={null}
        onChatSelect={vi.fn()}
        totalChatsCount={2}
        onProjectDelete={vi.fn()}
        onRenameProject={vi.fn()}
      />,
    );

    expect(screen.queryByText('Rename')).toBeNull();
    // Delete Project remains available for a real project.
    expect(screen.getByText('Delete Project')).toBeTruthy();
  });

  it('passes General Chats folder key for general chats delete-all', () => {
    const onDeleteAllChatsInFolder = vi.fn();
    render(
      <CodebaseItem
        codebaseKey="General Chats"
        codebase={buildCodebase({
          gitRemote: null,
          displayName: 'General Chats',
          gitOwner: null,
          gitRepo: null,
          projects: [],
          chats: [
            {
              id: 'general-chat',
              name: 'General Chat',
              branch: null,
              updatedAt: new Date('2026-01-01'),
              projectId: null,
              hasUnseenChanges: false,
              isLoading: false,
              hasPendingPlan: false,
              hasPendingQuestion: false,
              isHeld: false,
              isWorktree: false,
              taskId: null,
              batchId: null,
              pinnedAt: null,
            },
          ],
        })}
        isExpanded
        toggleCodebase={vi.fn()}
        selectedChatId={null}
        onChatSelect={vi.fn()}
        totalChatsCount={1}
        onDeleteAllChatsInFolder={onDeleteAllChatsInFolder}
      />,
    );

    fireEvent.click(screen.getByText('Delete all chats in this folder'));
    expect(onDeleteAllChatsInFolder).toHaveBeenCalledWith('General Chats');
  });

  describe('batch grouping', () => {
    it('renders a chat whose batchId is missing from batchGroups as a flat row, not inside BatchGroup', () => {
      const chats = [
        makeChat({
          id: 'orphan-batch',
          name: 'Not in summary map',
          batchId: BATCH_NOT_IN_MAP,
          updatedAt: new Date('2026-04-10'),
        }),
        makeChat({
          id: 'in-batch',
          name: 'In batch',
          batchId: BATCH_IN_MAP,
          updatedAt: new Date('2026-04-09'),
        }),
      ];
      const batchGroups = new Map<string, SidebarBatchGroup>([
        [BATCH_IN_MAP, makeBatchSummary(BATCH_IN_MAP)],
      ]);

      render(
        <CodebaseItem
          codebaseKey="git@github.com:acme/repo.git"
          codebase={buildSingleProjectCodebase(chats)}
          isExpanded
          toggleCodebase={vi.fn()}
          selectedChatId={null}
          onChatSelect={vi.fn()}
          totalChatsCount={2}
          batchGroups={batchGroups}
        />,
      );

      expect(screen.getByText('Not in summary map')).toBeDefined();
      expect(screen.getByTestId('batch-group')).toBeDefined();
      expect(screen.getByTestId('batch-group').getAttribute('data-batch-id')).toBe(BATCH_IN_MAP);
      expect(screen.getByText('In batch')).toBeDefined();
    });

    // A held question is a LIVE signal that never touches the chat rows a batch group fetches from
    // the server, so it reaches those rows only as a prop — and only if the memo lets it through.
    it('forwards pendingQuestionIds to BatchGroup and re-forwards a newly raised question', () => {
      const chats = [makeChat({ id: 'in-batch', name: 'In batch', batchId: BATCH_IN_MAP })];
      const batchGroups = new Map<string, SidebarBatchGroup>([
        [BATCH_IN_MAP, makeBatchSummary(BATCH_IN_MAP)],
      ]);
      const props = {
        codebaseKey: 'git@github.com:acme/repo.git',
        codebase: buildSingleProjectCodebase(chats),
        isExpanded: true,
        toggleCodebase: vi.fn(),
        selectedChatId: null,
        onChatSelect: vi.fn(),
        totalChatsCount: 1,
        batchGroups,
      };

      const { rerender } = render(<CodebaseItem {...props} pendingQuestionIds={new Set()} />);
      expect(screen.getByTestId('batch-group').getAttribute('data-pending-questions')).toBe('');

      // Same props by value except a fresh set: the memo must NOT swallow this, or a question
      // raised while the group is open would never light the row.
      rerender(<CodebaseItem {...props} pendingQuestionIds={new Set(['in-batch'])} />);
      expect(screen.getByTestId('batch-group').getAttribute('data-pending-questions')).toBe(
        'in-batch',
      );
    });

    it('renders batched chats flat when search is active (no BatchGroup)', () => {
      const chats = [
        makeChat({
          id: 'a',
          name: 'Alpha search',
          batchId: BATCH_IN_MAP,
          updatedAt: new Date('2026-04-08'),
        }),
        makeChat({
          id: 'b',
          name: 'Beta search',
          batchId: BATCH_IN_MAP,
          updatedAt: new Date('2026-04-07'),
        }),
      ];
      const batchGroups = new Map<string, SidebarBatchGroup>([
        [BATCH_IN_MAP, makeBatchSummary(BATCH_IN_MAP)],
      ]);

      render(
        <CodebaseItem
          codebaseKey="git@github.com:acme/repo.git"
          codebase={buildSingleProjectCodebase(chats)}
          isExpanded
          toggleCodebase={vi.fn()}
          selectedChatId={null}
          onChatSelect={vi.fn()}
          totalChatsCount={2}
          batchGroups={batchGroups}
          isSearchActive
        />,
      );

      expect(screen.queryByTestId('batch-group')).toBeNull();
      expect(screen.getByText('Alpha search')).toBeDefined();
      expect(screen.getByText('Beta search')).toBeDefined();
    });

    it('does not render an empty BatchGroup when batchGroups has an id no loaded chat uses', () => {
      const chats = [
        makeChat({
          id: 'solo',
          name: 'Solo chat',
          batchId: BATCH_IN_MAP,
          updatedAt: new Date('2026-04-08'),
        }),
      ];
      const batchGroups = new Map<string, SidebarBatchGroup>([
        [BATCH_IN_MAP, makeBatchSummary(BATCH_IN_MAP)],
        [
          'c3c4d5e6-f7a8-4993-c345-678901234567',
          makeBatchSummary('c3c4d5e6-f7a8-4993-c345-678901234'),
        ],
      ]);

      render(
        <CodebaseItem
          codebaseKey="git@github.com:acme/repo.git"
          codebase={buildSingleProjectCodebase(chats)}
          isExpanded
          toggleCodebase={vi.fn()}
          selectedChatId={null}
          onChatSelect={vi.fn()}
          totalChatsCount={1}
          batchGroups={batchGroups}
        />,
      );

      const groups = screen.queryAllByTestId('batch-group');
      expect(groups).toHaveLength(1);
      expect(groups[0]?.getAttribute('data-batch-id')).toBe(BATCH_IN_MAP);
    });
  });

  describe('pin sort order', () => {
    it('renders pinned chats before unpinned chats', () => {
      const chats = [
        makeChat({ id: 'old', name: 'Older unpinned', updatedAt: new Date('2026-04-10') }),
        makeChat({
          id: 'pinned',
          name: 'Pinned chat',
          updatedAt: new Date('2026-04-08'),
          pinnedAt: new Date('2026-04-08T10:00:00Z'),
        }),
        makeChat({ id: 'new', name: 'Newer unpinned', updatedAt: new Date('2026-04-12') }),
      ];

      const { container } = render(
        <CodebaseItem
          codebaseKey="git@github.com:acme/repo.git"
          codebase={buildSingleProjectCodebase(chats)}
          isExpanded
          toggleCodebase={vi.fn()}
          selectedChatId={null}
          onChatSelect={vi.fn()}
          totalChatsCount={3}
        />,
      );

      const allText = container.textContent ?? '';
      const pinnedPos = allText.indexOf('Pinned chat');
      const olderPos = allText.indexOf('Older unpinned');
      const newerPos = allText.indexOf('Newer unpinned');
      expect(pinnedPos).toBeGreaterThanOrEqual(0);
      expect(pinnedPos).toBeLessThan(olderPos);
      expect(pinnedPos).toBeLessThan(newerPos);
    });

    it('sorts multiple pinned chats by pin time (most recently pinned first)', () => {
      const chats = [
        makeChat({
          id: 'pin-old',
          name: 'Pinned earlier',
          updatedAt: new Date('2026-04-08'),
          pinnedAt: new Date('2026-04-07T08:00:00Z'),
        }),
        makeChat({
          id: 'pin-new',
          name: 'Pinned later',
          updatedAt: new Date('2026-04-08'),
          pinnedAt: new Date('2026-04-09T12:00:00Z'),
        }),
      ];

      const { container } = render(
        <CodebaseItem
          codebaseKey="git@github.com:acme/repo.git"
          codebase={buildSingleProjectCodebase(chats)}
          isExpanded
          toggleCodebase={vi.fn()}
          selectedChatId={null}
          onChatSelect={vi.fn()}
          totalChatsCount={2}
        />,
      );

      const allText = container.textContent ?? '';
      const laterPos = allText.indexOf('Pinned later');
      const earlierPos = allText.indexOf('Pinned earlier');
      expect(laterPos).toBeGreaterThanOrEqual(0);
      expect(laterPos).toBeLessThan(earlierPos);
    });

    it('inserts "Pinned" and "Recent" section headers when both pinned and unpinned chats exist', () => {
      const chats = [
        makeChat({
          id: 'pinned',
          name: 'Alpha',
          updatedAt: new Date('2026-04-08'),
          pinnedAt: new Date('2026-04-08T10:00:00Z'),
        }),
        makeChat({ id: 'recent', name: 'Bravo', updatedAt: new Date('2026-04-12') }),
      ];

      const { container } = render(
        <CodebaseItem
          codebaseKey="git@github.com:acme/repo.git"
          codebase={buildSingleProjectCodebase(chats)}
          isExpanded
          toggleCodebase={vi.fn()}
          selectedChatId={null}
          onChatSelect={vi.fn()}
          totalChatsCount={2}
        />,
      );

      const txt = container.textContent ?? '';
      const pinnedHeader = txt.indexOf('Pinned');
      const recentHeader = txt.indexOf('Recent');
      const alphaPos = txt.indexOf('Alpha');
      const bravoPos = txt.indexOf('Bravo');

      expect(pinnedHeader).toBeGreaterThanOrEqual(0);
      expect(recentHeader).toBeGreaterThanOrEqual(0);
      expect(pinnedHeader).toBeLessThan(alphaPos);
      expect(alphaPos).toBeLessThan(recentHeader);
      expect(recentHeader).toBeLessThan(bravoPos);
    });

    it('omits section headers when all chats are pinned', () => {
      const chats = [
        makeChat({
          id: 'p1',
          name: 'Alpha',
          updatedAt: new Date('2026-04-08'),
          pinnedAt: new Date('2026-04-08T10:00:00Z'),
        }),
        makeChat({
          id: 'p2',
          name: 'Bravo',
          updatedAt: new Date('2026-04-09'),
          pinnedAt: new Date('2026-04-09T10:00:00Z'),
        }),
      ];

      const { container } = render(
        <CodebaseItem
          codebaseKey="git@github.com:acme/repo.git"
          codebase={buildSingleProjectCodebase(chats)}
          isExpanded
          toggleCodebase={vi.fn()}
          selectedChatId={null}
          onChatSelect={vi.fn()}
          totalChatsCount={2}
        />,
      );

      expect(container.textContent).not.toContain('Pinned');
      expect(container.textContent).not.toContain('Recent');
    });

    it('does not render an orphan "Recent" header at pagination boundary (visibleCount === pinnedCount)', () => {
      // Default page size is 30. With 30 pinned + 1 unpinned, the slice fills with all
      // pinned chats, then encounters "Recent" header, then breaks before any unpinned
      // chat is rendered. The "Recent" header should not appear without a chat under it.
      const chats: ChatItem[] = [];
      for (let i = 0; i < 30; i++) {
        // Use minute offsets to get 30 distinct, valid pinned timestamps
        chats.push(
          makeChat({
            id: `pinned-${i}`,
            name: `Pinned${i}`,
            updatedAt: new Date('2026-04-08'),
            pinnedAt: new Date(2026, 3, 8, 12, i, 0),
          }),
        );
      }
      chats.push(
        makeChat({ id: 'unpinned', name: 'Unpinned0', updatedAt: new Date('2026-04-09') }),
      );

      const { container } = render(
        <CodebaseItem
          codebaseKey="git@github.com:acme/repo.git"
          codebase={buildSingleProjectCodebase(chats)}
          isExpanded
          toggleCodebase={vi.fn()}
          selectedChatId={null}
          onChatSelect={vi.fn()}
          totalChatsCount={31}
          hasMoreChatsFromServer={false}
        />,
      );

      const txt = container.textContent ?? '';
      // Either "Recent" must not appear, OR if it does, an unpinned chat name must follow
      const recentIdx = txt.indexOf('Recent');
      if (recentIdx !== -1) {
        const unpinnedIdx = txt.indexOf('Unpinned0');
        expect(unpinnedIdx).toBeGreaterThan(recentIdx);
      }
    });

    it('omits section headers when no chats are pinned', () => {
      const chats = [
        makeChat({ id: 'a', name: 'Alpha', updatedAt: new Date('2026-04-08') }),
        makeChat({ id: 'b', name: 'Bravo', updatedAt: new Date('2026-04-09') }),
      ];

      const { container } = render(
        <CodebaseItem
          codebaseKey="git@github.com:acme/repo.git"
          codebase={buildSingleProjectCodebase(chats)}
          isExpanded
          toggleCodebase={vi.fn()}
          selectedChatId={null}
          onChatSelect={vi.fn()}
          totalChatsCount={2}
        />,
      );

      expect(container.textContent).not.toContain('Pinned');
      expect(container.textContent).not.toContain('Recent');
    });

    it('keeps pinned batch chat inside its batch group (not floated above)', () => {
      const chats = [
        makeChat({ id: 'flat', name: 'Flat chat', updatedAt: new Date('2026-04-12') }),
        makeChat({
          id: 'batch-pinned',
          name: 'Batch pinned',
          batchId: BATCH_IN_MAP,
          updatedAt: new Date('2026-04-08'),
          pinnedAt: new Date('2026-04-10T10:00:00Z'),
        }),
      ];
      const batchGroups = new Map<string, SidebarBatchGroup>([
        [BATCH_IN_MAP, makeBatchSummary(BATCH_IN_MAP)],
      ]);

      render(
        <CodebaseItem
          codebaseKey="git@github.com:acme/repo.git"
          codebase={buildSingleProjectCodebase(chats)}
          isExpanded
          toggleCodebase={vi.fn()}
          selectedChatId={null}
          onChatSelect={vi.fn()}
          totalChatsCount={2}
          batchGroups={batchGroups}
        />,
      );

      // The batch group should still render (pinned batch chat stays inside it)
      expect(screen.getByTestId('batch-group')).toBeDefined();
      // The flat chat should still render
      expect(screen.getByText('Flat chat')).toBeDefined();
    });
  });

  describe('task-owned chat DnD lock', () => {
    const renderChat = (chat: ChatItem) =>
      render(
        <CodebaseItem
          codebaseKey="git@github.com:acme/repo.git"
          codebase={buildSingleProjectCodebase([chat])}
          isExpanded
          toggleCodebase={vi.fn()}
          selectedChatId={null}
          onChatSelect={vi.fn()}
          totalChatsCount={1}
        />,
      );

    beforeEach(() => {
      dndMock.calls.length = 0;
    });

    it('disables drag for a chat that belongs to a task (taskId set)', () => {
      renderChat(makeChat({ id: 'task-chat', name: 'Task chat', taskId: 'task-1' }));
      expect(dndMock.calls.find((c) => c.id === 'task-chat')?.disabled).toBe(true);
    });

    it('keeps drag enabled for a standalone chat (taskId null)', () => {
      renderChat(makeChat({ id: 'plain', name: 'Plain chat', taskId: null }));
      expect(dndMock.calls.find((c) => c.id === 'plain')?.disabled).toBe(false);
    });

    it('locks a task chat regardless of terminal status (gate is taskId, not taskStatus)', () => {
      render(
        <CodebaseItem
          codebaseKey="git@github.com:acme/repo.git"
          codebase={buildSingleProjectCodebase([
            makeChat({ id: 'done-task', name: 'Done task', taskId: 'task-9' }),
          ])}
          isExpanded
          toggleCodebase={vi.fn()}
          selectedChatId={null}
          onChatSelect={vi.fn()}
          totalChatsCount={1}
          chatTaskStatusByChatId={new Map([['done-task', 'done']])}
        />,
      );
      expect(dndMock.calls.find((c) => c.id === 'done-task')?.disabled).toBe(true);
    });

    it('renders the grip as a hidden, non-focusable spacer for task chats', () => {
      const { container } = renderChat(
        makeChat({ id: 'task-chat', name: 'Task chat', taskId: 'task-1' }),
      );
      const grip = container.querySelector('.lucide-grip-vertical');
      const btn = grip?.closest('button');
      // `disabled` (not aria-hidden+tabIndex on a focusable button) is the non-focusable primitive.
      expect((btn as HTMLButtonElement | null)?.disabled).toBe(true);
      expect(btn?.getAttribute('aria-hidden')).toBe('true');
      expect(btn?.className).toContain('cursor-default');
      expect(grip?.getAttribute('class')).toContain('invisible');
    });

    it('keeps the grip grabbable and focusable for standalone chats', () => {
      const { container } = renderChat(makeChat({ id: 'plain', name: 'Plain chat', taskId: null }));
      const grip = container.querySelector('.lucide-grip-vertical');
      const btn = grip?.closest('button');
      expect((btn as HTMLButtonElement | null)?.disabled).toBe(false);
      expect(btn?.getAttribute('aria-hidden')).toBeNull();
      expect(btn?.className).toContain('cursor-grab');
      expect(grip?.getAttribute('class')).not.toContain('invisible');
    });

    it('keeps a task chat locked on the orphan-batch flat fallback (batchId set but absent from batchGroups)', () => {
      // batchId present but no matching summary → renders flat via DraggableChat (not BatchGroup).
      // A task chat on that fallback path must still be drag-locked.
      render(
        <CodebaseItem
          codebaseKey="git@github.com:acme/repo.git"
          codebase={buildSingleProjectCodebase([
            makeChat({
              id: 'orphan-task',
              name: 'Orphan batch task chat',
              batchId: BATCH_NOT_IN_MAP,
              taskId: 'task-7',
            }),
          ])}
          isExpanded
          toggleCodebase={vi.fn()}
          selectedChatId={null}
          onChatSelect={vi.fn()}
          totalChatsCount={1}
          batchGroups={new Map([[BATCH_IN_MAP, makeBatchSummary(BATCH_IN_MAP)]])}
        />,
      );
      expect(screen.queryByTestId('batch-group')).toBeNull();
      expect(dndMock.calls.find((c) => c.id === 'orphan-task')?.disabled).toBe(true);
    });

    it('locks on live transition from standalone to task-owned', () => {
      const { rerender } = renderChat(makeChat({ id: 'c', name: 'C', taskId: null }));
      expect(dndMock.calls.find((c) => c.id === 'c')?.disabled).toBe(false);

      dndMock.calls.length = 0;
      rerender(
        <CodebaseItem
          codebaseKey="git@github.com:acme/repo.git"
          codebase={buildSingleProjectCodebase([
            makeChat({ id: 'c', name: 'C', taskId: 'task-1' }),
          ])}
          isExpanded
          toggleCodebase={vi.fn()}
          selectedChatId={null}
          onChatSelect={vi.fn()}
          totalChatsCount={1}
        />,
      );
      expect(dndMock.calls.find((c) => c.id === 'c')?.disabled).toBe(true);
    });
  });
});

/**
 * The memo below CodebaseItem keeps the 5s task poll from re-rendering every row. These assert both
 * halves: an update reaches exactly the rows it concerns, and no row it does not.
 */
describe('CodebaseItem row-render isolation', () => {
  const CHAT_A = 'chat-a';
  const CHAT_B = 'chat-b';

  beforeEach(() => {
    renderTally.rows.clear();
    renderTally.batches = 0;
  });

  const baseProps = (chats: ChatItem[]) => ({
    codebaseKey: 'git@github.com:acme/repo.git',
    codebase: buildSingleProjectCodebase(chats),
    isExpanded: true,
    toggleCodebase: vi.fn(),
    selectedChatId: null,
    onChatSelect: vi.fn(),
    totalChatsCount: chats.length,
  });

  it('routes a task-status change to the affected row only', () => {
    const props = baseProps([makeChat({ id: CHAT_A }), makeChat({ id: CHAT_B })]);
    const { rerender } = render(<CodebaseItem {...props} chatTaskStatusByChatId={new Map()} />);
    const before = new Map(renderTally.rows);

    rerender(
      <CodebaseItem {...props} chatTaskStatusByChatId={new Map([[CHAT_A, 'running' as const]])} />,
    );

    expect(renderTally.rows.get(CHAT_A)).toBe((before.get(CHAT_A) ?? 0) + 1);
    expect(renderTally.rows.get(CHAT_B)).toBe(before.get(CHAT_B));
  });

  // The poll re-derives the reason map every tick, so a reference compare here would re-render the
  // whole list forever; a field compare must still let a genuinely changed reason through.
  it('ignores a re-derived reason map but forwards a changed reason', () => {
    const props = baseProps([makeChat({ id: CHAT_A }), makeChat({ id: CHAT_B })]);
    const reason = new Map([[CHAT_A, { summary: 'waiting', details: 'on input' }]]);
    const { rerender } = render(<CodebaseItem {...props} chatReasonByChatId={reason} />);
    const before = new Map(renderTally.rows);

    rerender(
      <CodebaseItem
        {...props}
        chatReasonByChatId={new Map([[CHAT_A, { summary: 'waiting', details: 'on input' }]])}
      />,
    );
    expect(renderTally.rows.get(CHAT_A)).toBe(before.get(CHAT_A));
    expect(renderTally.rows.get(CHAT_B)).toBe(before.get(CHAT_B));

    rerender(
      <CodebaseItem
        {...props}
        chatReasonByChatId={new Map([[CHAT_A, { summary: 'blocked', details: 'on input' }]])}
      />,
    );
    expect(renderTally.rows.get(CHAT_A)).toBe((before.get(CHAT_A) ?? 0) + 1);
  });

  // Split view: pane 0 is a real pane, not "no pane". A falsy-check anywhere on this path would
  // leave the first pane's badge off the row that is actually open in it.
  it('routes a split-pane assignment to the affected row, including pane index 0', () => {
    const props = baseProps([makeChat({ id: CHAT_A }), makeChat({ id: CHAT_B })]);
    const { rerender } = render(<CodebaseItem {...props} chatPaneMap={new Map()} />);
    const before = new Map(renderTally.rows);

    rerender(<CodebaseItem {...props} chatPaneMap={new Map([[CHAT_A, 0]])} />);

    expect(renderTally.rows.get(CHAT_A)).toBe((before.get(CHAT_A) ?? 0) + 1);
    expect(renderTally.rows.get(CHAT_B)).toBe(before.get(CHAT_B));
  });

  // Two panes streaming at once is the ordinary multi-pane case: both rows must repaint, and a
  // third, untouched row must not.
  it('routes a simultaneous two-chat status change to exactly those two rows', () => {
    const CHAT_C = 'chat-c';
    const props = baseProps([
      makeChat({ id: CHAT_A }),
      makeChat({ id: CHAT_B }),
      makeChat({ id: CHAT_C }),
    ]);
    const { rerender } = render(<CodebaseItem {...props} chatTaskStatusByChatId={new Map()} />);
    const before = new Map(renderTally.rows);

    rerender(
      <CodebaseItem
        {...props}
        chatTaskStatusByChatId={
          new Map([
            [CHAT_A, 'running' as const],
            [CHAT_B, 'running' as const],
          ])
        }
      />,
    );

    expect(renderTally.rows.get(CHAT_A)).toBe((before.get(CHAT_A) ?? 0) + 1);
    expect(renderTally.rows.get(CHAT_B)).toBe((before.get(CHAT_B) ?? 0) + 1);
    expect(renderTally.rows.get(CHAT_C)).toBe(before.get(CHAT_C));
  });

  // A BatchGroup's expanded rows come from the server, absent from codebase.chats, so
  // every per-chat scan is blind to them; a change landing only there must still reach the group.
  it('re-renders a batch group for a chat outside the codebase chat list', () => {
    const props = {
      ...baseProps([makeChat({ id: 'in-batch', batchId: BATCH_IN_MAP })]),
      batchGroups: new Map<string, SidebarBatchGroup>([
        [BATCH_IN_MAP, makeBatchSummary(BATCH_IN_MAP)],
      ]),
    };
    const { rerender } = render(<CodebaseItem {...props} chatTaskStatusByChatId={new Map()} />);
    const before = renderTally.batches;

    rerender(
      <CodebaseItem
        {...props}
        chatTaskStatusByChatId={new Map([['server-only-chat', 'running' as const]])}
      />,
    );

    expect(renderTally.batches).toBe(before + 1);
  });
});
