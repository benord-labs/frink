// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAddToChat } from '@/lib/agent-chat/composer-input/add-to-chat-context';
import { pendingComposerInputAtomFamily } from '@/lib/agent-chat/composer-input/pending-input';
import { SplitPaneFileTreeSidebar } from './SplitPaneFileTreeSidebar';

const capturedResizable = {
  props: null as null | Record<string, unknown>,
};

const capturedPaneFileTree = {
  onClose: undefined as (() => void) | undefined,
  getMentionTexts: undefined as (() => string[]) | undefined,
};
let capturedAddToChat: ReturnType<typeof useAddToChat>;

vi.mock('@/components/ui/resizable-sidebar', () => ({
  ResizableSidebar: (props: Record<string, unknown>) => {
    capturedResizable.props = props;
    return <div data-testid="resizable-sidebar">{props.children as React.ReactNode}</div>;
  },
}));

vi.mock('../../../../features/files-sidebar/PaneFileTree', () => ({
  PaneFileTree: (props: { onClose?: () => void; getMentionTexts?: () => string[] }) => {
    capturedPaneFileTree.onClose = props.onClose;
    capturedPaneFileTree.getMentionTexts = props.getMentionTexts;
    capturedAddToChat = useAddToChat();
    return <div data-testid="pane-file-tree">tree</div>;
  },
}));

vi.mock('../../stores/message-store', () => ({
  readLoadedChatTexts: (chatId: string) => [`Messages of ${chatId}`],
}));

afterEach(() => {
  capturedResizable.props = null;
  capturedPaneFileTree.onClose = undefined;
  capturedPaneFileTree.getMentionTexts = undefined;
  cleanup();
});

describe('SplitPaneFileTreeSidebar', () => {
  it('keeps worktree tint classes on the sidebar wrapper', () => {
    const { container } = render(
      <SplitPaneFileTreeSidebar
        projectPath="/tmp/proj/.worktrees/feature"
        isWorktree={true}
        chatId="chat-1"
        paneIndex={0}
        onFileTreeRef={() => {}}
      />,
    );

    expect(screen.getByTestId('resizable-sidebar')).toBeInTheDocument();
    expect(capturedResizable.props?.className).toContain('color-mix');
    expect(container.querySelector('.border-primary\\/70')).toBeInTheDocument();
  });

  it('uses default non-worktree background classes when isWorktree is false', () => {
    render(
      <SplitPaneFileTreeSidebar
        projectPath="/tmp/proj"
        isWorktree={false}
        chatId="chat-2"
        paneIndex={0}
        onFileTreeRef={() => {}}
      />,
    );

    expect(capturedResizable.props?.className).toContain('bg-tl-background');
    expect(capturedResizable.props?.className).not.toContain('color-mix');
  });

  it('forwards onCloseFileTree to PaneFileTree onClose', () => {
    const onCloseFileTree = vi.fn();
    render(
      <SplitPaneFileTreeSidebar
        projectPath="/tmp/proj"
        isWorktree={false}
        chatId="chat-3"
        paneIndex={1}
        onFileTreeRef={() => {}}
        onCloseFileTree={onCloseFileTree}
      />,
    );

    expect(capturedPaneFileTree.onClose).toBe(onCloseFileTree);
  });

  it('passes undefined onClose to PaneFileTree when onCloseFileTree is omitted', () => {
    render(
      <SplitPaneFileTreeSidebar
        projectPath="/tmp/proj"
        isWorktree={false}
        chatId="chat-4"
        paneIndex={0}
        onFileTreeRef={() => {}}
      />,
    );

    expect(capturedPaneFileTree.onClose).toBeUndefined();
  });

  it("gives the pane's tree Add to Chat for the pane's own chat", () => {
    const store = createStore();
    render(
      <Provider store={store}>
        <SplitPaneFileTreeSidebar
          projectPath="/tmp/proj"
          isWorktree={false}
          chatId="chat-4"
          paneIndex={1}
          onFileTreeRef={() => {}}
        />
      </Provider>,
    );

    capturedAddToChat?.([{ path: 'src/a.ts', type: 'file' }]);

    expect(store.get(pendingComposerInputAtomFamily('chat-4'))).toEqual([
      { kind: 'paths', items: [{ path: 'src/a.ts', type: 'file' }] },
    ]);
  });

  it("gives PaneFileTree this pane's chat messages, for Link project", () => {
    render(
      <SplitPaneFileTreeSidebar
        projectPath="/tmp/proj"
        isWorktree={false}
        chatId="chat-5"
        paneIndex={1}
        onFileTreeRef={() => {}}
      />,
    );

    expect(capturedPaneFileTree.getMentionTexts?.()).toEqual(['Messages of chat-5']);
  });
});
