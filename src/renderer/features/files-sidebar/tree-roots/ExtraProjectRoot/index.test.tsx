// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { DndContext, useDndContext } from '@dnd-kit/core';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createStore, Provider } from 'jotai';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { chatContextFileAtomFamily, openFilesAtom } from '@/lib/code-editor/state';
import { FileTree } from '../../FileTree';
import type { FileTreeNode } from '../../types';
import { ExtraProjectRoot } from './index';

type Query = { data?: unknown; isError?: boolean; isSuccess?: boolean; isLoading?: boolean };

const api = vi.hoisted(() => {
  // A query that is switched off still returns what it last read, as in React Query.
  const state = {
    listing: {} as Query,
    searchResults: [] as unknown[],
    folderType: {} as Query,
    branches: {} as Query,
  };
  return {
    state,
    listQuery: vi.fn((_input: unknown, _options: unknown) => state.listing),
    searchQuery: vi.fn((_input: unknown, _options: unknown) => ({ data: state.searchResults })),
    invalidateList: vi.fn(),
    invalidateBranches: vi.fn(),
    invalidateChat: vi.fn(),
    listChildren: vi.fn(),
    subscribeToGitWatcher: vi.fn(),
  };
});

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      files: {
        listDirectory: { invalidate: api.invalidateList },
        search: { invalidate: vi.fn() },
        entryType: { invalidate: vi.fn() },
      },
      changes: { getBranches: { invalidate: api.invalidateBranches } },
      chats: { get: { invalidate: api.invalidateChat } },
    }),
    files: {
      listDirectory: { useQuery: api.listQuery },
      search: { useQuery: api.searchQuery },
      entryType: { useQuery: () => api.state.folderType },
    },
    changes: { getBranches: { useQuery: () => api.state.branches } },
    external: { openInFinder: { useMutation: () => ({ mutate: vi.fn() }) } },
  },
  trpcClient: { files: { listDirectory: { query: api.listChildren } } },
}));
// Each row's menu renders inline, so a test can read every item it offers.
vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({ children }: { children: ReactNode }) => <div role="menuitem">{children}</div>,
  ContextMenuSeparator: () => null,
}));
// No shortcut hints, so a menu item's text is its label alone.
vi.mock('@/lib/hotkeys/shortcut-registry', () => ({
  getShortcutAction: () => null,
  keysToDisplay: () => '',
}));

const entry = (path: string, type: string) => ({ name: path.split('/').pop(), path, type });
const MISSING_FOLDER = "Can't open api's folder. It may have moved or been deleted.";

