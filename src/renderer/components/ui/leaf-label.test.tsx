// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LeafLabel } from './leaf-label';

afterEach(cleanup);

describe('LeafLabel', () => {
  it('keeps the leaf rigid so only the namespace before it truncates', () => {
    render(<LeafLabel text="benjinorval/feat/issue-search" />);

    expect(screen.getByText('benjinorval/feat/')).toHaveClass('truncate', 'min-w-0');
    expect(screen.getByText('issue-search')).toHaveClass('truncate', 'shrink-0');
  });

  it('never shrinks below a few readable characters', () => {
    render(<LeafLabel text="issue-search" />);

    expect(screen.getByText('issue-search').parentElement).toHaveClass('min-w-[4ch]');
  });

  it('renders a name without a namespace as a single leaf', () => {
    render(<LeafLabel text="main" />);

    expect(screen.getByText('main')).toHaveClass('shrink-0');
    expect(screen.queryByText('/')).toBeNull();
  });
});
