// @vitest-environment happy-dom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createMatchHighlighter } from './highlight-match';

describe('createMatchHighlighter', () => {
  it('returns plain text when query is empty', () => {
    const highlight = createMatchHighlighter('', {
      matchCase: false,
      wholeWord: false,
      useRegex: false,
    });
    const { container } = render(<div>{highlight('const value = 1')}</div>);
    expect(container.querySelector('mark')).toBeNull();
    expect(container.textContent).toBe('const value = 1');
  });

  it('highlights all case-insensitive matches', () => {
    const highlight = createMatchHighlighter('react', {
      matchCase: false,
      wholeWord: false,
      useRegex: false,
    });
    const { container } = render(<div>{highlight('React react REACT component')}</div>);

    const marks = container.querySelectorAll('mark');
    expect(marks.length).toBe(3);
    expect(container.textContent).toBe('React react REACT component');
  });

  it('supports case-sensitive matching', () => {
    const highlight = createMatchHighlighter('React', {
      matchCase: true,
      wholeWord: false,
      useRegex: false,
    });
    const { container } = render(<div>{highlight('React react REACT')}</div>);

    const marks = container.querySelectorAll('mark');
    expect(marks.length).toBe(1);
    expect(marks[0]?.textContent).toBe('React');
  });

  it('supports regex + whole-word highlighting', () => {
    const highlight = createMatchHighlighter('set[A-Z]\\w+', {
      matchCase: true,
      wholeWord: true,
      useRegex: true,
    });
    const { container } = render(<div>{highlight('setState setup setSort')}</div>);

    const marks = container.querySelectorAll('mark');
    expect(marks.length).toBe(2);
    expect(marks[0]?.textContent).toBe('setState');
    expect(marks[1]?.textContent).toBe('setSort');
  });

  it('returns plain text when regex is invalid', () => {
    const highlight = createMatchHighlighter('[abc', {
      matchCase: false,
      wholeWord: false,
      useRegex: true,
    });
    const { container } = render(<div>{highlight('hello world')}</div>);

    expect(container.querySelector('mark')).toBeNull();
    expect(container.textContent).toBe('hello world');
  });

  it('does not emit empty span elements for boundary-only matches (split empty segments)', () => {
    const highlight = createMatchHighlighter('a', {
      matchCase: true,
      wholeWord: false,
      useRegex: false,
    });
    const { container } = render(<div>{highlight('a')}</div>);

    const emptySpans = Array.from(container.querySelectorAll('span')).filter(
      (el) => (el.textContent ?? '').length === 0,
    );
    expect(emptySpans.length).toBe(0);
    expect(container.querySelectorAll('mark').length).toBe(1);
    expect(container.textContent).toBe('a');
  });
});
