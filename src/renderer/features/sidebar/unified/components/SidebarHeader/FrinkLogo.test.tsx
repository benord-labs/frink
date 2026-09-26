// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STRINGS } from '../../constants';
import { FrinkLogo } from './FrinkLogo';

afterEach(cleanup);

describe('FrinkLogo', () => {
  it('uses role=img and a decorative label when not interactive', () => {
    render(<FrinkLogo />);
    const el = screen.getByRole('img', { name: 'Frink' });
    expect(el).not.toHaveAttribute('tabIndex');
  });

  it('allows a custom aria-label when not interactive', () => {
    render(<FrinkLogo ariaLabel="Frink wordmark" />);
    screen.getByRole('img', { name: 'Frink wordmark' });
  });

  it('uses role=button, default interactive label, and tabIndex=0 when onClick is set', () => {
    const onClick = vi.fn();
    render(<FrinkLogo onClick={onClick} />);
    const el = screen.getByRole('button', { name: STRINGS.FRINK_LOGO_INTERACTIVE });
    // happy-dom may expose tabIndex as a property without reflecting to the `tabindex` attribute on SVG
    const svg = el as unknown as SVGSVGElement & { tabIndex?: number };
    expect(svg.tabIndex).toBe(0);
  });

  it('uses a custom aria-label when the logo is interactive', () => {
    render(<FrinkLogo onClick={vi.fn()} ariaLabel="Custom action" />);
    screen.getByRole('button', { name: 'Custom action' });
  });

  it('invokes onClick on Enter and Space (keyboard)', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<FrinkLogo onClick={onClick} />);
    const el = screen.getByRole('button', { name: STRINGS.FRINK_LOGO_INTERACTIVE });
    el.focus();
    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);
    await user.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('invokes onClick on primary pointer activation', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<FrinkLogo onClick={onClick} />);
    await user.click(screen.getByRole('button', { name: STRINGS.FRINK_LOGO_INTERACTIVE }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
