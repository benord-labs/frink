// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileTreeNode } from '../types';
import { SelectionActionsContext, SelectionStateContext } from './MultiSelectContext';
import { ModifiedFilterContext } from './modified-filter-context';
import { RefreshContext } from './RefreshContext';
import { TreeNode } from './TreeNode';
import { createSelectionStore, NOOP_SELECTION_STORE } from './use-multi-select';

/** Build a seeded selection store from a set of selected paths (test helper) */
function seedStore(selectedPaths?: Set<string>) {
  const store = createSelectionStore();
  if (selectedPaths && selectedPaths.size > 0) {
    store.selectAll(Array.from(selectedPaths), (p) => ({
      name: p.split('/').pop() ?? p,
      type: 'file',
    }));
  }
  return store;
}

const mocks = vi.hoisted(() => ({
  listDirectoryQuery: vi.fn(),
  getShortcutAction: vi.fn(),
  keysToDisplay: vi.fn(),
  // Render proxy: a file node calls this once per render, so call args = which nodes re-rendered.
  getFileIcon: vi.fn((_name: string) => null),
}));

vi.mock('@dnd-kit/core', () => ({
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    isDragging: false,
  }),
  useDroppable: () => ({
    setNodeRef: () => {},
    isOver: false,
  }),
}));

vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({
    children,
    onClick,
    onSelect,
    disabled,
  }: {
    children: ReactNode;
    onClick?: () => void;
    onSelect?: () => void;
    disabled?: boolean;
  }) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        onClick?.();
        onSelect?.();
      }}
    >
      {children}
    </button>
  ),
  ContextMenuSeparator: () => <div />,
}));

vi.mock('@/hooks/use-context-menu-focus-handoff', () => ({
  useContextMenuFocusHandoff: () => ({
    markNextCloseForInputFocus: vi.fn(),
    handleCloseAutoFocus: vi.fn(),
  }),
}));

vi.mock('@/lib/hotkeys/shortcut-registry', () => ({
  getShortcutAction: mocks.getShortcutAction,
  keysToDisplay: mocks.keysToDisplay,
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    external: {
      openInFinder: {
        useMutation: () => ({ mutate: vi.fn() }),
      },
    },
  },
  trpcClient: {
    files: {
      listDirectory: {
        query: mocks.listDirectoryQuery,
      },
    },
  },
}));

vi.mock('@/lib/utils', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
}));

vi.mock('@/lib/utils/platform', () => ({
  getRevealLabel: () => 'Reveal in Finder',
}));

vi.mock('../../agents/mentions/agents-file-mention', () => ({
  getFileIconByExtension: mocks.getFileIcon,
}));

const folderNode: FileTreeNode = {
  id: 'src/components',
  name: 'components',
  path: 'src/components',
  type: 'folder',
  childrenLoaded: false,
};

const fileNode: FileTreeNode = {
  id: 'src/index.ts',
  name: 'index.ts',
  path: 'src/index.ts',
  type: 'file',
  childrenLoaded: false,
};

const rootFileNode: FileTreeNode = {
  id: 'README.md',
  name: 'README.md',
  path: 'README.md',
  type: 'file',
  childrenLoaded: false,
};

function renderTreeNode(
  pathToExpandAfterDrop: string | null,
  options?: {
    node?: FileTreeNode;
    onCopyItem?: (path: string) => void;
    onPasteIntoFolder?: (targetFolder: string) => void;
    hasCopiedItem?: boolean;
    isMultiSelected?: boolean;
    selectedPaths?: Set<string>;
    modifiedOnly?: boolean;
  },
) {
  const node = options?.node ?? folderNode;
  // Selection is now a store: seed from selectedPaths, or from this node when only
  // isMultiSelected is requested (membership is what drives the highlight).
  const paths =
    options?.selectedPaths ?? (options?.isMultiSelected ? new Set([node.path]) : undefined);
  return render(
    <ModifiedFilterContext.Provider value={Boolean(options?.modifiedOnly)}>
      <RefreshContext.Provider value={0}>
        <SelectionActionsContext.Provider value={{}}>
          <SelectionStateContext.Provider value={seedStore(paths)}>
            <TreeNode
              node={node}
              level={0}
              projectPath="/tmp/proj"
              onFileClick={vi.fn()}
              onCopyItem={options?.onCopyItem}
              onPasteIntoFolder={options?.onPasteIntoFolder}
              hasCopiedItem={options?.hasCopiedItem}
              pathToExpandAfterDrop={pathToExpandAfterDrop}
            />
          </SelectionStateContext.Provider>
        </SelectionActionsContext.Provider>
      </RefreshContext.Provider>
    </ModifiedFilterContext.Provider>,
  );
}

