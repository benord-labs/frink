// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HeaderBadge } from './header-badge';

afterEach(cleanup);

describe('HeaderBadge', () => {
  it('renders a button with type="button" when onClick is provided', () => {
    const onClick = vi.fn();
    render(
      <HeaderBadge onClick={onClick} aria-label="Test badge">
        Label
      </HeaderBadge>,
    );

    const btn = screen.getByRole('button', { name: 'Test badge' });
    expect(btn.tagName).toBe('BUTTON');
    expect(btn).toHaveAttribute('type', 'button');
  });

  it('renders a div when onClick is omitted', () => {
    render(<HeaderBadge>Static</HeaderBadge>);

    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Static').tagName).toBe('DIV');
  });

  it('renders a button when variant is menuTrigger (explicit dropdown trigger)', () => {
    render(
      <HeaderBadge variant="menuTrigger" aria-label="Menu pill">
        Pill
      </HeaderBadge>,
    );

    const btn = screen.getByRole('button', { name: 'Menu pill' });
    expect(btn.tagName).toBe('BUTTON');
    expect(btn).toHaveAttribute('type', 'button');
  });

  it('renders a button when only onPointerDown is provided (Radix menu trigger merge)', () => {
    const onPointerDown = vi.fn();
    render(
      <HeaderBadge
        {...({
          children: 'Menu trigger',
          onPointerDown,
          'aria-label': 'Merged trigger',
        } as ComponentProps<typeof HeaderBadge>)}
      />,
    );

    const btn = screen.getByRole('button', { name: 'Merged trigger' });
    expect(btn.tagName).toBe('BUTTON');
    expect(btn).toHaveAttribute('type', 'button');
  });
});
