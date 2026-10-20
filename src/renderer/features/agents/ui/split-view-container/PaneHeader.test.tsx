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
  SquareArrowDown: () => <span data-testid="square-arrow-down" />,
  SquareArrowLeft: () => <span data-testid="square-arrow-left" />,
  SquareArrowRight: () => <span data-testid="square-arrow-right" />,
  SquareArrowUp: () => <span data-testid="square-arrow-up" />,
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

    it('activates the pane and asks the sidebar to reveal its chat on cmd-click', async () => {
      const onActivate = vi.fn();
      const onReveal = vi.fn();
      window.addEventListener('sidebar:reveal-active-chat', onReveal);
      render(<PaneHeader {...baseProps()} onActivate={onActivate} />);
      const activateBtn = screen.getByRole('button', { name: FOCUS_PANE_1 });

      await userEvent.click(activateBtn);
      expect(onReveal).not.toHaveBeenCalled();

      const user = userEvent.setup();
      await user.keyboard('{Meta>}');
      await user.click(activateBtn);
      await user.keyboard('{/Meta}');
      window.removeEventListener('sidebar:reveal-active-chat', onReveal);

      expect(onActivate).toHaveBeenCalledTimes(2);
      expect(onReveal).toHaveBeenCalledOnce();
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

  describe('reorder buttons', () => {
    it('uses boxed move arrows, not the chevrons macOS reads as Back/Forward', () => {
      const { container } = render(
        <PaneHeader
          {...baseProps()}
          canMoveLeft
          canMoveRight
          onMoveLeft={vi.fn()}
          onMoveRight={vi.fn()}
        />,
      );

      const left = screen.getByRole('button', { name: 'Move pane 1 left' });
      const right = screen.getByRole('button', { name: 'Move pane 1 right' });
      expect(left.querySelector('[data-testid="square-arrow-left"]')).not.toBeNull();
      expect(right.querySelector('[data-testid="square-arrow-right"]')).not.toBeNull();
      expect(container.querySelector('[data-testid^="chevron-"]')).toBeNull();
    });

    it('uses up/down move arrows in a stacked layout', () => {
      render(
        <PaneHeader
          {...baseProps()}
          isVertical
          canMoveLeft
          canMoveRight
          onMoveLeft={vi.fn()}
          onMoveRight={vi.fn()}
        />,
      );

      expect(
        screen
          .getByRole('button', { name: 'Move pane 1 up' })
          .querySelector('[data-testid="square-arrow-up"]'),
      ).not.toBeNull();
      expect(
        screen
          .getByRole('button', { name: 'Move pane 1 down' })
          .querySelector('[data-testid="square-arrow-down"]'),
      ).not.toBeNull();
    });

    it('disables the move at the end of the row and keeps its shortcut hint', async () => {
      const onMoveLeft = vi.fn();
      render(<PaneHeader {...baseProps()} canMoveLeft={false} onMoveLeft={onMoveLeft} />);

      const left = screen.getByRole('button', { name: 'Move pane 1 left' });
      expect(left).toHaveProperty('disabled', true);
      expect(left.querySelector('[data-testid="square-arrow-left"]')).not.toBeNull();
      await userEvent.click(left);
      expect(onMoveLeft).not.toHaveBeenCalled();
      expect(screen.getByText('Move left')).toBeDefined();
      expect(screen.getByTestId('kbd-reorder-pane-left')).toBeDefined();
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

  describe('header controls', () => {
    it('removes the pane from the split when the close button is clicked', async () => {
      const props = baseProps();
      render(<PaneHeader {...props} />);

      await userEvent.click(screen.getByRole('button', { name: 'Remove pane 1 from split' }));

      expect(props.onClose).toHaveBeenCalledOnce();
    });

    it('moves the pane with the reorder arrows, named for a stacked layout', async () => {
      const onMoveLeft = vi.fn();
      const onMoveRight = vi.fn();
      render(
        <PaneHeader
          {...baseProps()}
          isVertical
          canMoveLeft
          canMoveRight
          onMoveLeft={onMoveLeft}
          onMoveRight={onMoveRight}
        />,
      );

      await userEvent.click(screen.getByRole('button', { name: 'Move pane 1 up' }));
      await userEvent.click(screen.getByRole('button', { name: 'Move pane 1 down' }));

      expect(onMoveLeft).toHaveBeenCalledOnce();
      expect(onMoveRight).toHaveBeenCalledOnce();
    });

    it('shows a zoomed pane its zoom level and resets it on click', async () => {
      const onResetPaneZoom = vi.fn();
      render(
        <PaneHeader
          {...baseProps()}
          zoomFactor={1.25}
          onResetPaneZoom={onResetPaneZoom}
          onMoveLeft={vi.fn()}
        />,
      );

      await userEvent.click(
        screen.getByRole('button', { name: 'Reset zoom to 100% (currently 125%)' }),
      );

      expect(onResetPaneZoom).toHaveBeenCalledOnce();
    });
  });
});