function renderRoot(
  props: Partial<ComponentProps<typeof ExtraProjectRoot>> = {},
  after?: ReactNode,
) {
  const store = createStore();
  const onRemove = vi.fn();
  render(
    <Provider store={store}>
      <TooltipProvider>
        <ExtraProjectRoot
          project={{ id: 'api', name: 'api', path: '/w/api' }}
          chatId="chat-1"
          paneIndex={1}
          onRemove={onRemove}
          {...props}
        />
        {after}
      </TooltipProvider>
    </Provider>,
  );
  const tree = screen.getByRole('tree', { name: 'api file tree, linked', hidden: true });
  return { store, onRemove, tree, row: screen.getByRole('button', { name: /^api/ }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.state.listing = { data: [entry('src', 'folder'), entry('README.md', 'file')] };
  api.state.searchResults = [];
  api.state.folderType = {};
  api.state.branches = { data: { current: 'main' } };
  api.listChildren.mockResolvedValue([entry('src/a.ts', 'file')]);
  Object.defineProperty(window, 'desktopApi', {
    configurable: true,
    value: { subscribeToGitWatcher: api.subscribeToGitWatcher },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ExtraProjectRoot', () => {
  it('lists the project folder while open, without starting a git watcher', () => {
    const { tree, row } = renderRoot();

    expect(api.listQuery).toHaveBeenLastCalledWith(
      { projectPath: '/w/api', relativePath: '' },
      expect.objectContaining({ enabled: true }),
    );
    expect(
      within(tree)
        .getAllByRole('treeitem')
        .map((item) => item.textContent),
    ).toEqual(['src', 'README.md']);
    expect(row.closest('[data-read-only-root]')).toContainElement(tree);
    expect(api.subscribeToGitWatcher).not.toHaveBeenCalled();
  });

  it('hides its files when closed, keeps an open folder open, and re-reads them on opening', async () => {
    const user = userEvent.setup();
    const { tree, row } = renderRoot();
    await user.click(within(tree).getByRole('treeitem', { name: 'src' }));
    await within(tree).findByRole('treeitem', { name: 'a.ts' });

    await user.click(row);
    expect(tree).not.toBeVisible();
    expect(api.invalidateList).not.toHaveBeenCalled();
    const folderReads = api.listChildren.mock.calls.length;

    await user.click(row);
    expect(within(tree).getByRole('treeitem', { name: 'a.ts' })).toBeVisible();
    expect(api.invalidateList).toHaveBeenCalledWith({ projectPath: '/w/api' });
    await waitFor(() => expect(api.listChildren).toHaveBeenCalledTimes(folderReads + 1));
    // The folder was there, so the chat isn't asked about it again.
    expect(api.invalidateChat).not.toHaveBeenCalled();
  });

  it('unlinks the project from its x', async () => {
    const { onRemove } = renderRoot();
    await userEvent.click(screen.getByRole('button', { name: 'Unlink api' }));
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('says a linked folder that is gone is missing, and reads neither it nor its branch', () => {
    renderRoot({ project: { id: 'api', name: 'api', path: '/w/api', missing: true } });

    expect(screen.getByRole('status')).toHaveTextContent(/^Can't find api's folder\.$/);
    expect(screen.getByRole('button', { name: /^api/ })).toHaveAccessibleName(
      'api Linked folder missing',
    );
    expect(api.listQuery).toHaveBeenLastCalledWith(expect.anything(), { enabled: false });
  });

  it('keeps a missing folder marked on its row while closed, and looks for it again on opening', async () => {
    const user = userEvent.setup();
    const { row } = renderRoot({
      project: { id: 'api', name: 'api', path: '/w/api', missing: true },
    });

    await user.click(row);
    expect(screen.queryByRole('status')).toBeNull();
    expect(row).toHaveAccessibleName('api Linked folder missing');
    fireEvent.focus(row);
    expect(screen.getByRole('tooltip')).toHaveTextContent("Can't find api's folder.");
    expect(api.invalidateChat).not.toHaveBeenCalled();

    await user.click(row);
    expect(api.invalidateChat).toHaveBeenCalledExactlyOnceWith({ id: 'chat-1' });
  });

  it("opens a file as the chat's browsed tab and never as its context file", async () => {
    const { store, tree } = renderRoot();
    await userEvent.click(within(tree).getByRole('treeitem', { name: 'README.md' }));

    expect(store.get(openFilesAtom)).toEqual([
      expect.objectContaining({
        path: 'README.md',
        name: 'README.md',
        projectPath: '/w/api',
        isOtherProject: true,
        isWorktreeContext: false,
        sourceChatId: 'chat-1',
        sourcePaneIndex: 1,
        isPreview: true,
      }),
    ]);
    expect(store.get(chatContextFileAtomFamily('chat-1'))).toBeNull();
  });

  it('offers no menu item that changes the project', () => {
    const { tree } = renderRoot();
    const labels = within(tree)
      .getAllByRole('menuitem')
      .map((item) => item.textContent);

    expect(labels).toContain('Copy Path');
    for (const label of ['New File...', 'New Folder...', 'Copy', 'Paste', 'Rename', 'Delete']) {
      expect(labels).not.toContain(label);
    }
  });

  it.each<[string, Query, Query, 'missing' | 'empty' | 'loading']>([
    ['says a folder that fails to list may have moved', { isError: true }, {}, 'missing'],
    [
      'says a folder no longer on disk may have moved',
      { data: [] },
      { data: null, isSuccess: true },
      'missing',
    ],
    ['lists an empty folder as empty', { data: [] }, { data: 'folder', isSuccess: true }, 'empty'],
    [
      'waits for the disk before it calls a folder empty',
      { data: [] },
      { isLoading: true },
      'loading',
    ],
  ])('%s', (_, listing, folderType, shows) => {
    api.state.listing = listing;
    api.state.folderType = folderType;
    const { tree } = renderRoot();

    expect(screen.queryByRole('status')?.textContent ?? null).toBe(
      shows === 'missing' ? MISSING_FOLDER : null,
    );
    expect(Boolean(screen.queryByText('No files in project'))).toBe(shows === 'empty');
    expect(tree.getAttribute('aria-busy')).toBe(shows === 'loading' ? 'true' : null);
  });

  it('says a folder no longer on disk may have moved while a name filter is set', () => {
    api.state.folderType = { data: null, isSuccess: true };
    renderRoot({ searchQuery: 'guide' });

    expect(screen.getByRole('status')).toHaveTextContent(MISSING_FOLDER);
    expect(screen.queryByText('No files found')).not.toBeInTheDocument();
  });

  it('searches only this project for a name filter', () => {
    api.state.searchResults = [entry('guide.md', 'file')];
    const { tree } = renderRoot({ searchQuery: 'guide' });

    expect(api.searchQuery).toHaveBeenLastCalledWith(
      { projectPath: '/w/api', query: 'guide', limit: 5000 },
      expect.objectContaining({ enabled: true }),
    );
    expect(api.listQuery).toHaveBeenLastCalledWith(expect.anything(), { enabled: false });
    expect(within(tree).getByRole('treeitem', { name: 'guide.md' })).toBeInTheDocument();
  });

  it('moves, opens folders and opens files with the keys, staying inside this project', async () => {
    const user = userEvent.setup();
    const { store, tree } = renderRoot(
      {},
      <div role="tree">
        <button type="button" data-tree-path="elsewhere.ts" />
      </div>,
    );
    tree.focus();

    await user.keyboard('{ArrowDown}{ArrowRight}');
    await within(tree).findByRole('treeitem', { name: 'a.ts' });
    await user.keyboard('{ArrowDown}{Enter}');
    expect(store.get(openFilesAtom).map((file) => file.path)).toEqual(['src/a.ts']);

    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(within(tree).getByRole('treeitem', { selected: true })).toHaveTextContent('README.md');

    // F2 renames elsewhere; nothing here can be renamed, so it leaves the file closed.
    await user.keyboard('{F2}');
    expect(store.get(openFilesAtom).map((file) => file.path)).toEqual(['src/a.ts']);
  });

  it('re-reads the files on window focus at most every 30 seconds after they were last read', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    renderRoot();
    const focusAt = (time: number) => {
      now.mockReturnValue(time);
      act(() => window.dispatchEvent(new Event('focus')));
    };

    focusAt(101_000);
    expect(api.invalidateList).not.toHaveBeenCalled();
    focusAt(130_000);
    focusAt(159_999);
    expect(api.invalidateList).toHaveBeenCalledTimes(1);
    expect(api.invalidateBranches).toHaveBeenCalledWith(
      { worktreePath: '/w/api' },
      { stale: true },
    );
    focusAt(160_000);
    expect(api.invalidateList).toHaveBeenCalledTimes(2);
  });

  it('leaves a closed root unread on window focus', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const { row } = renderRoot();
    await userEvent.click(row);

    now.mockReturnValue(200_000);
    act(() => window.dispatchEvent(new Event('focus')));
    expect(api.invalidateList).not.toHaveBeenCalled();
  });

  it.each([
    ['shows the branch checked out', { data: { current: 'main' } }, 'api Linked on branch main'],
    ['shows no branch when it cannot be read', { isError: true }, 'api Linked'],
  ])('%s', (_, branches, name) => {
    api.state.branches = branches;
    renderRoot();
    expect(screen.getByRole('button', { name })).toBeInTheDocument();
  });

  it("leaves drag and drop working in another pane's tree of the same folder", () => {
    const store = createStore();
    let dnd: ReturnType<typeof useDndContext> | undefined;
    function DndRegistry() {
      dnd = useDndContext();
      return null;
    }
    const mainNodes: FileTreeNode[] = [
      { id: 'src', name: 'src', path: 'src', type: 'folder' },
      { id: 'README.md', name: 'README.md', path: 'README.md', type: 'file' },
    ];
    // Split view: pane 0 works in api, and pane 1 browses api after it, under one DndContext.
    const panes = (browsing: boolean) => (
      <Provider store={store}>
        <TooltipProvider>
          <DndContext>
            <div role="tree" aria-label="Pane 0 file tree">
              <FileTree
                nodes={mainNodes}
                projectPath="/w/api"
                paneIndex={0}
                manageDnd={false}
                onFileClick={() => {}}
              />
            </div>
            {browsing && (
              <ExtraProjectRoot
                project={{ id: 'api', name: 'api', path: '/w/api' }}
                chatId="chat-2"
                paneIndex={1}
                onRemove={() => {}}
              />
            )}
            <DndRegistry />
          </DndContext>
        </TooltipProvider>
      </Provider>
    );
    const { rerender } = render(panes(true));
    const mainTree = screen.getByRole('tree', { name: 'Pane 0 file tree' });
    const mainRow = (path: string) => mainTree.querySelector(`[data-tree-path="${path}"]`);
    const expectMainTreeRegistered = () => {
      const draggables = [...(dnd?.draggableNodes.values() ?? [])].map((d) => d?.node.current);
      expect(draggables).toEqual(expect.arrayContaining([mainRow('src'), mainRow('README.md')]));
      const dropTargets = dnd?.droppableContainers.getEnabled().map((d) => d.node.current) ?? [];
      expect(dropTargets.some((node) => node?.contains(mainRow('src')))).toBe(true);
    };

    expect(
      within(screen.getByRole('tree', { name: 'api file tree, linked' })).getAllByRole('treeitem'),
    ).toHaveLength(2);
    expectMainTreeRegistered();
    rerender(panes(false));
    expectMainTreeRegistered();
  });
});
