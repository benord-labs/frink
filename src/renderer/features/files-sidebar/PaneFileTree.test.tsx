// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { atom, getDefaultStore } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activeFilePathAtom,
  codeEditorOpenAtom,
  fileKey,
  openFilesAtom,
} from '@/lib/code-editor/state';
import { PaneFileTree } from './PaneFileTree';
import { FILE_TREE_REFRESH_EVENT } from './refresh-trigger';

const mockState = vi.hoisted(() => ({
  selectedCount: 0,
  primary: null as { path: string; name: string; type: 'file' | 'folder' } | null,
}));
const duplicateMutateMock = vi.hoisted(() => vi.fn());
// Captures the onSuccess handler wired to structural mutations (it is `invalidateTree`),
// so a test can invoke it and assert the cross-pane refresh broadcast fires.
const mutationHandlers = vi.hoisted(() => ({ deleteOnSuccess: null as null | (() => void) }));
// Stable spies on the tRPC util invalidators so a test can observe the FILE_TREE_REFRESH_EVENT
// listener's side effects (throttle / force-bypass / projectPath-scoping behaviour).
const utilsInvalidate = vi.hoisted(() => ({
  listDirectory: vi.fn(),
  search: vi.fn(),
  searchContent: vi.fn(),
}));
const externalOnPasteMock = vi.hoisted(() => vi.fn());
const externalDropState = vi.hoisted(() => ({ isDragOver: false }));
const clearSelectionMock = vi.hoisted(() => vi.fn());
const searchState = vi.hoisted(() => ({
  searchQuery: '',
  debouncedQuery: '',
}));
const directoryState = vi.hoisted(() => ({
  rootContents: [] as Array<{
    name: string;
    path: string;
    type: 'file' | 'folder';
    gitStatus?: 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked';
    isGitIgnored?: boolean;
  }>,
}));
const fileTreePropsState = vi.hoisted(() => ({
  pathToExpandAfterDrop: null as string | null | undefined,
  onCopyItem: null as null | ((path: string) => void),
  onPasteIntoFolder: null as null | ((targetFolder: string) => void),
  nodes: [] as Array<{ path: string; gitStatus?: string }>,
  onFileClick: null as null | ((path: string) => void),
}));

vi.mock('@dnd-kit/core', () => ({
  useDndContext: () => ({ active: null }),
  useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
}));

vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/hooks/use-context-menu-focus-handoff', () => ({
  useContextMenuFocusHandoff: () => ({
    markNextCloseForInputFocus: vi.fn(),
    handleCloseAutoFocus: vi.fn(),
  }),
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

vi.mock('../code-editor', () => ({
  openFileAtom: atom(null),
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      files: {
        listDirectory: { invalidate: utilsInvalidate.listDirectory },
        search: { invalidate: utilsInvalidate.search },
        searchContent: { invalidate: utilsInvalidate.searchContent },
      },
    }),
    files: {
      listDirectory: { useQuery: () => ({ data: directoryState.rootContents, isLoading: false }) },
      search: { useQuery: () => ({ data: [], isLoading: false }) },
      moveFile: { useMutation: () => ({ mutate: vi.fn() }) },
      batchMoveFiles: { useMutation: () => ({ mutate: vi.fn() }) },
      createFile: { useMutation: () => ({ mutate: vi.fn() }) },
      createFolder: { useMutation: () => ({ mutate: vi.fn() }) },
      deleteFile: {
        useMutation: (opts?: { onSuccess?: () => void }) => {
          mutationHandlers.deleteOnSuccess = opts?.onSuccess ?? null;
          return { mutate: vi.fn() };
        },
      },
      renameFile: { useMutation: () => ({ mutate: vi.fn() }) },
      duplicateFile: { useMutation: () => ({ mutate: duplicateMutateMock }) },
      copyExternalFiles: { useMutation: () => ({ mutate: vi.fn() }) },
      batchDeleteFiles: { useMutation: () => ({ mutate: vi.fn() }) },
    },
  },
}));

