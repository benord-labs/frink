// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { act, screen, waitFor } from '@testing-library/react';
import type { Operation } from '@trpc/client';
import { createStore, Provider } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithTrpc } from '@/lib/test-utils/render-with-trpc';
import { contentSearchOptionsAtom } from '../../atoms';
import { triggerFileTreeRefresh } from '../../refresh-trigger';
import { DEFAULT_CONTENT_SEARCH_OPTIONS } from '../../types/content-search-options';
import { ExtraProjectContentSearch } from './index';

// `lib/trpc` wires its ipc client at import time, so the preload bridge must exist first.
vi.hoisted(() => {
  Object.assign(globalThis, {
    electronTRPC: { onMessage: () => () => undefined, sendMessage: () => undefined },
  });
});

// A real query client, unlike index.test.tsx, so what shows while a search loads is React Query's.
/** Each search sent, by its query, held until the test answers it with one matching line. */
const pending = new Map<string, () => void>();
/** Every search sent, in order. */
const sent: unknown[] = [];
let store = createStore();

function answer(op: Operation) {
  if (op.path !== 'files.searchContent') return Promise.reject(new Error(`Unexpected ${op.path}`));
  sent.push(op.input);
  const { query } = op.input as { query: string };
  return new Promise((resolve) => {
    const match = { id: query, filePath: 'a.ts', lineNumber: 1, startColumn: 1, endColumn: 2 };
    pending.set(query, () =>
      resolve({ matches: [{ ...match, lineText: `${query} line` }], invalidRegex: false }),
    );
  });
}

const section = (query: string) => (
  <Provider store={store}>
    <ExtraProjectContentSearch
      project={{ id: 'api', name: 'api', path: '/w/api' }}
      chatId="chat-1"
      query={query}
    />
  </Provider>
);

async function answerSearch(query: string) {
  await waitFor(() => expect(pending.has(query)).toBe(true));
  act(() => pending.get(query)?.());
  await screen.findByRole('button', { name: new RegExp(`${query} line`) });
  pending.clear();
}

afterEach(() => {
  pending.clear();
  sent.length = 0;
  // The options persist, so a test that changes them must not leave them for the next.
  localStorage.removeItem('files-sidebar-content-search-options');
  store = createStore();
});

describe('ExtraProjectContentSearch while a search loads', () => {
  it("shows a busy spinner for a new query, not the earlier query's matches", async () => {
    const view = renderWithTrpc(section('alpha'), answer);
    await answerSearch('alpha');

    view.rerender(section('beta'));
    expect(screen.queryByRole('button', { name: /alpha line/ })).not.toBeInTheDocument();
    expect(view.container.querySelector('[aria-busy="true"] .animate-spin')).toBeInTheDocument();

    await answerSearch('beta');
    expect(view.container.querySelector('[aria-busy]')).not.toBeInTheDocument();
  });

  it('shows a busy spinner for new search options, not the matches found without them', async () => {
    const view = renderWithTrpc(section('alpha'), answer);
    await answerSearch('alpha');

    const matchCase = { ...DEFAULT_CONTENT_SEARCH_OPTIONS, matchCase: true };
    act(() => store.set(contentSearchOptionsAtom, matchCase));
    expect(screen.queryByRole('button', { name: /alpha line/ })).not.toBeInTheDocument();
    expect(view.container.querySelector('[aria-busy="true"] .animate-spin')).toBeInTheDocument();

    await answerSearch('alpha');
    expect(sent.at(-1)).toMatchObject({ query: 'alpha', matchCase: true });
  });

  it('keeps its matches up while it searches again after a save', async () => {
    const view = renderWithTrpc(section('alpha'), answer);
    await answerSearch('alpha');

    act(() => triggerFileTreeRefresh('/w/api'));
    await waitFor(() => expect(pending.has('alpha')).toBe(true));
    expect(screen.getByRole('button', { name: /alpha line/ })).toBeInTheDocument();
    expect(view.container.querySelector('[aria-busy]')).not.toBeInTheDocument();
  });
});

describe('ExtraProjectContentSearch with a pattern that is not a valid regular expression', () => {
  it.each([
    ['foo(', false],
    ['foo(', true],
    // Valid once wrapped in a group, as the highlighter wraps it, but the search runs it as typed.
    ['a)(b', false],
  ])('says %j is invalid at once and sends nothing (whole words %s)', (query, wholeWord) => {
    store.set(contentSearchOptionsAtom, { matchCase: false, wholeWord, useRegex: true });
    const view = renderWithTrpc(section(query), answer);

    expect(screen.getByText('Invalid regular expression.')).toBeInTheDocument();
    expect(view.container.querySelector('[aria-busy]')).not.toBeInTheDocument();
    expect(sent).toEqual([]);
  });

  it('still sends a pattern that is valid', async () => {
    store.set(contentSearchOptionsAtom, { ...DEFAULT_CONTENT_SEARCH_OPTIONS, useRegex: true });
    renderWithTrpc(section('al.ha'), answer);

    await answerSearch('al.ha');
    expect(screen.queryByText('Invalid regular expression.')).not.toBeInTheDocument();
  });
});
