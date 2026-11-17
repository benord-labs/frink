// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { getBranchesUseQuery, fetchBranches } = vi.hoisted(() => ({
  getBranchesUseQuery: vi.fn(
    (_input: { worktreePath: string }, _options: { enabled: boolean }) => ({
      data: undefined,
      isLoading: false,
    }),
  ),
  // transformBranchData is stubbed below to pass this list through as-is
  fetchBranches: vi.fn(async () => [{ name: 'old', type: 'local' }]),
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      changes: {
        getBranches: { invalidate: vi.fn(), fetch: fetchBranches },
        getStatus: { invalidate: vi.fn() },
      },
    }),
    changes: {
      getBranches: { useQuery: getBranchesUseQuery },
      switchBranch: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
      deleteBranch: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
    },
  },
}));

const { toastInfo } = vi.hoisted(() => ({ toastInfo: vi.fn() }));
vi.mock('sonner', () => ({
  toast: { info: toastInfo, error: vi.fn() },
}));

vi.mock('../../../../../lib/branch-normalization', () => ({
  transformBranchData: (x: unknown) => x ?? [],
}));

vi.mock('../../../components/branch-selector', () => ({
  BranchSelector: () => null,
}));
vi.mock('../../../components/create-branch-dialog', () => ({
  CreateBranchDialog: () => null,
}));
vi.mock('../../../components/delete-branch-dialog', () => ({
  DeleteBranchDialog: () => null,
}));

vi.mock('@/components/ui/alert-dialog', () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  return {
    AlertDialog: Passthrough,
    AlertDialogContent: Passthrough,
    AlertDialogHeader: Passthrough,
    AlertDialogFooter: Passthrough,
    AlertDialogTitle: Passthrough,
    AlertDialogDescription: Passthrough,
    AlertDialogCancel: Passthrough,
    AlertDialogAction: Passthrough,
  };
});

import { GitBranchCheckout } from './git-branch-checkout';

const lastEnabled = () => getBranchesUseQuery.mock.lastCall?.[1].enabled;

describe('GitBranchCheckout getBranches query enabled', () => {
  it('stays off without git context, and loads only once the picker opens', () => {
    getBranchesUseQuery.mockClear();

    const { rerender } = render(
      <GitBranchCheckout worktreePath="/repo" currentBranch={null} isActive>
        {() => null}
      </GitBranchCheckout>,
    );
    expect(lastEnabled()).toBe(false);

    rerender(
      <GitBranchCheckout worktreePath="/repo" currentBranch="main" isActive>
        {() => null}
      </GitBranchCheckout>,
    );
    // Listing every branch and worktree is costly; nothing on screen needs it until the picker opens
    expect(lastEnabled()).toBe(false);

    act(() => {
      window.dispatchEvent(new Event('branches:open-picker'));
    });
    expect(lastEnabled()).toBe(true);
  });

  it('reads the list before opening the delete picker from the keyboard, even while locked', async () => {
    fetchBranches.mockClear();
    fetchBranches.mockResolvedValueOnce([]);
    toastInfo.mockClear();

    render(
      <GitBranchCheckout worktreePath="/repo" currentBranch="main" isActive locked>
        {() => null}
      </GitBranchCheckout>,
    );
    await act(async () => {
      window.dispatchEvent(new Event('branches:open-delete-picker'));
    });

    expect(fetchBranches).toHaveBeenCalledWith({ worktreePath: '/repo' });
    expect(toastInfo).toHaveBeenCalledWith('No deletable branches found.');
  });

  it('opens the delete picker once the list shows a deletable branch', async () => {
    getBranchesUseQuery.mockClear();
    fetchBranches.mockClear();

    render(
      <GitBranchCheckout worktreePath="/repo" currentBranch="main" isActive>
        {() => null}
      </GitBranchCheckout>,
    );
    await act(async () => {
      window.dispatchEvent(new Event('branches:open-delete-picker'));
    });

    expect(fetchBranches).toHaveBeenCalledOnce();
    expect(lastEnabled()).toBe(true);
  });
});
