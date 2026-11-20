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
    previewStart: 6,
    previewEnd: 12,
  },
  {
    id: 'a-2',
    filePath: 'src/a.ts',
    lineNumber: 9,
    startColumn: 2,
    endColumn: 8,
    lineText: 'needle()',
    previewStart: 0,
    previewEnd: 6,
  },
  {
    id: 'b-1',
    filePath: 'src/b.ts',
    lineNumber: 4,
    startColumn: 1,
    endColumn: 7,
    lineText: 'needle and more',
    previewStart: 0,
    previewEnd: 6,
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
      />,
    );

    expect(screen.getByText('3 results in 2 files')).toBeTruthy();
    expect(screen.getByText('src/a.ts')).toBeTruthy();
    expect(screen.getByText('src/b.ts')).toBeTruthy();
    expect(screen.getByText('2 results')).toBeTruthy();
    expect(screen.getByText('1 result')).toBeTruthy();
  });

  it('marks exactly the span the search reported, with no query to re-run', () => {
    // A regex like (a+)+b matched this line in the worker; its 500-character preview lost the b.
    const longLine: ContentSearchMatch = {
      id: 'redos',
      filePath: 'long.txt',
      lineNumber: 1,
      startColumn: 1,
      endColumn: 602,
      lineText: `${'a'.repeat(500)}...`,
      previewStart: 0,
      previewEnd: 500,
    };
    const { container } = render(
      <ContentSearchResults
        isLoading={false}
        query="(a+)+b"
        invalidRegex={false}
        matches={[...MATCHES.slice(0, 1), longLine]}
        onSelectMatch={vi.fn()}
      />,
    );

    const marks = [...container.querySelectorAll('mark')].map((mark) => mark.textContent);
    expect(marks).toEqual(['needle', 'a'.repeat(500)]);
  });

  it('says a search hit its time limit instead of claiming nothing matched', () => {
    const props = {
      isLoading: false,
      query: 'needle',
      invalidRegex: false,
      timedOut: true,
      onSelectMatch: vi.fn(),
    };
    const { rerender } = render(<ContentSearchResults {...props} matches={[]} />);

    expect(screen.queryByText('No matches found.')).toBeNull();
    expect(screen.getByText(/Nothing matched in the first 30 seconds/)).toBeTruthy();

    rerender(<ContentSearchResults {...props} matches={MATCHES} />);
    expect(screen.getByText(/Search stopped after 30 seconds/)).toBeTruthy();
    expect(screen.getByText('src/a.ts')).toBeTruthy();
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
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /const needle = true;/ }));
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
      previewStart: 0,
      previewEnd: 6,
    }));

    render(
      <ContentSearchResults
        isLoading={false}
        query="needle"
        invalidRegex={false}
        matches={largeMatches}
        onSelectMatch={vi.fn()}
        pageSize={10}
      />,
    );

    expect(screen.getByText('12 results in 2 files')).toBeTruthy();
    expect(screen.queryByText('needle 11')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more (2 remaining)' }));
    expect(screen.getByRole('button', { name: /needle 11/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /needle 12/ })).toBeTruthy();
  });
});
