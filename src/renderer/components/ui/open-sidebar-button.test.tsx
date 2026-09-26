// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenSidebarButton } from './open-sidebar-button';

vi.mock('./kbd', () => ({
  Kbd: ({ shortcutId }: { shortcutId: string }) => <kbd data-testid={`kbd-${shortcutId}`} />,
}));

vi.mock('./tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-root">{children}</div>
  ),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

afterEach(cleanup);

describe('OpenSidebarButton', () => {
  it('renders when the sidebar is closed', () => {
    render(<OpenSidebarButton isSidebarOpen={false} onOpenSidebar={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Open sidebar' })).toBeInTheDocument();
  });

  it('renders nothing when the sidebar is already open', () => {
    render(<OpenSidebarButton isSidebarOpen onOpenSidebar={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Open sidebar' })).toBeNull();
  });

  // Electron's -webkit-app-region: drag can't be modeled in happy-dom, so a missing
  // no-drag opt-out here would silently ship a button that only drags the window
  // when embedded in a drag-region header (e.g. Work Queue's).
  it('opts out of an ancestor drag region', () => {
    render(<OpenSidebarButton isSidebarOpen={false} onOpenSidebar={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Open sidebar' })).toHaveClass('no-drag');
  });

  it('reserves its header slot while aligning the visible control to the shared seam', () => {
    render(<OpenSidebarButton isSidebarOpen={false} onOpenSidebar={vi.fn()} />);

    const button = screen.getByRole('button', { name: 'Open sidebar' });
    const slot = button.closest('span');
    expect(slot).toHaveClass('block', 'h-6', 'shrink-0');
    // The slot ends where the offset button ends, so the next header control keeps the usual gap.
    expect(slot).toHaveClass(
      'w-[calc(var(--open-sidebar-button-left,1rem)+1.5rem-var(--open-sidebar-slot-start,0.5rem))]',
    );
    expect(button).toHaveClass(
      '[position:var(--open-sidebar-button-position,absolute)]',
      '[zoom:calc(1/var(--pane-zoom-factor,1))]',
    );
  });

  it('can flatten its wrapper when the consumer does not need a reserved title slot', () => {
    render(
      <OpenSidebarButton
        isSidebarOpen={false}
        onOpenSidebar={vi.fn()}
        reserveLayoutSpace={false}
      />,
    );

    const wrapper = screen.getByRole('button', { name: 'Open sidebar' }).closest('span');
    expect(wrapper).toHaveClass('contents');
    expect(wrapper).not.toHaveClass('block', 'h-6', 'w-6');
  });

  it('invokes onOpenSidebar when clicked', () => {
    const onOpenSidebar = vi.fn();
    render(<OpenSidebarButton isSidebarOpen={false} onOpenSidebar={onOpenSidebar} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }));

    expect(onOpenSidebar).toHaveBeenCalledOnce();
  });

  it('shows the unseen-changes indicator when requested', () => {
    const { container } = render(
      <OpenSidebarButton isSidebarOpen={false} onOpenSidebar={vi.fn()} hasUnseenChanges />,
    );
    expect(container.querySelector('.bg-pane-accent')).toBeInTheDocument();
  });

  it('omits the unseen-changes indicator by default', () => {
    const { container } = render(
      <OpenSidebarButton isSidebarOpen={false} onOpenSidebar={vi.fn()} />,
    );
    expect(container.querySelector('.bg-pane-accent')).toBeNull();
  });
});
