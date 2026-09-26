// @vitest-environment happy-dom

import { useVirtualizer } from '@tanstack/react-virtual';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BranchSelector, type BranchSelectorProps } from './branch-selector';

const FE_HIGHLIGHT_PATTERN = /fe/i;

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: vi.fn(({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({
        index: i,
        key: String(i),
        size: 28,
        start: i * 28,
      })),
    getTotalSize: () => count * 28,
    measure: vi.fn(),
  })),
}));

vi.mock('../../../components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-root">{children}</div>
  ),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-trigger">{children}</div>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

vi.mock('../../../components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="popover-content">{children}</div>
  ),
}));

vi.mock('@benord-labs/frink-primitives', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@benord-labs/frink-primitives')>()),
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));

vi.mock('lucide-react', () => ({
  Check: () => <span data-testid="check-icon" />,
  ChevronDown: () => <span data-testid="chevron-icon" />,
  GitBranch: () => <span data-testid="branch-icon" />,
  Plus: () => <span data-testid="plus-icon" />,
  Search: () => <span data-testid="search-icon" />,
  Trash2: () => <span data-testid="trash-icon" />,
}));

const makeBranch = (
  name: string,
  overrides: Partial<Parameters<typeof Object.assign>[0]> = {},
) => ({
  name,
  type: 'local' as const,
  protected: false,
  isDefault: false,
  committedAt: null,
  authorName: null,
  checkedOutIn: null,
  ...overrides,
});

const defaultProps = (): BranchSelectorProps => ({
  branches: [
    makeBranch('main', { isDefault: true }),
    makeBranch('feat/tooltip'),
    makeBranch('fix/bug-123'),
  ],
  selectedBranch: 'main',
  selectedBranchType: 'local',
  defaultBranch: 'main',
  isLoading: false,
  onBranchSelect: vi.fn(),
  onCreateBranch: vi.fn(),
  isOpen: true,
  onOpenChange: vi.fn(),
  searchQuery: '',
  onSearchChange: vi.fn(),
});

afterEach(cleanup);

