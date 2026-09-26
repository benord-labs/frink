// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubLayout } from '@/lib/hooks/priority-overflow/layout-stub';

vi.mock('../ProjectSelector', () => ({
  ProjectSelector: () => <div data-testid="project-selector" />,
}));
vi.mock('../components/work-mode-selector', () => ({
  WorkModeSelector: () => <div data-testid="work-mode" />,
}));
vi.mock('../components/branch-selector', () => ({
  BranchSelector: () => <div data-testid="branch-selector" />,
}));
vi.mock('../components/create-branch-dialog', () => ({
  CreateBranchDialog: () => null,
}));

import { ProjectSelectionSection } from './ProjectSelectionSection';

let layout: ReturnType<typeof stubLayout> | undefined;

afterEach(() => {
  cleanup();
  layout?.restore();
  layout = undefined;
});

const PROJECT = { id: 'p1', name: 'P', path: '/tmp/p' };

function renderSection(props: {
  workMode: 'local' | 'worktree';
  localBranchCheckoutPicker?: React.ReactNode;
}) {
  return render(
    <ProjectSelectionSection
      project={PROJECT}
      branches={[]}
      selectedBranch=""
      selectedBranchType={undefined}
      defaultBranch="main"
      isLoadingBranches={false}
      isCreatingChat={false}
      branchSearch=""
      branchPopoverOpen={false}
      createBranchDialogOpen={false}
      onWorkModeChange={() => {}}
      onBranchSelect={() => {}}
      onBranchSearchChange={() => {}}
      onBranchPopoverOpenChange={() => {}}
      onCreateBranchDialogOpenChange={() => {}}
      onBranchCreated={() => {}}
      {...props}
    />,
  );
}

const LOCAL_PICKER = <span data-testid="local-branch-slot">branch</span>;

describe('ProjectSelectionSection', () => {
  it('renders localBranchCheckoutPicker after WorkModeSelector in local mode', () => {
    renderSection({ workMode: 'local', localBranchCheckoutPicker: LOCAL_PICKER });
    expect(screen.getByTestId('local-branch-slot')).toHaveTextContent('branch');
  });

  it('never wraps: the row clips residue instead of stacking selectors in a narrow pane', () => {
    renderSection({ workMode: 'local' });
    const row = screen.getByTestId('project-selection-row');
    expect(row).toHaveClass('overflow-hidden', 'min-w-0');
    expect(row).not.toHaveClass('flex-wrap');
  });

  it('does not render localBranchCheckoutPicker in worktree mode', () => {
    renderSection({ workMode: 'worktree', localBranchCheckoutPicker: LOCAL_PICKER });
    expect(screen.queryByTestId('local-branch-slot')).not.toBeInTheDocument();
  });

  describe('overflow', () => {
    it('moves work mode behind an ellipsis before the branch, keeping the branch picker inline', () => {
      layout = stubLayout(200, 150);
      renderSection({ workMode: 'worktree' });

      expect(screen.getByTestId('branch-selector')).toBeInTheDocument();
      expect(screen.queryByTestId('work-mode')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'More: Mode' }));

      expect(screen.getByText('Mode')).toBeInTheDocument();
      expect(screen.getByTestId('work-mode')).toBeInTheDocument();
    });

    it('shows no ellipsis when everything fits', () => {
      layout = stubLayout(1000, 150);
      renderSection({ workMode: 'local', localBranchCheckoutPicker: LOCAL_PICKER });

      expect(screen.queryByRole('button', { name: /^More:/ })).toBeNull();
      expect(screen.getByTestId('work-mode')).toBeInTheDocument();
      expect(screen.getByTestId('local-branch-slot')).toBeInTheDocument();
    });

    it('re-measures when an inline control grows in place, without any prop changing', () => {
      layout = stubLayout(200, 60);
      renderSection({ workMode: 'local', localBranchCheckoutPicker: LOCAL_PICKER });
      expect(screen.queryByRole('button', { name: /^More:/ })).toBeNull();

      // A checkout to a longer branch name widens the chip; nothing above re-renders the row.
      layout.set(200, 150);
      act(() => layout?.fire());

      expect(screen.getByRole('button', { name: 'More: Mode' })).toBeInTheDocument();
      expect(screen.getByTestId('local-branch-slot')).toBeInTheDocument();
    });
  });
});
