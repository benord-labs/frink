// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { getDefaultStore } from 'jotai';
import type { MouseEvent, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { stubLayout } from '@/lib/hooks/priority-overflow/layout-stub';
import { loadingSubChatsAtom } from '../../../atoms';
import { ChatInputContextBar } from './ChatInputContextBar';

/** The lock reads the agents feature's loading map, so tests drive it through the real atom. */
const store = getDefaultStore();

vi.mock('./WorktreeIndicator', () => ({
  WorktreeIndicator: ({
    worktreeLabel,
    worktreePath,
  }: {
    worktreeLabel: string;
    worktreePath?: string | null;
  }) => {
    const worktreeName = worktreeLabel.replace(/^WT:\s*/i, '');
    return (
      <output
        aria-label={`Worktree: ${worktreeName}`}
        data-testid="worktree-indicator-mock"
        data-worktree-path={worktreePath ?? ''}
      >
        {worktreeLabel}
      </output>
    );
  },
}));

/** The folder chip carries a Radix tooltip, which needs the provider the app shell supplies. */
const renderBar = (ui: ReactNode) => render(ui, { wrapper: TooltipProvider });

const PLACEHOLDER = '—';

const DEFAULT_BRANCH_DATA = {
  current: 'main',
  local: [
    { branch: 'main', lastCommitDate: Date.now() },
    { branch: 'feature/delete-me', lastCommitDate: Date.now() },
  ],
  remote: [],
  defaultBranch: 'main',
  checkedOutBranches: {},
};

let mockBranchData = DEFAULT_BRANCH_DATA;
let mockWorktrees: Array<{
  path: string;
  branch: string | null;
  isMain: boolean;
  prunable: boolean;
}> = [];
let mockWorktreesLoading = false;
let mockWorktreesError = false;
/** Chats with a non-terminal flow run — one half of the workspace-context lock. */
let mockActiveRunChatIds: string[] = [];
let deleteMutationMode: 'success' | 'unmerged-error' | 'generic-error' = 'success';
let lastBranchSelectorProps:
  | {
      isBranchDeletable?: (branch: {
        name: string;
        type: 'local' | 'remote';
        protected: boolean;
        isDefault: boolean;
        checkedOutIn: string | null;
      }) => boolean;
    }
  | undefined;

const invalidateBranches = vi.fn();
const invalidateStatus = vi.fn();
const switchMutate = vi.fn();
const deleteMutate = vi.fn();
const toastInfo = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock('../../../components/branch-selector', () => ({
  BranchSelector: (props: {
    isOpen: boolean;
    onDeleteBranch?: (branch: string) => void;
    onOpenChange: (open: boolean) => void;
    isBranchDeletable?: (branch: {
      name: string;
      type: 'local' | 'remote';
      protected: boolean;
      isDefault: boolean;
      checkedOutIn: string | null;
    }) => boolean;
  }) =>
    (() => {
      lastBranchSelectorProps = props;
      return (
        <div data-testid="branch-selector">
          <span data-testid="branch-selector-open">{String(props.isOpen)}</span>
          <button type="button" onClick={() => props.onOpenChange(true)}>
            open-branch-picker
          </button>
          <button type="button" onClick={() => props.onDeleteBranch?.('feature/delete-me')}>
            inline-delete
          </button>
        </div>
      );
    })(),
}));

vi.mock('../../../components/create-branch-dialog', () => ({
  CreateBranchDialog: () => null,
}));

vi.mock('../../../components/delete-branch-dialog', () => ({
  DeleteBranchDialog: (props: { open: boolean; onBranchSelect: (branch: string) => void }) =>
    props.open ? (
      <div data-testid="delete-branch-dialog">
        <button type="button" onClick={() => props.onBranchSelect('feature/delete-me')}>
          select-delete-branch
        </button>
      </div>
    ) : null,
}));

vi.mock('../../../components/worktree-picker', () => ({
  WorktreePicker: ({ selectedPath, chatId }: { selectedPath: string; chatId?: string }) => (
    <div data-testid="worktree-picker" data-chat-id={chatId}>
      {selectedPath.split('/').pop()}
    </div>
  ),
}));

vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div data-testid="alert-dialog">{children}</div> : null,
  AlertDialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <h3>{children}</h3>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogCancel: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  AlertDialogAction: ({
    children,
    onClick,
  }: {
    children: ReactNode;
    onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock('sonner', () => ({
  toast: {
    info: (...args: unknown[]) => toastInfo(...args),
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      changes: {
        getBranches: { invalidate: invalidateBranches },
        getStatus: { invalidate: invalidateStatus },
      },
    }),
    flows: {
      activeRunChatIds: { useQuery: () => ({ data: mockActiveRunChatIds }) },
    },
    changes: {
      getBranches: {
        useQuery: () => ({
          data: mockBranchData,
          isLoading: false,
        }),
      },
      getWorktrees: {
        useQuery: () => ({
          data: mockWorktrees,
          isLoading: mockWorktreesLoading,
          isError: mockWorktreesError,
        }),
      },
      switchBranch: {
        useMutation: (opts?: {
          onSuccess?: (data: unknown, variables: { worktreePath: string }) => void;
        }) => ({
          mutate: (variables: { worktreePath: string }) => {
            switchMutate(variables);
            opts?.onSuccess?.({}, variables);
          },
          isPending: false,
        }),
      },
      deleteBranch: {
        useMutation: (opts?: {
          onSuccess?: (data: unknown, variables: { worktreePath: string; branch: string }) => void;
          onError?: (
            error: Error,
            variables: {
              worktreePath: string;
              branch: string;
              force: boolean;
              deleteRemote: boolean;
            },
          ) => void;
        }) => ({
          mutate: (variables: {
            worktreePath: string;
            branch: string;
            force: boolean;
            deleteRemote: boolean;
          }) => {
            deleteMutate(variables);
            if (deleteMutationMode === 'success') {
              opts?.onSuccess?.({}, variables);
              return;
            }
            if (deleteMutationMode === 'unmerged-error') {
              opts?.onError?.(
                new Error("The branch 'feature/delete-me' is not fully merged"),
                variables,
              );
              return;
            }
            opts?.onError?.(new Error('Cannot delete branch due to repository error'), variables);
          },
          isPending: false,
        }),
      },
    },
  },
}));

afterEach(() => {
  cleanup();
  switchMutate.mockClear();
  deleteMutate.mockClear();
  invalidateBranches.mockClear();
  invalidateStatus.mockClear();
  toastInfo.mockClear();
  toastError.mockClear();
  toastSuccess.mockClear();
  mockBranchData = DEFAULT_BRANCH_DATA;
  mockWorktrees = [];
  mockWorktreesLoading = false;
  mockWorktreesError = false;
  mockActiveRunChatIds = [];
  store.set(loadingSubChatsAtom, new Map());
  deleteMutationMode = 'success';
  lastBranchSelectorProps = undefined;
});

const LONG_BRANCH = 'feature/very-long-branch-name-that-will-truncate-in-narrow-split-panes-abc123';
const LONG_FOLDER = 'monorepo-package-with-very-long-directory-name-for-overflow-testing-xyz789';

describe('ChatInputContextBar', () => {
  describe('three-slot layout', () => {
    it('shows the project alone for a folder without a branch or linked worktrees', () => {
      renderBar(
        <ChatInputContextBar
          currentBranch={null}
          workspaceFolderName="owners-web"
          worktreePath="/tmp/owners-web"
        />,
      );

      const region = screen.getByLabelText('Workspace context');
      expect(region).toHaveTextContent('owners-web');
      expect(screen.queryByLabelText(/^Branch:/)).toBeNull();
      expect(screen.queryByTestId('worktree-indicator-mock')).toBeNull();
      expect(region).not.toHaveTextContent(PLACEHOLDER);
    });

    it('shows the prompt-cache countdown right after the folder when an expiry is known', () => {
      renderBar(
        <ChatInputContextBar
          currentBranch={null}
          workspaceFolderName="owners-web"
          worktreePath="/tmp/owners-web"
          promptCacheExpiresAt={Date.now() + 5 * 60_000}
        />,
      );

      const timer = screen.getByRole('img', { name: /^Prompt cache stays warm/ });
      expect(screen.getByLabelText('Folder: owners-web').nextElementSibling).toBe(timer);
      // Reference only: narrow rows (split panes) shed it rather than crowd the git chips.
      expect(timer.className).toContain('@max-[26rem]/context-row:hidden');
    });

    it('renders an empty row when there is no project context', () => {
      renderBar(
        <ChatInputContextBar worktreePath={null} currentBranch={null} workspaceFolderName={null} />,
      );

      expect(screen.getByLabelText('Workspace context')).toHaveTextContent('');
      expect(screen.queryByLabelText(/^(Folder|Branch|Worktree):/)).toBeNull();
    });

    it('exposes the full branch name via title on the read-only branch chip', () => {
      renderBar(
        <ChatInputContextBar
          currentBranch={LONG_BRANCH}
          workspaceFolderName="proj"
          worktreePath={null}
        />,
      );

      expect(screen.getByTitle(LONG_BRANCH)).toBeInTheDocument();
    });

    it('exposes the full folder name in the accessible name when the label truncates', () => {
      renderBar(
        <ChatInputContextBar
          currentBranch="main"
          workspaceFolderName={LONG_FOLDER}
          worktreePath="/tmp/proj"
        />,
      );

      expect(screen.getByLabelText(`Folder: ${LONG_FOLDER}`)).toBeInTheDocument();
    });

    it('shows derived worktree label in the worktree slot', () => {
      mockWorktrees = [
        { path: '/tmp/app', branch: 'main', isMain: true, prunable: false },
        { path: '/tmp/worktrees/app/wt-1', branch: 'wt-1', isMain: false, prunable: false },
      ];
      renderBar(
        <ChatInputContextBar
          currentBranch="main"
          workspaceFolderName="app"
          worktreePath="/tmp/worktrees/app/wt-1"
        />,
      );

      expect(screen.getByTestId('branch-selector')).toBeInTheDocument();
      expect(screen.getByLabelText('Worktree: wt-1')).toBeInTheDocument();
      expect(screen.getByText('app')).toBeInTheDocument();
    });
  });

  describe('git branch picker and worktree picker', () => {
    it('renders branch picker for git projects', () => {
      renderBar(
        <ChatInputContextBar
          worktreePath="/tmp/project"
          currentBranch="main"
          workspaceFolderName="project"
        />,
      );

      expect(screen.getByTestId('branch-selector')).toBeInTheDocument();
      expect(screen.getByText('project')).toBeInTheDocument();
    });

    it('shows worktree picker when chatId is provided and linked worktrees exist', () => {
      mockWorktrees = [
        { path: '/tmp/main', branch: 'main', isMain: true, prunable: false },
        {
          path: '/tmp/worktrees/owners-web/zonal-manatee-8369af',
          branch: 'feature',
          isMain: false,
          prunable: false,
        },
      ];
      renderBar(
        <ChatInputContextBar
          worktreePath="/tmp/worktrees/owners-web/zonal-manatee-8369af"
          currentBranch="main"
          workspaceFolderName="owners-web"
          chatId="chat-123"
        />,
      );

      expect(screen.getByTestId('branch-selector')).toBeInTheDocument();
      expect(screen.getByTestId('worktree-picker')).toBeInTheDocument();
      expect(screen.getByText('owners-web')).toBeInTheDocument();
    });

    it('omits the worktree slot when the repo has no linked worktrees', () => {
      mockWorktrees = [{ path: '/tmp/frink', branch: 'main', isMain: true, prunable: false }];
      renderBar(
        <ChatInputContextBar
          worktreePath="/tmp/frink"
          currentBranch="main"
          workspaceFolderName="frink"
          chatId="chat-main-only"
        />,
      );

      expect(screen.queryByTestId('worktree-picker')).not.toBeInTheDocument();
      expect(screen.queryByTestId('worktree-indicator-mock')).not.toBeInTheDocument();
    });

    it('omits the worktree slot while getWorktrees is still loading, never flashing a chip', () => {
      mockWorktreesLoading = true;
      mockWorktrees = [];
      renderBar(
        <ChatInputContextBar
          worktreePath="/tmp/project"
          currentBranch="main"
          workspaceFolderName="project"
          chatId="chat-loading-wt"
        />,
      );

      expect(screen.queryByTestId('worktree-picker')).not.toBeInTheDocument();
      expect(screen.queryByTestId('worktree-indicator-mock')).not.toBeInTheDocument();
    });

    it('falls back to static worktree chip when getWorktrees errors (no interactive picker)', () => {
      mockWorktreesError = true;
      mockWorktrees = [];
      renderBar(
        <ChatInputContextBar
          worktreePath="/tmp/my-repo"
          currentBranch="main"
          workspaceFolderName="my-repo"
          chatId="chat-wt-err"
        />,
      );

      expect(screen.queryByTestId('worktree-picker')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Worktree: my-repo')).toBeInTheDocument();
    });

    it('omits the branch slot when the current branch is unknown', () => {
      renderBar(
        <ChatInputContextBar
          worktreePath="/tmp/project"
          currentBranch={null}
          workspaceFolderName="project"
        />,
      );

      expect(screen.queryByTestId('branch-selector')).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/^Branch:/)).toBeNull();
      expect(screen.getByText('project')).toBeInTheDocument();
    });

    it('renders General chat label in the folder slot', () => {
      renderBar(
        <ChatInputContextBar
          worktreePath={null}
          currentBranch={null}
          workspaceFolderName="General chat"
        />,
      );

      expect(screen.queryByTestId('branch-selector')).not.toBeInTheDocument();
      expect(screen.getByText('General chat')).toBeInTheDocument();
    });

    it('opens delete confirm and calls delete mutation from inline delete action', () => {
      renderBar(
        <ChatInputContextBar
          worktreePath="/tmp/project"
          currentBranch="main"
          workspaceFolderName="project"
        />,
      );
      fireEvent.click(screen.getByText('inline-delete'));
      expect(screen.getByTestId('alert-dialog')).toBeInTheDocument();
      fireEvent.click(screen.getByText('Delete branch'));
      expect(deleteMutate).toHaveBeenCalledWith({
        worktreePath: '/tmp/project',
        branch: 'feature/delete-me',
        force: false,
        deleteRemote: false,
      });
      expect(toastSuccess).toHaveBeenCalledWith("Deleted branch 'feature/delete-me'");
    });

    it('opens dedicated delete dialog from hotkey event and deletes selected branch', async () => {
      renderBar(
        <ChatInputContextBar
          worktreePath="/tmp/project"
          currentBranch="main"
          workspaceFolderName="project"
        />,
      );
      window.dispatchEvent(new Event('branches:open-delete-picker'));
      expect(await screen.findByTestId('delete-branch-dialog')).toBeInTheDocument();
      fireEvent.click(screen.getByText('select-delete-branch'));
      fireEvent.click(screen.getByText('Delete branch'));
      expect(deleteMutate).toHaveBeenCalledWith({
        worktreePath: '/tmp/project',
        branch: 'feature/delete-me',
        force: false,
        deleteRemote: false,
      });
    });

    it('shows info toast when branch picker shortcut is used without git context', () => {
      renderBar(
        <ChatInputContextBar
          worktreePath={null}
          currentBranch={null}
          workspaceFolderName="General chat"
        />,
      );
      window.dispatchEvent(new Event('branches:open-picker'));
      expect(toastInfo).toHaveBeenCalledWith('No git branch context is available in this chat.');
    });

    it('shows info toast when delete picker shortcut has no deletable branches', () => {
      mockBranchData = {
        ...DEFAULT_BRANCH_DATA,
        local: [{ branch: 'main', lastCommitDate: Date.now() }],
      };
      renderBar(
        <ChatInputContextBar
          worktreePath="/tmp/project"
          currentBranch="main"
          workspaceFolderName="project"
        />,
      );
      window.dispatchEvent(new Event('branches:open-delete-picker'));
      expect(toastInfo).toHaveBeenCalledWith('No deletable branches found.');
    });

    it('shows custom unmerged branch message when backend returns not fully merged', () => {
      deleteMutationMode = 'unmerged-error';
      renderBar(
        <ChatInputContextBar
          worktreePath="/tmp/project"
          currentBranch="main"
          workspaceFolderName="project"
        />,
      );
      fireEvent.click(screen.getByText('inline-delete'));
      fireEvent.click(screen.getByText('Delete branch'));
      expect(toastError).toHaveBeenCalledWith(
        "Branch 'feature/delete-me' is not fully merged. Merge it first before deleting.",
      );
    });

    it('shows generic backend error when delete fails for another reason', () => {
      deleteMutationMode = 'generic-error';
      renderBar(
        <ChatInputContextBar
          worktreePath="/tmp/project"
          currentBranch="main"
          workspaceFolderName="project"
        />,
      );
      fireEvent.click(screen.getByText('inline-delete'));
      fireEvent.click(screen.getByText('Delete branch'));
      expect(toastError).toHaveBeenCalledWith('Cannot delete branch due to repository error');
    });

    it('scopes shortcut event handling to active pane', async () => {
      renderBar(
        <>
          <ChatInputContextBar
            worktreePath="/tmp/project-1"
            currentBranch="main"
            workspaceFolderName="project-1"
            isActive={true}
          />
          <ChatInputContextBar
            worktreePath="/tmp/project-2"
            currentBranch="main"
            workspaceFolderName="project-2"
            isActive={false}
          />
        </>,
      );
      window.dispatchEvent(new Event('branches:open-delete-picker'));
      expect(await screen.findAllByTestId('delete-branch-dialog')).toHaveLength(1);
    });

    it('opens branch picker only for the active pane', async () => {
      renderBar(
        <>
          <ChatInputContextBar
            worktreePath="/tmp/project-1"
            currentBranch="main"
            workspaceFolderName="project-1"
            isActive={true}
          />
          <ChatInputContextBar
            worktreePath="/tmp/project-2"
            currentBranch="main"
            workspaceFolderName="project-2"
            isActive={false}
          />
        </>,
      );

      window.dispatchEvent(new Event('branches:open-picker'));

      await waitFor(() => {
        const openStates = screen
          .getAllByTestId('branch-selector-open')
          .map((node) => node.textContent);
        expect(openStates).toEqual(['true', 'false']);
      });
    });

    it('keeps one non-wrapping row with the project leading and never shrinking first', () => {
      renderBar(
        <ChatInputContextBar
          worktreePath="/tmp/project"
          currentBranch="main"
          workspaceFolderName="project"
        />,
      );

      const barRoot = screen.getByTestId('chat-input-branch-bar');
      expect(barRoot).not.toHaveClass('flex-wrap');
      expect(barRoot).toHaveClass('min-w-0', 'overflow-hidden');
      const folder = screen.getByLabelText('Folder: project');
      expect(barRoot.firstElementChild).toBe(folder);
      expect(folder).toHaveClass('shrink-0', 'max-w-[50%]');
      expect(screen.getByText('project')).toHaveClass('truncate');
    });

    it('treats only eligible local branches as deletable', () => {
      renderBar(
        <ChatInputContextBar
          worktreePath="/tmp/project"
          currentBranch="main"
          workspaceFolderName="project"
        />,
      );

      const isDeletable = lastBranchSelectorProps?.isBranchDeletable;
      expect(isDeletable).toBeDefined();
      if (!isDeletable) {
        throw new Error('isBranchDeletable prop was not passed to BranchSelector');
      }

      expect(
        isDeletable({
          name: 'feature/local',
          type: 'local',
          protected: false,
          isDefault: false,
          checkedOutIn: null,
        }),
      ).toBe(true);
      expect(
        isDeletable({
          name: 'origin/main',
          type: 'remote',
          protected: false,
          isDefault: false,
          checkedOutIn: null,
        }),
      ).toBe(false);
      expect(
        isDeletable({
          name: 'main',
          type: 'local',
          protected: false,
          isDefault: true,
          checkedOutIn: null,
        }),
      ).toBe(false);
      expect(
        isDeletable({
          name: 'main',
          type: 'local',
          protected: false,
          isDefault: false,
          checkedOutIn: null,
        }),
      ).toBe(false);
      expect(
        isDeletable({
          name: 'feature/protected',
          type: 'local',
          protected: true,
          isDefault: false,
          checkedOutIn: null,
        }),
      ).toBe(false);
      expect(
        isDeletable({
          name: 'feature/worktree',
          type: 'local',
          protected: false,
          isDefault: false,
          checkedOutIn: '/tmp/other-worktree',
        }),
      ).toBe(false);
    });
  });

  // A busy chat's git controls become read-only cues: a checkout or a worktree re-point would move
  // files under the running agent, and every sub-chat tab shares this one worktree.
  describe('locked by a live run', () => {
    const LINKED_WORKTREES = [
      { path: '/tmp/main', branch: 'main', isMain: true, prunable: false },
      {
        path: '/tmp/worktrees/owners-web/zonal-manatee-8369af',
        branch: 'feature',
        isMain: false,
        prunable: false,
      },
    ];

    function renderLocked(extra?: { chatId?: string }) {
      mockActiveRunChatIds = ['chat-123'];
      return renderBar(
        <ChatInputContextBar
          worktreePath="/tmp/project"
          currentBranch="main"
          workspaceFolderName="project"
          chatId={extra?.chatId ?? 'chat-123'}
        />,
      );
    }

    it('degrades the branch picker to a read-only chip carrying the reason', () => {
      renderLocked();

      expect(screen.queryByTestId('branch-selector')).toBeNull();
      expect(
        screen.getByTitle(/main — Locked while this chat has a run in progress\./),
      ).toBeInTheDocument();
      // The reason must also reach the accessible name, not only the hover title — otherwise the
      // control just goes silently missing for screen-reader users.
      expect(
        screen.getByLabelText('Branch: main — Locked while this chat has a run in progress.'),
      ).toBeInTheDocument();
    });

    it('degrades the worktree picker to the static indicator', () => {
      mockWorktrees = LINKED_WORKTREES;
      renderLocked();

      expect(screen.queryByTestId('worktree-picker')).toBeNull();
      expect(screen.getByTestId('worktree-indicator-mock')).toBeInTheDocument();
    });

    it('keeps the branch picker interactive for a different chat’s run', () => {
      mockWorktrees = LINKED_WORKTREES;
      mockActiveRunChatIds = ['chat-other'];
      renderBar(
        <ChatInputContextBar
          worktreePath="/tmp/project"
          currentBranch="main"
          workspaceFolderName="project"
          chatId="chat-123"
        />,
      );

      expect(screen.getByTestId('branch-selector')).toBeInTheDocument();
      expect(screen.getByTestId('worktree-picker')).toBeInTheDocument();
    });

    it('answers the branch shortcut with the lock reason, not the no-git-context message', () => {
      renderLocked();
      window.dispatchEvent(new Event('branches:open-picker'));

      expect(toastInfo).toHaveBeenCalledWith('Locked while this chat has a run in progress.');
      expect(toastInfo).not.toHaveBeenCalledWith(
        'No git branch context is available in this chat.',
      );
    });

    it('still allows deleting a branch — a deletable branch is never the one in use', async () => {
      renderLocked();
      window.dispatchEvent(new Event('branches:open-delete-picker'));

      expect(await screen.findByTestId('delete-branch-dialog')).toBeInTheDocument();
    });

    it('locks while a sibling sub-chat of the same chat streams', () => {
      store.set(loadingSubChatsAtom, new Map([['sub-other', 'chat-123']]));
      renderBar(
        <ChatInputContextBar
          worktreePath="/tmp/project"
          currentBranch="main"
          workspaceFolderName="project"
          chatId="chat-123"
        />,
      );

      expect(screen.queryByTestId('branch-selector')).toBeNull();
      expect(
        screen.getByLabelText('Branch: main — Locked while this chat has a run in progress.'),
      ).toBeInTheDocument();
    });

    it('restores the picker closed when the chat goes idle, never sprung open', async () => {
      vi.useFakeTimers();
      try {
        store.set(loadingSubChatsAtom, new Map([['sub-other', 'chat-123']]));
        renderBar(
          <ChatInputContextBar
            worktreePath="/tmp/project"
            currentBranch="main"
            workspaceFolderName="project"
            chatId="chat-123"
          />,
        );
        window.dispatchEvent(new Event('branches:open-picker'));

        // Two steps: going idle must commit before its release timer exists to advance.
        await act(async () => {
          store.set(loadingSubChatsAtom, new Map());
        });
        // The release is held past the queue processor's gap between two queued messages.
        await act(async () => {
          vi.advanceTimersByTime(2_000);
        });

        expect(screen.getByTestId('branch-selector')).toBeInTheDocument();
        expect(screen.getByTestId('branch-selector-open')).toHaveTextContent('false');
      } finally {
        vi.useRealTimers();
      }
    });

    it('leaves the folder slot untouched', () => {
      renderLocked();

      expect(screen.getByText('project')).toBeInTheDocument();
    });
  });

  describe('overflow', () => {
    const LINKED = [
      { path: '/tmp/main', branch: 'main', isMain: true, prunable: false },
      { path: '/tmp/worktrees/app/wt-1', branch: 'feat', isMain: false, prunable: false },
    ];

    let layout: ReturnType<typeof stubLayout>;
    afterEach(() => layout.restore());

    it('moves the worktree behind an ellipsis before the branch, keeping the branch picker inline', () => {
      mockWorktrees = LINKED;
      layout = stubLayout(200, 150);
      renderBar(
        <ChatInputContextBar
          worktreePath="/tmp/worktrees/app/wt-1"
          currentBranch="feat"
          workspaceFolderName="app"
          chatId="chat-1"
        />,
      );

      expect(screen.getByLabelText('Folder: app')).toBeInTheDocument();
      expect(screen.getByTestId('branch-selector')).toBeInTheDocument();
      expect(screen.queryByTestId('worktree-picker')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'More: Worktree' }));

      expect(screen.getByText('Worktree')).toBeInTheDocument();
      expect(screen.getByTestId('worktree-picker')).toBeInTheDocument();
    });

    it('re-measures a hidden control when content changes so it returns inline once it fits', () => {
      mockWorktrees = LINKED;
      layout = stubLayout(200, 150);
      const bar = (branch: string) => (
        <ChatInputContextBar
          worktreePath="/tmp/worktrees/app/wt-1"
          currentBranch={branch}
          workspaceFolderName="app"
          chatId="chat-1"
        />
      );
      const { rerender } = renderBar(bar('feature/very-long-branch-name'));
      expect(screen.queryByTestId('worktree-picker')).toBeNull();

      // A shorter branch narrows the chips; the hidden worktree must be measured afresh, not cached.
      layout.set(200, 60);
      rerender(bar('main'));

      expect(screen.queryByRole('button', { name: /^More:/ })).toBeNull();
      expect(screen.getByTestId('worktree-picker')).toBeInTheDocument();
    });

    it('re-measures when content grows while nothing was hidden', () => {
      mockWorktrees = LINKED;
      layout = stubLayout(200, 60);
      const bar = (branch: string) => (
        <ChatInputContextBar
          worktreePath="/tmp/worktrees/app/wt-1"
          currentBranch={branch}
          workspaceFolderName="app"
          chatId="chat-1"
        />
      );
      const { rerender } = renderBar(bar('main'));
      expect(screen.queryByRole('button', { name: /^More:/ })).toBeNull();

      layout.set(200, 150);
      rerender(bar('feature/very-long-branch-name'));

      expect(screen.getByRole('button', { name: 'More: Worktree' })).toBeInTheDocument();
    });

    it('brings the branch back inline when the worktree slot disappears', () => {
      mockWorktrees = LINKED;
      layout = stubLayout(200, 150);
      const { rerender } = renderBar(
        <ChatInputContextBar
          worktreePath="/tmp/worktrees/app/wt-1"
          currentBranch="feat"
          workspaceFolderName="app"
          chatId="chat-1"
        />,
      );
      expect(screen.getByRole('button', { name: 'More: Worktree' })).toBeInTheDocument();

      mockWorktrees = [{ path: '/tmp/main', branch: 'main', isMain: true, prunable: false }];
      rerender(
        <ChatInputContextBar
          worktreePath="/tmp/main"
          currentBranch="feat"
          workspaceFolderName="app"
          chatId="chat-1"
        />,
      );

      expect(screen.queryByRole('button', { name: /^More:/ })).toBeNull();
      expect(screen.getByTestId('branch-selector')).toBeInTheDocument();
    });

    it('collapses every git control when a laid-out row has no width at all', () => {
      mockWorktrees = LINKED;
      layout = stubLayout(0, 150);
      renderBar(
        <ChatInputContextBar
          worktreePath="/tmp/worktrees/app/wt-1"
          currentBranch="feat"
          workspaceFolderName="app"
          chatId="chat-1"
        />,
      );

      expect(screen.queryByTestId('branch-selector')).toBeNull();
      expect(screen.getByRole('button', { name: 'More: Worktree, Branch' })).toBeInTheDocument();
    });

    it('shows no ellipsis when everything fits', () => {
      mockWorktrees = LINKED;
      layout = stubLayout(1000, 150);
      renderBar(
        <ChatInputContextBar
          worktreePath="/tmp/worktrees/app/wt-1"
          currentBranch="feat"
          workspaceFolderName="app"
          chatId="chat-1"
        />,
      );

      expect(screen.queryByRole('button', { name: /^More:/ })).toBeNull();
      expect(screen.getByTestId('worktree-picker')).toBeInTheDocument();
    });
  });
});
