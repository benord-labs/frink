// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const { getBranchesUseQuery } = vi.hoisted(() => ({
  getBranchesUseQuery: vi.fn(() => ({ data: undefined, isLoading: false })),
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      changes: {
        getBranches: { invalidate: vi.fn() },
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

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), error: vi.fn() },
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

describe('GitBranchCheckout getBranches query enabled', () => {
  it('tracks git context: disabled without non-empty currentBranch, enabled once branch is set', () => {
    getBranchesUseQuery.mockClear();

    const { rerender } = render(
      <GitBranchCheckout worktreePath="/repo" currentBranch={null} isActive>
        {() => null}
      </GitBranchCheckout>,
    );

    expect(getBranchesUseQuery).toHaveBeenLastCalledWith(
      { worktreePath: '/repo' },
      expect.objectContaining({ enabled: false }),
    );

    rerender(
      <GitBranchCheckout worktreePath="/repo" currentBranch="" isActive>
        {() => null}
      </GitBranchCheckout>,
    );
    expect(getBranchesUseQuery).toHaveBeenLastCalledWith(
      { worktreePath: '/repo' },
      expect.objectContaining({ enabled: false }),
    );

    rerender(
      <GitBranchCheckout worktreePath="/repo" currentBranch="main" isActive>
        {() => null}
      </GitBranchCheckout>,
    );
    expect(getBranchesUseQuery).toHaveBeenLastCalledWith(
      { worktreePath: '/repo' },
      expect.objectContaining({ enabled: true }),
    );
  });

  it('stays enabled while locked, so unlocking costs no loading tick and delete keeps its list', () => {
    getBranchesUseQuery.mockClear();

    render(
      <GitBranchCheckout worktreePath="/repo" currentBranch="main" isActive locked>
        {() => null}
      </GitBranchCheckout>,
    );

    expect(getBranchesUseQuery).toHaveBeenLastCalledWith(
      { worktreePath: '/repo' },
      expect.objectContaining({ enabled: true }),
    );
  });
});
