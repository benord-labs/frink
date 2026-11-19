// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import type { Operation } from '@trpc/client';
import { createStore, Provider } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import { contentSearchOptionsAtom } from '../../atoms';
import { DEFAULT_CONTENT_SEARCH_OPTIONS } from '../../types/content-search-options';
import { useContentSearchTab } from '../../use-content-search-tab';
import { SearchRootsLayout } from './index';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

const main = { id: 'app', name: 'app', path: '/w/app', workingPath: '/w/app', branch: 'feat' };
const linked = { id: 'api', name: 'api', path: '/w/api', missing: false };

/** Each search sent, by folder and query, held until the test answers it with one matching line. */
const pending = new Map<string, () => void>();
/** Every search sent, in order. */
const sent: unknown[] = [];
let store = createStore();

function answer(op: Operation) {
  if (op.path !== 'files.searchContent') return Promise.reject(new Error(`Unexpected ${op.path}`));
  sent.push(op.input);
  const { projectPath, query } = op.input as { projectPath: string; query: string };
  return new Promise((resolve) => {
    const match = { id: query, filePath: 'a.ts', lineNumber: 1, startColumn: 1, endColumn: 2 };
    pending.set(`${projectPath} ${query}`, () =>
      resolve({ matches: [{ ...match, lineText: `${query} line` }], invalidRegex: false }),
    );
  });
}

/** The Search tab as the sidebar wires it: its own search for the chat, under Main. */
function SearchTab() {
  const tab = useContentSearchTab({
    projectPath: main.path,
    canSearch: true,
    isSearchTabActive: true,
  });
  return (
    <>
      <input
        aria-label="Search in files"
        value={tab.contentSearchQuery}
        onChange={(event) => tab.setContentSearchQuery(event.target.value)}
      />
      <SearchRootsLayout
        projects={{ main, linked: [linked] }}
        chatId="chat-1"
        mainPath={main.path}
        isLoading={tab.isLoadingContentSearch}
        isStale={tab.isContentSearchStale}
        query={tab.contentDebouncedQuery}
        invalidRegex={tab.contentSearchInvalidRegex}
        matches={tab.contentMatches}
        onSelectMatch={() => {}}
        renderLine={tab.highlightContentMatch}
      />
    </>
  );
}

const renderTab = () =>
  renderWithTrpc(
    <Provider store={store}>
      <SearchTab />
    </Provider>,
    answer,
  );
const type = (query: string) =>
  fireEvent.change(screen.getByRole('textbox', { name: 'Search in files' }), {
    target: { value: query },
  });
const section = (name: string) =>
  screen.getByRole('heading', { name }).parentElement as HTMLElement;

async function answerSearches(query: string) {
  for (const path of [main.path, linked.path]) {
    await waitFor(() => expect(pending.has(`${path} ${query}`)).toBe(true));
    act(() => pending.get(`${path} ${query}`)?.());
  }
  await waitFor(() =>
    expect(screen.getAllByRole('button', { name: new RegExp(`${query} line`) })).toHaveLength(2),
  );
}

afterEach(() => {
  pending.clear();
  sent.length = 0;
  // The options persist, so a test that changes them must not leave them for the next.
  localStorage.removeItem('files-sidebar-content-search-options');
  store = createStore();
});

describe('SearchRootsLayout with the Search tab driving its search', () => {
  it("marks each section's earlier matches busy as the query changes, then shows Main's search loading in place of them", async () => {
    const view = renderTab();
    type('alpha');
    await answerSearches('alpha');
    expect(view.container.querySelector('[aria-busy]')).not.toBeInTheDocument();

    type('beta');
    for (const name of ['app Main', 'api Linked']) {
      expect(section(name)).toHaveAttribute('aria-busy', 'true');
      expect(section(name)).toHaveTextContent('alpha line');
    }
    expect(view.container.querySelector('.animate-spin')).not.toBeInTheDocument();

    await waitFor(() => expect(pending.has(`${main.path} beta`)).toBe(true));
    expect(section('app Main')).not.toHaveTextContent('alpha line');
    expect(section('app Main').querySelector('.animate-spin')).toBeInTheDocument();

    await answerSearches('beta');
    expect(view.container.querySelector('[aria-busy]')).not.toBeInTheDocument();
  });

  it('says once that a pattern is invalid while it is edited, searching no project', async () => {
    store.set(contentSearchOptionsAtom, { ...DEFAULT_CONTENT_SEARCH_OPTIONS, useRegex: true });
    const view = renderTab();

    for (const query of ['foo(', 'foo((']) {
      type(query);
      await waitFor(() => expect(view.container.querySelector('[aria-busy]')).toBeNull());
      expect(screen.getAllByText('Invalid regular expression.')).toHaveLength(1);
      expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    }
    expect(sent).toEqual([]);
  });
});