describe('BranchSelector', () => {
  it('renders the trigger label in the button', () => {
    render(<BranchSelector {...defaultProps()} />);
    const tooltipTrigger = screen.getByTestId('tooltip-trigger');
    const triggerButton = tooltipTrigger.querySelector('button');
    expect(triggerButton).not.toBeNull();
    expect(triggerButton?.querySelector('.truncate')?.textContent).toBe('main');
  });

  it('uses min-w-0 and max-w-full on the chip trigger so narrow split panes can shrink the label', () => {
    render(<BranchSelector {...defaultProps()} />);
    const triggerButton = screen.getByTestId('tooltip-trigger').querySelector('button');
    expect(triggerButton?.className).toMatch(/min-w-0/);
    expect(triggerButton?.className).toMatch(/max-w-full/);
  });

  it('wraps trigger in a Tooltip', () => {
    render(<BranchSelector {...defaultProps()} />);
    const tooltipContent = screen.getByTestId('tooltip-content');
    expect(tooltipContent.textContent).toBe('main');
  });

  it('shows tooltip content matching selected branch', () => {
    const props = defaultProps();
    props.selectedBranch = 'feat/tooltip';
    render(<BranchSelector {...props} />);
    const tooltipContent = screen.getByTestId('tooltip-content');
    expect(tooltipContent.textContent).toBe('feat/tooltip');
  });

  it('sets aria-label on each virtualised branch option', () => {
    render(<BranchSelector {...defaultProps()} />);
    const options = screen
      .getAllByRole('option')
      .filter((option) => option.getAttribute('aria-label'));
    expect(options).toHaveLength(3);
    expect(options.map((option) => option.getAttribute('aria-label'))).toEqual([
      'main',
      'feat/tooltip',
      'fix/bug-123',
    ]);
  });

  it('calls onBranchSelect when a branch row is clicked', async () => {
    const props = defaultProps();
    render(<BranchSelector {...props} />);
    await userEvent.click(screen.getByRole('option', { name: 'feat/tooltip' }));
    expect(props.onBranchSelect).toHaveBeenCalledWith('feat/tooltip', 'local');
  });

  it('renders delete icon only for deletable rows', async () => {
    const props = defaultProps();
    const onDeleteBranch = vi.fn();
    render(
      <BranchSelector
        {...props}
        onDeleteBranch={onDeleteBranch}
        isBranchDeletable={(branch) => branch.name === 'feat/tooltip'}
      />,
    );

    const deleteButtons = screen
      .getAllByRole('button')
      .filter((button) => button.getAttribute('aria-label')?.startsWith('Delete '));
    expect(deleteButtons).toHaveLength(1);
    expect(deleteButtons[0]?.getAttribute('aria-label')).toBe('Delete feat/tooltip');
    await userEvent.click(deleteButtons[0]);
    expect(onDeleteBranch).toHaveBeenCalledWith('feat/tooltip');
  });

  it('does not switch branch when delete icon is clicked', async () => {
    const props = defaultProps();
    render(
      <BranchSelector
        {...props}
        onDeleteBranch={vi.fn()}
        isBranchDeletable={(branch) => branch.name === 'feat/tooltip'}
      />,
    );
    const deleteButton = screen.getByRole('button', { name: 'Delete feat/tooltip' });
    await userEvent.click(deleteButton);
    expect(props.onBranchSelect).not.toHaveBeenCalled();
  });

  it('highlights the matched query text in branch names', () => {
    const props = defaultProps();
    props.searchQuery = 'tip';
    render(<BranchSelector {...props} />);
    const highlighted = screen.getByText('tip', { selector: 'mark' });
    expect(highlighted).toBeDefined();
  });

  it('highlights repeated and case-insensitive matches', () => {
    const props = defaultProps();
    props.branches = [makeBranch('feature/FE-fe-test')];
    props.searchQuery = 'fe';
    render(<BranchSelector {...props} />);
    const matches = screen.getAllByText(FE_HIGHLIGHT_PATTERN, { selector: 'mark' });
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('handles regex-like search input safely for highlighting', () => {
    const props = defaultProps();
    props.branches = [makeBranch('feature/(x)+')];
    props.searchQuery = '(x)+';
    render(<BranchSelector {...props} />);
    const highlighted = screen.getByText('(x)+', { selector: 'mark' });
    expect(highlighted).toBeDefined();
  });

  it('supports keyboard-only branch selection with Enter', async () => {
    const props = defaultProps();
    render(<BranchSelector {...props} />);
    const targetButton = screen.getByRole('option', { name: 'feat/tooltip' });
    targetButton.focus();
    await userEvent.keyboard('{Enter}');
    expect(props.onBranchSelect).toHaveBeenCalledWith('feat/tooltip', 'local');
  });

  it('supports keyboard-only branch selection with Space', async () => {
    const props = defaultProps();
    render(<BranchSelector {...props} />);
    const targetButton = screen.getByRole('option', { name: 'feat/tooltip' });
    targetButton.focus();
    await userEvent.keyboard(' ');
    expect(props.onBranchSelect).toHaveBeenCalledWith('feat/tooltip', 'local');
  });

  it('ignores out-of-range virtual rows without crashing', async () => {
    const props = defaultProps();
    vi.mocked(useVirtualizer).mockReturnValueOnce({
      getVirtualItems: () => [
        { index: 0, key: '0', size: 28, start: 0 },
        { index: 999, key: '999', size: 28, start: 28 },
      ],
      getTotalSize: () => 56,
      measure: vi.fn(),
    } as never);

    render(<BranchSelector {...props} />);
    await userEvent.click(screen.getByRole('option', { name: 'main' }));
    expect(props.onBranchSelect).toHaveBeenCalledWith('main', 'local');
  });

  it('shows empty state when no branches match', () => {
    const props = defaultProps();
    props.branches = [];
    render(<BranchSelector {...props} />);
    expect(screen.getByText('No branches found.')).toBeDefined();
  });

  it('uses defaultBranch as fallback label when selectedBranch is empty', () => {
    const props = defaultProps();
    props.selectedBranch = '';
    props.defaultBranch = 'develop';
    render(<BranchSelector {...props} />);
    const tooltipContent = screen.getByTestId('tooltip-content');
    expect(tooltipContent.textContent).toBe('develop');
    const triggerSpan = screen.getByTestId('tooltip-trigger').querySelector('.truncate');
    expect(triggerSpan?.textContent).toBe('develop');
  });

  it('shows checkmark for selected branch when selectedBranchType is undefined (name-only match)', () => {
    const props = defaultProps();
    props.selectedBranchType = undefined;
    props.selectedBranch = 'main';
    render(<BranchSelector {...props} />);
    const mainOption = screen.getByRole('option', { name: 'main' });
    expect(mainOption.querySelector('[data-testid="check-icon"]')).not.toBeNull();
  });

  it('puts id on field variant trigger for label association', () => {
    const props = defaultProps();
    render(<BranchSelector {...props} variant="field" id="flow-start-task-branch" />);
    const trigger = document.getElementById('flow-start-task-branch');
    expect(trigger).not.toBeNull();
    expect(trigger?.tagName).toBe('BUTTON');
  });

  it('shows Default branch as field trigger label when onSelectDefault and empty selection', () => {
    const props = defaultProps();
    props.variant = 'field';
    props.id = 'branch-field-trigger';
    props.selectedBranch = '';
    props.defaultBranch = '';
    props.onSelectDefault = vi.fn();
    render(<BranchSelector {...props} />);
    expect(document.getElementById('branch-field-trigger')?.textContent).toContain(
      'Default branch',
    );
  });
});
