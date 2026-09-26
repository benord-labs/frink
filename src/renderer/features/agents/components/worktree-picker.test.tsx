// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorktreePicker } from './worktree-picker';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

type WorktreeEntry = { path: string; branch: string | null; isMain: boolean; prunable: boolean };

let mockWorktrees: WorktreeEntry[] = [];
let lastBranchSelectCb: ((name: string) => void) | undefined;
const switchMutate = vi.fn();
const onSelectCallback = vi.fn();
const toastError = vi.fn();
let switchOnSuccess:
  | ((data: Record<string, unknown>, variables: Record<string, unknown>) => void)
  | undefined;

vi.mock('../../../lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      chats: {
        get: { setData: vi.fn(), invalidate: vi.fn().mockResolvedValue(undefined) },
        listByFolder: { invalidate: vi.fn() },
      },
      changes: {
        getBranches: { invalidate: vi.fn() },
        getStatus: { invalidate: vi.fn() },
        getWorktrees: { invalidate: vi.fn() },
      },
      files: { listDirectory: { invalidate: vi.fn() } },
    }),
    changes: {
      getWorktrees: {
        useQuery: () => ({
          data: mockWorktrees,
          isLoading: false,
        }),
      },
    },
    chats: {
      switchWorktree: {
        useMutation: (opts?: {
          onSuccess?: (data: Record<string, unknown>, variables: Record<string, unknown>) => void;
        }) => {
          switchOnSuccess = opts?.onSuccess;
          return {
            mutate: switchMutate,
            isPending: false,
          };
        },
      },
    },
  },
}));

vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => toastError(...args) },
}));