vi.mock('./ContentSearchOptionsRow', () => ({
  ContentSearchOptionsRow: () => null,
}));

vi.mock('./ContentSearchResults', () => ({
  ContentSearchResults: () => null,
}));

vi.mock('./FileTree', () => ({
  FileTree: (props: {
    pathToExpandAfterDrop?: string | null;
    onCopyItem?: (path: string) => void;
    onPasteIntoFolder?: (targetFolder: string) => void;
    nodes: Array<{ path: string; gitStatus?: string }>;
    onFileClick?: (path: string) => void;
  }) => {
    fileTreePropsState.onFileClick = props.onFileClick ?? null;
    fileTreePropsState.pathToExpandAfterDrop = props.pathToExpandAfterDrop;
    fileTreePropsState.onCopyItem = props.onCopyItem ?? null;
    fileTreePropsState.onPasteIntoFolder = props.onPasteIntoFolder ?? null;
    fileTreePropsState.nodes = props.nodes;
    return <div data-testid="file-tree">tree</div>;
  },
}));

vi.mock('./use-chat-context-file', () => ({
  useChatContextFile: () => ({ setContextFileFromPath: vi.fn() }),
}));

vi.mock('./use-content-search-tab', () => ({
  useContentSearchTab: () => ({
    contentSearchQuery: '',
    contentDebouncedQuery: '',
    setContentSearchQuery: vi.fn(),
    contentSearchOptions: { caseSensitive: false, wholeWord: false, regex: false },
    setContentSearchOptions: vi.fn(),
    contentMatches: [],
    contentSearchInvalidRegex: false,
    isLoadingContentSearch: false,
    highlightContentMatch: (line: string) => line,
  }),
}));

vi.mock('./use-external-file-drop', () => ({
  useExternalFileDrop: () => ({
    isDragOver: externalDropState.isDragOver,
    onDragOver: vi.fn(),
    onDragLeave: vi.fn(),
    onDrop: vi.fn(),
    onPaste: externalOnPasteMock,
  }),
}));

vi.mock('./use-search-debounce', () => ({
  useSearchDebounce: () => ({
    searchQuery: searchState.searchQuery,
    debouncedQuery: searchState.debouncedQuery,
    setSearchQuery: vi.fn(),
  }),
}));

vi.mock('./FileTree/use-multi-select', () => ({
  useMultiSelect: () => ({
    selectOne: vi.fn(),
    selectRange: vi.fn(),
    toggleItem: vi.fn(),
    clearSelection: clearSelectionMock,
    getPrimary: vi.fn(() => mockState.primary),
    getSelectedItems: vi.fn(() => []),
    deselectDescendants: vi.fn(),
    selectAll: vi.fn(),
    count: mockState.selectedCount,
    selection: { paths: new Set<string>() },
  }),
}));

afterEach(() => {
  mockState.selectedCount = 0;
  mockState.primary = null;
  clearSelectionMock.mockReset();
  searchState.searchQuery = '';
  searchState.debouncedQuery = '';
  directoryState.rootContents = [];
  duplicateMutateMock.mockReset();
  externalOnPasteMock.mockReset();
  externalDropState.isDragOver = false;
  fileTreePropsState.pathToExpandAfterDrop = null;
  fileTreePropsState.onCopyItem = null;
  fileTreePropsState.onPasteIntoFolder = null;
  fileTreePropsState.nodes = [];
  fileTreePropsState.onFileClick = null;
  mutationHandlers.deleteOnSuccess = null;
  utilsInvalidate.listDirectory.mockReset();
  utilsInvalidate.search.mockReset();
  utilsInvalidate.searchContent.mockReset();
  cleanup();
});

