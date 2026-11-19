// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openFilesAtom } from '@/lib/code-editor/state';
import { contentSearchOptionsAtom } from '../../atoms';
import { triggerFileTreeRefresh } from '../../refresh-trigger';
import { ExtraProjectContentSearch } from './index';

type Query = { data?: unknown; isSuccess?: boolean; isLoading?: boolean };

const api = vi.hoisted(() => {
  const state = { search: {} as Query, folderType: {} as Query };
  return {
    state,
    searchContent: vi.fn((_input: unknown, _options: unknown) => state.search),
    entryType: vi.fn((_input: unknown, _options: unknown) => state.folderType),
    invalidateSearch: vi.fn(),
    invalidateEntryType: vi.fn(),
  };
});

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      files: {
        searchContent: { invalidate: api.invalidateSearch },
        entryType: { invalidate: api.invalidateEntryType },
      },
    }),
    files: {
      searchContent: { useQuery: api.searchContent },
      entryType: { useQuery: api.entryType },
    },
  },
}));

const OPTIONS = { matchCase: true, wholeWord: false, useRegex: true };
const MATCH = {
  id: 'm-1',
  filePath: 'src/orders.ts',
  lineNumber: 12,
  startColumn: 3,
  endColumn: 12,
  lineText: 'useOrders()',
};
const MISSING_FOLDER = "Can't open api's folder. It may have moved or been deleted.";

function renderSections(
  query: string,
  projects: ComponentProps<typeof ExtraProjectContentSearch>['project'][] = [
    { id: 'api', name: 'api', path: '/w/api' },
  ],
) {
  const store = createStore();
  store.set(contentSearchOptionsAtom, OPTIONS);
  render(
    <Provider store={store}>
      {projects.map((project) => (
        <ExtraProjectContentSearch
          key={project.id}
          project={project}
          chatId="chat-1"
          paneIndex={1}
          query={query}
        />
      ))}
    </Provider>,
  );
  return store;
}

