// @vitest-environment happy-dom

import { useVirtualizer } from '@tanstack/react-virtual';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeleteBranchDialog } from './delete-branch-dialog';

const DELETE_BRANCH_NAME_PATTERN = /feature\/delete-target/i;
const FE_HIGHLIGHT_PATTERN = /fe/i;
const LARGE_BRANCH_BUTTON_PATTERN = /feature\/\s*branch-1199/i;

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: vi.fn(({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: String(index),
        size: 32,
        start: index * 32,
      })),
    getTotalSize: () => count * 32,
    measure: vi.fn(),
  })),
}));

vi.mock('../../../components/ui/dialog', () => ({
  Dialog: ({
    open,
    children,
    onOpenChange,
  }: {
    open: boolean;
    children: ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) =>
    open ? (
      <div>
        <button type="button" onClick={() => onOpenChange?.(false)}>
          close-dialog
        </button>
        {children}
      </div>
    ) : null,
  CanvasDialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CanvasDialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CanvasDialogBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

afterEach(cleanup);

describe('DeleteBranchDialog', () => {
  it('highlights matched query text in branch rows', () => {
    render(
      <DeleteBranchDialog
        open={true}
        onOpenChange={vi.fn()}
        branches={[
          { name: 'feature/delete-target', committedAt: null },
          { name: 'chore/other', committedAt: null },
        ]}
        searchQuery="delete"
        onSearchChange={vi.fn()}
        onBranchSelect={vi.fn()}
      />,
    );
    expect(screen.getByText('delete', { selector: 'mark' })).toBeDefined();
  });

  it('calls onBranchSelect when a branch is clicked', async () => {
    const onBranchSelect = vi.fn();
    render(
      <DeleteBranchDialog
        open={true}
        onOpenChange={vi.fn()}
        branches={[{ name: 'feature/delete-target', committedAt: null }]}
        searchQuery=""
        onSearchChange={vi.fn()}
        onBranchSelect={onBranchSelect}
      />,
    );
    await userEvent.click(screen.getByRole('option', { name: DELETE_BRANCH_NAME_PATTERN }));
    expect(onBranchSelect).toHaveBeenCalledWith('feature/delete-target');
  });

  it('highlights repeated and case-insensitive matches', () => {
    render(
      <DeleteBranchDialog
        open={true}
        onOpenChange={vi.fn()}
        branches={[{ name: 'feature/FE-fe-case', committedAt: null }]}
        searchQuery="fe"
        onSearchChange={vi.fn()}
        onBranchSelect={vi.fn()}
      />,
    );
    const matches = screen.getAllByText(FE_HIGHLIGHT_PATTERN, { selector: 'mark' });
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('handles regex-like search text without throwing', () => {
    render(
      <DeleteBranchDialog
        open={true}
        onOpenChange={vi.fn()}
        branches={[{ name: 'feature/(x)+', committedAt: null }]}
        searchQuery="(x)+"
        onSearchChange={vi.fn()}
        onBranchSelect={vi.fn()}
      />,
    );
    expect(screen.getByText('(x)+', { selector: 'mark' })).toBeDefined();
  });

  it('supports keyboard-only branch selection with Enter', async () => {
    const onBranchSelect = vi.fn();
    render(
      <DeleteBranchDialog
        open={true}
        onOpenChange={vi.fn()}
        branches={[{ name: 'feature/delete-target', committedAt: null }]}
        searchQuery=""
        onSearchChange={vi.fn()}
        onBranchSelect={onBranchSelect}
      />,
    );
    const branchButton = screen.getByRole('option', { name: DELETE_BRANCH_NAME_PATTERN });
    branchButton.focus();
    await userEvent.keyboard('{Enter}');
    expect(onBranchSelect).toHaveBeenCalledWith('feature/delete-target');
  });

  it('ignores out-of-range virtual rows without crashing', async () => {
    const onBranchSelect = vi.fn();
    vi.mocked(useVirtualizer).mockReturnValueOnce({
      getVirtualItems: () => [
        { index: 0, key: '0', size: 32, start: 0 },
        { index: 999, key: '999', size: 32, start: 32 },
      ],
      getTotalSize: () => 64,
      measure: vi.fn(),
    } as never);

    render(
      <DeleteBranchDialog
        open={true}
        onOpenChange={vi.fn()}
        branches={[{ name: 'feature/delete-target', committedAt: null }]}
        searchQuery=""
        onSearchChange={vi.fn()}
        onBranchSelect={onBranchSelect}
      />,
    );

    await userEvent.click(screen.getByRole('option', { name: DELETE_BRANCH_NAME_PATTERN }));
    expect(onBranchSelect).toHaveBeenCalledWith('feature/delete-target');
  });

  it('renders large branch lists and keeps search behavior stable', () => {
    const branches = Array.from({ length: 1200 }, (_, index) => ({
      name: `feature/branch-${index}`,
      committedAt: null,
    }));
    render(
      <DeleteBranchDialog
        open={true}
        onOpenChange={vi.fn()}
        branches={branches}
        searchQuery="branch-1199"
        onSearchChange={vi.fn()}
        onBranchSelect={vi.fn()}
      />,
    );
    expect(screen.getByRole('option', { name: LARGE_BRANCH_BUTTON_PATTERN })).toBeDefined();
  });

  it('clears search query when dialog closes', () => {
    const onSearchChange = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <DeleteBranchDialog
        open={true}
        onOpenChange={onOpenChange}
        branches={[{ name: 'feature/delete-target', committedAt: null }]}
        searchQuery="delete"
        onSearchChange={onSearchChange}
        onBranchSelect={vi.fn()}
      />,
    );
    screen.getByRole('button', { name: 'close-dialog' }).click();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSearchChange).toHaveBeenCalledWith('');
  });
});
