// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { atom } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilesSidebar } from './index';

const mockState = vi.hoisted(() => ({
  primary: null as { path: string; name: string; type: 'file' | 'folder' } | null,
}));
const duplicateMutateMock = vi.hoisted(() => vi.fn());
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
const navigationState = vi.hoisted(() => ({
  onCopy: null as null | ((path: string) => void),
}));
const fileTreePropsState = vi.hoisted(() => ({
  pathToExpandAfterDrop: null as string | null | undefined,
  onCopyItem: null as null | ((path: string) => void),
  onPasteIntoFolder: null as null | ((targetFolder: string) => void),
  nodes: [] as Array<{ path: string; gitStatus?: string }>,
}));

vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/ui/resizable-sidebar', () => ({
  ResizableSidebar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));

vi.mock('@/hooks/use-context-menu-focus-handoff', () => ({
  useContextMenuFocusHandoff: () => ({
    markNextCloseForInputFocus: vi.fn(),
    handleCloseAutoFocus: vi.fn(),
  }),
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      files: {
        listDirectory: { invalidate: vi.fn() },
        search: { invalidate: vi.fn() },
        searchContent: { invalidate: vi.fn() },
      },
    }),
    chats: {
      get: {
        useQuery: () => ({ data: undefined }),
      },
    },
    files: {
      listDirectory: { useQuery: () => ({ data: directoryState.rootContents, isLoading: false }) },
      search: { useQuery: () => ({ data: [], isLoading: false }) },
      searchContent: { useQuery: () => ({ data: { matches: [], invalidRegex: false } }) },
      moveFile: { useMutation: () => ({ mutate: vi.fn() }) },
      batchMoveFiles: { useMutation: () => ({ mutate: vi.fn() }) },
      createFile: { useMutation: () => ({ mutate: vi.fn() }) },
      createFolder: { useMutation: () => ({ mutate: vi.fn() }) },
      deleteFile: { useMutation: () => ({ mutate: vi.fn() }) },
      renameFile: { useMutation: () => ({ mutate: vi.fn() }) },
      duplicateFile: { useMutation: () => ({ mutate: duplicateMutateMock }) },
      copyExternalFiles: { useMutation: () => ({ mutate: vi.fn() }) },
      batchDeleteFiles: { useMutation: () => ({ mutate: vi.fn() }) },
    },
  },
}));

vi.mock('../agents/atoms', () => ({
  selectedProjectAtom: atom({
    name: 'proj',
    path: '/tmp/proj',
  }),
  recentlyOpenedFilesAtom: atom<string[]>([]),
}));

vi.mock('../code-editor', () => ({
  openFileAtom: atom(null),
}));

vi.mock('./atoms', () => ({
  filesSidebarOpenAtom: atom(true),
  filesSidebarActiveTabAtom: atom('files'),
  filesSidebarWidthAtom: atom(320),
}));

vi.mock('../sidebar/components/SidebarHeaderWithSearch', () => ({
  SidebarHeaderWithSearch: () => null,
}));

vi.mock('./ContentSearchOptionsRow', () => ({
  ContentSearchOptionsRow: () => null,
}));

vi.mock('./ContentSearchResults', () => ({
  ContentSearchResults: () => null,
}));

vi.mock('./FilesSidebarFooter', () => ({
  FilesSidebarFooter: () => null,
}));

vi.mock('./FileTree', () => ({
  FileTree: (props: {
    pathToExpandAfterDrop?: string | null;
    onCopyItem?: (path: string) => void;
    onPasteIntoFolder?: (targetFolder: string) => void;
    nodes: Array<{ path: string; gitStatus?: string }>;
  }) => {
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
    contentSearchOptions: { matchCase: false, wholeWord: false, useRegex: false },
    setContentSearchOptions: vi.fn(),
    contentMatches: [],
    contentSearchInvalidRegex: false,
    isLoadingContentSearch: false,
    highlightContentMatch: (line: string) => line,
  }),
}));