describe('PaneFileTree footer rendering', () => {
  it('renders worktree footer variant when isWorktree is true', () => {
    const { container } = render(
      <PaneFileTree projectPath="/tmp/proj/.worktrees/feature-foo" isWorktree={true} />,
    );

    expect(container.textContent).toContain('feature-foo');
    const footer = container.querySelector('[title="Worktree: /tmp/proj/.worktrees/feature-foo"]');
    expect(footer).toBeInTheDocument();
  });

  it('renders non-worktree footer variant when isWorktree is false', () => {
    const { container } = render(<PaneFileTree projectPath="/tmp/proj" isWorktree={false} />);

    expect(container.textContent).toContain('proj');
    expect(container.querySelector('[title="/tmp/proj"]')).toBeInTheDocument();
  });

  it('shows selected count in footer when multiple items are selected', () => {
    mockState.selectedCount = 3;
    const { getByText } = render(<PaneFileTree projectPath="/tmp/proj" isWorktree={false} />);
    expect(getByText('3 selected')).toBeInTheDocument();
  });

  it('pastes copied node into currently selected folder', () => {
    mockState.primary = { path: '.cursor/rules', name: 'rules', type: 'folder' };
    const { container } = render(<PaneFileTree projectPath="/tmp/proj" isWorktree={false} />);
    const tree = container.querySelector('[role="tree"]');
    expect(tree).toBeTruthy();
    if (!tree) return;

    fireEvent.keyDown(tree, { key: 'c', metaKey: true });
    mockState.primary = { path: '.claude', name: '.claude', type: 'folder' };
    fireEvent.paste(tree);

    expect(duplicateMutateMock).toHaveBeenCalledWith({
      projectPath: '/tmp/proj',
      relativePath: '.cursor/rules',
      destinationFolder: '.claude',
    });
    expect(fileTreePropsState.pathToExpandAfterDrop).toBe('.claude');
  });

  it('pastes copied node into selected file parent folder', () => {
    mockState.primary = { path: '.cursor/rules', name: 'rules', type: 'folder' };
    const { container } = render(<PaneFileTree projectPath="/tmp/proj" isWorktree={false} />);
    const tree = container.querySelector('[role="tree"]');
    expect(tree).toBeTruthy();
    if (!tree) return;

    fireEvent.keyDown(tree, { key: 'c', metaKey: true });
    mockState.primary = { path: '.claude/README.md', name: 'README.md', type: 'file' };
    fireEvent.paste(tree);

    expect(duplicateMutateMock).toHaveBeenCalledWith({
      projectPath: '/tmp/proj',
      relativePath: '.cursor/rules',
      destinationFolder: '.claude',
    });
  });

  it('pastes copied node to project root when nothing is selected', () => {
    mockState.primary = { path: '.cursor/rules', name: 'rules', type: 'folder' };
    const { container } = render(<PaneFileTree projectPath="/tmp/proj" isWorktree={false} />);
    const tree = container.querySelector('[role="tree"]');
    expect(tree).toBeTruthy();
    if (!tree) return;

    fireEvent.keyDown(tree, { key: 'c', metaKey: true });
    mockState.primary = null;
    fireEvent.paste(tree);

    expect(duplicateMutateMock).toHaveBeenCalledWith({
      projectPath: '/tmp/proj',
      relativePath: '.cursor/rules',
      destinationFolder: '',
    });
  });

  it('does not run internal paste when external paste handled the event', () => {
    externalOnPasteMock.mockImplementation((event: { preventDefault: () => void }) => {
      event.preventDefault();
    });
    mockState.primary = { path: '.cursor/rules', name: 'rules', type: 'folder' };
    const { container } = render(<PaneFileTree projectPath="/tmp/proj" isWorktree={false} />);
    const tree = container.querySelector('[role="tree"]');
    expect(tree).toBeTruthy();
    if (!tree) return;

    fireEvent.keyDown(tree, { key: 'c', metaKey: true });
    mockState.primary = { path: '.claude', name: '.claude', type: 'folder' };
    fireEvent.paste(tree);

    expect(duplicateMutateMock).not.toHaveBeenCalled();
  });

  it('keeps copy buffer scoped per pane instance', () => {
    const { getAllByRole } = render(
      <>
        <PaneFileTree projectPath="/tmp/proj-a" isWorktree={false} />
        <PaneFileTree projectPath="/tmp/proj-b" isWorktree={false} />
      </>,
    );

    const trees = getAllByRole('tree');
    const firstTree = trees[0];
    const secondTree = trees[1];
    expect(firstTree).toBeTruthy();
    expect(secondTree).toBeTruthy();
    if (!firstTree || !secondTree) return;

    // Copy in first pane
    mockState.primary = { path: '.cursor/rules', name: 'rules', type: 'folder' };
    fireEvent.keyDown(firstTree, { key: 'c', metaKey: true });

    // Paste in second pane without copying there should no-op
    mockState.primary = { path: '.claude', name: '.claude', type: 'folder' };
    fireEvent.paste(secondTree);

    expect(duplicateMutateMock).not.toHaveBeenCalled();
  });

  it('wires context-menu copy and paste callbacks to duplicate flow', () => {
    const { container } = render(<PaneFileTree projectPath="/tmp/proj" isWorktree={false} />);
    const tree = container.querySelector('[role="tree"]');
    expect(tree).toBeTruthy();
    expect(fileTreePropsState.onCopyItem).toBeTruthy();
    expect(fileTreePropsState.onPasteIntoFolder).toBeTruthy();
    if (!tree || !fileTreePropsState.onCopyItem || !fileTreePropsState.onPasteIntoFolder) return;

    fileTreePropsState.onCopyItem('.cursor/rules');
    fileTreePropsState.onPasteIntoFolder('.claude');

    expect(duplicateMutateMock).toHaveBeenCalledWith({
      projectPath: '/tmp/proj',
      relativePath: '.cursor/rules',
      destinationFolder: '.claude',
    });
  });

  it('no-ops context-menu paste when internal buffer is empty', () => {
    render(<PaneFileTree projectPath="/tmp/proj" isWorktree={false} />);
    expect(fileTreePropsState.onPasteIntoFolder).toBeTruthy();
    fileTreePropsState.onPasteIntoFolder?.('.claude');
    expect(duplicateMutateMock).not.toHaveBeenCalled();
  });

  it('uses context-menu paste target instead of current primary selection', () => {
    mockState.primary = { path: '.other', name: '.other', type: 'folder' };
    render(<PaneFileTree projectPath="/tmp/proj" isWorktree={false} />);
    expect(fileTreePropsState.onCopyItem).toBeTruthy();
    expect(fileTreePropsState.onPasteIntoFolder).toBeTruthy();
    if (!fileTreePropsState.onCopyItem || !fileTreePropsState.onPasteIntoFolder) return;

    fileTreePropsState.onCopyItem('.cursor/rules');
    fileTreePropsState.onPasteIntoFolder('.claude');

    expect(duplicateMutateMock).toHaveBeenCalledWith({
      projectPath: '/tmp/proj',
      relativePath: '.cursor/rules',
      destinationFolder: '.claude',
    });
  });

  it('prevents duplicate double-paste from one context-menu copy action', () => {
    render(<PaneFileTree projectPath="/tmp/proj" isWorktree={false} />);
    if (!fileTreePropsState.onCopyItem || !fileTreePropsState.onPasteIntoFolder) return;

    fileTreePropsState.onCopyItem('.cursor/rules');
    fileTreePropsState.onPasteIntoFolder('.claude');
    fileTreePropsState.onPasteIntoFolder('.claude');

    expect(duplicateMutateMock).toHaveBeenCalledTimes(1);
  });

  it('supports independent copy/paste flows in parallel split panes', () => {
    const { getAllByRole } = render(
      <>
        <PaneFileTree projectPath="/tmp/proj-a" isWorktree={false} />
        <PaneFileTree projectPath="/tmp/proj-b" isWorktree={false} />
      </>,
    );

    const trees = getAllByRole('tree');
    const firstTree = trees[0];
    const secondTree = trees[1];
    if (!firstTree || !secondTree) return;

    mockState.primary = { path: '.cursor/rules-a', name: 'rules-a', type: 'folder' };
    fireEvent.keyDown(firstTree, { key: 'c', metaKey: true });
    mockState.primary = { path: '.claude-a', name: '.claude-a', type: 'folder' };
    fireEvent.paste(firstTree);

    mockState.primary = { path: '.cursor/rules-b', name: 'rules-b', type: 'folder' };
    fireEvent.keyDown(secondTree, { key: 'c', metaKey: true });
    mockState.primary = { path: '.claude-b', name: '.claude-b', type: 'folder' };
    fireEvent.paste(secondTree);

    expect(duplicateMutateMock).toHaveBeenNthCalledWith(1, {
      projectPath: '/tmp/proj-a',
      relativePath: '.cursor/rules-a',
      destinationFolder: '.claude-a',
    });
    expect(duplicateMutateMock).toHaveBeenNthCalledWith(2, {
      projectPath: '/tmp/proj-b',
      relativePath: '.cursor/rules-b',
      destinationFolder: '.claude-b',
    });
  });
});