describe('TreeNode drop reveal', () => {
  beforeEach(() => {
    mocks.getShortcutAction.mockReset();
    mocks.keysToDisplay.mockReset();
    mocks.getShortcutAction.mockReturnValue(null);
    mocks.keysToDisplay.mockReturnValue('');
    mocks.listDirectoryQuery.mockReset();
    mocks.listDirectoryQuery.mockResolvedValue([
      {
        name: 'child.ts',
        path: 'src/components/child.ts',
        type: 'file',
      },
    ]);
  });

  afterEach(() => {
    cleanup();
  });

  it('expands and loads children when the reveal path matches the folder', async () => {
    renderTreeNode('src/components');

    await waitFor(() => {
      expect(mocks.listDirectoryQuery).toHaveBeenCalledWith({
        projectPath: '/tmp/proj',
        relativePath: 'src/components',
      });
    });

    await waitFor(() => {
      expect(screen.getByText('child.ts')).toBeInTheDocument();
    });

    expect(screen.getAllByRole('treeitem')[0]).toHaveAttribute('aria-expanded', 'true');
  });

  it('ignores reveal paths for other folders', async () => {
    renderTreeNode('src/other');

    await waitFor(() => {
      expect(mocks.listDirectoryQuery).not.toHaveBeenCalled();
    });

    expect(screen.queryByText('child.ts')).not.toBeInTheDocument();
    expect(screen.getByRole('treeitem')).toHaveAttribute('aria-expanded', 'false');
  });

  it('copies node path into internal clipboard from context menu', () => {
    const onCopyItem = vi.fn();
    renderTreeNode(null, { onCopyItem });

    const copyButton = screen
      .getAllByRole('button')
      .find((button) => button.textContent?.trim() === 'Copy');
    expect(copyButton).toBeTruthy();
    if (!copyButton) return;

    fireEvent.click(copyButton);
    expect(onCopyItem).toHaveBeenCalledWith('src/components');
  });

  it('pastes into folder path when context menu paste is used on folder', () => {
    const onPasteIntoFolder = vi.fn();
    renderTreeNode(null, { onPasteIntoFolder, hasCopiedItem: true });

    const pasteButton = screen
      .getAllByRole('button')
      .find((button) => button.textContent?.trim() === 'Paste');
    expect(pasteButton).toBeTruthy();
    if (!pasteButton) return;

    fireEvent.click(pasteButton);
    expect(onPasteIntoFolder).toHaveBeenCalledWith('src/components');
  });

  it('pastes into parent folder when context menu paste is used on file', () => {
    const onPasteIntoFolder = vi.fn();
    renderTreeNode(null, { node: fileNode, onPasteIntoFolder, hasCopiedItem: true });

    const pasteButton = screen
      .getAllByRole('button')
      .find((button) => button.textContent?.trim() === 'Paste');
    expect(pasteButton).toBeTruthy();
    if (!pasteButton) return;

    fireEvent.click(pasteButton);
    expect(onPasteIntoFolder).toHaveBeenCalledWith('src');
  });

  it('pastes to project root when context menu paste is used on a root-level file', () => {
    const onPasteIntoFolder = vi.fn();
    renderTreeNode(null, { node: rootFileNode, onPasteIntoFolder, hasCopiedItem: true });

    const pasteButton = screen
      .getAllByRole('button')
      .find((button) => button.textContent?.trim() === 'Paste');
    expect(pasteButton).toBeTruthy();
    if (!pasteButton) return;

    fireEvent.click(pasteButton);
    expect(onPasteIntoFolder).toHaveBeenCalledWith('');
  });

  it('shows shortcut hints for copy and paste menu items', () => {
    mocks.getShortcutAction.mockImplementation((actionId: string) => {
      if (actionId === 'file-copy') {
        return { defaultKeys: ['cmd', 'C'] };
      }
      if (actionId === 'file-paste') {
        return { defaultKeys: ['cmd', 'V'] };
      }
      return null;
    });
    mocks.keysToDisplay.mockImplementation((keys: string[]) => keys.join('+'));

    renderTreeNode(null);

    expect(screen.getByText('cmd+C')).toBeInTheDocument();
    expect(screen.getByText('cmd+V')).toBeInTheDocument();
  });

  it('hides internal copy/paste menu items for batch selection context', () => {
    renderTreeNode(null, {
      selectedPaths: new Set(['src/components', 'src/other']),
    });

    const buttons = screen.getAllByRole('button');
    const hasInternalCopy = buttons.some((button) => button.textContent?.trim() === 'Copy');
    const hasInternalPaste = buttons.some((button) => button.textContent?.trim() === 'Paste');

    expect(hasInternalCopy).toBe(false);
    expect(hasInternalPaste).toBe(false);
  });

  it('treats a single selected node as non-batch (count = 1 is below the batch threshold)', () => {
    // Boundary: the node is selected but the selection size is 1, so it must show the
    // single-item menu ("Copy Path"), not the batch variant ("Copy 1 Paths").
    renderTreeNode(null, { selectedPaths: new Set(['src/components']) });

    const buttons = screen.getAllByRole('button');
    expect(buttons.some((b) => b.textContent?.trim() === 'Copy Path')).toBe(true);
    expect(buttons.some((b) => b.textContent?.includes('Copy 1 Paths'))).toBe(false);
    // Internal copy/paste stays available for a single selection.
    expect(buttons.some((b) => b.textContent?.trim() === 'Copy')).toBe(true);
  });

  it('disables paste menu item when no copied item exists', () => {
    renderTreeNode(null, { hasCopiedItem: false });
    const pasteButton = screen
      .getAllByRole('button')
      .find((button) => button.textContent?.trim().startsWith('Paste'));
    expect(pasteButton).toBeTruthy();
    expect(pasteButton).toBeDisabled();
  });

  it('filters already-loaded children when modified-only mode is enabled', async () => {
    const nodeWithChildren: FileTreeNode = {
      ...folderNode,
      childrenLoaded: true,
      children: [
        {
          id: 'src/components/changed.ts',
          name: 'changed.ts',
          path: 'src/components/changed.ts',
          type: 'file',
          gitStatus: 'modified',
        },
        {
          id: 'src/components/clean.ts',
          name: 'clean.ts',
          path: 'src/components/clean.ts',
          type: 'file',
        },
      ],
    };

    renderTreeNode(null, { node: nodeWithChildren, modifiedOnly: true });
    fireEvent.click(screen.getByRole('treeitem'));

    await waitFor(() => {
      expect(screen.getByText('changed.ts')).toBeInTheDocument();
    });
    expect(screen.queryByText('clean.ts')).not.toBeInTheDocument();
  });
});

