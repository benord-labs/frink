// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recentlyOpenedFilesAtom } from '../../agents/atoms';
import { FileSearchDialog } from './file-search-dialog';

const searchUseQueryMock = vi.fn();

vi.mock('@/lib/trpc', () => ({
  trpc: {
    files: {
      search: {
        useQuery: (...args: unknown[]) => searchUseQueryMock(...args),
      },
    },
  },
}));

describe('FileSearchDialog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    searchUseQueryMock.mockImplementation((input: { query: string }) => {
      const all = [
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
          projectPath="/project"
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
          projectPath="/project"
          onSelectFile={onSelectFile}
        />
      </Provider>,
    );

    const input = screen.getByPlaceholderText('Go to file...');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSelectFile).toHaveBeenCalledWith('/project/src/b.ts');
  });

  it('shows recent files first and de-duplicates overlapping search results', () => {
    const store = createStore();
    store.set(recentlyOpenedFilesAtom, ['/project/src/a.ts']);

    render(
      <Provider store={store}>
        <FileSearchDialog
          open={true}
          onOpenChange={() => {}}
          projectPath="/project"
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
          projectPath="/project"
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
          projectPath="/project"
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
});
