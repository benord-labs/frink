// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ResizeHandle } from '../ResizeHandle';

describe('ResizeHandle', () => {
  it('sets aria-disabled and removes from tab order when interactionDisabled', () => {
    render(
      <ResizeHandle
        onPointerDown={vi.fn()}
        onMouseEnter={vi.fn()}
        onMouseLeave={vi.fn()}
        style={{ width: 4 }}
        interactionDisabled
      />,
    );
    const btn = screen.getByRole('button', { name: /resize sidebar/i });
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).toHaveAttribute('tabindex', '-1');
  });

  it('is not aria-disabled and is tabbable when interactive', () => {
    render(
      <ResizeHandle
        onPointerDown={vi.fn()}
        onMouseEnter={vi.fn()}
        onMouseLeave={vi.fn()}
        style={{ width: 4 }}
        interactionDisabled={false}
      />,
    );
    const btn = screen.getByRole('button', { name: /resize sidebar/i });
    expect(btn).not.toHaveAttribute('aria-disabled', 'true');
    expect(btn).toHaveAttribute('tabindex', '0');
  });
});
