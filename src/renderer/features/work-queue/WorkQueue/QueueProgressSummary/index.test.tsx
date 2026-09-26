// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { QueueProgressSummary } from '.';

describe('QueueProgressSummary', () => {
  it('shows the showcase running, review, and queued distribution', () => {
    render(<QueueProgressSummary runningCount={6} reviewCount={1} queuedCount={15} />);

    const summary = screen.getByRole('group', { name: 'Work queue by state' });
    expect(within(summary).getByText('Running')).toBeInTheDocument();
    expect(within(summary).getByText('Review')).toBeInTheDocument();
    expect(within(summary).getByText('Queued')).toBeInTheDocument();
    expect(within(summary).getByText('6')).toBeInTheDocument();
    expect(within(summary).getByText('1')).toBeInTheDocument();
    expect(within(summary).getByText('15')).toBeInTheDocument();
  });

  it('keeps an all-zero queue finite and readable', () => {
    render(<QueueProgressSummary runningCount={0} reviewCount={0} queuedCount={0} />);

    const summary = screen.getByRole('group', { name: 'Work queue by state' });
    expect(summary.innerHTML).not.toContain('NaN');
    expect(within(summary).getAllByText('0')).toHaveLength(3);
  });
});
