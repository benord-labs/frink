// @vitest-environment happy-dom
/**
 * Tests for BatchGroup sidebar component.
 * Covers: header rendering, progress badge, failed-run badge, expand/collapse, loading vs empty,
 * listByBatch error + Retry, server list replacing local subset, chat actions.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SidebarBatchGroup } from '../../../../../../shared/types/flows/sidebar-batch-group';
import type { ChatItem } from '../../types';
import { BatchGroup } from './index';

const listByBatchRefetch = vi.hoisted(() => vi.fn(() => Promise.resolve()));

type ListByBatchQueryResult = {
  data: unknown;
  isLoading: boolean;
  isError?: boolean;
  isFetching?: boolean;
  refetch: () => unknown;
};

function defaultListByBatchResult(): ListByBatchQueryResult {
  return {
    data: undefined,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: listByBatchRefetch,
  };
}

const listByBatchUseQuery = vi.hoisted(() =>
  vi.fn((_input: unknown, _opts?: unknown): ListByBatchQueryResult => defaultListByBatchResult()),
);

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../TreeItem', () => ({
  TreeItem: ({
    label,
    rightContent,
    children,
    isExpanded,
    onToggle,
  }: {
    label: React.ReactNode;
    rightContent?: React.ReactNode;
    children?: React.ReactNode;
    isExpanded: boolean;
    onToggle: () => void;
  }) => (
    <div>
      <button type="button" onClick={onToggle}>
        {label}
      </button>
      {rightContent}
      {isExpanded ? <div>{children}</div> : null}
    </div>
  ),
}));

vi.mock('../../../../../lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      tasks: {
        listPaginated: { invalidate: vi.fn() },
        listCounts: { invalidate: vi.fn() },
        getById: { invalidate: vi.fn() },
      },
    }),
    chats: {
      listByBatch: {
        useQuery: (input: unknown, opts: unknown) => listByBatchUseQuery(input, opts),
      },
    },
    tasks: {
      complete: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
  },
}));

vi.mock('../../../../../components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

vi.mock('../../../../../components/ui/dropdown-menu', () => ({
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
  DropdownMenuSeparator: () => null,
}));

afterEach(() => {
  cleanup();
  listByBatchRefetch.mockClear();
  listByBatchUseQuery.mockImplementation(
    (_input: unknown, _opts?: unknown): ListByBatchQueryResult => defaultListByBatchResult(),
  );
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeSummary(overrides: Partial<SidebarBatchGroup> = {}): SidebarBatchGroup {
  return {
    batch_id: 'a1b2c3d4-e5f6-4890-8bcd-ef1234567890',
    flow_name: 'PR Review Flow',
    run_count: 35,
    completed_count: 28,
    failed_count: 0,
    running_count: 0,
    first_run_at: '2026-04-01T10:00:00.000Z',
    last_activity_at: '2026-04-08T12:00:00.000Z',
    ...overrides,
  };
}

function makeChatItem(overrides: Partial<ChatItem> & { id: string }): ChatItem {
  return {
    name: 'Chat item',
    branch: null,
    updatedAt: new Date('2026-04-08'),
    projectId: 'proj-1',
    hasUnseenChanges: false,
    isLoading: false,
    hasPendingPlan: false,
    hasPendingQuestion: false,
    isHeld: false,
    isWorktree: false,
    taskId: 'task-1',
    batchId: 'a1b2c3d4-e5f6-4890-8bcd-ef1234567890',
    pinnedAt: null,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('BatchGroup', () => {
  it('renders flow name in the header', () => {
    render(
      <BatchGroup
        summary={makeSummary()}
        localChats={[]}
        selectedChatId={null}
        onChatSelect={vi.fn()}
      />,
    );
    expect(screen.getByText('PR Review Flow')).toBeDefined();
  });

  it('renders progress badge with completed/total counts', () => {
    render(
      <BatchGroup
        summary={makeSummary({ completed_count: 28, run_count: 35 })}
        localChats={[]}
        selectedChatId={null}
        onChatSelect={vi.fn()}
      />,
    );
    expect(screen.getByText('28/35')).toBeDefined();
    expect(screen.getByText('28 of 35 runs completed')).toBeDefined();
  });

  it('renders failed-run badge when failed_count > 0', () => {
    render(
      <BatchGroup
        summary={makeSummary({ failed_count: 3 })}
        localChats={[]}
        selectedChatId={null}
        onChatSelect={vi.fn()}
      />,
    );
    expect(screen.getByText('3 failed runs')).toBeDefined();
  });

  it('does not render failed-run badge when failed_count is 0', () => {
    render(
      <BatchGroup
        summary={makeSummary({ failed_count: 0 })}
        localChats={[]}
        selectedChatId={null}
        onChatSelect={vi.fn()}
      />,
    );
    expect(screen.queryByText(/failed runs/)).toBeNull();
  });

  it('starts collapsed and shows no chats initially', () => {
    const chats = [makeChatItem({ id: 'chat-1', name: 'Chat One' })];
    render(
      <BatchGroup
        summary={makeSummary()}
        localChats={chats}
        selectedChatId={null}
        onChatSelect={vi.fn()}
      />,
    );
    expect(screen.queryByText('Chat One')).toBeNull();
  });

  it('expands and shows local chats when header is clicked', () => {
    const chats = [
      makeChatItem({ id: 'chat-1', name: 'Chat Alpha' }),
      makeChatItem({ id: 'chat-2', name: 'Chat Beta' }),
    ];

    render(
      <BatchGroup
        summary={makeSummary()}
        localChats={chats}
        selectedChatId={null}
        onChatSelect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('PR Review Flow'));

    expect(screen.getByText('Chat Alpha')).toBeDefined();
    expect(screen.getByText('Chat Beta')).toBeDefined();
  });

  it('calls onChatSelect when a chat item button is clicked', () => {
    const onChatSelect = vi.fn();
    const chats = [makeChatItem({ id: 'chat-1', name: 'Clickable Chat' })];

    render(
      <BatchGroup
        summary={makeSummary()}
        localChats={chats}
        selectedChatId={null}
        onChatSelect={onChatSelect}
      />,
    );

    // Expand
    fireEvent.click(screen.getByText('PR Review Flow'));
    // Click the chat button
    fireEvent.click(screen.getByText('Clickable Chat'));

    expect(onChatSelect).toHaveBeenCalledWith('chat-1');
  });

  it('shows "No chats in this batch" when expanded with empty chat list', () => {
    render(
      <BatchGroup
        summary={makeSummary()}
        localChats={[]}
        selectedChatId={null}
        onChatSelect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('PR Review Flow'));

    expect(screen.getByText('No chats in this batch')).toBeDefined();
  });

  it('shows Loading when expanded with no chats and listByBatch is still loading', () => {
    listByBatchUseQuery.mockImplementation(
      (_input: unknown, opts?: unknown): ListByBatchQueryResult => {
        const enabled = (opts as { enabled?: boolean } | undefined)?.enabled;
        if (!enabled) {
          return defaultListByBatchResult();
        }
        return {
          data: undefined,
          isLoading: true,
          isError: false,
          isFetching: true,
          refetch: listByBatchRefetch,
        };
      },
    );

    render(
      <BatchGroup
        summary={makeSummary()}
        localChats={[]}
        selectedChatId={null}
        onChatSelect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('PR Review Flow'));

    expect(screen.getByText('Loading…')).toBeDefined();
    expect(screen.queryByText('No chats in this batch')).toBeNull();
  });

  it('when server returns an empty array, shows empty state instead of local subset rows', () => {
    const batchId = 'a1b2c3d4-e5f6-4890-8bcd-ef1234567890';
    listByBatchUseQuery.mockImplementation(
      (_input: unknown, opts?: unknown): ListByBatchQueryResult => {
        const enabled = (opts as { enabled?: boolean } | undefined)?.enabled;
        return {
          data: enabled ? [] : undefined,
          isLoading: false,
          isError: false,
          isFetching: false,
          refetch: listByBatchRefetch,
        };
      },
    );

    render(
      <BatchGroup
        summary={makeSummary({ batch_id: batchId })}
        localChats={[makeChatItem({ id: 'local-1', name: 'Local until fetch', batchId })]}
        selectedChatId={null}
        onChatSelect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('PR Review Flow'));

    expect(screen.getByText('No chats in this batch')).toBeDefined();
    expect(screen.queryByText('Local until fetch')).toBeNull();
  });

  it('shows fetch error and Retry when listByBatch fails', () => {
    listByBatchUseQuery.mockImplementation(
      (_input: unknown, opts?: unknown): ListByBatchQueryResult => {
        const enabled = (opts as { enabled?: boolean } | undefined)?.enabled;
        if (!enabled) {
          return defaultListByBatchResult();
        }
        return {
          data: undefined,
          isLoading: false,
          isError: true,
          isFetching: false,
          refetch: listByBatchRefetch,
        };
      },
    );

    const chats = [
      makeChatItem({
        id: 'local-1',
        name: 'Hidden while fetch error',
        batchId: makeSummary().batch_id,
      }),
    ];

    render(
      <BatchGroup
        summary={makeSummary()}
        localChats={chats}
        selectedChatId={null}
        onChatSelect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('PR Review Flow'));

    expect(screen.getByText(/Couldn.*t load chats/)).toBeDefined();
    expect(screen.queryByText('Hidden while fetch error')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^retry$/i }));
    expect(listByBatchRefetch).toHaveBeenCalled();
  });

  it('collapses again when header is clicked a second time', () => {
    const chats = [makeChatItem({ id: 'chat-1', name: 'Toggle Chat' })];

    render(
      <BatchGroup
        summary={makeSummary()}
        localChats={chats}
        selectedChatId={null}
        onChatSelect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('PR Review Flow'));
    expect(screen.getByText('Toggle Chat')).toBeDefined();

    fireEvent.click(screen.getByText('PR Review Flow'));
    expect(screen.queryByText('Toggle Chat')).toBeNull();
  });

  it('when expanded and listByBatch returns data, shows server chat list instead of local subset', () => {
    const batchId = 'a1b2c3d4-e5f6-4890-8bcd-ef1234567890';
    listByBatchUseQuery.mockImplementation(
      (_input: unknown, opts?: unknown): ListByBatchQueryResult => {
        const enabled = (opts as { enabled?: boolean } | undefined)?.enabled;
        return {
          data: enabled
            ? [
                {
                  id: 'server-1',
                  name: 'Server list wins',
                  projectId: 'proj-1',
                  createdAt: new Date('2026-04-08'),
                  updatedAt: new Date('2026-04-08'),
                  archivedAt: null,
                  worktreePath: null,
                  branch: null,
                  baseBranch: null,
                  prUrl: null,
                  prNumber: null,
                  taskId: null,
                  batchId,
                },
              ]
            : undefined,
          isLoading: false,
          isError: false,
          isFetching: false,
          refetch: listByBatchRefetch,
        };
      },
    );

    const localOnly = [makeChatItem({ id: 'local-1', name: 'Local subset only', batchId })];

    render(
      <BatchGroup
        summary={makeSummary({ batch_id: batchId })}
        localChats={localOnly}
        selectedChatId={null}
        onChatSelect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('PR Review Flow'));

    expect(screen.getByText('Server list wins')).toBeDefined();
    expect(screen.queryByText('Local subset only')).toBeNull();
  });

  // A batch member row is built from the SERVER list, which carries no live flags — the parent must
  // thread the held-question set in or the row keeps claiming "Running" while it waits on the user.
  describe('held question on a batch member row', () => {
    const batchId = 'a1b2c3d4-e5f6-4890-8bcd-ef1234567890';

    // The `enabled` gate the other tests model is irrelevant here: a collapsed group renders
    // localChats regardless of fetched data, and every test below expands first.
    function mockServerChat(id: string) {
      listByBatchUseQuery.mockImplementation((): ListByBatchQueryResult => ({
        data: [
          {
            id,
            name: 'Batch member',
            projectId: 'proj-1',
            createdAt: new Date('2026-04-08'),
            updatedAt: new Date('2026-04-08'),
            archivedAt: null,
            worktreePath: null,
            branch: null,
            baseBranch: null,
            prUrl: null,
            prNumber: null,
            taskId: 'task-1',
            batchId,
          },
        ],
        isLoading: false,
        isError: false,
        isFetching: false,
        refetch: listByBatchRefetch,
      }));
    }

    it('shows Waiting instead of Running when the member is in pendingQuestionIds', () => {
      mockServerChat('server-q');
      render(
        <BatchGroup
          summary={makeSummary({ batch_id: batchId })}
          localChats={[]}
          selectedChatId={null}
          onChatSelect={vi.fn()}
          chatTaskStatusByChatId={new Map([['server-q', 'running' as const]])}
          pendingQuestionIds={new Set(['server-q'])}
        />,
      );
      fireEvent.click(screen.getByText('PR Review Flow'));

      expect(screen.getAllByText('Waiting').length).toBeGreaterThan(0);
      expect(screen.queryByText('Running')).toBeNull();
    });

    it('leaves a sibling member without a question on Running', () => {
      // Guards the per-id lookup: the flag must not smear across every row in the group.
      mockServerChat('server-plain');
      render(
        <BatchGroup
          summary={makeSummary({ batch_id: batchId })}
          localChats={[]}
          selectedChatId={null}
          onChatSelect={vi.fn()}
          chatTaskStatusByChatId={new Map([['server-plain', 'running' as const]])}
          pendingQuestionIds={new Set(['some-other-chat'])}
        />,
      );
      fireEvent.click(screen.getByText('PR Review Flow'));

      expect(screen.getAllByText('Running').length).toBeGreaterThan(0);
      expect(screen.queryByText('Waiting')).toBeNull();
    });

    it('renders a running member unchanged when the parent passes no set at all', () => {
      // The prop is optional; an omitted set must read as "no questions", never throw.
      mockServerChat('server-none');
      render(
        <BatchGroup
          summary={makeSummary({ batch_id: batchId })}
          localChats={[]}
          selectedChatId={null}
          onChatSelect={vi.fn()}
          chatTaskStatusByChatId={new Map([['server-none', 'running' as const]])}
        />,
      );
      fireEvent.click(screen.getByText('PR Review Flow'));

      expect(screen.getAllByText('Running').length).toBeGreaterThan(0);
    });
  });

  describe('delete batch action', () => {
    it('does not render actions menu button when onDeleteBatch is not provided', () => {
      render(
        <BatchGroup
          summary={makeSummary()}
          localChats={[]}
          selectedChatId={null}
          onChatSelect={vi.fn()}
        />,
      );
      expect(screen.queryByLabelText('Batch actions')).toBeNull();
    });

    it('renders actions menu button when onDeleteBatch is provided', () => {
      render(
        <BatchGroup
          summary={makeSummary()}
          localChats={[]}
          selectedChatId={null}
          onChatSelect={vi.fn()}
          onDeleteBatch={vi.fn()}
        />,
      );
      expect(screen.getByLabelText('Batch actions')).toBeDefined();
    });

    it('calls onDeleteBatch with batchId and summary when "Delete batch" is clicked', () => {
      const onDeleteBatch = vi.fn();
      const summary = makeSummary({ batch_id: 'test-batch-id', flow_name: 'Test Flow' });
      render(
        <BatchGroup
          summary={summary}
          localChats={[]}
          selectedChatId={null}
          onChatSelect={vi.fn()}
          onDeleteBatch={onDeleteBatch}
        />,
      );
      fireEvent.click(screen.getByText('Delete batch'));
      expect(onDeleteBatch).toHaveBeenCalledWith('test-batch-id', summary);
    });

    it('clicking "Delete batch" does not toggle the expand/collapse state', () => {
      const onDeleteBatch = vi.fn();
      // The TreeItem mock wraps the toggle in a button around the label.
      // rightContent is outside that button, so delete should not expand the batch.
      render(
        <BatchGroup
          summary={makeSummary()}
          localChats={[]}
          selectedChatId={null}
          onChatSelect={vi.fn()}
          onDeleteBatch={onDeleteBatch}
        />,
      );
      // Batch is collapsed. Click "Delete batch" (rendered in rightContent, outside toggle button).
      fireEvent.click(screen.getByText('Delete batch'));
      // Toggle button was not clicked — batch remains collapsed (no chat list).
      expect(screen.queryByText('No chats in this batch')).toBeNull();
    });
  });

  it('shows worktree indicator when server chat worktreePath differs from project path', () => {
    const batchId = 'a1b2c3d4-e5f6-4890-8bcd-ef1234567890';
    listByBatchUseQuery.mockImplementation(
      (_input: unknown, opts?: unknown): ListByBatchQueryResult => {
        const enabled = (opts as { enabled?: boolean } | undefined)?.enabled;
        return {
          data: enabled
            ? [
                {
                  id: 'wt-1',
                  name: 'Worktree chat',
                  projectId: 'proj-1',
                  createdAt: new Date('2026-04-08'),
                  updatedAt: new Date('2026-04-08'),
                  archivedAt: null,
                  worktreePath: '/tmp/wt-copy',
                  branch: null,
                  baseBranch: null,
                  prUrl: null,
                  prNumber: null,
                  taskId: null,
                  batchId,
                },
              ]
            : undefined,
          isLoading: false,
          isError: false,
          isFetching: false,
          refetch: listByBatchRefetch,
        };
      },
    );

    render(
      <BatchGroup
        summary={makeSummary({ batch_id: batchId })}
        localChats={[]}
        projectPathById={new Map([['proj-1', '/repo/main']])}
        selectedChatId={null}
        onChatSelect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('PR Review Flow'));

    expect(screen.getByText('Worktree chat')).toBeDefined();
    expect(screen.getByText('(worktree)')).toBeDefined();
  });
});
