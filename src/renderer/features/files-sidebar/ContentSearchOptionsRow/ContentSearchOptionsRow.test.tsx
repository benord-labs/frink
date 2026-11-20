// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONTENT_SEARCH_OPTIONS } from '../types/content-search-options';
import { ContentSearchOptionsRow } from '.';

afterEach(cleanup);

describe('ContentSearchOptionsRow', () => {
  it('opens the file filters and searches with the typed globs on Enter', () => {
    const onChange = vi.fn();
    render(
      <ContentSearchOptionsRow options={DEFAULT_CONTENT_SEARCH_OPTIONS} onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Filter files' }));
    const include = screen.getByRole('textbox', { name: 'Files to include' });
    // The input stops where the server would refuse the list.
    expect(include.getAttribute('maxlength')).toBe('2000');
    fireEvent.change(include, { target: { value: 'src, *.ts' } });
    fireEvent.keyDown(include, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith({
      ...DEFAULT_CONTENT_SEARCH_OPTIONS,
      includeGlobs: 'src, *.ts',
    });
  });

  it('saves typed globs when the row closes before they were committed', () => {
    const onChange = vi.fn();
    const { unmount } = render(
      <ContentSearchOptionsRow options={DEFAULT_CONTENT_SEARCH_OPTIONS} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Filter files' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Files to exclude' }), {
      target: { value: 'dist' },
    });

    unmount();

    expect(onChange).toHaveBeenCalledWith({
      ...DEFAULT_CONTENT_SEARCH_OPTIONS,
      excludeGlobs: 'dist',
    });
  });

  it('shows the filters straight away when saved globs are in effect', () => {
    render(
      <ContentSearchOptionsRow
        options={{ ...DEFAULT_CONTENT_SEARCH_OPTIONS, excludeGlobs: 'dist' }}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('textbox', { name: 'Files to exclude' })).toHaveProperty(
      'value',
      'dist',
    );
  });
});