describe('TreeNode edge cases for modified-only filter', () => {
  beforeEach(() => {
    mocks.getShortcutAction.mockReset();
    mocks.keysToDisplay.mockReset();
    mocks.getShortcutAction.mockReturnValue(null);
    mocks.keysToDisplay.mockReturnValue('');
    mocks.listDirectoryQuery.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders InlineInput inside a visible folder during modified-only mode', async () => {
    const nodeWithChildren: FileTreeNode = {
      ...folderNode,
      gitStatus: 'modified',
      childrenLoaded: true,
      children: [
        {
          id: 'src/components/existing.ts',
          name: 'existing.ts',
          path: 'src/components/existing.ts',
          type: 'file',
          gitStatus: 'modified',
        },
      ],
    };

    render(
      <ModifiedFilterContext.Provider value={true}>
        <RefreshContext.Provider value={0}>
          <SelectionActionsContext.Provider value={{}}>
            <SelectionStateContext.Provider value={NOOP_SELECTION_STORE}>
              <TreeNode
                node={nodeWithChildren}
                level={0}
                projectPath="/tmp/proj"
                onFileClick={vi.fn()}
                creatingItem={{ parentFolder: 'src/components', type: 'file' }}
                onInlineConfirm={vi.fn()}
                onInlineCancel={vi.fn()}
                pathToExpandAfterDrop={null}
              />
            </SelectionStateContext.Provider>
          </SelectionActionsContext.Provider>
        </RefreshContext.Provider>
      </ModifiedFilterContext.Provider>,
    );

    fireEvent.click(screen.getByRole('treeitem'));

    await waitFor(() => {
      expect(screen.getByText('existing.ts')).toBeInTheDocument();
    });

    const input = screen.getByRole('textbox');
    expect(input).toBeInTheDocument();
  });

  it('filters dynamically loaded children in modified-only mode', async () => {
    mocks.listDirectoryQuery.mockResolvedValue([
      {
        name: 'modified.ts',
        path: 'src/components/modified.ts',
        type: 'file',
        gitStatus: 'modified',
      },
      { name: 'clean.ts', path: 'src/components/clean.ts', type: 'file' },
      { name: 'added.ts', path: 'src/components/added.ts', type: 'file', gitStatus: 'added' },
    ]);

    renderTreeNode(null, { modifiedOnly: true });

    fireEvent.click(screen.getByRole('treeitem'));

    await waitFor(() => {
      expect(screen.getByText('modified.ts')).toBeInTheDocument();
    });
    expect(screen.getByText('added.ts')).toBeInTheDocument();
    expect(screen.queryByText('clean.ts')).not.toBeInTheDocument();
  });

  it('shows all children when modified-only is off after dynamic load', async () => {
    mocks.listDirectoryQuery.mockResolvedValue([
      {
        name: 'modified.ts',
        path: 'src/components/modified.ts',
        type: 'file',
        gitStatus: 'modified',
      },
      { name: 'clean.ts', path: 'src/components/clean.ts', type: 'file' },
    ]);

    renderTreeNode(null, { modifiedOnly: false });

    fireEvent.click(screen.getByRole('treeitem'));

    await waitFor(() => {
      expect(screen.getByText('modified.ts')).toBeInTheDocument();
    });
    expect(screen.getByText('clean.ts')).toBeInTheDocument();
  });

  it('expand via pathToExpandAfterDrop still works for folder with gitStatus in modified-only', async () => {
    mocks.listDirectoryQuery.mockResolvedValue([
      {
        name: 'changed.ts',
        path: 'src/components/changed.ts',
        type: 'file',
        gitStatus: 'modified',
      },
      { name: 'untouched.ts', path: 'src/components/untouched.ts', type: 'file' },
    ]);

    const modifiedFolder: FileTreeNode = {
      ...folderNode,
      gitStatus: 'modified',
    };

    renderTreeNode('src/components', { node: modifiedFolder, modifiedOnly: true });

    await waitFor(() => {
      expect(mocks.listDirectoryQuery).toHaveBeenCalledWith({
        projectPath: '/tmp/proj',
        relativePath: 'src/components',
      });
    });

    await waitFor(() => {
      expect(screen.getByText('changed.ts')).toBeInTheDocument();
    });
    expect(screen.queryByText('untouched.ts')).not.toBeInTheDocument();
  });

  it('refresh trigger refetches children and applies modified-only filter to updated data', async () => {
    mocks.listDirectoryQuery.mockResolvedValue([
      { name: 'a.ts', path: 'src/components/a.ts', type: 'file', gitStatus: 'modified' },
      { name: 'b.ts', path: 'src/components/b.ts', type: 'file' },
    ]);

    const modifiedFolder: FileTreeNode = {
      ...folderNode,
      gitStatus: 'modified',
    };

    const { rerender } = render(
      <ModifiedFilterContext.Provider value={true}>
        <RefreshContext.Provider value={0}>
          <SelectionActionsContext.Provider value={{}}>
            <SelectionStateContext.Provider value={NOOP_SELECTION_STORE}>
              <TreeNode
                node={modifiedFolder}
                level={0}
                projectPath="/tmp/proj"
                onFileClick={vi.fn()}
                pathToExpandAfterDrop={null}
              />
            </SelectionStateContext.Provider>
          </SelectionActionsContext.Provider>
        </RefreshContext.Provider>
      </ModifiedFilterContext.Provider>,
    );

    fireEvent.click(screen.getByRole('treeitem'));
    await waitFor(() => {
      expect(screen.getByText('a.ts')).toBeInTheDocument();
    });
    expect(screen.queryByText('b.ts')).not.toBeInTheDocument();

    mocks.listDirectoryQuery.mockResolvedValue([
      { name: 'a.ts', path: 'src/components/a.ts', type: 'file', gitStatus: 'modified' },
      { name: 'b.ts', path: 'src/components/b.ts', type: 'file', gitStatus: 'modified' },
    ]);

    rerender(
      <ModifiedFilterContext.Provider value={true}>
        <RefreshContext.Provider value={1}>
          <SelectionActionsContext.Provider value={{}}>
            <SelectionStateContext.Provider value={NOOP_SELECTION_STORE}>
              <TreeNode
                node={modifiedFolder}
                level={0}
                projectPath="/tmp/proj"
                onFileClick={vi.fn()}
                pathToExpandAfterDrop={null}
              />
            </SelectionStateContext.Provider>
          </SelectionActionsContext.Provider>
        </RefreshContext.Provider>
      </ModifiedFilterContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByText('b.ts')).toBeInTheDocument();
    });
    expect(screen.getByText('a.ts')).toBeInTheDocument();
  });

  it('shows empty expanded folder when all children lack gitStatus in modified-only', async () => {
    mocks.listDirectoryQuery.mockResolvedValue([
      { name: 'clean1.ts', path: 'src/components/clean1.ts', type: 'file' },
      { name: 'clean2.ts', path: 'src/components/clean2.ts', type: 'file' },
    ]);

    const modifiedFolder: FileTreeNode = {
      ...folderNode,
      gitStatus: 'modified',
    };

    renderTreeNode(null, { node: modifiedFolder, modifiedOnly: true });

    fireEvent.click(screen.getByRole('treeitem'));

    await waitFor(() => {
      expect(mocks.listDirectoryQuery).toHaveBeenCalled();
    });

    expect(screen.queryByText('clean1.ts')).not.toBeInTheDocument();
    expect(screen.queryByText('clean2.ts')).not.toBeInTheDocument();
  });

  it('filters mixed children: keeps folders with gitStatus, hides clean folders', async () => {
    mocks.listDirectoryQuery.mockResolvedValue([
      { name: 'utils', path: 'src/components/utils', type: 'folder', gitStatus: 'modified' },
      { name: 'types', path: 'src/components/types', type: 'folder' },
      { name: 'index.ts', path: 'src/components/index.ts', type: 'file', gitStatus: 'added' },
    ]);

    renderTreeNode(null, { modifiedOnly: true });

    fireEvent.click(screen.getByRole('treeitem'));

    await waitFor(() => {
      expect(screen.getByText('utils')).toBeInTheDocument();
    });
    expect(screen.getByText('index.ts')).toBeInTheDocument();
    expect(screen.queryByText('types')).not.toBeInTheDocument();
  });
});

