// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { LoaderCircle } from 'lucide-react';
import { afterEach, describe, expect, it } from 'vitest';
import { Spinner } from './spinner';

afterEach(cleanup);

const spinClassOf = (el: Element | null) =>
  (el?.getAttribute('class') ?? '').split(/\s+/).filter((c) => c.includes('animate-'));

// spinner.tsx is the one file frink/no-svg-spin exempts, so only this suite stops the
// rotation moving back onto the svg, where Chromium redraws it every frame at Frink's zoom.
describe('Spinner', () => {
  it('rotates its HTML wrapper and leaves the svg still', () => {
    const { container } = render(<Spinner className="size-4 text-primary" />);
    const wrapper = container.firstElementChild;
    expect(wrapper?.tagName).toBe('SPAN');
    expect(spinClassOf(wrapper)).toEqual(['motion-safe:animate-spin']);
    expect(wrapper?.getAttribute('data-spinner')).toBe('true');
    expect(spinClassOf(wrapper?.querySelector('svg') ?? null)).toEqual([]);
  });

  it('spins a supplied icon at the slow speed', () => {
    const { container } = render(<Spinner icon={LoaderCircle} speed="slow" />);
    expect(spinClassOf(container.firstElementChild)).toEqual(['motion-safe:animate-spin-slow']);
    expect(container.querySelector('svg')?.getAttribute('class')).toContain('lucide-loader-circle');
  });

  it('stands still with no spinner hook when not spinning', () => {
    const { container } = render(<Spinner spinning={false} />);
    expect(spinClassOf(container.firstElementChild)).toEqual([]);
    expect(container.querySelector('[data-spinner]')).toBeNull();
  });

  it('is decorative without a label and named with one', () => {
    const { container, rerender } = render(<Spinner />);
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('img')).toBeNull();

    rerender(<Spinner label="Run in progress" />);
    expect(screen.getByRole('img', { name: 'Run in progress' }).hasAttribute('aria-hidden')).toBe(
      false,
    );
  });
});