describe('PaneFileTree cross-pane sync', () => {
  it('broadcasts a forced file-tree refresh on a structural mutation so sibling same-project panes update', () => {
    render(<PaneFileTree projectPath="/tmp/proj" isWorktree={false} />);
    expect(mutationHandlers.deleteOnSuccess).toBeTruthy();

    // Spy after mount so mount-time events (e.g. PANE_FILE_TREE_READY_EVENT) are excluded.
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    // Simulate a structural mutation completing — this is the wired `invalidateTree`.
    mutationHandlers.deleteOnSuccess?.();

    const refreshEvents = dispatchSpy.mock.calls
      .map((call) => call[0] as CustomEvent)
      .filter((event) => event.type === FILE_TREE_REFRESH_EVENT);

    expect(refreshEvents).toHaveLength(1);
    // `force: true` bypasses the listener throttle; projectPath scopes it to same-project panes.
    expect(refreshEvents[0].detail).toEqual({ projectPath: '/tmp/proj', force: true });

    dispatchSpy.mockRestore();
  });

  const dispatchRefresh = (projectPath: string, force?: boolean) =>
    window.dispatchEvent(
      new CustomEvent(FILE_TREE_REFRESH_EVENT, { detail: { projectPath, force } }),
    );

  it('processes every forced refresh in the throttle window (force bypasses REFETCH_THROTTLE_MS)', () => {
    render(<PaneFileTree projectPath="/tmp/proj" isWorktree={false} />);

    // Two forced events back-to-back (well within 500ms). force:true must skip the throttle
    // so a rapid second rename/delete still re-fetches — the contract the cross-pane fix relies on.
    dispatchRefresh('/tmp/proj', true);
    dispatchRefresh('/tmp/proj', true);

    expect(utilsInvalidate.listDirectory).toHaveBeenCalledTimes(2);
  });

  it('throttles unforced refreshes in the window (proves force:true is required, not incidental)', () => {
    render(<PaneFileTree projectPath="/tmp/proj" isWorktree={false} />);

    // Without force, the second in-window event is dropped — which is exactly why the mutation
    // broadcast passes force:true. If this drops to 1→2, the fix's force flag has become a no-op.
    dispatchRefresh('/tmp/proj');
    dispatchRefresh('/tmp/proj');

    expect(utilsInvalidate.listDirectory).toHaveBeenCalledTimes(1);
  });

  it('ignores a forced refresh scoped to a different project (no cross-project leak)', () => {
    render(<PaneFileTree projectPath="/tmp/proj-a" isWorktree={false} />);

    dispatchRefresh('/tmp/proj-b', true);

    expect(utilsInvalidate.listDirectory).not.toHaveBeenCalled();
  });
});

