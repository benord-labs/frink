// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatHeader } from './ChatHeader';

const capturedPaneUtility = vi.hoisted(() => ({
  onToggleTerminal: undefined as (() => void) | undefined,
}));

vi.mock('@benord-labs/frink-primitives', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@benord-labs/frink-primitives')>()),
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));

vi.mock('../../../../../components/ui/kbd', () => ({
  Kbd: ({ shortcutId }: { shortcutId: string }) => <kbd data-testid={`kbd-${shortcutId}`} />,
}));

vi.mock('../../../../../components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-root">{children}</div>
  ),
  TooltipTrigger: ({ children }: { children: React.ReactNode; asChild?: boolean }) => (
    <div data-testid="tooltip-trigger">{children}</div>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode; side?: string }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

vi.mock('../../../hooks/use-file-tree-toggle', () => ({
  useFileTreeToggle: () => ({
    fileTreeOpen: false,
    modifiedFiles: false,
    toggleFileTree: vi.fn(),
  }),
}));

vi.mock('../../../components/pane-utility-buttons', () => ({
  PaneUtilityButtons: (props: Record<string, unknown>) => {
    capturedPaneUtility.onToggleTerminal = props.onToggleTerminal as () => void;
    return <div data-props={JSON.stringify(props)} data-testid="pane-utility-buttons" />;
  },
}));

vi.mock('../../../components/preview-setup-hover-card', () => ({
  PreviewSetupHoverCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../../ui/account-indicator', () => ({
  AccountIndicator: () => <span data-testid="account-indicator" />,
}));

vi.mock('../../../ui/agents-header-controls', () => ({
  AgentsHeaderControls: () => <span data-testid="agents-header-controls" />,
}));

vi.mock('../../../ui/mobile-chat-header', () => ({
  MobileChatHeader: () => <div data-testid="mobile-chat-header" />,
}));

const baseProps = (): React.ComponentProps<typeof ChatHeader> => ({
  isMobileFullscreen: false,
  isSidebarOpen: false,
  onToggleSidebar: vi.fn(),
  splitPaneIndex: undefined,
  hasAnyUnseenChanges: false,
  isPreviewSidebarOpen: false,
  setIsPreviewSidebarOpen: vi.fn(),
  isTerminalSidebarOpen: false,
  setIsTerminalSidebarOpen: vi.fn(),
  setIsDiffSidebarOpen: vi.fn(),
  chatId: 'chat-1',
  gitContextPath: null,
  sandboxId: null,
  canOpenPreview: false,
  canOpenDiff: false,
  diffStats: {
    fileCount: 0,
    additions: 0,
    deletions: 0,
    isLoading: false,
    hasChanges: false,
  },
  isArchived: false,
  taskId: null,
  onBackToChats: vi.fn(),
  onOpenPreview: vi.fn(),
  onOpenDiff: vi.fn(),
  onOpenTerminal: vi.fn(),
  handleRestoreWorkspace: vi.fn(),
  restoreWorkspaceMutationIsPending: false,
});

beforeEach(() => {
  capturedPaneUtility.onToggleTerminal = undefined;
});

afterEach(() => {
  cleanup();
});

function parsePaneUtilityProps(container: HTMLElement) {
  const el = container.querySelector('[data-testid="pane-utility-buttons"]');
  if (!el) return null;
  const raw = el.getAttribute('data-props');
  if (!raw) return null;
  return JSON.parse(raw) as {
    showFileTree?: boolean;
    showDiff?: boolean;
    showTerminal?: boolean;
    terminalOpen?: boolean;
  };
}

