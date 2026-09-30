// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { type ReactElement, type ReactNode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useWorkQueueDestination } from '@/lib/work-queue/use-work-queue-destination';
import { AgentsDestinationPane } from './index';

const agentsContentState = vi.hoisted(() => ({
  showChatInput: true,
  showHiddenChatInputFirst: false,
}));

vi.mock('@/features/agents', () => ({
  AgentsContent: () => (
    <div data-testid="agents-content">
      {agentsContentState.showHiddenChatInputFirst ? (
        <div aria-hidden="true">
          {/* biome-ignore lint/a11y/useSemanticElements: Mirrors an inactive rich-text chat input. */}
          <div
            aria-label="Inactive message"
            contentEditable
            data-chat-input="true"
            role="textbox"
            tabIndex={-1}
          />
        </div>
      ) : null}
      {agentsContentState.showChatInput ? (
        // biome-ignore lint/a11y/useSemanticElements: Mirrors the production rich-text chat input.
        <div
          aria-label="Message"
          contentEditable
          data-chat-input="true"
          role="textbox"
          tabIndex={0}
        />
      ) : null}
    </div>
  ),
}));

vi.mock('@/features/code-editor', () => ({
  CodeEditorPanel: () => <div data-testid="code-editor-panel" />,
}));

vi.mock('@/features/flows', () => ({
  FlowsPage: ({ sidebarTrigger }: { sidebarTrigger?: ReactNode }) => (
    <div data-testid="flows-page">{sidebarTrigger}</div>
  ),
}));

vi.mock('@/features/settings', () => ({
  SettingsPage: ({ onClose }: { onClose: () => void }) => (
    <button type="button" data-testid="settings-page" onClick={onClose}>
      Close Settings
    </button>
  ),
}));

vi.mock('@/features/work-queue', () => ({
  WorkQueue: ({
    onRequestClose,
    sidebarTrigger,
  }: {
    onRequestClose: () => void;
    sidebarTrigger?: ReactElement;
  }) => (
    <button type="button" data-testid="work-queue" onClick={onRequestClose}>
      Close Work Queue
      {sidebarTrigger}
    </button>
  ),
}));

let animationFrameCallbacks: FrameRequestCallback[] = [];

type WorkQueueDestinationHarnessProps = {
  commitDismissal?: boolean;
};

function WorkQueueDestinationHarness({
  commitDismissal = true,
}: WorkQueueDestinationHarnessProps): ReactElement {
  const [activeOverlay, setActiveOverlay] = useState<'workqueue' | null>('workqueue');
  const { requestWorkQueueClose, navigateWorkQueueToChat } = useWorkQueueDestination({
    isMobile: true,
    isSplitActive: false,
    setActiveOverlay: (overlay) => {
      if (commitDismissal) setActiveOverlay(overlay);
    },
    exitWorkQueueForNavigation: vi.fn(() => true),
    fillActivePane: vi.fn(),
    selectChat: vi.fn(),
    focusWorkQueueTrigger: vi.fn(),
  });

  return (
    <AgentsDestinationPane
      activeOverlay={activeOverlay}
      isMobile={true}
      onCloseOverlay={() => setActiveOverlay(null)}
      onCloseSettings={() => setActiveOverlay(null)}
      onRequestWorkQueueClose={requestWorkQueueClose}
      onNavigateWorkQueueToChat={navigateWorkQueueToChat}
    />
  );
}

function runNextAnimationFrame(): void {
  const callback = animationFrameCallbacks.shift();
  if (!callback) throw new Error('Expected a queued animation frame');
  act(() => callback(0));
}

