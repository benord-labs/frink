// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SplitPaneFileTreeSidebar } from './SplitPaneFileTreeSidebar';

const capturedResizable = {
  props: null as null | Record<string, unknown>,
};

const capturedPaneFileTree = {
  onClose: undefined as (() => void) | undefined,
};

vi.mock('@/components/ui/resizable-sidebar', () => ({
  ResizableSidebar: (props: Record<string, unknown>) => {
    capturedResizable.props = props;
    return <div data-testid="resizable-sidebar">{props.children as React.ReactNode}</div>;
  },
}));

vi.mock('../../../../features/files-sidebar/PaneFileTree', () => ({
  PaneFileTree: (props: { onClose?: () => void }) => {
    capturedPaneFileTree.onClose = props.onClose;
    return <div data-testid="pane-file-tree">tree</div>;
  },
}));

afterEach(() => {
  capturedResizable.props = null;
  capturedPaneFileTree.onClose = undefined;
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
});
