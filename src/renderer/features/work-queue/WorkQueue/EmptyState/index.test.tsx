// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EmptyState } from './index';

describe('EmptyState', () => {
  it('disables its decorative pulse when reduced motion is requested', () => {
    const { container } = render(<EmptyState />);

    expect(container.querySelector('.animate-pulse')).toHaveClass('motion-reduce:animate-none');
  });
});