beforeEach(() => {
  agentsContentState.showChatInput = true;
  agentsContentState.showHiddenChatInputFirst = false;
  animationFrameCallbacks = [];
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      animationFrameCallbacks.push(callback);
      return animationFrameCallbacks.length;
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AgentsDestinationPane', () => {
  it('passes an out-of-flow sidebar trigger into the Flows dashboard', () => {
    render(
      <TooltipProvider>
        <AgentsDestinationPane
          activeOverlay="flows"
          isMobile={false}
          onCloseOverlay={vi.fn()}
          onCloseSettings={vi.fn()}
          onRequestWorkQueueClose={vi.fn()}
          onNavigateWorkQueueToChat={vi.fn()}
          sidebar={{ canToggle: true, isOpen: false, onOpen: vi.fn() }}
        />
      </TooltipProvider>,
    );

    const sidebarButton = within(screen.getByTestId('flows-page')).getByRole('button', {
      name: 'Open sidebar',
    });
    // Both sidebar-capable destinations are centred columns, so neither reserves a layout slot.
    expect(sidebarButton.closest('span')).toHaveClass('contents');
  });

  it('mounts the Flows dashboard on one shared atmosphere surface', () => {
    const { container } = render(
      <TooltipProvider>
        <AgentsDestinationPane
          activeOverlay="flows"
          isMobile={false}
          onCloseOverlay={vi.fn()}
          onCloseSettings={vi.fn()}
          onRequestWorkQueueClose={vi.fn()}
          onNavigateWorkQueueToChat={vi.fn()}
        />
      </TooltipProvider>,
    );

    // One layer only — a page rendering its own copy would double the wash.
    expect(container.querySelectorAll('.chat-canvas-atmosphere')).toHaveLength(1);
  });

  it('omits the Flows sidebar trigger while the flow editor holds the pane', () => {
    render(
      <TooltipProvider>
        <AgentsDestinationPane
          activeOverlay="flows"
          isMobile={false}
          onCloseOverlay={vi.fn()}
          onCloseSettings={vi.fn()}
          onRequestWorkQueueClose={vi.fn()}
          onNavigateWorkQueueToChat={vi.fn()}
          sidebar={{ canToggle: false, isOpen: false, onOpen: vi.fn() }}
        />
      </TooltipProvider>,
    );

    expect(
      within(screen.getByTestId('flows-page')).queryByRole('button', { name: 'Open sidebar' }),
    ).toBeNull();
  });

  it('passes a sidebar trigger into Work Queue when one is offered', () => {
    render(
      <TooltipProvider>
        <AgentsDestinationPane
          activeOverlay="workqueue"
          isMobile={false}
          onCloseOverlay={vi.fn()}
          onCloseSettings={vi.fn()}
          onRequestWorkQueueClose={vi.fn()}
          onNavigateWorkQueueToChat={vi.fn()}
          sidebar={{ canToggle: true, isOpen: false, onOpen: vi.fn() }}
        />
      </TooltipProvider>,
    );

    const sidebarButton = within(screen.getByTestId('work-queue')).getByRole('button', {
      name: 'Open sidebar',
    });
    expect(sidebarButton).toBeInTheDocument();
    expect(sidebarButton.closest('span')).toHaveClass('contents');
  });

  it('omits the sidebar trigger when the layout policy says the sidebar cannot toggle', () => {
    render(
      <AgentsDestinationPane
        activeOverlay="workqueue"
        isMobile={true}
        onCloseOverlay={vi.fn()}
        onCloseSettings={vi.fn()}
        onRequestWorkQueueClose={vi.fn()}
        onNavigateWorkQueueToChat={vi.fn()}
        sidebar={{ canToggle: false, isOpen: false, onOpen: vi.fn() }}
      />,
    );

    expect(
      within(screen.getByTestId('work-queue')).queryByRole('button', { name: 'Open sidebar' }),
    ).toBeNull();
  });

  it('omits the sidebar trigger from Work Queue when the desktop sidebar is open', () => {
    render(
      <AgentsDestinationPane
        activeOverlay="workqueue"
        isMobile={false}
        onCloseOverlay={vi.fn()}
        onCloseSettings={vi.fn()}
        onRequestWorkQueueClose={vi.fn()}
        onNavigateWorkQueueToChat={vi.fn()}
        sidebar={{ canToggle: true, isOpen: true, onOpen: vi.fn() }}
      />,
    );

    expect(
      within(screen.getByTestId('work-queue')).queryByRole('button', { name: 'Open sidebar' }),
    ).toBeNull();
  });

  it('omits the sidebar trigger from Work Queue when none is offered', () => {
    render(
      <AgentsDestinationPane
        activeOverlay="workqueue"
        isMobile={false}
        onCloseOverlay={vi.fn()}
        onCloseSettings={vi.fn()}
        onRequestWorkQueueClose={vi.fn()}
        onNavigateWorkQueueToChat={vi.fn()}
      />,
    );

    expect(
      within(screen.getByTestId('work-queue')).queryByRole('button', { name: 'Open sidebar' }),
    ).toBeNull();
  });

  it('mounts one Work Queue on one atmosphere without a duplicate destination', () => {
    const { container } = render(
      <AgentsDestinationPane
        activeOverlay="workqueue"
        isMobile={false}
        onCloseOverlay={vi.fn()}
        onCloseSettings={vi.fn()}
        onRequestWorkQueueClose={vi.fn()}
        onNavigateWorkQueueToChat={vi.fn()}
      />,
    );

    expect(screen.getAllByTestId('work-queue')).toHaveLength(1);
    expect(container.querySelectorAll('.chat-canvas-atmosphere')).toHaveLength(1);
    expect(container.querySelector('[data-agents-destination="workqueue"]')).toHaveClass(
      'bg-background',
    );
    expect(container.querySelector('[data-agents-destination="workqueue"]')).not.toHaveClass(
      'absolute',
    );
    expect(screen.getAllByTestId('code-editor-panel')).toHaveLength(1);
    expect(screen.getByTestId('code-editor-panel').parentElement).toHaveClass('hidden');
    expect(screen.getByTestId('agents-content').parentElement).toHaveAttribute('inert');
    expect(screen.getByTestId('agents-content').parentElement).toHaveClass('hidden');
  });

  it.each([
    { overlay: null, visible: 'agents-content' },
    { overlay: 'flows', visible: 'flows-page' },
    { overlay: 'settings', visible: 'settings-page' },
  ] as const)('renders only the $overlay destination', ({ overlay, visible }) => {
    render(
      <AgentsDestinationPane
        activeOverlay={overlay}
        isMobile={false}
        onCloseOverlay={vi.fn()}
        onCloseSettings={vi.fn()}
        onRequestWorkQueueClose={vi.fn()}
        onNavigateWorkQueueToChat={vi.fn()}
      />,
    );

    expect(screen.getByTestId(visible)).toBeInTheDocument();
    expect(screen.queryByTestId('work-queue')).not.toBeInTheDocument();
  });

  it('keeps the chat runtime mounted across Work Queue navigation', () => {
    const props = {
      isMobile: false,
      onCloseOverlay: vi.fn(),
      onCloseSettings: vi.fn(),
      onRequestWorkQueueClose: vi.fn(),
      onNavigateWorkQueueToChat: vi.fn(),
    };
    const { rerender } = render(<AgentsDestinationPane {...props} activeOverlay={null} />);
    const agentsContent = screen.getByTestId('agents-content');

    rerender(<AgentsDestinationPane {...props} activeOverlay="workqueue" />);

    expect(screen.getByTestId('agents-content')).toBe(agentsContent);
    expect(agentsContent.parentElement).toMatchObject({
      tagName: 'SECTION',
      tabIndex: -1,
    });
    expect(agentsContent.parentElement).toHaveAttribute('aria-label', 'Chat');
    expect(agentsContent.parentElement).toHaveAttribute('aria-hidden', 'true');
    expect(agentsContent.parentElement).toHaveAttribute('data-work-queue-return-target');
    expect(agentsContent.parentElement).toHaveClass('hidden');
  });

  it('keeps the chat mounted but covered and inert behind Settings', () => {
    const props = {
      isMobile: false,
      onCloseOverlay: vi.fn(),
      onCloseSettings: vi.fn(),
      onRequestWorkQueueClose: vi.fn(),
      onNavigateWorkQueueToChat: vi.fn(),
    };
    const { rerender } = render(<AgentsDestinationPane {...props} activeOverlay={null} />);
    const agentsContent = screen.getByTestId('agents-content');

    rerender(<AgentsDestinationPane {...props} activeOverlay="settings" />);
    const chat = agentsContent.parentElement;
    expect(screen.getByTestId('settings-page')).toBeInTheDocument();
    expect(chat).toHaveAttribute('inert');
    expect(chat).toHaveAttribute('aria-hidden', 'true');
    expect(chat).toHaveClass('[content-visibility:hidden]');

    rerender(<AgentsDestinationPane {...props} activeOverlay={null} />);
    expect(screen.getByTestId('agents-content')).toBe(agentsContent);
    expect(chat).not.toHaveAttribute('inert');
    expect(chat).not.toHaveClass('[content-visibility:hidden]');
  });

  it('returns mobile dismissal focus to the restored chat input', () => {
    const { container } = render(<WorkQueueDestinationHarness />);
    const returnTarget = container.querySelector<HTMLElement>('[data-work-queue-return-target]');
    expect(returnTarget).toHaveAttribute('inert');

    fireEvent.click(screen.getByRole('button', { name: 'Close Work Queue' }));

    expect(returnTarget).not.toHaveAttribute('inert');
    expect(returnTarget).not.toHaveAttribute('aria-hidden');
    runNextAnimationFrame();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveFocus();
  });

  it('skips an inactive composer before focusing the active chat input', () => {
    agentsContentState.showHiddenChatInputFirst = true;
    render(<WorkQueueDestinationHarness />);

    fireEvent.click(screen.getByRole('button', { name: 'Close Work Queue' }));
    runNextAnimationFrame();

    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveFocus();
    expect(
      screen.getByRole('textbox', { name: 'Inactive message', hidden: true }),
    ).not.toHaveFocus();
  });

  it('returns mobile dismissal focus to the chat runtime when no input exists', () => {
    agentsContentState.showChatInput = false;
    const { container } = render(<WorkQueueDestinationHarness />);
    const returnTarget = container.querySelector<HTMLElement>('[data-work-queue-return-target]');

    fireEvent.click(screen.getByRole('button', { name: 'Close Work Queue' }));
    runNextAnimationFrame();

    expect(returnTarget).toHaveFocus();
  });

  it('does not focus the retained chat runtime before it becomes visible and interactive', () => {
    const { container } = render(<WorkQueueDestinationHarness commitDismissal={false} />);
    const returnTarget = container.querySelector<HTMLElement>('[data-work-queue-return-target]');

    fireEvent.click(screen.getByRole('button', { name: 'Close Work Queue' }));
    runNextAnimationFrame();

    expect(returnTarget).toHaveAttribute('aria-hidden', 'true');
    expect(returnTarget).toHaveAttribute('inert');
    expect(returnTarget).not.toHaveFocus();
  });

  it('does not mount the desktop editor on mobile Work Queue', () => {
    render(
      <AgentsDestinationPane
        activeOverlay="workqueue"
        isMobile={true}
        onCloseOverlay={vi.fn()}
        onCloseSettings={vi.fn()}
        onRequestWorkQueueClose={vi.fn()}
        onNavigateWorkQueueToChat={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('code-editor-panel')).not.toBeInTheDocument();
  });

  it('keeps the editor mounted in a narrow chat destination', () => {
    render(
      <AgentsDestinationPane
        activeOverlay={null}
        isMobile={true}
        onCloseOverlay={vi.fn()}
        onCloseSettings={vi.fn()}
        onRequestWorkQueueClose={vi.fn()}
        onNavigateWorkQueueToChat={vi.fn()}
      />,
    );

    expect(screen.getByTestId('code-editor-panel')).toBeInTheDocument();
  });

  it('routes Settings close through the Settings-specific callback', () => {
    const onCloseOverlay = vi.fn();
    const onCloseSettings = vi.fn();
    render(
      <AgentsDestinationPane
        activeOverlay="settings"
        isMobile={false}
        onCloseOverlay={onCloseOverlay}
        onCloseSettings={onCloseSettings}
        onRequestWorkQueueClose={vi.fn()}
        onNavigateWorkQueueToChat={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close Settings' }));

    expect(onCloseSettings).toHaveBeenCalledOnce();
    expect(onCloseOverlay).not.toHaveBeenCalled();
  });
});