describe('TreeNode selection subscription', () => {
  const files: FileTreeNode[] = ['a', 'b', 'c', 'd', 'e'].map((n) => ({
    id: `src/${n}.ts`,
    name: `${n}.ts`,
    path: `src/${n}.ts`,
    type: 'file',
    childrenLoaded: false,
  }));
  const meta = { name: '', type: 'file' as const };

  function renderSiblings(store: ReturnType<typeof createSelectionStore>) {
    return render(
      <ModifiedFilterContext.Provider value={false}>
        <RefreshContext.Provider value={0}>
          <SelectionActionsContext.Provider value={{}}>
            <SelectionStateContext.Provider value={store}>
              {files.map((f) => (
                <TreeNode
                  key={f.id}
                  node={f}
                  level={0}
                  projectPath="/tmp/proj"
                  onFileClick={vi.fn()}
                  pathToExpandAfterDrop={null}
                />
              ))}
            </SelectionStateContext.Provider>
          </SelectionActionsContext.Provider>
        </RefreshContext.Provider>
      </ModifiedFilterContext.Provider>,
    );
  }

  beforeEach(() => {
    mocks.getShortcutAction.mockReset().mockReturnValue(null);
    mocks.keysToDisplay.mockReset().mockReturnValue('');
    mocks.getFileIcon.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('re-renders only the node whose selected-bit flips (O(changed), not O(N))', () => {
    const store = createSelectionStore();
    renderSiblings(store);

    // Selecting one node re-renders only that node — not all five.
    mocks.getFileIcon.mockClear();
    act(() => store.selectOne('src/b.ts', meta));
    expect(mocks.getFileIcon.mock.calls.map((c) => c[0])).toEqual(['b.ts']);

    // Adding a second node leaves the already-selected node's bit unchanged,
    // so only the newly-added node re-renders.
    mocks.getFileIcon.mockClear();
    act(() => store.toggleItem('src/d.ts', meta));
    expect(mocks.getFileIcon.mock.calls.map((c) => c[0])).toEqual(['d.ts']);
  });

  it('keeps batch context-menu labels fresh as the count changes', () => {
    const store = createSelectionStore();
    store.selectAll(['src/b.ts', 'src/c.ts'], () => meta);
    renderSiblings(store);

    // A selected node's menu reflects the current count of 2.
    expect(screen.getAllByText('Copy 2 Paths').length).toBeGreaterThan(0);

    // Growing the selection updates the label even though the node's own bit didn't flip.
    act(() => store.toggleItem('src/d.ts', meta));
    expect(screen.getAllByText('Copy 3 Paths').length).toBeGreaterThan(0);
    expect(screen.queryByText('Copy 2 Paths')).not.toBeInTheDocument();
  });
});
