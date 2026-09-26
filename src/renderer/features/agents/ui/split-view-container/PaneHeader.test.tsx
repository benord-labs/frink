// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaneHeader } from './PaneHeader';

// PaneHeader renders PaneReorderHandleButton when paneReorderIndex is set, which calls
// useDraggable internally. Mock dnd-kit so tests don't need a full DndContext provider.
vi.mock('@dnd-kit/core', () => ({
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    isDragging: false,
  }),
}));

vi.mock('../../../../components/ui/tooltip', () => ({
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

vi.mock('../../../../components/ui/kbd', () => ({
  Kbd: ({ shortcutId }: { shortcutId: string }) => <kbd data-testid={`kbd-${shortcutId}`} />,
}));

vi.mock('lucide-react', () => ({
  ChevronDown: () => <span data-testid="chevron-down" />,
  ChevronLeft: () => <span data-testid="chevron-left" />,
  ChevronRight: () => <span data-testid="chevron-right" />,
  ChevronUp: () => <span data-testid="chevron-up" />,
  GripVertical: () => <span data-testid="grip-vertical" />,
}));

const FOCUS_PANE_1 = /focus pane 1/i;
const FOCUS_PANE = /focus pane/i;

const baseProps = () => ({
  paneNumber: 1,
  paneIndex: 0,
  isActive: false,
  onClose: vi.fn(),
});

afterEach(cleanup);

describe('PaneHeader', () => {
  describe('onActivate button behaviour', () => {
    it('wraps badge+label in a button when onActivate is provided', () => {
      const onActivate = vi.fn();
      render(<PaneHeader {...baseProps()} onActivate={onActivate} />);

      const activateBtn = screen.getByRole('button', { name: FOCUS_PANE_1 });
      expect(activateBtn).toBeDefined();
    });

    it('calls onActivate when the activate button is clicked', async () => {
      const onActivate = vi.fn();
      render(<PaneHeader {...baseProps()} onActivate={onActivate} />);

      const activateBtn = screen.getByRole('button', { name: FOCUS_PANE_1 });
      await userEvent.click(activateBtn);
      expect(onActivate).toHaveBeenCalledOnce();
    });

    it('does not render an activate button when onActivate is absent', () => {
      render(<PaneHeader {...baseProps()} />);

      const activateBtn = screen.queryByRole('button', { name: FOCUS_PANE });
      expect(activateBtn).toBeNull();
    });

    it('omits aria-label on the activate button when pane is already active', () => {
      const onActivate = vi.fn();
      render(<PaneHeader {...baseProps()} isActive onActivate={onActivate} />);

      const buttons = screen.getAllByRole('button');
      const activateBtn = buttons.find(
        (b) =>
          !b.getAttribute('aria-label')?.includes('Remove') &&
          !b.getAttribute('aria-label')?.includes('Drag'),
      );
      expect(activateBtn?.getAttribute('aria-label')).toBeNull();
    });
  });

  describe('display label with totalPanes', () => {
    it('shows "Pane N · label" when totalPanes >= 2', () => {
      render(<PaneHeader {...baseProps()} label="My Chat" totalPanes={2} />);

      expect(screen.getByText('Pane 1 · My Chat')).toBeDefined();
    });

    it('shows just the label when totalPanes < 2', () => {
      render(<PaneHeader {...baseProps()} label="My Chat" totalPanes={1} />);

      const triggers = screen.getAllByTestId('tooltip-trigger');
      const labelSpan = triggers[0].querySelector('.truncate');
      expect(labelSpan?.textContent).toBe('My Chat');
      expect(screen.queryByText('Pane 1 · My Chat')).toBeNull();
    });

    it('shows just the label when totalPanes is undefined', () => {
      render(<PaneHeader {...baseProps()} label="My Chat" />);

      const triggers = screen.getAllByTestId('tooltip-trigger');
      const labelSpan = triggers[0].querySelector('.truncate');
      expect(labelSpan?.textContent).toBe('My Chat');
      expect(screen.queryByText('Pane 1 · My Chat')).toBeNull();
    });

    it('falls back to "Chat" when label is undefined', () => {
      render(<PaneHeader {...baseProps()} totalPanes={3} />);

      expect(screen.getByText('Pane 1 · Chat')).toBeDefined();
    });
  });

  describe('pane number badge', () => {
    it('renders compact digit badge (not PermissionPrompt PANE chip)', () => {
      render(<PaneHeader {...baseProps()} paneNumber={2} paneIndex={1} />);

      expect(screen.getByTitle('Displayed in pane 2')).toBeDefined();
    });
  });

  describe('active indicator', () => {
    it('shows "Active" badge when isActive is true', () => {
      render(<PaneHeader {...baseProps()} isActive />);

      expect(screen.getByText('Active')).toBeDefined();
    });

    it('does not show "Active" badge when isActive is false', () => {
      render(<PaneHeader {...baseProps()} isActive={false} />);

      expect(screen.queryByText('Active')).toBeNull();
    });
  });

  describe('compact pane chrome', () => {
    const COMPACT_HIDDEN = '@max-[30rem]/pane:hidden';

    it('sheds the reorder arrows, their separator and the Active chip below the Compact tier', () => {
      const { container } = render(
        <PaneHeader
          {...baseProps()}
          isActive
          paneReorderIndex={0}
          onMoveLeft={vi.fn()}
          onMoveRight={vi.fn()}
        />,
      );

      for (const arrow of screen.getAllByRole('button', { name: /^move pane 1/i })) {
        expect(arrow.className).toContain(COMPACT_HIDDEN);
      }
      expect(screen.getByText('Active').className).toContain(COMPACT_HIDDEN);
      expect(container.querySelector('.w-px')?.className).toContain(COMPACT_HIDDEN);
    });

    it('keeps the drag handle, label and close button in a Compact pane', () => {
      render(
        <PaneHeader {...baseProps()} label="My Chat" paneReorderIndex={0} onMoveLeft={vi.fn()} />,
      );

      for (const name of [/drag to reorder pane/i, /remove pane 1 from split/i]) {
        expect(screen.getByRole('button', { name }).className).not.toContain(COMPACT_HIDDEN);
      }
      expect(
        screen.getAllByTestId('tooltip-trigger')[0].querySelector('.truncate')?.className,
      ).not.toContain(COMPACT_HIDDEN);
    });
  });

  describe('pane-reorder drag handle', () => {
    it('renders the grab-dots drag handle when paneReorderIndex is provided', () => {
      render(<PaneHeader {...baseProps()} paneReorderIndex={0} />);

      expect(screen.getByRole('button', { name: /drag to reorder pane/i })).toBeDefined();
    });

    it('does not render the drag handle when paneReorderIndex is undefined', () => {
      render(<PaneHeader {...baseProps()} />);

      expect(screen.queryByRole('button', { name: /drag to reorder pane/i })).toBeNull();
    });
  });
});