beforeEach(() => {
  api.state.search = { data: { matches: [], invalidRegex: false }, isLoading: false };
  api.state.folderType = { data: 'folder', isSuccess: true };
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callback(0);
    return 1;
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('ExtraProjectContentSearch', () => {
  it("searches each project's folder with the Search tab's trimmed query and options", () => {
    renderSections(' useOrders ', [
      { id: 'api', name: 'api', path: '/w/api' },
      { id: 'web', name: 'web', path: '/w/web' },
    ]);

    for (const projectPath of ['/w/api', '/w/web']) {
      expect(api.searchContent).toHaveBeenCalledWith(
        { projectPath, query: 'useOrders', limit: 200, ...OPTIONS },
        expect.objectContaining({ enabled: true }),
      );
    }
    // Earlier matches stay up while the next query loads.
    const options = api.searchContent.mock.lastCall?.[1] as {
      placeholderData: (p: string) => string;
    };
    expect(options.placeholderData('earlier')).toBe('earlier');
  });

  it.each(['', '   '])('sends nothing for the query %j', (query) => {
    renderSections(query);
    expect(api.searchContent).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false }),
    );
  });

  it.each([
    [
      'names the project when nothing matches',
      { matches: [], invalidRegex: false },
      { data: 'folder', isSuccess: true },
      'No matches in api.',
      true,
    ],
    [
      'says an invalid pattern is invalid',
      { matches: [], invalidRegex: true },
      { data: 'folder', isSuccess: true },
      'Invalid regular expression.',
      false,
    ],
    [
      "says the folder can't be opened when it is gone",
      { matches: [], invalidRegex: false },
      { data: null, isSuccess: true },
      MISSING_FOLDER,
      true,
    ],
  ])('%s, under its Linked heading', (_, data, folderType, message, asksDisk) => {
    api.state.search = { data, isLoading: false };
    api.state.folderType = folderType;
    renderSections('use(');

    expect(screen.getByRole('heading', { name: 'api Linked' })).toHaveAttribute('title', '/w/api');
    expect(screen.getByText(message)).toBeInTheDocument();
    // Only an empty search asks the disk whether the folder is still there.
    expect(api.entryType).toHaveBeenLastCalledWith(
      { projectPath: '/w/', relativePath: 'api' },
      { enabled: asksDisk },
    );
  });

  it("says a linked folder known to be gone can't be found, as the tree does, and searches nothing", () => {
    renderSections('useOrders', [{ id: 'api', name: 'api', path: '/w/api', missing: true }]);

    expect(screen.getByText("Can't find api's folder.")).toBeInTheDocument();
    expect(api.searchContent).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ enabled: false }),
    );
    expect(api.entryType).toHaveBeenLastCalledWith(expect.anything(), { enabled: false });
  });

  it('asks the disk nothing when something matches', () => {
    api.state.search = { data: { matches: [MATCH], invalidRegex: false }, isLoading: false };
    renderSections('useOrders');

    expect(screen.getByText('1 results in 1 files')).toBeInTheDocument();
    expect(api.entryType).toHaveBeenLastCalledWith(expect.anything(), { enabled: false });
  });

  it.each([
    ['its matches load', { isLoading: true }, {}],
    [
      'the disk says whether its folder is there',
      { data: { matches: [], invalidRegex: false }, isLoading: false },
      { isLoading: true },
    ],
  ])('shows a spinner under its heading while %s', (_, search, folderType) => {
    api.state.search = search;
    api.state.folderType = folderType;
    renderSections('useOrders');

    const section = screen.getByRole('heading', { name: 'api Linked' }).parentElement;
    expect(section?.querySelector('.animate-spin')).toBeInTheDocument();
    expect(screen.queryByText(/No matches|Can't open/)).not.toBeInTheDocument();
  });

  it("opens a match as the chat's browsed tab and shows its line", () => {
    api.state.search = { data: { matches: [MATCH], invalidRegex: false }, isLoading: false };
    const reveals: unknown[] = [];
    const onReveal = (event: Event) => reveals.push((event as CustomEvent).detail);
    window.addEventListener('editor:reveal-line', onReveal);
    const store = renderSections('useOrders');

    fireEvent.click(screen.getByRole('button', { name: /useOrders/ }));
    window.removeEventListener('editor:reveal-line', onReveal);

    expect(store.get(openFilesAtom)).toEqual([
      expect.objectContaining({
        path: '/w/api/src/orders.ts',
        name: 'orders.ts',
        projectPath: '/w/api',
        isOtherProject: true,
        isWorktreeContext: false,
        sourceChatId: 'chat-1',
        sourcePaneIndex: 1,
        isPreview: true,
      }),
    ]);
    expect(reveals).toEqual([
      { filePath: '/w/api/src/orders.ts', lineNumber: 12, startColumn: 3, endColumn: 12 },
    ]);
  });

  it('searches again after a file in its own folder is saved, and not after a save elsewhere', () => {
    renderSections('useOrders', [
      { id: 'api', name: 'api', path: '/w/api' },
      { id: 'web', name: 'web', path: '/w/web' },
    ]);

    act(() => triggerFileTreeRefresh('/tmp/proj'));
    expect(api.invalidateSearch).not.toHaveBeenCalled();

    act(() => triggerFileTreeRefresh('/w/api'));
    expect(api.invalidateSearch).toHaveBeenCalledExactlyOnceWith({ projectPath: '/w/api' });
    expect(api.invalidateEntryType).toHaveBeenCalledExactlyOnceWith({
      projectPath: '/w/',
      relativePath: 'api',
    });
  });

  it('searches again on window focus at most every 30 seconds after it last searched', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    renderSections('useOrders');
    const focusAt = (time: number) => {
      now.mockReturnValue(time);
      act(() => window.dispatchEvent(new Event('focus')));
    };

    focusAt(129_999);
    expect(api.invalidateSearch).not.toHaveBeenCalled();
    focusAt(130_000);
    focusAt(159_999);
    expect(api.invalidateSearch).toHaveBeenCalledExactlyOnceWith({ projectPath: '/w/api' });
    focusAt(160_000);
    expect(api.invalidateSearch).toHaveBeenCalledTimes(2);
  });
});