describe('ChatHeader', () => {
  it('shows a task badge when chat is task-linked', () => {
    const { getByText } = render(<ChatHeader {...baseProps()} taskId="task-1" />);
    expect(getByText('Task')).toBeInTheDocument();
    // Its word yields to an icon square in a tight header but stays readable to screen readers.
    expect(getByText('Task')).toHaveClass('@max-[26rem]/pane-header:sr-only');
    expect(getByText('Task').parentElement).toHaveAttribute('title', 'Work Queue task');
  });

  it('names the outer header, not the static row, as the pane-header container', () => {
    const { container } = render(<ChatHeader {...baseProps()} splitPaneIndex={0} />);
    expect(container.firstElementChild).toHaveClass('@container/pane-header');
    expect(container.firstElementChild?.firstElementChild).not.toHaveClass(
      '@container/pane-header',
    );
  });

  it('shows pane utility buttons in split view without workspace so every pane has the same header affordances', () => {
    const { getByTestId } = render(
      <ChatHeader {...baseProps()} splitPaneIndex={0} gitContextPath={null} />,
    );
    expect(getByTestId('pane-utility-buttons')).toBeInTheDocument();
  });

  it('does not render pane utilities on mobile fullscreen (desktop controls only)', () => {
    const { container } = render(<ChatHeader {...baseProps()} isMobileFullscreen />);
    expect(container.querySelector('[data-testid="pane-utility-buttons"]')).toBeNull();
  });

  it('passes showFileTree true in split view and false in single pane when workspace is set', () => {
    const { container: single } = render(<ChatHeader {...baseProps()} gitContextPath="/tmp/ws" />);
    expect(parsePaneUtilityProps(single)?.showFileTree).toBe(false);

    const { container: split } = render(
      <ChatHeader {...baseProps()} splitPaneIndex={1} gitContextPath="/tmp/ws" />,
    );
    expect(parsePaneUtilityProps(split)?.showFileTree).toBe(true);
  });

  it('passes showTerminal when workspace is set (single pane)', () => {
    const { container } = render(
      <ChatHeader {...baseProps()} gitContextPath="/tmp/ws" splitPaneIndex={undefined} />,
    );
    expect(parsePaneUtilityProps(container)?.showTerminal).toBe(true);
  });

  it('passes showDiff when diff can be opened', () => {
    const { container } = render(
      <ChatHeader {...baseProps()} canOpenDiff gitContextPath="/tmp/ws" />,
    );
    expect(parsePaneUtilityProps(container)?.showDiff).toBe(true);
  });

  it('does not pass showDiff when diff cannot be opened', () => {
    const { container } = render(
      <ChatHeader {...baseProps()} canOpenDiff={false} gitContextPath="/tmp/ws" />,
    );
    expect(parsePaneUtilityProps(container)?.showDiff).toBe(false);
  });

  it('passes terminalOpen=false to PaneUtilityButtons when terminal is closed', () => {
    const { container } = render(
      <ChatHeader {...baseProps()} isTerminalSidebarOpen={false} gitContextPath="/tmp/ws" />,
    );
    expect(parsePaneUtilityProps(container)?.terminalOpen).toBe(false);
  });

  it('passes terminalOpen=true to PaneUtilityButtons when terminal is open', () => {
    const { container } = render(
      <ChatHeader {...baseProps()} isTerminalSidebarOpen={true} gitContextPath="/tmp/ws" />,
    );
    expect(parsePaneUtilityProps(container)?.terminalOpen).toBe(true);
  });

  it('hides terminal toggle (showTerminal=false) when no workspace is set', () => {
    // When gitContextPath is null, canOpenTerminal is false. Use canOpenDiff to force
    // PaneUtilityButtons to render so we can assert showTerminal is still false.
    const { container } = render(<ChatHeader {...baseProps()} gitContextPath={null} canOpenDiff />);
    expect(parsePaneUtilityProps(container)?.showTerminal).toBe(false);
  });

  it('onToggleTerminal calls setIsTerminalSidebarOpen(true) when terminal is closed', () => {
    const setIsTerminalSidebarOpen = vi.fn();
    render(
      <ChatHeader
        {...baseProps()}
        isTerminalSidebarOpen={false}
        setIsTerminalSidebarOpen={setIsTerminalSidebarOpen}
        gitContextPath="/tmp/ws"
      />,
    );
    capturedPaneUtility.onToggleTerminal?.();
    expect(setIsTerminalSidebarOpen).toHaveBeenCalledWith(true);
  });

  it('onToggleTerminal calls setIsTerminalSidebarOpen(false) when terminal is open', () => {
    const setIsTerminalSidebarOpen = vi.fn();
    render(
      <ChatHeader
        {...baseProps()}
        isTerminalSidebarOpen={true}
        setIsTerminalSidebarOpen={setIsTerminalSidebarOpen}
        gitContextPath="/tmp/ws"
      />,
    );
    capturedPaneUtility.onToggleTerminal?.();
    expect(setIsTerminalSidebarOpen).toHaveBeenCalledWith(false);
  });

  // The shared sidebar control keeps one horizontal seam, so top-level macOS headers clear the
  // traffic lights vertically. Split panes already have PaneHeader above this row.
  describe('macOS traffic-light clearance', () => {
    function setPlatform(platform: 'darwin' | 'win32' | 'linux') {
      (window as unknown as { desktopApi?: { platform: string } }).desktopApi = { platform };
    }

    function rootClassName(container: HTMLElement) {
      return (container.firstElementChild as HTMLElement).className;
    }

    afterEach(() => {
      (window as unknown as { desktopApi?: unknown }).desktopApi = undefined;
    });

    it('adds vertical clearance to the single-pane header when the sidebar is closed', () => {
      setPlatform('darwin');
      const { container } = render(
        <ChatHeader {...baseProps()} isSidebarOpen={false} splitPaneIndex={undefined} />,
      );
      expect(rootClassName(container)).toContain('pt-7');
      expect(rootClassName(container)).not.toContain('pl-20');
    });

    it('keeps the outer header as the split-pane sidebar button containing block', () => {
      setPlatform('darwin');
      const { container } = render(
        <ChatHeader {...baseProps()} isSidebarOpen={false} splitPaneIndex={0} />,
      );

      expect(container.firstElementChild).toHaveClass('relative');
      expect(container.firstElementChild?.firstElementChild).not.toHaveClass('relative');
    });

    it('does not add clearance inside the leftmost split pane', () => {
      setPlatform('darwin');
      const { container } = render(
        <ChatHeader {...baseProps()} isSidebarOpen={false} splitPaneIndex={0} />,
      );
      expect(rootClassName(container)).not.toContain('pt-7');
      expect(rootClassName(container)).not.toContain('pl-20');
    });

    it('does not add clearance inside non-leftmost split panes', () => {
      setPlatform('darwin');
      const { container } = render(
        <ChatHeader {...baseProps()} isSidebarOpen={false} splitPaneIndex={1} />,
      );
      expect(rootClassName(container)).not.toContain('pt-7');
    });

    it('does not add clearance when the sidebar is open', () => {
      setPlatform('darwin');
      const { container } = render(
        <ChatHeader {...baseProps()} isSidebarOpen={true} splitPaneIndex={undefined} />,
      );
      expect(rootClassName(container)).not.toContain('pt-7');
    });

    it('does not add clearance on Windows', () => {
      setPlatform('win32');
      const { container } = render(
        <ChatHeader {...baseProps()} isSidebarOpen={false} splitPaneIndex={undefined} />,
      );
      expect(rootClassName(container)).not.toContain('pt-7');
    });
  });
});
