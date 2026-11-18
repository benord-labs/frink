// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuickOpenRoot } from '@/lib/workspace-context/use-quick-open-roots';
import { recentlyOpenedFilesAtom } from '../../agents/atoms';
import { FileSearchDialog } from './file-search-dialog';

const searchUseQueryMock = vi.fn();

// Answers each `t.files.search(input, options)` that the dialog hands to useQueries, in order.
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useQueries: (build: (t: unknown) => unknown[][]) =>
      build({ files: { search: (...args: unknown[]) => args } }).map((args) =>
        searchUseQueryMock(...args),
      ),
  },
}));

type SearchInput = { projectPath: string; query: string };
const CHAT: QuickOpenRoot = { path: '/project', name: 'project', isChat: true };
const OTHER: QuickOpenRoot = { path: '/b', name: 'ros-service', isChat: false };
const B_FILES = [
  { id: '1', type: 'file', path: 'src/index.ts', label: 'index.ts' },
  { id: '2', type: 'file', path: 'lib/app.ts', label: 'app.ts' },
];

describe('FileSearchDialog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    searchUseQueryMock.mockReset();
    searchUseQueryMock.mockImplementation((input: SearchInput) => {
      const all =
        input.projectPath === '/b'
          ? B_FILES
          : [
              { id: '1', type: 'file', path: 'src/a.ts', label: 'a.ts' },
              { id: '2', type: 'file', path: 'src/b.ts', label: 'b.ts' },
            ];
      const query = input.query.toLowerCase();
      const filtered = query ? all.filter((item) => item.path.includes(query)) : all;
      return { data: filtered };
    });
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    cleanup();
  });

  it('focuses search input when opened', () => {
    const store = createStore();
    store.set(recentlyOpenedFilesAtom, []);

    render(
      <Provider store={store}>
        <FileSearchDialog
          open={true}
          onOpenChange={() => {}}
          roots={[CHAT]}
          onSelectFile={() => {}}
        />
      </Provider>,
    );

    vi.runAllTimers();
    expect(document.activeElement).toBe(screen.getByPlaceholderText('Go to file...'));
  });

  it('supports arrow navigation and enter selection', async () => {
    const store = createStore();
    store.set(recentlyOpenedFilesAtom, []);
    const onSelectFile = vi.fn();

    render(
      <Provider store={store}>
        <FileSearchDialog
          open={true}
          onOpenChange={() => {}}
          roots={[CHAT]}
          onSelectFile={onSelectFile}
        />
      </Provider>,
    );

    const input = screen.getByPlaceholderText('Go to file...');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSelectFile).toHaveBeenCalledWith('/project/src/b.ts', CHAT);
  });

  it('shows recent files first and de-duplicates overlapping search results', () => {
    const store = createStore();
    store.set(recentlyOpenedFilesAtom, ['/project/src/a.ts']);

    render(
      <Provider store={store}>
        <FileSearchDialog
          open={true}
          onOpenChange={() => {}}
          roots={[CHAT]}
          onSelectFile={() => {}}
        />
      </Provider>,
    );

    expect(screen.getAllByText('a.ts')).toHaveLength(1);
    expect(screen.queryByText('recently opened')).not.toBeNull();
  });

  it('removes file from recently opened list', () => {
    const store = createStore();
    store.set(recentlyOpenedFilesAtom, ['/project/src/a.ts']);

    render(
      <Provider store={store}>
        <FileSearchDialog
          open={true}
          onOpenChange={() => {}}
          roots={[CHAT]}
          onSelectFile={() => {}}
        />
      </Provider>,
    );

    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Delete' });
    expect(store.get(recentlyOpenedFilesAtom)).toEqual([]);
  });

  it('renders a PDF-specific icon for .pdf results, distinct from the lucide icon used for code files', () => {
    const store = createStore();
    store.set(recentlyOpenedFilesAtom, []);
    searchUseQueryMock.mockImplementation((input: { query: string }) => {
      const all = [
        { id: '1', type: 'file', path: 'src/a.ts', label: 'a.ts' },
        { id: '3', type: 'file', path: 'src/design.pdf', label: 'design.pdf' },
      ];
      const query = input.query.toLowerCase();
      const filtered = query ? all.filter((item) => item.path.includes(query)) : all;
      return { data: filtered };
    });

    render(
      <Provider store={store}>
        <FileSearchDialog
          open={true}
          onOpenChange={() => {}}
          roots={[CHAT]}
          onSelectFile={() => {}}
        />
      </Provider>,
    );

    const tsRow = screen.getByText('a.ts').closest('[role="option"]');
    const pdfRow = screen.getByText('design.pdf').closest('[role="option"]');

    expect(tsRow?.querySelector('svg.lucide-file-code')).not.toBeNull();
    expect(pdfRow?.querySelector('svg.lucide-file-text')).toBeNull();
    expect(pdfRow?.querySelector('svg')).not.toBeNull();
  });

  // The hint runs right to left so its start is cut; unisolated, a bracketed name drew as "y [x]".
  it('reads a bracketed folder hint left to right', () => {
    const store = createStore();
    store.set(recentlyOpenedFilesAtom, []);
    const plain = { id: '1', type: 'file', path: '[x] y/plain.ts', label: 'plain.ts' };
    searchUseQueryMock.mockReturnValue({ data: [plain] });

    render(
      <Provider store={store}>
        <FileSearchDialog
          open={true}
          onOpenChange={() => {}}
          roots={[CHAT]}
          onSelectFile={() => {}}
        />
      </Provider>,
    );

    expect(screen.getByText('[x] y')).toHaveClass('[direction:ltr]', '[unicode-bidi:isolate]');
  });

  describe('across the projects in the tree', () => {
    function renderTree({ roots = [CHAT, OTHER], recents = [] as string[] } = {}) {
      const store = createStore();
      store.set(recentlyOpenedFilesAtom, recents);
      const onSelectFile = vi.fn();
      const onOpenChange = vi.fn();
      const dialog = (open: boolean, shownRoots = roots) => (
        <Provider store={store}>
          <FileSearchDialog
            open={open}
            onOpenChange={onOpenChange}
            roots={shownRoots}
            onSelectFile={onSelectFile}
          />
        </Provider>
      );
      const view = render(dialog(true));
      const reopen = () => [false, true].forEach((open) => view.rerender(dialog(open)));
      const changeRoots = (next: QuickOpenRoot[]) => view.rerender(dialog(true, next));
      return { onSelectFile, onOpenChange, reopen, changeRoots };
    }
    // Each row's text: the name, its folder, the project tag, then "recently opened".
    const rows = () => screen.getAllByRole('option').map((option) => option.textContent);
    const pill = (name: string) => screen.getByRole('button', { name });
    const searched = () => [
      ...new Set(
        searchUseQueryMock.mock.calls.map(([input]) => (input as SearchInput).projectPath),
      ),
    ];

    it('searches one folder, with no scope pills, when the tree has one project', () => {
      renderTree({ roots: [CHAT] });

      expect(screen.queryByRole('group', { name: 'Search scope' })).toBeNull();
      expect(searched()).toEqual(['/project']);
      expect(searchUseQueryMock).toHaveBeenCalledWith(
        { projectPath: '/project', query: '', limit: 50 },
        expect.objectContaining({ enabled: true }),
      );
    });

    it("searches every project, tags another project's files, and narrows to one project's", () => {
      renderTree({ recents: ['/project/src/a.ts', '/b/lib/app.ts'] });

      expect(searched()).toEqual(['/project', '/b']);
      expect(pill('All in this tree')).toHaveAttribute('aria-pressed', 'true');
      expect(rows()).toEqual([
        'a.tssrcrecently opened',
        'app.tslibros-servicerecently opened',
        'b.tssrc',
        'index.tssrcros-service',
      ]);
      // The tag names the project in full, since a long name is cut off.
      expect(screen.getAllByTitle('ros-service')).toHaveLength(2);

      searchUseQueryMock.mockClear();
      fireEvent.click(pill('ros-service'));

      expect(pill('ros-service')).toHaveAttribute('aria-pressed', 'true');
      expect(searched()).toEqual(['/b']);
      expect(rows()).toEqual(['app.tslibros-servicerecently opened', 'index.tssrcros-service']);
    });

    it('lists the same path in two projects twice and opens the one picked', () => {
      // React reports rows that share a key here.
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      searchUseQueryMock.mockReturnValue({ data: [B_FILES[0]] });
      const { onSelectFile } = renderTree();
      const input = screen.getByPlaceholderText('Go to file...');

      expect(rows()).toEqual(['index.tssrc', 'index.tssrcros-service']);
      expect(consoleError).not.toHaveBeenCalled();
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(onSelectFile).toHaveBeenCalledWith('/b/src/index.ts', OTHER);
    });

    it("still lists a project's files when another project's search fails", () => {
      searchUseQueryMock.mockImplementation((input: SearchInput) =>
        input.projectPath === '/b' ? { data: B_FILES } : { data: undefined, isError: true },
      );
      renderTree();

      expect(rows()).toEqual(['index.tssrcros-service', 'app.tslibros-service']);
    });

    it("keeps each project's last results on screen while its next search loads", () => {
      const answer = searchUseQueryMock.getMockImplementation()!;
      searchUseQueryMock.mockImplementation(
        (input: SearchInput, options: { placeholderData: () => unknown }) =>
          input.query === 'pending'
            ? { data: options.placeholderData(), isPlaceholderData: true }
            : answer(input),
      );
      renderTree();

      fireEvent.change(screen.getByPlaceholderText('Go to file...'), {
        target: { value: 'pending' },
      });
      act(() => vi.advanceTimersByTime(300));
      expect(rows()).toHaveLength(4);
      // ros-service is now the only folder searched, but its last results are still its own.
      fireEvent.click(pill('ros-service'));

      expect(rows()).toEqual(['index.tssrcros-service', 'app.tslibros-service']);
    });

    it('leaves Enter on a pill to the pill, and searches every project again on reopen', () => {
      const { onSelectFile, reopen } = renderTree();
      fireEvent.click(pill('ros-service'));

      fireEvent.keyDown(pill('ros-service'), { key: 'Enter' });
      expect(onSelectFile).not.toHaveBeenCalled();

      reopen();
      expect(pill('All in this tree')).toHaveAttribute('aria-pressed', 'true');
      expect(rows()).toHaveLength(4);
    });

    it('puts focus back in the input once a pill is picked, so typing and Enter still search', () => {
      const { onSelectFile } = renderTree();
      const input = screen.getByPlaceholderText('Go to file...');
      pill('ros-service').focus();

      fireEvent.click(pill('ros-service'));

      expect(document.activeElement).toBe(input);
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Enter' });
      expect(onSelectFile).toHaveBeenCalledWith('/b/src/index.ts', OTHER);
    });

    it('searches every project again when the chosen one leaves the tree while open', () => {
      const WEB: QuickOpenRoot = { path: '/c', name: 'web', isChat: false };
      const { changeRoots } = renderTree({ roots: [CHAT, OTHER, WEB] });
      fireEvent.click(pill('ros-service'));

      changeRoots([CHAT, WEB]);

      expect(pill('All in this tree')).toHaveAttribute('aria-pressed', 'true');
      expect(rows()).toEqual(['a.tssrc', 'b.tssrc', 'a.tssrcweb', 'b.tssrcweb']);
    });

    it('lists a recent file under the deepest project holding it', () => {
      const PKG: QuickOpenRoot = { path: '/b/pkg', name: 'pkg', isChat: false };
      renderTree({ roots: [CHAT, OTHER, PKG], recents: ['/b/pkg/x.ts'] });

      expect(rows()[0]).toBe('x.tspkgrecently opened');
    });

    it('drops an open it has nothing to search, so it never pops up later by itself', () => {
      const { onOpenChange } = renderTree({ roots: [] });

      expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
      expect(screen.queryByPlaceholderText('Go to file...')).toBeNull();
    });
  });
});
