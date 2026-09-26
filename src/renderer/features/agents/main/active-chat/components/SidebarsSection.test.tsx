// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SidePanelDockHost } from '../../../../../components/SidePanelDock';
import { splitViewAtom } from '../../../atoms';
import { SidebarsSection } from './SidebarsSection';

vi.mock('../../../../../features/terminal/terminal-sidebar', () => ({
  TerminalSidebar: ({ cwd }: { cwd: string }) => (
    <div data-cwd={cwd} data-testid="terminal-sidebar" />
  ),
}));

vi.mock('../../../../../components/ui/resizable-sidebar', () => ({
  ResizableSidebar: ({ children, isOpen }: { children: ReactNode; isOpen: boolean }) =>
    isOpen ? <div data-testid="resizable-sidebar">{children}</div> : null,
}));

vi.mock('../../../ui/agent-preview', () => ({
  AgentPreview: () => <div data-testid="agent-preview" />,
}));

vi.mock('./EmptyPreviewState', () => ({
  EmptyPreviewState: () => <div data-testid="empty-preview-state" />,
}));

afterEach(cleanup);

function baseProps(): ComponentProps<typeof SidebarsSection> {
  return {
    isActive: true,
    isMobileFullscreen: false,
    canOpenDiff: false,
    isDiffSidebarOpen: false,
    setIsDiffSidebarOpen: vi.fn(),
    diffPanel: null,
    gitContextPath: null,
    chatId: 'chat-1',
    sandboxId: null,
    repository: null,
    canOpenPreview: false,
    isPreviewSidebarOpen: false,
    setIsPreviewSidebarOpen: vi.fn(),
    isQuickSetup: false,
    previewPort: null,
  };
}

describe('SidebarsSection git context gating', () => {
  it('renders the terminal sidebar when gitContextPath exists', () => {
    render(<SidebarsSection {...baseProps()} gitContextPath="/tmp/owners-web" />);

    expect(screen.getByTestId('terminal-sidebar')).toHaveAttribute('data-cwd', '/tmp/owners-web');
  });

  it('does not render the terminal sidebar for general or virtual-like context', () => {
    render(<SidebarsSection {...baseProps()} gitContextPath={null} />);

    expect(screen.queryByTestId('terminal-sidebar')).not.toBeInTheDocument();
  });
});

describe('SidebarsSection diff panel', () => {
  const diffPanel = <div data-testid="diff-panel" />;

  it('renders the diff panel when open', () => {
    render(
      <SidebarsSection {...baseProps()} canOpenDiff isDiffSidebarOpen diffPanel={diffPanel} />,
    );
    expect(screen.getByTestId('diff-panel')).toBeInTheDocument();
  });

  it('keeps the diff panel out of mobile fullscreen', () => {
    render(
      <SidebarsSection
        {...baseProps()}
        canOpenDiff
        isDiffSidebarOpen
        isMobileFullscreen
        diffPanel={diffPanel}
      />,
    );
    expect(screen.queryByTestId('diff-panel')).not.toBeInTheDocument();
  });
});

describe('SidebarsSection docking', () => {
  function renderWithDock(splitChatIds: string[], dockHidden = false) {
    const store = createStore();
    store.set(splitViewAtom, (prev) => ({ ...prev, chatIds: splitChatIds }));
    render(
      <Provider store={store}>
        <div data-testid="dock">
          <SidePanelDockHost hidden={dockHidden} />
        </div>
        <div data-testid="pane">
          <SidebarsSection {...baseProps()} gitContextPath="/repo" />
        </div>
      </Provider>,
    );
  }

  it("moves a single chat's panels into the dock beside the main pane", () => {
    renderWithDock([]);
    expect(within(screen.getByTestId('dock')).getByTestId('terminal-sidebar')).toBeInTheDocument();
  });

  it("keeps a split pane's panels inside the pane", () => {
    renderWithDock(['chat-1', 'chat-2']);
    expect(within(screen.getByTestId('pane')).getByTestId('terminal-sidebar')).toBeInTheDocument();
  });

  it('hides and disables docked panels while Work Queue covers the chat', () => {
    renderWithDock([], true);
    const dock = screen.getByTestId('dock').firstElementChild;
    expect(dock).toHaveAttribute('hidden');
    expect(dock).toHaveAttribute('inert');
    expect(within(screen.getByTestId('dock')).getByTestId('terminal-sidebar')).toBeInTheDocument();
  });
});