vi.mock('./use-search-debounce', () => ({
  useSearchDebounce: () => ({
    searchQuery: searchState.searchQuery,
    debouncedQuery: searchState.debouncedQuery,
    setSearchQuery: vi.fn(),
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

vi.mock('./use-file-tree-hotkeys', () => ({
  useFileTreeHotkeys: () => {},
}));

vi.mock('./use-file-tree-navigation', () => ({
  useFileTreeNavigation: (
    _containerRef: unknown,
    callbacks: { onCopy: (path: string) => void },
  ) => {
    navigationState.onCopy = callbacks.onCopy;
  },
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
    count: 0,
    selection: { paths: new Set<string>() },
  }),
}));

afterEach(() => {
  mockState.primary = null;
  clearSelectionMock.mockReset();
  searchState.searchQuery = '';
  searchState.debouncedQuery = '';
  directoryState.rootContents = [];
  navigationState.onCopy = null;
  duplicateMutateMock.mockReset();
  externalOnPasteMock.mockReset();
  externalDropState.isDragOver = false;
  fileTreePropsState.pathToExpandAfterDrop = null;
  fileTreePropsState.onCopyItem = null;
  fileTreePropsState.onPasteIntoFolder = null;
  fileTreePropsState.nodes = [];
  cleanup();
});

describe('FilesSidebar paste behavior', () => {
  it('pastes copied node into selected folder', () => {
    mockState.primary = { path: '.claude', name: '.claude', type: 'folder' };

    const { container } = render(<FilesSidebar />);
    const tree = container.querySelector('[role="tree"]');
    expect(tree).toBeTruthy();
    if (!tree) return;

    navigationState.onCopy?.('.cursor/rules');
    fireEvent.paste(tree);

    expect(duplicateMutateMock).toHaveBeenCalledWith({
      projectPath: '/tmp/proj',
      relativePath: '.cursor/rules',
      destinationFolder: '.claude',
    });
    expect(fileTreePropsState.pathToExpandAfterDrop).toBe('.claude');
  });

  it('wires context-menu copy and paste callbacks to duplicate flow', () => {
    const { container } = render(<FilesSidebar />);
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

  it('no-ops context-menu paste when no internal copy exists', () => {
    render(<FilesSidebar />);
    fileTreePropsState.onPasteIntoFolder?.('.claude');
    expect(duplicateMutateMock).not.toHaveBeenCalled();
  });

  it('uses context-menu destination even when primary selection differs', () => {
    mockState.primary = { path: '.other', name: '.other', type: 'folder' };
    render(<FilesSidebar />);
    if (!fileTreePropsState.onCopyItem || !fileTreePropsState.onPasteIntoFolder) return;

    fileTreePropsState.onCopyItem('.cursor/rules');
    fileTreePropsState.onPasteIntoFolder('.claude');

    expect(duplicateMutateMock).toHaveBeenCalledWith({
      projectPath: '/tmp/proj',
      relativePath: '.cursor/rules',
      destinationFolder: '.claude',
    });
  });

  it('does not run duplicate twice for repeated context-menu paste after one copy', () => {
    render(<FilesSidebar />);
    if (!fileTreePropsState.onCopyItem || !fileTreePropsState.onPasteIntoFolder) return;

    fileTreePropsState.onCopyItem('.cursor/rules');
    fileTreePropsState.onPasteIntoFolder('.claude');
    fileTreePropsState.onPasteIntoFolder('.claude');

    expect(duplicateMutateMock).toHaveBeenCalledTimes(1);
  });
});

describe('FilesSidebar modified-only toggle', () => {
  it('shows the toggle only when git diff exists', () => {
    const { queryByRole, rerender } = render(<FilesSidebar />);
    expect(queryByRole('button', { name: 'Show modified files only' })).not.toBeInTheDocument();

    directoryState.rootContents = [
      { name: 'src', path: 'src', type: 'folder', gitStatus: 'modified' },
      { name: 'README.md', path: 'README.md', type: 'file' },
    ];
    rerender(<FilesSidebar />);
    expect(queryByRole('button', { name: 'Show modified files only' })).toBeInTheDocument();
  });

  it('hides the toggle while searching file names', () => {
    directoryState.rootContents = [
      { name: 'src', path: 'src', type: 'folder', gitStatus: 'modified' },
    ];
    searchState.debouncedQuery = 'agent';

    const { queryByRole } = render(<FilesSidebar />);
    expect(queryByRole('button', { name: 'Show modified files only' })).not.toBeInTheDocument();
  });

  it('filters nodes and clears selection when toggled', () => {
    directoryState.rootContents = [
      { name: 'src', path: 'src', type: 'folder', gitStatus: 'modified' },
      { name: 'docs', path: 'docs', type: 'folder' },
    ];
    const { getByRole } = render(<FilesSidebar />);

    fireEvent.click(getByRole('button', { name: 'Show modified files only' }));

    expect(fileTreePropsState.nodes.map((node) => node.path)).toEqual(['src']);
    expect(clearSelectionMock).toHaveBeenCalledTimes(1);
  });

  it('toggling OFF restores all nodes', () => {
    directoryState.rootContents = [
      { name: 'src', path: 'src', type: 'folder', gitStatus: 'modified' },
      { name: 'docs', path: 'docs', type: 'folder' },
      { name: 'tests', path: 'tests', type: 'folder' },
    ];
    const { getByRole } = render(<FilesSidebar />);
    const btn = getByRole('button', { name: 'Show modified files only' });

    fireEvent.click(btn);
    expect(fileTreePropsState.nodes.map((n) => n.path)).toEqual(['src']);

    fireEvent.click(btn);
    expect(fileTreePropsState.nodes.map((n) => n.path)).toEqual(['src', 'docs', 'tests']);
  });

  it('sets aria-pressed to reflect toggle state', () => {
    directoryState.rootContents = [
      { name: 'src', path: 'src', type: 'folder', gitStatus: 'modified' },
    ];
    const { getByRole } = render(<FilesSidebar />);
    const btn = getByRole('button', { name: 'Show modified files only' });

    expect(btn).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-pressed', 'false');
  });

  it('hides root folders without gitStatus even when deeply nested files are modified (edge: propagation gap)', () => {
    directoryState.rootContents = [
      { name: 'src', path: 'src', type: 'folder', gitStatus: 'modified' },
      { name: 'vendor', path: 'vendor', type: 'folder' },
      { name: 'config', path: 'config', type: 'folder' },
    ];
    const { getByRole } = render(<FilesSidebar />);

    fireEvent.click(getByRole('button', { name: 'Show modified files only' }));

    expect(fileTreePropsState.nodes.map((n) => n.path)).toEqual(['src']);
    expect(fileTreePropsState.nodes.some((n) => n.path === 'vendor')).toBe(false);
    expect(fileTreePropsState.nodes.some((n) => n.path === 'config')).toBe(false);
  });

  it('auto-resets toggle and restores nodes when all git diffs are resolved', () => {
    directoryState.rootContents = [
      { name: 'src', path: 'src', type: 'folder', gitStatus: 'modified' },
      { name: 'docs', path: 'docs', type: 'folder' },
    ];
    const { getByRole, queryByRole, rerender } = render(<FilesSidebar />);

    fireEvent.click(getByRole('button', { name: 'Show modified files only' }));
    expect(fileTreePropsState.nodes.map((n) => n.path)).toEqual(['src']);

    directoryState.rootContents = [
      { name: 'src', path: 'src', type: 'folder' },
      { name: 'docs', path: 'docs', type: 'folder' },
    ];
    rerender(<FilesSidebar />);

    expect(queryByRole('button', { name: 'Show modified files only' })).not.toBeInTheDocument();
    expect(fileTreePropsState.nodes.map((n) => n.path)).toEqual(['src', 'docs']);
  });

  it('clears selection when hasGitDiff becomes false while toggle is active', () => {
    directoryState.rootContents = [
      { name: 'src', path: 'src', type: 'folder', gitStatus: 'modified' },
    ];
    const { getByRole, rerender } = render(<FilesSidebar />);

    fireEvent.click(getByRole('button', { name: 'Show modified files only' }));
    clearSelectionMock.mockReset();

    directoryState.rootContents = [{ name: 'src', path: 'src', type: 'folder' }];
    rerender(<FilesSidebar />);

    expect(clearSelectionMock).toHaveBeenCalled();
  });

  it('rerender after drag removes folder that lost gitStatus', () => {
    directoryState.rootContents = [
      { name: 'src', path: 'src', type: 'folder', gitStatus: 'modified' },
      { name: 'lib', path: 'lib', type: 'folder', gitStatus: 'added' },
    ];
    const { getByRole, rerender } = render(<FilesSidebar />);

    fireEvent.click(getByRole('button', { name: 'Show modified files only' }));
    expect(fileTreePropsState.nodes.map((n) => n.path)).toEqual(['src', 'lib']);

    directoryState.rootContents = [
      { name: 'src', path: 'src', type: 'folder', gitStatus: 'modified' },
      { name: 'lib', path: 'lib', type: 'folder' },
    ];
    rerender(<FilesSidebar />);

    expect(fileTreePropsState.nodes.map((n) => n.path)).toEqual(['src']);
  });

  it('rapid toggle does not corrupt filtered state', () => {
    directoryState.rootContents = [
      { name: 'src', path: 'src', type: 'folder', gitStatus: 'modified' },
      { name: 'docs', path: 'docs', type: 'folder' },
    ];
    const { getByRole } = render(<FilesSidebar />);
    const btn = getByRole('button', { name: 'Show modified files only' });

    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);

    expect(fileTreePropsState.nodes.map((n) => n.path)).toEqual(['src']);
    expect(btn).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('FilesSidebar external-drop announcement', () => {
  it('announces drop acceptance to screen readers during drag-over', () => {
    externalDropState.isDragOver = true;
    const { container } = render(<FilesSidebar />);
    const liveRegion = container.querySelector('[role="tree"] [role="status"]');
    expect(liveRegion).toHaveTextContent('Drop files to copy into proj file tree');
  });

  it('keeps the live region empty when not dragging over', () => {
    const { container } = render(<FilesSidebar />);
    const liveRegion = container.querySelector('[role="tree"] [role="status"]');
    expect(liveRegion).toBeInTheDocument();
    expect(liveRegion).toHaveTextContent('');
  });
});