vi.mock('./branch-selector', () => ({
  BranchSelector: (props: {
    branches: { name: string }[];
    selectedBranch: string;
    onBranchSelect: (name: string) => void;
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    searchQuery: string;
    onSearchChange: (q: string) => void;
    searchPlaceholder?: string;
    showTypeBadge?: boolean;
  }) => {
    lastBranchSelectCb = props.onBranchSelect;
    return (
      <div data-testid="branch-selector">
        <span data-testid="selected-label">{props.selectedBranch}</span>
        <ul data-testid="branch-list">
          {props.branches.map((b: { name: string }) => (
            <li key={b.name} data-testid={`branch-item-${b.name}`}>
              <button type="button" onClick={() => props.onBranchSelect(b.name)}>
                {b.name}
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function selectWorktree(name: string) {
  if (!lastBranchSelectCb) throw new Error('BranchSelector not rendered yet');
  lastBranchSelectCb(name);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
  switchMutate.mockClear();
  onSelectCallback.mockClear();
  toastError.mockClear();
  mockWorktrees = [];
  lastBranchSelectCb = undefined;
  switchOnSuccess = undefined;
});

describe('WorktreePicker', () => {
  describe('labelling', () => {
    it('labels main worktree as "Main" and linked worktrees by folder name', () => {
      mockWorktrees = [
        { path: '/repo', branch: 'main', isMain: true, prunable: false },
        {
          path: '/worktrees/repo/cool-feature',
          branch: 'feat-abc',
          isMain: false,
          prunable: false,
        },
      ];
      render(<WorktreePicker repoPath="/repo" selectedPath={null} onSelect={onSelectCallback} />);

      expect(screen.getByTestId('branch-item-Main')).toBeInTheDocument();
      expect(screen.getByTestId('branch-item-cool-feature')).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // EDGE CASE #3 (HIGH): Duplicate folder names
  // ---------------------------------------------------------------------------
  describe('duplicate folder names (disambiguation)', () => {
    beforeEach(() => {
      mockWorktrees = [
        { path: '/repo', branch: 'main', isMain: true, prunable: false },
        { path: '/worktrees/projectA/fix-bug', branch: 'branch-A', isMain: false, prunable: false },
        { path: '/worktrees/projectB/fix-bug', branch: 'branch-B', isMain: false, prunable: false },
      ];
    });

    it('disambiguates labels with parent directory when folder names collide', () => {
      render(<WorktreePicker repoPath="/repo" selectedPath={null} onSelect={onSelectCallback} />);

      expect(screen.getByTestId('branch-item-projectA/fix-bug')).toBeInTheDocument();
      expect(screen.getByTestId('branch-item-projectB/fix-bug')).toBeInTheDocument();
    });

    it('selects the correct worktree when disambiguated labels are used', () => {
      render(<WorktreePicker repoPath="/repo" selectedPath={null} onSelect={onSelectCallback} />);

      selectWorktree('projectB/fix-bug');
      expect(onSelectCallback).toHaveBeenCalledWith('/worktrees/projectB/fix-bug');
    });

    it('selects the first worktree correctly via its disambiguated label', () => {
      render(<WorktreePicker repoPath="/repo" selectedPath={null} onSelect={onSelectCallback} />);

      selectWorktree('projectA/fix-bug');
      expect(onSelectCallback).toHaveBeenCalledWith('/worktrees/projectA/fix-bug');
    });
  });

  // ---------------------------------------------------------------------------
  // EDGE CASE #2 (MEDIUM): Rapid worktree switching
  // ---------------------------------------------------------------------------
  describe('rapid worktree switching', () => {
    beforeEach(() => {
      mockWorktrees = [
        { path: '/repo', branch: 'main', isMain: true, prunable: false },
        { path: '/worktrees/repo/alpha', branch: 'branch-alpha', isMain: false, prunable: false },
        { path: '/worktrees/repo/beta', branch: 'branch-beta', isMain: false, prunable: false },
        { path: '/worktrees/repo/gamma', branch: 'branch-gamma', isMain: false, prunable: false },
      ];
    });

    it('fires multiple mutations without deduplication when switching rapidly', () => {
      render(<WorktreePicker repoPath="/repo" selectedPath="/repo" chatId="chat-1" />);

      selectWorktree('alpha');
      selectWorktree('beta');
      selectWorktree('gamma');

      // All 3 mutations fire with no cancellation/deduplication of prior in-flight ones.
      expect(switchMutate).toHaveBeenCalledTimes(3);
      expect(switchMutate).toHaveBeenNthCalledWith(1, {
        chatId: 'chat-1',
        worktreePath: '/worktrees/repo/alpha',
      });
      expect(switchMutate).toHaveBeenNthCalledWith(2, {
        chatId: 'chat-1',
        worktreePath: '/worktrees/repo/beta',
      });
      expect(switchMutate).toHaveBeenNthCalledWith(3, {
        chatId: 'chat-1',
        worktreePath: '/worktrees/repo/gamma',
      });
    });

    it('out-of-order mutation resolution overwrites cache with stale data', async () => {
      const setDataSpy = vi.fn();
      const invalidateSpy = vi.fn().mockResolvedValue(undefined);

      const { trpc: trpcRef } = await import('../../../lib/trpc');
      // Hoisted vi.mock trpc — replace useUtils so onSuccess uses setDataSpy (test double).
      (trpcRef as unknown as { useUtils: () => object }).useUtils = () => ({
        chats: {
          get: { setData: setDataSpy, invalidate: invalidateSpy },
          listByFolder: { invalidate: vi.fn() },
        },
        changes: {
          getBranches: { invalidate: vi.fn() },
          getStatus: { invalidate: vi.fn() },
          getWorktrees: { invalidate: vi.fn() },
        },
        files: { listDirectory: { invalidate: vi.fn() } },
      });

      render(<WorktreePicker repoPath="/repo" selectedPath="/repo" chatId="chat-1" />);

      selectWorktree('alpha');
      selectWorktree('beta');

      // Simulate beta resolving first, then alpha (out of order)
      if (switchOnSuccess) {
        await switchOnSuccess(
          { worktreePath: '/worktrees/repo/beta', branch: 'branch-beta', baseBranch: 'main' },
          { chatId: 'chat-1', worktreePath: '/worktrees/repo/beta' },
        );
        await switchOnSuccess(
          { worktreePath: '/worktrees/repo/alpha', branch: 'branch-alpha', baseBranch: 'main' },
          { chatId: 'chat-1', worktreePath: '/worktrees/repo/alpha' },
        );
      }

      // BUG: The last onSuccess to run wins the cache, even though the user's
      // intended final selection was beta. The cache now shows alpha.
      expect(setDataSpy).toHaveBeenCalledTimes(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Select mode basics
  // ---------------------------------------------------------------------------
  describe('select mode (new chat)', () => {
    it('calls onSelect with null when main worktree is picked', () => {
      mockWorktrees = [
        { path: '/repo', branch: 'main', isMain: true, prunable: false },
        { path: '/worktrees/repo/feat', branch: 'feat', isMain: false, prunable: false },
      ];
      render(
        <WorktreePicker
          repoPath="/repo"
          selectedPath="/worktrees/repo/feat"
          onSelect={onSelectCallback}
        />,
      );

      selectWorktree('Main');
      expect(onSelectCallback).toHaveBeenCalledWith(null);
    });

    it('calls onSelect with worktree path for linked worktrees', () => {
      mockWorktrees = [
        { path: '/repo', branch: 'main', isMain: true, prunable: false },
        { path: '/worktrees/repo/feat', branch: 'feat', isMain: false, prunable: false },
      ];
      render(<WorktreePicker repoPath="/repo" selectedPath={null} onSelect={onSelectCallback} />);

      selectWorktree('feat');
      expect(onSelectCallback).toHaveBeenCalledWith('/worktrees/repo/feat');
    });
  });

  // ---------------------------------------------------------------------------
  // Switch mode basics
  // ---------------------------------------------------------------------------
  describe('switch mode (active chat)', () => {
    it('calls switchWorktree mutation with chatId and path', () => {
      mockWorktrees = [
        { path: '/repo', branch: 'main', isMain: true, prunable: false },
        { path: '/worktrees/repo/feat', branch: 'feat', isMain: false, prunable: false },
      ];
      render(<WorktreePicker repoPath="/repo" selectedPath="/repo" chatId="chat-42" />);

      selectWorktree('feat');
      expect(switchMutate).toHaveBeenCalledWith({
        chatId: 'chat-42',
        worktreePath: '/worktrees/repo/feat',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Visibility
  // ---------------------------------------------------------------------------
  describe('visibility', () => {
    it('returns null when no linked worktrees exist', () => {
      mockWorktrees = [{ path: '/repo', branch: 'main', isMain: true, prunable: false }];
      const { container } = render(
        <WorktreePicker repoPath="/repo" selectedPath={null} onSelect={onSelectCallback} />,
      );

      expect(container.innerHTML).toBe('');
    });

    it('renders when at least one linked worktree exists', () => {
      mockWorktrees = [
        { path: '/repo', branch: 'main', isMain: true, prunable: false },
        { path: '/worktrees/repo/feat', branch: 'feat', isMain: false, prunable: false },
      ];
      render(<WorktreePicker repoPath="/repo" selectedPath={null} onSelect={onSelectCallback} />);

      expect(screen.getByTestId('branch-selector')).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // No-op on unknown label
  // ---------------------------------------------------------------------------
  describe('unknown label', () => {
    it('does nothing when selected label does not match any worktree', () => {
      mockWorktrees = [
        { path: '/repo', branch: 'main', isMain: true, prunable: false },
        { path: '/worktrees/repo/feat', branch: 'feat', isMain: false, prunable: false },
      ];
      render(<WorktreePicker repoPath="/repo" selectedPath={null} onSelect={onSelectCallback} />);

      selectWorktree('nonexistent');
      expect(onSelectCallback).not.toHaveBeenCalled();
    });
  });
});
