// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContentSearchMatch } from '../types/content-search-match';
import { ContentSearchResults } from '.';

const MATCHES: ContentSearchMatch[] = [
  {
    id: 'a-1',
    filePath: 'src/a.ts',
    lineNumber: 3,
    startColumn: 7,
    endColumn: 13,
    lineText: 'const needle = true;',
  },
  {
    id: 'a-2',
    filePath: 'src/a.ts',
    lineNumber: 9,
    startColumn: 2,
    endColumn: 8,
    lineText: 'needle()',
  },
  {
    id: 'b-1',
    filePath: 'src/b.ts',
    lineNumber: 4,
    startColumn: 1,
    endColumn: 7,
    lineText: 'needle and more',
  },
];

describe('ContentSearchResults', () => {
  afterEach(() => {
    cleanup();
  });

  it('groups visible matches by file and renders grouped counts', () => {
    render(
      <ContentSearchResults
        isLoading={false}
        query="needle"
        invalidRegex={false}
        matches={MATCHES}
        onSelectMatch={vi.fn()}
        renderLine={(line) => line}
      />,
    );

    expect(screen.getByText('3 results in 2 files')).toBeTruthy();
    expect(screen.getByText('src/a.ts')).toBeTruthy();
    expect(screen.getByText('src/b.ts')).toBeTruthy();
    expect(screen.getByText('2 results')).toBeTruthy();
    expect(screen.getByText('1 result')).toBeTruthy();
  });

  it('passes line and range values when selecting a match', () => {
    const onSelectMatch = vi.fn();
    render(
      <ContentSearchResults
        isLoading={false}
        query="needle"
        invalidRegex={false}
        matches={MATCHES}
        onSelectMatch={onSelectMatch}
        renderLine={(line) => line}
      />,
    );

    fireEvent.click(screen.getByText('const needle = true;'));
    expect(onSelectMatch).toHaveBeenCalledWith('src/a.ts', 3, 7, 13);
  });

  it('renders only first page and reveals more results progressively', () => {
    const largeMatches: ContentSearchMatch[] = Array.from({ length: 12 }, (_, index) => ({
      id: `m-${index + 1}`,
      filePath: index < 7 ? 'src/a.ts' : 'src/b.ts',
      lineNumber: index + 1,
      startColumn: 1,
      endColumn: 7,
      lineText: `needle ${index + 1}`,
    }));

    render(
      <ContentSearchResults
        isLoading={false}
        query="needle"
        invalidRegex={false}
        matches={largeMatches}
        onSelectMatch={vi.fn()}
        renderLine={(line) => line}
        pageSize={10}
      />,
    );

    expect(screen.getByText('12 results in 2 files')).toBeTruthy();
    expect(screen.queryByText('needle 11')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more (2 remaining)' }));
    expect(screen.getByText('needle 11')).toBeTruthy();
    expect(screen.getByText('needle 12')).toBeTruthy();
  });
});
