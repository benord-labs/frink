// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import superjson from 'superjson';
import { ipcLink } from 'trpc-electron/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { trpc } from '@/lib/trpc';
import { SplitPaneBranchBarHeightProvider } from '../../../../ui/split-view-container/SplitPaneBranchBarHeightSync';
import { ChatDock } from './index';

// A tRPC transport that never answers, set before lib/trpc builds its client on import: the
// workspace row's queries stay pending.
vi.hoisted(() => {
  vi.stubGlobal('electronTRPC', { sendMessage: () => {}, onMessage: () => () => {} });
});

/**
 * happy-dom performs no layout and its ResizeObserver never fires, so the stack reports a fixed
 * offsetHeight and observers are recorded for the test to drive by hand.
 */
const STACK_HEIGHT_PX = 120;
let observed: Array<{ element: Element; observer: RecordingResizeObserver }> = [];
const originalResizeObserver = globalThis.ResizeObserver;
const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');

class RecordingResizeObserver implements ResizeObserver {
  constructor(readonly callback: ResizeObserverCallback) {}
  observe(element: Element) {
    observed.push({ element, observer: this });
  }
  unobserve(element: Element) {
    observed = observed.filter((entry) => entry.element !== element);
  }
  disconnect() {
    observed = observed.filter((entry) => entry.observer !== this);
  }
}

function resize(element: Element, blockSize: number): void {
  const size = [{ blockSize, inlineSize: 0 }];
  const entry: ResizeObserverEntry = {
    target: element,
    contentRect: new DOMRect(0, 0, 0, blockSize),
    borderBoxSize: size,
    contentBoxSize: size,
    devicePixelContentBoxSize: size,
  };
  for (const { element: target, observer } of observed) {
    if (target === element) observer.callback([entry], observer);
  }
}

function renderDock(props: Partial<ComponentProps<typeof ChatDock>> = {}) {
  const queryClient = new QueryClient();
  const client = trpc.createClient({ links: [ipcLink({ transformer: superjson })] });
  return render(
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <SplitPaneBranchBarHeightProvider layout="horizontal" paneCount={2}>
            <ChatDock
              transcript={<div data-testid="transcript" />}
              hasLeftBottom={false}
              onScrollToBottom={() => {}}
              worktreePath={null}
              currentBranch="main"
              workspaceFolderName="project"
              chatId="chat-1"
              isActive
              {...props}
            >
              <div data-testid="composer" />
            </ChatDock>
          </SplitPaneBranchBarHeightProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </trpc.Provider>,
  );
}

function getStack(): HTMLElement {
  const stack = document.querySelector<HTMLElement>('[data-chat-dock]');
  if (!stack) throw new Error('ChatDock rendered no stack');
  return stack;
}

beforeEach(() => {
  observed = [];
  globalThis.ResizeObserver = RecordingResizeObserver;
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    get(this: HTMLElement) {
      return this.hasAttribute('data-chat-dock') ? STACK_HEIGHT_PX : 0;
    },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  globalThis.ResizeObserver = originalResizeObserver;
  if (originalOffsetHeight) {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
  }
});

describe('ChatDock', () => {
  it('floats the stack over the transcript and keeps the workspace row on the floor below', () => {
    renderDock();
    const region = screen.getByTestId('transcript').parentElement;
    const stack = getStack();

    expect(stack.parentElement).toBe(region);
    expect(stack).toContainElement(screen.getByTestId('composer'));
    expect(region).not.toContainElement(screen.getByTestId('chat-input-branch-bar'));
  });

  it('publishes the stack height on the region before paint, then on every resize', () => {
    renderDock();
    const stack = getStack();
    const region = stack.parentElement;

    expect(region?.style.getPropertyValue('--chat-dock-height')).toBe(`${STACK_HEIGHT_PX}px`);

    resize(stack, 180);
    expect(region?.style.getPropertyValue('--chat-dock-height')).toBe('180px');
  });

  it('renders the scroll-to-bottom button as the last child of the stack, after every member', () => {
    renderDock({ hasLeftBottom: true });

    expect(getStack().lastElementChild).toBe(
      screen.getByRole('button', { name: 'Scroll to bottom' }),
    );
  });

  describe('split-pane floor sync', () => {
    it('does not register a single-pane chat', () => {
      renderDock();
      expect(screen.queryByTestId('split-pane-branch-footer-sync')).toBeNull();
    });

    it('registers the visible sub-chat of a split pane', () => {
      renderDock({ splitPaneIndex: 0 });
      expect(screen.getByTestId('split-pane-branch-footer-sync')).toBeInTheDocument();
    });

    it('does not register a keep-alive sub-chat hidden behind another tab', () => {
      renderDock({ splitPaneIndex: 0, isActive: false });
      expect(screen.queryByTestId('split-pane-branch-footer-sync')).toBeNull();
    });
  });
});
