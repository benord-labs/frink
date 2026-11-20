// @vitest-environment happy-dom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { NodeRunStatusIcon } from './node-run-status-icon';

// A paused node keeps spinning, in the warning colour, unlike a paused run's still icon.
describe('NodeRunStatusIcon', () => {
  it.each([
    ['running', 'text-blue-500'],
    ['paused', 'text-warning'],
  ])('spins a %s node on its wrapper', (status, colour) => {
    const { container } = render(<NodeRunStatusIcon status={status} />);
    const spinner = container.querySelector('[data-spinner]');
    expect(spinner?.getAttribute('class')).toContain(colour);
    expect(spinner?.querySelector('svg')?.getAttribute('class')).not.toContain('animate');
  });

  it.each(['completed', 'failed', 'pending'])('keeps a %s node still', (status) => {
    const { container } = render(<NodeRunStatusIcon status={status} />);
    expect(container.querySelector('[data-spinner]')).toBeNull();
  });
});
