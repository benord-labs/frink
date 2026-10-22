// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoalCard } from './index';

afterEach(cleanup);

describe('GoalCard', () => {
  it('shows the latest failed check while Claude works, with no Clear to race the turn', () => {
    render(
      <GoalCard
        goal={{ objective: 'tests pass', lastCheck: '2 fail' }}
        isStreaming
        hasCardAbove={false}
        onClear={vi.fn()}
      />,
    );
    expect(screen.getByText('Goal: tests pass')).toBeInTheDocument();
    expect(screen.getByText('Not there yet: 2 fail')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear goal' })).toBeNull();
  });

  it('says the next message continues a paused goal, and clears it on request', () => {
    const onClear = vi.fn();
    render(
      <GoalCard
        goal={{ objective: 'tests pass' }}
        isStreaming={false}
        hasCardAbove
        onClear={onClear}
      />,
    );
    expect(screen.getByText('Paused. Your next message picks it back up.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear goal' }));
    expect(onClear).toHaveBeenCalledOnce();
  });
});
