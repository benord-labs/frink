// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewChatFormHeader } from './new-chat-form-header';

const agentsHeaderControlsSpy = vi.fn((_props: Record<string, unknown>) => null);

const fileTreeToggle = vi.hoisted(() => ({
  isInSplitView: true,
  hasProject: false,
  fileTreeOpen: false,
  modifiedFiles: false,
  toggleFileTree: vi.fn(),
}));

vi.mock('../ui/agents-header-controls', () => ({
  AgentsHeaderControls: (props: Record<string, unknown>) => agentsHeaderControlsSpy(props),
}));

vi.mock('../hooks/use-file-tree-toggle', () => ({
  useFileTreeToggle: () => fileTreeToggle,
}));

vi.mock('../ui/account-indicator', () => ({
  AccountIndicator: () => <span data-testid="account-indicator" />,
}));

vi.mock('./pane-utility-buttons', () => ({
  PaneUtilityButtons: () => <span data-testid="pane-utility-buttons" />,
}));

beforeEach(() => {
  fileTreeToggle.isInSplitView = true;
  fileTreeToggle.hasProject = false;
  fileTreeToggle.fileTreeOpen = false;
  fileTreeToggle.modifiedFiles = false;
  fileTreeToggle.toggleFileTree.mockClear();
});

afterEach(() => {
  cleanup();
  agentsHeaderControlsSpy.mockClear();
});

describe('NewChatFormHeader', () => {
  it('forwards splitPaneIndex to AgentsHeaderControls for split panes', () => {
    const store = createStore();

    render(
      <Provider store={store}>
        <NewChatFormHeader
          isMobileFullscreen={false}
          isSidebarOpen={false}
          hasUnseenChanges={false}
          onToggleSidebar={vi.fn()}
          splitPaneIndex={3}
        />
      </Provider>,
    );

    expect(agentsHeaderControlsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        splitPaneIndex: 3,
        isSidebarOpen: false,
        hasUnseenChanges: false,
      }),
    );
  });

  it('passes undefined splitPaneIndex to AgentsHeaderControls when not in split view', () => {
    const store = createStore();

    render(
      <Provider store={store}>
        <NewChatFormHeader
          isMobileFullscreen={false}
          isSidebarOpen={false}
          hasUnseenChanges={false}
          onToggleSidebar={vi.fn()}
        />
      </Provider>,
    );

    expect(agentsHeaderControlsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        splitPaneIndex: undefined,
      }),
    );
  });

  it('names the outer header as the pane-header container and clips the row inside it', () => {
    const { container } = render(
      <Provider store={createStore()}>
        <NewChatFormHeader
          isMobileFullscreen={false}
          isSidebarOpen={false}
          hasUnseenChanges={false}
          onToggleSidebar={vi.fn()}
          splitPaneIndex={0}
        />
      </Provider>,
    );

    const outer = container.firstElementChild;
    expect(outer).toHaveClass('relative', '@container/pane-header');
    expect(outer).not.toHaveClass('overflow-hidden');
    expect(outer?.firstElementChild).toHaveClass('min-w-0', 'overflow-x-clip');
  });

  describe('macOS traffic-light clearance', () => {
    afterEach(() => {
      (window as unknown as { desktopApi?: unknown }).desktopApi = undefined;
    });

    it('adds vertical clearance only to a closed-sidebar desktop single pane', () => {
      (window as unknown as { desktopApi?: { platform: string } }).desktopApi = {
        platform: 'darwin',
      };
      const store = createStore();
      const { container, rerender } = render(
        <Provider store={store}>
          <NewChatFormHeader
            isMobileFullscreen={false}
            isSidebarOpen={false}
            hasUnseenChanges={false}
            onToggleSidebar={vi.fn()}
          />
        </Provider>,
      );

      expect(container.firstElementChild).toHaveClass('pt-7');
      expect(container.firstElementChild).toHaveClass('relative');

      rerender(
        <Provider store={store}>
          <NewChatFormHeader
            isMobileFullscreen={false}
            isSidebarOpen={false}
            hasUnseenChanges={false}
            onToggleSidebar={vi.fn()}
            splitPaneIndex={0}
          />
        </Provider>,
      );
      expect(container.firstElementChild).not.toHaveClass('pt-7');
    });
  });
});