describe('PaneFileTree header close', () => {
  it('invokes onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    const { getByRole } = render(
      <PaneFileTree projectPath="/tmp/proj" isWorktree={false} onClose={onClose} />,
    );
    fireEvent.click(getByRole('button', { name: 'Close files' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not render the close button when onClose is omitted', () => {
    const { queryByRole } = render(<PaneFileTree projectPath="/tmp/proj" isWorktree={false} />);
    expect(queryByRole('button', { name: 'Close files' })).not.toBeInTheDocument();
  });

  it('invokes onClose on every click (parent toggle may run twice on double-click)', () => {
    const onClose = vi.fn();
    const { getByRole } = render(
      <PaneFileTree projectPath="/tmp/proj" isWorktree={false} onClose={onClose} />,
    );
    const closeBtn = getByRole('button', { name: 'Close files' });
    fireEvent.click(closeBtn);
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('keeps onClose handlers independent across two pane instances', () => {
    const onCloseA = vi.fn();
    const onCloseB = vi.fn();
    const { getAllByRole } = render(
      <>
        <PaneFileTree projectPath="/tmp/proj-a" isWorktree={false} onClose={onCloseA} />
        <PaneFileTree projectPath="/tmp/proj-b" isWorktree={false} onClose={onCloseB} />
      </>,
    );
    const closeButtons = getAllByRole('button', { name: 'Close files' });
    expect(closeButtons).toHaveLength(2);
    const [firstClose, secondClose] = closeButtons;
    expect(firstClose).toBeDefined();
    expect(secondClose).toBeDefined();
    if (!firstClose || !secondClose) return;

    fireEvent.click(firstClose);
    expect(onCloseA).toHaveBeenCalledTimes(1);
    expect(onCloseB).not.toHaveBeenCalled();

    fireEvent.click(secondClose);
    expect(onCloseA).toHaveBeenCalledTimes(1);
    expect(onCloseB).toHaveBeenCalledTimes(1);
  });
});

describe('PaneFileTree modified-only toggle', () => {
  it('shows the toggle only when git diff exists', () => {
    const { queryByRole, rerender } = render(
      <PaneFileTree projectPath="/tmp/proj" isWorktree={false} />,
    );
    expect(queryByRole('button', { name: 'Show modified files only' })).not.toBeInTheDocument();

    directoryState.rootContents = [
      { name: 'src', path: 'src', type: 'folder', gitStatus: 'modified' },
    ];
    rerender(<PaneFileTree projectPath="/tmp/proj" isWorktree={false} />);
    expect(queryByRole('button', { name: 'Show modified files only' })).toBeInTheDocument();
  });

  it('hides the toggle while searching file names', () => {
    directoryState.rootContents = [
      { name: 'src', path: 'src', type: 'folder', gitStatus: 'modified' },
    ];
    searchState.debouncedQuery = 'task';

    const { queryByRole } = render(<PaneFileTree projectPath="/tmp/proj" isWorktree={false} />);
    expect(queryByRole('button', { name: 'Show modified files only' })).not.toBeInTheDocument();
  });

  it('filters nodes and clears selection when toggled', () => {
    directoryState.rootContents = [
      { name: 'src', path: 'src', type: 'folder', gitStatus: 'modified' },
      { name: 'docs', path: 'docs', type: 'folder' },
    ];
    const { getByRole } = render(<PaneFileTree projectPath="/tmp/proj" isWorktree={false} />);

    fireEvent.click(getByRole('button', { name: 'Show modified files only' }));

    expect(fileTreePropsState.nodes.map((node) => node.path)).toEqual(['src']);
    expect(clearSelectionMock).toHaveBeenCalledTimes(1);
  });

  it('toggling OFF restores all nodes', () => {
    directoryState.rootContents = [
      { name: 'src', path: 'src', type: 'folder', gitStatus: 'modified' },
      { name: 'docs', path: 'docs', type: 'folder' },
    ];
    const { getByRole } = render(<PaneFileTree projectPath="/tmp/proj" isWorktree={false} />);
    const btn = getByRole('button', { name: 'Show modified files only' });

    fireEvent.click(btn);
    expect(fileTreePropsState.nodes.map((n) => n.path)).toEqual(['src']);

    fireEvent.click(btn);
    expect(fileTreePropsState.nodes.map((n) => n.path)).toEqual(['src', 'docs']);
  });

  it('hides root folders without gitStatus even when deeply nested files are modified (edge: propagation gap)', () => {
    directoryState.rootContents = [
      { name: 'src', path: 'src', type: 'folder', gitStatus: 'modified' },
      { name: 'vendor', path: 'vendor', type: 'folder' },
    ];
    const { getByRole } = render(<PaneFileTree projectPath="/tmp/proj" isWorktree={false} />);

    fireEvent.click(getByRole('button', { name: 'Show modified files only' }));

    expect(fileTreePropsState.nodes.map((n) => n.path)).toEqual(['src']);
    expect(fileTreePropsState.nodes.some((n) => n.path === 'vendor')).toBe(false);
  });

  it('auto-resets toggle when all git diffs are resolved', () => {
    directoryState.rootContents = [
      { name: 'src', path: 'src', type: 'folder', gitStatus: 'modified' },
      { name: 'docs', path: 'docs', type: 'folder' },
    ];
    const { getByRole, queryByRole, rerender } = render(
      <PaneFileTree projectPath="/tmp/proj" isWorktree={false} />,
    );

    fireEvent.click(getByRole('button', { name: 'Show modified files only' }));
    expect(fileTreePropsState.nodes.map((n) => n.path)).toEqual(['src']);

    directoryState.rootContents = [
      { name: 'src', path: 'src', type: 'folder' },
      { name: 'docs', path: 'docs', type: 'folder' },
    ];
    rerender(<PaneFileTree projectPath="/tmp/proj" isWorktree={false} />);

    expect(queryByRole('button', { name: 'Show modified files only' })).not.toBeInTheDocument();
    expect(fileTreePropsState.nodes.map((n) => n.path)).toEqual(['src', 'docs']);
  });

  it('clears selection when hasGitDiff becomes false while toggle is active', () => {
    directoryState.rootContents = [
      { name: 'src', path: 'src', type: 'folder', gitStatus: 'modified' },
    ];
    const { getByRole, rerender } = render(
      <PaneFileTree projectPath="/tmp/proj" isWorktree={false} />,
    );

    fireEvent.click(getByRole('button', { name: 'Show modified files only' }));
    clearSelectionMock.mockReset();

    directoryState.rootContents = [{ name: 'src', path: 'src', type: 'folder' }];
    rerender(<PaneFileTree projectPath="/tmp/proj" isWorktree={false} />);

    expect(clearSelectionMock).toHaveBeenCalled();
  });

  it('rerender after drag removes folder that lost gitStatus', () => {
    directoryState.rootContents = [
      { name: 'src', path: 'src', type: 'folder', gitStatus: 'modified' },
      { name: 'lib', path: 'lib', type: 'folder', gitStatus: 'added' },
    ];
    const { getByRole, rerender } = render(
      <PaneFileTree projectPath="/tmp/proj" isWorktree={false} />,
    );

    fireEvent.click(getByRole('button', { name: 'Show modified files only' }));
    expect(fileTreePropsState.nodes.map((n) => n.path)).toEqual(['src', 'lib']);

    directoryState.rootContents = [
      { name: 'src', path: 'src', type: 'folder', gitStatus: 'modified' },
      { name: 'lib', path: 'lib', type: 'folder' },
    ];
    rerender(<PaneFileTree projectPath="/tmp/proj" isWorktree={false} />);

    expect(fileTreePropsState.nodes.map((n) => n.path)).toEqual(['src']);
  });

  it('maintains independent toggle state across two panes', () => {
    directoryState.rootContents = [
      { name: 'src', path: 'src', type: 'folder', gitStatus: 'modified' },
      { name: 'docs', path: 'docs', type: 'folder' },
    ];
    const { getAllByRole } = render(
      <>
        <PaneFileTree projectPath="/tmp/proj-a" isWorktree={false} />
        <PaneFileTree projectPath="/tmp/proj-b" isWorktree={false} />
      </>,
    );

    const toggles = getAllByRole('button', { name: 'Show modified files only' });
    expect(toggles).toHaveLength(2);

    const firstToggle = toggles[0];
    expect(firstToggle).toBeTruthy();
    if (!firstToggle) return;
    fireEvent.click(firstToggle);

    expect(toggles[0]).toHaveAttribute('aria-pressed', 'true');
    expect(toggles[1]).toHaveAttribute('aria-pressed', 'false');
  });

  it('rapid toggle does not corrupt filtered state', () => {
    directoryState.rootContents = [
      { name: 'src', path: 'src', type: 'folder', gitStatus: 'modified' },
      { name: 'docs', path: 'docs', type: 'folder' },
    ];
    const { getByRole } = render(<PaneFileTree projectPath="/tmp/proj" isWorktree={false} />);
    const btn = getByRole('button', { name: 'Show modified files only' });

    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);

    expect(fileTreePropsState.nodes.map((n) => n.path)).toEqual(['src']);
    expect(btn).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('PaneFileTree external-drop announcement', () => {
  it('announces drop acceptance to screen readers during drag-over', () => {
    externalDropState.isDragOver = true;
    const { container } = render(<PaneFileTree projectPath="/tmp/proj" isWorktree={false} />);
    const liveRegion = container.querySelector('[role="tree"] [role="status"]');
    expect(liveRegion).toHaveTextContent('Drop files to copy into proj file tree');
  });

  it('keeps the live region empty when not dragging over', () => {
    const { container } = render(<PaneFileTree projectPath="/tmp/proj" isWorktree={false} />);
    const liveRegion = container.querySelector('[role="tree"] [role="status"]');
    expect(liveRegion).toBeInTheDocument();
    expect(liveRegion).toHaveTextContent('');
  });
});

// sc-3855: the tree's click/Space wiring reaches the real openFileAtom, so a closed editor reopens.
describe('PaneFileTree opens files into the editor', () => {
  const store = getDefaultStore();

  afterEach(() => {
    store.set(openFilesAtom, []);
    store.set(activeFilePathAtom, null);
    store.set(codeEditorOpenAtom, false);
  });

  it('reopens a closed editor on a tree click, carrying the pane and preview intent', () => {
    render(
      <PaneFileTree projectPath="/tmp/proj" paneIndex={1} chatId="chat-1" isWorktree={false} />,
    );
    const onFileClick = fileTreePropsState.onFileClick;
    expect(onFileClick).toBeTypeOf('function');

    act(() => onFileClick?.('src/a.ts'));
    act(() => store.set(codeEditorOpenAtom, false));
    act(() => onFileClick?.('src/a.ts'));

    expect(store.get(codeEditorOpenAtom)).toBe(true);
    expect(store.get(activeFilePathAtom)).toBe(fileKey('src/a.ts', '/tmp/proj'));
    expect(store.get(openFilesAtom)).toEqual([
      expect.objectContaining({
        path: 'src/a.ts',
        name: 'a.ts',
        projectPath: '/tmp/proj',
        sourcePaneIndex: 1,
        sourceChatId: 'chat-1',
        isPreview: true,
      }),
    ]);
  });

  it('reopens a closed editor when Space is pressed on the already-selected file', () => {
    mockState.primary = { path: 'src/a.ts', name: 'a.ts', type: 'file' };
    const { getByRole } = render(<PaneFileTree projectPath="/tmp/proj" isWorktree={false} />);

    fireEvent.keyDown(getByRole('tree'), { key: ' ' });
    expect(store.get(codeEditorOpenAtom)).toBe(true);
    act(() => store.set(codeEditorOpenAtom, false));
    fireEvent.keyDown(getByRole('tree'), { key: ' ' });

    expect(store.get(codeEditorOpenAtom)).toBe(true);
    expect(store.get(openFilesAtom).map((f) => f.path)).toEqual(['src/a.ts']);
  });
});
