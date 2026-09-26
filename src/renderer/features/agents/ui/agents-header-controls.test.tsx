// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentsHeaderControls } from './agents-header-controls';

vi.mock('../../../components/ui/kbd', () => ({
  Kbd: ({ shortcutId }: { shortcutId: string }) => <kbd data-testid={`kbd-${shortcutId}`} />,
}));

vi.mock('../../../components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-root">{children}</div>
  ),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

afterEach(cleanup);

describe('AgentsHeaderControls', () => {
  const onToggle = vi.fn();

  it('renders Open sidebar when the sidebar is closed and not in split view', () => {
    render(
      <AgentsHeaderControls
        isSidebarOpen={false}
        onToggleSidebar={onToggle}
        hasUnseenChanges={false}
      />,
    );
    expect(screen.getByRole('button', { name: 'Open sidebar' })).toBeInTheDocument();
  });

  it('renders Open sidebar on split pane index 0 when the sidebar is closed', () => {
    render(
      <AgentsHeaderControls
        isSidebarOpen={false}
        onToggleSidebar={onToggle}
        splitPaneIndex={0}
        hasUnseenChanges={false}
      />,
    );
    expect(screen.getByRole('button', { name: 'Open sidebar' })).toBeInTheDocument();
  });

  it('does not render Open sidebar on split pane index > 0 when the sidebar is closed', () => {
    render(
      <AgentsHeaderControls
        isSidebarOpen={false}
        onToggleSidebar={onToggle}
        splitPaneIndex={1}
        hasUnseenChanges={false}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Open sidebar' })).toBeNull();
  });

  it('does not render when the sidebar is already open', () => {
    render(
      <AgentsHeaderControls
        isSidebarOpen
        onToggleSidebar={onToggle}
        splitPaneIndex={0}
        hasUnseenChanges={false}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Open sidebar' })).toBeNull();
  });
});
